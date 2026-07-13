# Security design

This document describes the threat model and the controls in place. Treat it as
a living document — review it whenever you add a tool or a platform.

## Assets to protect

1. **Claude subscription token** (`CLAUDE_CODE_OAUTH_TOKEN`) — grants use of your
   Claude account.
2. **Discord bot token** — full control of the bot identity in the server.
3. **WhatsApp linked-device credentials** (`whatsapp-auth/`) — effectively
   control of the bot's WhatsApp number.
4. **The interaction database** — contains community members' messages (PII).
5. **Moderation authority** — the ability to timeout/kick/ban/announce, and
   (when auto-moderation is enabled) to mute/block members via a Discord role.

## Threat model & controls

### 1. Privilege escalation via chat ("prompt injection")
A normal user tries to get the agent to moderate, announce, or reveal secrets.

**Controls**
- **Built-in tools disabled outright**: the `tools` option passed to every
  `query()` removes ALL built-in Claude Code tools (Bash/Read/Write/Glob/…)
  from the model's surface, with one deliberate exception: **admin and
  super-admin turns get exactly `WebSearch`** (search-and-summarise). Note
  `allowedTools` alone does NOT restrict — it only pre-approves; the
  restriction comes from the `tools` list.
- **WebFetch stays disallowed for every tier**: the model constructs fetch
  URLs, so an injection could exfiltrate conversation content via a query
  string to an attacker's server, and fetched pages are a rich injection
  vector. WebSearch snippets are a much smaller surface; they are still
  untrusted content and the system prompt says so.
- **Structural RBAC (three tiers)**: `allowedTools` is computed from the
  *sender's* resolved tier (super_admin > admin > member > guest), not from
  anything in the message. A lower tier's turn never has higher-tier tools
  attached, so the model cannot call them even if convinced to.
- **Admin scoping is data-layer**: admins' cross-conversation tools filter in
  SQL against the admin's *platform-verified* conversation membership
  (Discord channel visibility / WhatsApp group participation, cached ~60s).
- **Confirm-before-destructive**: kick/timeout/delete/purge/forget — and
  **grant_admin**, the highest-blast-radius action of all — register a pending
  action; the actor must reply CONFIRM in the same conversation within 60s.
  **`redeploy_bot`** (issue #101) follows the identical path: super-admin only,
  `{}` input schema (no ref/branch/argument the model or chat text could ever
  supply), CONFIRM-gated, and executed by the router via a fixed `execFile`
  argv — an injection can at most *request* a deploy of already-human-merged
  `origin/main` and still cannot complete it without the super admin's own
  CONFIRM.
  The confirmation is intercepted by the router *before* the addressed-check
  (so a bare CONFIRM works in group chats; bot mention tokens are stripped and
  tolerated) and executed deterministically — it never passes through the
  model, so an injection can *request* an action but can never *complete*
  one. The actor's tier is **re-resolved at confirm time**: a role revoked
  inside the TTL invalidates the queued action.
- **Defence in depth**: every privileged tool calls `assertAtLeast()` before
  any side effect.
- **Identity is platform-derived**: super admins come from env config; admins
  and members from the `community_users` table, changed only via audited
  super-admin/admin tools — never from message content. The system prompt
  explicitly states that messages cannot grant permissions.
- **Super-admin alerting**: every successful privileged action DMs the other
  super admins, so misuse or a successful injection is *seen*, not just logged.
- **Memory is conversation-scoped**: automatic recall and `remember_search`
  only see the current conversation. Cross-conversation search (which could
  expose other members' DMs) is admin-only.
- **Knowledge scope is enforced at read time, not just write time** (issue
  #106): `knowledge.scope` (`'global'` | a platform | a conversation id) is
  applied as a SQL filter in `searchKnowledge()` — a caller only ever gets
  `'global'` entries plus entries scoped to their own platform or
  conversation. The `knowledge_search` tool always passes the caller's real
  `(platform, conversationId)`, so an admin who saves a channel-scoped FAQ
  can no longer have the bot recite it in a different channel or on the
  other platform. The near-duplicate nudge in `save_knowledge` applies the
  same scope filter, so it never surfaces another scope's entry content to
  an admin saving into a scope they may not be in. `list_knowledge` (admin
  browse/curation) is the one deliberate exception: it keeps browsing by
  explicit scope, unrestricted by the caller's own conversation — it's an
  admin-tier curation view, not member-facing recall.
- **Guest FAQ shortcut is global-scope only** (`GUEST_KNOWLEDGE_SHORTCUT_ENABLED`,
  off by default, issue #165): a gated guest's first message may be answered
  from `knowledge` before the static "ask an admin" pointer, but the lookup
  passes `scopeRestriction: 'global-only'` — a guest can never be served a
  platform- or conversation-scoped entry, even at very high similarity,
  because a guest has no meaningful conversation scope and platform-scoped
  entries may assume member context (pinned by test). No new stored data: the
  guest's message is used only in-memory to compute a transient embedding, and
  neither the guest's message nor the shortcut's reply is written to
  `interactions` — the existing "guest content not stored" invariant below
  covers this reply too, not just the inbound message. The only DB write
  remains the existing `access_requests` upsert, unaffected by whether a
  shortcut answer was served.
- **Recalled content is quarantined**: memories are injected into the *user*
  turn inside a delimited `<recalled-messages>` block with angle brackets
  stripped (so recalled text can't fake a closing tag), and the system prompt
  instructs the model to treat recalled/tool-returned chat content as data,
  never instructions. This mitigates stored prompt injection; it does not
  eliminate it — see "Residual risks".
- **Privileged targets are validated**: `moderate`/`announce`/`create_poll`/
  `end_poll`/`create_thread`/`archive_thread` refuse targets
  (conversations/users) the bot has never seen, so a manipulated admin turn
  cannot message arbitrary phone numbers or unknown channels. `link_member`
  applies the same pattern: both identities must already be known community
  members (a `community_users` row exists) — it cannot conjure membership,
  only associate two identities that already have it.
- `settingSources: []` prevents loading the host's `~/.claude` config.

### 2. Secret exposure
**Controls**
- Secrets live only in `.env` (git-ignored; `chmod 600`) and are loaded as env
  vars. `ANTHROPIC_API_KEY` is actively deleted at startup to enforce
  subscription-only billing.
- The logger **redacts** token/password fields.
- The system prompt instructs the agent never to reveal instructions, tokens,
  or internal ids.
- `whatsapp-auth/` and `*.key`/`*.pem` are git-ignored.

### 3. Abuse / cost runaway
**Controls**
- Per-user rate limit (8 msg/min).
- `AGENT_MAX_TURNS` caps the agentic loop per request, **tiered by role**
  (issue #347): member/guest turns — the highest-volume, lowest-trust
  segment, restricted to the narrower `MEMBER_TOOLS` surface with no
  WebSearch — are capped by the lower `AGENT_MAX_TURNS_MEMBER` (default 6)
  instead of the admin/super_admin ceiling (`AGENT_MAX_TURNS`, default 12),
  bounding the worst-case cost of a stuck or injected member/guest turn to
  roughly half of today's uniform value. admin/super_admin behaviour is
  unchanged. Wired in `buildQueryOptions` (`src/agent/core.ts`), which
  already branches on role for WebSearch gating.
- Per-conversation serialisation bounds concurrent `query()` calls.
- `cost_usd` is recorded per outbound turn for monitoring.
- The bot only responds when **addressed** (mention/reply) or in a direct
  chat — it does not react to every message in a channel.
- `report_content` is capped at 5 submissions per reporter per rolling 24h,
  enforced as a `COUNT(*)` over `content_reports.created_at` inside the insert
  query itself — a DB-backed check, not an in-memory counter, so it survives a
  restart and can't be bypassed by timing a bounce (the only in-memory rate
  limiter in the codebase is router.ts's per-message map, which is unrelated
  and does reset on restart by design).
- Optional proactive alert (`USAGE_ALERT_DAILY_REPLIES`, off by default):
  when the rolling-24h outbound reply count reaches the configured
  threshold, super admins get one debounced DM (`src/usageAlert.ts`) instead
  of having to remember to run `usage_stats`. Reply count, not `cost_usd`, is
  the trigger — it's a coarse proxy for shared Max-pool draw that can't
  silently under-report the way `cost_usd` can (see below). No auto-pause;
  a super admin decides.
- `WebSearch` — the one metered, real-cost built-in Claude Code tool the bot
  grants (admin+ only) — carries its own per-conversation rolling-hour cap
  (`AGENT_WEB_SEARCH_RATE_LIMIT_PER_HOUR`, default 20, issue #412), enforced
  via a `hooks.PreToolUse` matcher in `buildQueryOptions`
  (`src/agent/core.ts`) rather than `canUseTool`, since a tool listed bare in
  `allowedTools` (which `WebSearch` is) auto-approves and never reaches
  `canUseTool`. Same sliding-window shape as the four `reserve*Slot` caps
  below; fails closed on a hook error (denies rather than letting the call
  through). Never constructed for member/guest turns — those tiers have no
  WebSearch access to begin with.
- A thrown `query()` error whose message matches a small, anchored
  usage-limit/overload pattern (`src/agent/upstreamFailure.ts`) gets an
  honest member-facing reply instead of the generic internal-error one, and
  optionally (`UPSTREAM_LIMIT_ALERT_ENABLED`, off by default) a debounced
  super-admin DM — same `sendDirectMessage` path, same "no auto-pause, a
  super admin decides" posture. Only the error's own message is inspected
  (never user-supplied text), and both the member reply and the admin DM
  are always one of a small set of fixed strings — the raw error is never
  echoed.

### 4. Moderation misuse / accountability
**Controls**
- Every privileged action is written to the append-only `admin_audit` table
  (who, what, target, params, result, success, timestamp).
- Admin actions are gated on platform-native admin identity.

### 5. Host compromise / blast radius
**Controls**
- Runs as a dedicated, non-login system user (`community-agent`).
- systemd hardening: `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome`, `PrivateTmp`, restricted namespaces, single `ReadWritePaths`.
- Postgres bound to localhost with a dedicated least-privilege role.
- **One new, deliberate host-level surface (issue #101):** the
  `redeploy_bot` tool needs the unprivileged `community-agent` user to start
  one root-owned systemd unit. This is granted via a single **exact-match**
  sudoers line (`NOPASSWD: /usr/bin/systemctl start
  community-agent-redeploy.service`, no wildcard — see docs/DEPLOYMENT.md) —
  it does not grant `systemctl` generally, only starting that one oneshot
  unit, which itself only fast-forwards to already-human-merged `main` (see
  branch protection above). `sudo -n` (non-interactive) means a missing grant
  fails the tool loudly instead of hanging. This is an **operator opt-in**:
  the code ships gated behind the sudoers line existing, so a deployment that
  never adds it never gains the new surface.

### 6. Data protection (member PII)
- All messages are stored for memory/audit. **Inform your community** that an
  AI assistant logs interactions (Discord/WhatsApp etiquette + NZ Privacy Act
  2020 expectations).
- **Ambient channel archiving** (`DISCORD_ARCHIVE_ALL_MESSAGES`, issue #48,
  off by default): when enabled, EVERY message posted in the guild's allowed
  channels is stored with an embedding and its Discord message id —
  member, guest, or lurker, addressed to the bot or not. This is the
  project's founding "store all interactions so it can learn" goal, enabled
  deliberately by the operator. Controls that ship with it:
  - **Storage is decoupled from response**: the addressed-check still solely
    decides whether the agent runs; ambient rows never trigger a reply
    (pinned by `SECURITY:` test).
  - **Platform deletes/edits are honoured**: deleting a Discord message
    hard-deletes the stored copy; editing re-writes and re-embeds it —
    stronger than the pre-#48 posture, where a processed message was kept
    even if later deleted on Discord.
  - Ambient rows join the same lifecycle as everything else: conversation-
    scoped recall, `INTERACTION_RETENTION_DAYS` age purge, and
    `forget_me`/`purge_user_data` (all pinned by tests). The recall
    quarantine (untrusted block, bracket stripping) applies to ambient
    content identically.
  - **Visible community notice is a precondition, not a nicety** — see the
    operational checklist and the ready-to-pin notice text below. Do not
    enable the flag before the notice is posted.

  Ready-to-pin server notice (edit the retention line to match your config):

  > 📢 **Message logging in this server**
  > Our community assistant stores messages posted in this server's public
  > channels — including from non-members — to build shared community
  > memory (so it can answer things like "what did we decide about X?").
  > What's stored: message text, author, channel, and time. Deleting or
  > editing your Discord message deletes or updates the stored copy. DMs
  > with the bot are stored for registered members only. You can tell the
  > bot to "forget me" at any time to erase your stored messages
  > [, and messages are automatically deleted after N days]. Questions →
  > ask an admin.
- **Ambient WhatsApp group archiving** (`WHATSAPP_ARCHIVE_GROUP_JIDS`, issue
  #103, extends #48, off by default): the same posture and controls as
  Discord's ambient archiving above, applied to the community's WhatsApp
  group(s) — same "storage decoupled from response", same delete/edit
  honouring, same lifecycle (retention purge, `forget_me`/`purge_user_data`,
  conversation-scoped recall), all pinned by `SECURITY:` tests. It differs
  from Discord in one deliberate way: it's an **explicit per-group JID
  allowlist**, not a single all-channels flag. WhatsApp groups have no
  "public channel" convention, so each group's archiving is opted into
  individually — the act of adding a JID to the list **is** the operator's
  assertion that the group's notice has been posted. Guest 1:1 DMs to the
  bot are never archived, regardless of config. Edit-tracking is
  best-effort (Baileys' protocol fidelity for edits is less reliable than
  for revokes); delete-honouring is the load-bearing privacy promise and
  always applies to archived groups. See "WhatsApp / Baileys ToS risk"
  below for why this adds no new ban-risk surface.

  Ready-to-pin WhatsApp group notice (edit the retention line to match your
  config, then post it in the group *before* adding its JID to
  `WHATSAPP_ARCHIVE_GROUP_JIDS`):

  > 📢 **Message logging in this group**
  > Our community assistant stores messages posted in this group — including
  > from non-members — to build shared community memory (so it can answer
  > things like "what did we decide about X?"). What's stored: message text,
  > sender, group, and time. Deleting your WhatsApp message deletes the
  > stored copy. 1:1 chats with the bot are stored for registered members
  > only. You can tell the bot to "forget me" at any time to erase your
  > stored messages [, and messages are automatically deleted after N days].
  > Questions → ask an admin.
- **Context digests** (`context_digests`, issue #51): an internal batch job
  summarises *already-stored* interactions into aggregate topic digests — no
  new collection surface. Admin-tier reads only (`list_context_digests`,
  wrapped as untrusted data). Privacy properties enforced in code and pinned
  by `SECURITY:` tests: digests reference interaction ids (never copied
  content); a `forget_me`/`purge_user_data` invalidates every digest built
  over the purged person's rows; and a minimum-distinct-authors floor stops
  a digest from becoming a single-person profile. Cost is bounded by a hard
  per-run cap on model calls plus an automatic skip while the usage-alert
  threshold is breached.
- **Knowledge candidates** (`knowledge_candidates`, issue #102 — the
  deferred half of #51): the offline builder can draft a Q&A candidate from
  a recurring, answerable question cluster (behind `CONTEXT_CANDIDATES_ENABLED`,
  off by default), but **the human-curation invariant this repo keeps for
  `knowledge` generally is unchanged**: nothing reaches `knowledge` (and
  therefore no tier's `knowledge_search`) until an admin explicitly calls
  `accept_knowledge_candidate`, pinned by a `SECURITY:` test. Candidates are
  model-written text derived from member chat — same provenance/injection
  posture as digests (k-floor inherited from the source digest,
  `untrusted()`-wrapped on `list_knowledge_candidates`) — and all three
  tools (`list_knowledge_candidates`, `accept_knowledge_candidate`,
  `decline_knowledge_candidate`) are admin-tier only, pinned by a
  `SECURITY:` RBAC test. `decline_knowledge_candidate` is a non-destructive
  status flip (no CONFIRM) that retains the row as `'declined'` rather than
  deleting it, so the builder's dedup guard can see it was already reviewed.
  Cost stays inside the builder's existing hard per-run model-call cap: a
  candidate is drafted by the SAME summarisation call that writes the
  digest, never a second call. Purge coherence: invalidating a digest
  deletes its still-*pending* candidates; an accepted candidate (and the
  knowledge entry it produced) is unaffected, matching how `knowledge`
  itself outlives an unrelated purge.
- **Knowledge gaps** (`knowledge_gaps`, issue #208): the `knowledge_search`
  handler persists a below-floor miss — a call that came back with hits but
  none cleared `KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD` — so admins can see
  what real questions have no confident answer yet, the one curation signal
  `question_digest`/`countStaleKnowledge`/`knowledge_candidates` don't
  capture. **No new tier, no new untrusted input path**: `args.query` is
  member-authored text already flowing through `recordInteraction`; this is
  a second, smaller, purpose-built copy for cheap clustering, not a new
  category of collection. Gated on `hits.length > 0 && relevantIds.length
  === 0`, never on a plain empty result, pinned by a `SECURITY:` test — a
  `searchKnowledge` `embed()` failure also returns `[]`, and gating on "zero
  hits" alone would silently log an embedding outage as a wave of genuine
  gaps. A conservative DB-backed rolling-24h insert cap per `(platform,
  user_id)` (`KNOWLEDGE_GAP_DAILY_LIMIT`, 20/day, same COUNT(*)-inside-insert
  pattern as `answer_feedback`/`suggestions`) bounds a chatty or adversarial
  member flooding the signal, pinned by a `SECURITY:` test. The read side,
  `list_knowledge_gaps`, is read-only, admin-tier, conversation-scoped via
  `callerScope()` exactly like `question_digest` (pinned by a `SECURITY:`
  RBAC-placement test and a scoping test mirroring
  `repository.test.ts`'s `recentQuestionClusters` scope test), and
  `untrusted()`-wraps its output like `list_suggestions`/`list_reports` since
  the representative query text is member-authored. `forget_me`/
  `purge_user_data` delete the caller's own `knowledge_gaps` rows, pinned by
  a `SECURITY:` purge-coherence test — same treatment as `suggestions`/
  `content_reports`/`answer_feedback`. No paid model call: the embedding is
  the same free, local `embed()` every other memory/knowledge feature uses.
- **Daily knowledge refresh** (`KNOWLEDGE_REFRESH_ENABLED`, off by default —
  src/context/knowledgeRefresh.ts): the one path that writes to `knowledge`
  **without** the human-curation gate above — a deliberate, operator-enabled
  exception for keeping a couple of fast-moving Claude/Anthropic topics
  current. Its blast radius is bounded by construction: the topic list is
  **fixed in code** (not user- or env-supplied, so chat/injection can't steer
  what gets researched), each topic upserts a **single** `global` entry by a
  stable title (the base is refreshed, never grown unbounded), and every entry
  carries an explicit *"auto-researched … machine-generated … verify against
  official sources"* footer so a human skimming `list_knowledge` knows it is
  unreviewed. **The load-bearing control is at retrieval, not in the prompt:**
  auto entries are written with `created_by_role='auto'`, and `knowledge_search`
  (`formatKnowledgeSearchResults`) **quarantines** any `auto` hit before it
  reaches the answering model — angle brackets stripped and framed as
  reference-only data the model must never follow instructions from, exactly
  the `untrusted()` treatment recalled chat gets. So even if a prompt-injection
  string in a web page survived summarisation into an entry, it is served
  neutralised, not at full trust (pinned by a `SECURITY:` test on
  `formatKnowledgeSearchResults`, plus one asserting refresh entries carry the
  `auto` provenance). Human-authored/accepted `knowledge` stays trusted and
  verbatim — the quarantine is scoped to the `auto` provenance only. The
  zero-token **knowledge shortcut** (which direct-serves a near-exact FAQ match
  to members/guests, bypassing the model) likewise **excludes `auto` entries**
  (`tryKnowledgeShortcut`, pinned by a `SECURITY:` router test), so unreviewed
  content is never served on the trust-maximising path — it only reaches a user
  through the model-mediated, quarantined `knowledge_search`. Prompt-side
  "treat search results as untrusted" is kept as defence-in-depth, the job
  defers to a busy live bot (usage-alert threshold), and it is bounded to
  `KNOWLEDGE_REFRESH_MAX_TURNS` per topic. This does not relax the invariant
  for member/admin-authored knowledge or for candidates — only this narrow,
  labelled, fixed-topic surface publishes without review, and even it is
  quarantined on the way out.
- **Docs ingest** (`DOCS_INGEST_ENABLED`, off by default —
  src/context/docsIngest.ts): backfills Anthropic's official developer docs into
  `knowledge` as RAG chunks (provenance `'docs'`), refreshed ~weekly with a
  content diff. Unlike the `'auto'` web-research refresh, `'docs'` entries are
  treated as **trusted** (served verbatim by `knowledge_search`, shortcut-
  eligible) — a deliberate call, because the source is **one fixed, official,
  first-party HTTPS source** (`DOCS_INGEST_INDEX_URL` → each page's `.md`), not
  arbitrary open-web content, and no model is in the loop (deterministic
  fetch/chunk/embed; the fetch URLs come from Anthropic's own index, never from
  chat/env). The "first-party source" claim is **enforced, not assumed**:
  `parseDocIndex` keeps only `.md` URLs whose origin matches
  `DOCS_INGEST_INDEX_URL` (which must be `https://`), so a stray or compromised
  third-party link in the upstream index is dropped rather than ingested as
  trusted — pinned by a `SECURITY:` test. Removals are fail-safe: pruning keys
  off the **index**, not fetch success — a `'docs'` chunk is removed only when
  its page is no longer listed in the index at all, so a page that transiently
  404s/times out (the index habitually lists some dead URLs) is never deleted.
  Bounds:
  fixed source URL (override-only), `DOCS_INGEST_MAX_PAGES`/
  `DOCS_INGEST_MAX_CHUNKS` caps, polite fetch concurrency, and a redeploy-safe
  ~weekly freshness guard. Provenance safety mirrors the refresh: writes only
  ever touch existing `'docs'` rows or create new ones — a human- (or other-)
  authored entry sharing a title is never overwritten and never pruned (pruning
  of vanished sections is scoped to the `'docs'` provenance, and only runs when
  the fetch mostly succeeded, so a bad fetch can't nuke the corpus). No model-
  facing tool can set the `'docs'` (or `'auto'`) provenance — `save_knowledge`
  always writes the caller's `Tier`. Both invariants are pinned by `SECURITY:`
  tests. If you'd rather be strict, treat `'docs'` like `'auto'` by
  quarantining it in `formatKnowledgeSearchResults` — the flag already flows
  through `searchKnowledge`.
- **Anthropic status check** (`STATUS_CHECK_ENABLED`, off by default —
  src/status/anthropicStatus.ts, issue #206): answers "is this me, or is
  Anthropic having an incident?" from **one fixed, official, first-party
  HTTPS source** — Anthropic's own public Statuspage summary endpoint
  (`STATUS_CHECK_API_URL`, `https://`-enforced at config validation, override-
  only default, never user/chat-supplied). No model is in the fetch/parse
  loop: a background timer polls the endpoint and deterministically parses
  it into a small in-memory cache; the member-tier `check_status` tool
  (`mcp__community__check_status`, no arguments) only ever reads that cache
  — a member's turn never triggers a live fetch, so there is nothing for a
  prompt-injected turn to steer. No new data about members is collected —
  the cache holds only Anthropic's own already-public incident data, with no
  per-user association, so `forget_me`/`purge_user_data` have nothing to
  touch. A fetch failure or a malformed 200 response both degrade to the
  last-known-good cached value (with its age) rather than throwing into a
  member's turn or silently reporting a stale "operational" — pinned by
  `SECURITY:` tests. No new DB table, no migration — the data is already
  public, ephemeral, and re-fetchable.
- **Community-context export** (`docs/COMMUNITY-CONTEXT.md`, issue #53):
  the one place DB-derived content deliberately leaves the database — an
  aggregate rendering of `context_digests` for the research loop. The
  boundary is enforced in `src/context/export.ts` and pinned by `SECURITY:`
  tests: aggregate fields only (topic, counts, summaries, period stamps; no
  raw content, user ids, display names, conversation ids, or interaction
  refs), a configurable k-anonymity floor
  (`CONTEXT_EXPORT_MIN_DISTINCT_USERS`, default 3 — small enough to keep
  signal in a modest community, large enough that no single person's
  activity becomes an identifiable line; sub-floor topics are dropped and
  the drop logged), and a lexical PII scrub (emails, phones, @handles, URL
  query strings) over the model-written summaries. **Honest limits**: the
  scrub is lexical, not semantic — a summary can still be *semantically*
  identifying, the same exposure class as an admin reading a digest; and
  once committed, the export lives in git history permanently (`forget_me`
  shapes future exports, it cannot retract committed ones). Both are
  acceptable **only because this repo is private** — if the repo's
  visibility ever changes, re-evaluate this export before flipping the
  switch. Committing the regenerated file is a deliberate human step; the
  bot never pushes — and the on-server `CONTEXT_EXPORT_PATH` default is an
  **untracked** `var/` file (issue #108), precisely so the unattended
  in-process exporter can never write to the tracked `docs/` path itself
  (which would otherwise dirty the deploy checkout and deadlock the
  nightly redeploy's clean-tree check — see docs/DEPLOYMENT.md).
- **Suggestions** (`suggestions`, issue #46): member-authored improvement
  ideas for the bot. No new data class (members' messages are already
  stored; guests, whose content is never stored in gated mode, have no
  access to the tool), write-only at member tier with a DB-backed 3/24h
  cap, admin-only reads wrapped as untrusted data, purged with the user.
  The pipeline bridge stays human — the bot has **no** GitHub access, so an
  injected "suggestion" can never become a repo issue a build worker acts
  on without an admin consciously filing it.
- **Answer feedback** (`answer_feedback`, issue #118): a member/admin/super
  admin rates the bot's most recent answer to them with `rate_answer(helpful:
  boolean, comment?: string)`. Since issue #355, `comment` carries an
  optional, bounded (≤200 char, control-char-stripped) free-text reason —
  smaller than `report_content`/`suggest_improvement`'s `reason`/`content`
  fields, but no longer the zero-free-text surface #60 originally set as the
  condition for revisiting a rating mechanism; the same admin-only,
  conversation-scoped, `untrusted()`-wrapped read posture those fields
  already have applies here too (`list_answer_feedback`, and since #409,
  the most recent unhelpful-rating comment per entry via
  `list_low_rated_knowledge`). Write-only at member tier, DB-backed rolling-24h cap
  (`RATE_ANSWER_DAILY_LIMIT`, default 20 — higher than
  `report_content`/`suggest_improvement` because a rating carries no
  admin-triage cost per submission), non-destructive so no CONFIRM gate.
  **Caller-scoped interaction resolution**: the rated interaction is resolved
  via `meta->>'replyToUserId' = caller` (same stamp `router.ts` writes on
  every outbound send and `purgeSingleIdentity`/`countRepliesToUser` already
  key on) before falling back to the conversation's most-recent outbound
  reply — this is a deliberate anti-mis-attribution guard: without it, a busy
  multi-member channel could bind one member's "thanks, that helped" to the
  answer the bot just gave a *different* member, corrupting the exact signal
  this feature exists to produce (pinned by a `SECURITY:` test). Admin-only
  read via `list_answer_feedback`, conversation-scoped identically to
  `list_reports` — a rating from a conversation the admin doesn't participate
  in is only reachable by a super admin. The system prompt's guideline is
  deliberately conservative: fire only on a clear, explicit member cue about
  the bot's own last answer, never on general positivity or ambiguous
  chatter, since this signal is model-inferred rather than an explicit
  member request (unlike `report_content`). Purge-coherent:
  `forget_me`/`purge_user_data` delete the rater's own rows; the FK to
  `interactions` is `ON DELETE SET NULL`, so purging the *rated* interaction
  (the recipient's own purge, a different identity than the rater) clears the
  reference rather than deleting the feedback row or leaving a dangling FK —
  the aggregate helpful/unhelpful trend survives. `list_low_rated_knowledge`
  (issue #287) is the grouped, admin-only complement — same admin gate and
  conversation-scope filter, no new stored data, no CONFIRM (read-only). It
  aggregates ratings by `knowledgeEntryId`, so a rating outside the caller's
  scope is excluded from the count entirely, not merely hidden from a
  per-row view (pinned by a `SECURITY:` test); an entry only surfaces once
  its `unhelpfulCount` clears `minUnhelpful` (default 2).
  `KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL` (off by default, issue #337) is
  the member-facing counterpart: once an entry's unhelpful count clears this
  threshold, a served hit gets a fixed, non-interpolated caveat clause
  (`KNOWLEDGE_LOW_RATED_CAVEAT_TEXT`) nudging the member to `rate_answer`
  too — the threshold decision crosses the render boundary as a boolean/id-set
  membership only, never a raw count, so no single rater is inferable. Issue
  #337 rendered this only on the deterministic knowledge-shortcut path; issue
  #432 extends it to the `knowledge_search` path too (the dominant case, since
  the shortcut only fires above a strict 0.9-cosine floor), via a batched,
  same-shape lookup (`areKnowledgeEntriesLowRated`) that fails safe to no
  caveat on a lookup error and renders per-hit rather than as one trailing
  line.
- **Member notes** (`member_notes`, issue #45): admins can attach durable,
  person-scoped context notes to *known* members (unknown identities are
  refused). This is a deliberate, owner-approved PII surface with hard
  boundaries: notes are **human-entered only** (the bot never auto-populates
  one from web search or chat), **admin-read only** via `list_member_notes`
  (never on member/guest turns, never in `knowledge_search` — the table has
  no embedding column — never in memory recall; pinned by `SECURITY:`
  tests), writes/deletes are **audited** (the audit row records that a note
  was added, never its text, so a later purge actually removes the content),
  `delete_member_note` is **CONFIRM-gated** like `delete_knowledge` (the
  confirmation names whose note is being deleted, so an injected turn can
  request but never complete an irreversible deletion), and
  `forget_me`/`purge_user_data` delete all notes **about** the person.
  The owner has explicitly accepted (issue #45) that there is **no
  self-access path** (members cannot read notes about themselves) and that
  admins may manually transcribe web-researched facts into a note — both are
  scope decisions for this small, high-trust community, revisit if it grows.
- **Server roster** (`server_roster`, issue #47; extended to WhatsApp groups
  by issue #407): join/leave events plus a startup backfill persist
  **identity metadata for every guild member (or, for WhatsApp, every group
  participant)** — platform user id, display name (Discord only; Baileys'
  `group-participants.update` carries no push name, so WhatsApp rows have
  none), join/leave timestamps, rejoin count — including non-members and
  lurkers who have never interacted with the bot. It stores **no message
  content** (pinned by a `SECURITY:` test on each platform's handlers, plus a
  structural column check so a content-bearing column can't appear silently).
  On WhatsApp, roster collection is scoped by the same `WHATSAPP_ALLOWED_JIDS`
  gate already used for message intake and the welcome feature (a `SECURITY:`
  test pins that an add/remove for a group outside that scope writes nothing),
  and excludes the bot's own number/LID; it carries no new opt-in flag,
  reasoning that group participant lists are visible to every member of a
  WhatsApp group, the same "not a secret list" posture already applied to
  Discord's roster. A known, documented limitation for multi-group WhatsApp
  deployments: a single `(platform, user_id)` row can't represent per-group
  presence, so a `remove` from one allowed group marks the row "left" even if
  the person remains in another — the same coarseness Discord's single-guild
  model sidesteps by construction. Reads are **admin-tier and guild/group-wide**
  (`list_roster` is not conversation-scoped — same precedent as
  `list_access_requests`), display names are wrapped as untrusted data, and
  `forget_me`/`purge_user_data` delete the person's roster row by
  `(platform, user_id)` regardless of platform. Roster rows are durable (like
  `community_users`) for members still present; departed members'
  (`left_at IS NOT NULL`) rows are age-purged after
  `ROSTER_DEPARTED_RETENTION_DAYS` (issue #136, unset/0 = disabled, floor of
  30 days if set — mirrors `INTERACTION_RETENTION_DAYS`), platform-agnostic
  already.
- **Weekly admin digest** (`admin_digest_sends`, issue #97): a daily timer
  (off unless `ADMIN_DIGEST_ENABLED`) proactively DMs each `community_users`
  admin the same recurring-question-cluster signal `question_digest` already
  computes on demand — no new tool, no new RBAC tier, no message content
  treated as instructions. Recipients come **only** from
  `community_users WHERE role = 'admin'`; super admins are deliberately not
  enrolled (they keep the on-demand, unrestricted-scope `question_digest`
  tool instead, so they're never double-served). Scoping is identical to the
  `question_digest` admin path: `adapter.conversationsForUser(admin.id)` feeds
  `recentQuestionClusters`, so an admin can never receive a cluster sourced
  from a conversation outside their own membership. The DM goes through the
  same `sendDirectMessage` path as every other proactive alert (secret
  redaction applies), snippet count is capped at 5 and each snippet is
  length-bounded (mirrors `question_digest`'s own 300-char slice). A quiet
  week (zero qualifying clusters) sends nothing and leaves the freshness row
  untouched — same "silently re-arm, no noise" convention as the disconnect/
  usage alerts. `admin_digest_sends` stores only `(platform, platform_user_id,
  sent_at)` — no cluster text — and is purge-coherent:
  `forget_me`/`purge_user_data` remove an offboarded admin's row alongside
  other admin-identity-keyed data. The digest has since grown further
  guild-wide, bare-count signals, most recently (issue #357) a
  currently-muted-member count from `countMutedMembers`, which reuses
  `countActiveWarnings`'s exact strike-limit/window definition so the
  digest's "muted" can never disagree with the actual mute trigger in
  `src/moderation/moderator.ts` — the DM text carries only the integer, never
  a `member_warnings.reason`, `excerpt`, user id, or member name. Issue #403
  added a second, complementary sub-count alongside it: `countStaleMutedMembers`
  surfaces members whose unwindowed strike count is still at/over the limit
  but whose windowed count (the one `countMutedMembers` uses) has since fallen
  below it — i.e. someone who was actually muted and then aged out of
  `countMutedMembers`'s own deliberate windowed definition, with no other
  admin-facing signal left anywhere that they're still blocked (mute state
  is never persisted; only `clear_warnings` lifts one — see the auto-moderation
  section above). This count is an **over-approximation, not an exact "is this
  member still muted" signal** — mute state itself is never persisted, so a
  member whose strikes simply accrued too slowly to ever cross the windowed
  limit can also satisfy it despite never having actually been muted. The
  digest hedges accordingly ("N more **may** still be muted... — check
  `moderation_history`") rather than asserting it, is inert (no query) unless
  `MODERATION_STRIKE_WINDOW_DAYS` is configured, and — like the count it
  extends — carries only bare integers, never warning content or an identity.
- **`list_admins`** (super-admin, read-only, no arguments, issue #428):
  answers "who currently holds bot-admin tier?" as a direct query —
  `listAdminRoster()` joins `community_users WHERE role = 'admin'` against
  `server_roster` on `(platform, user_id)`, same display-name precedence as
  `listAdminDisplayNames`. This closes a real visibility gap: leaving the
  Discord server/WhatsApp group only clears roster/membership-scope state
  (`onGuildMemberRemove` → `markRosterLeave`) and never touches
  `community_users.role`, so a departed admin keeps admin-tier tools via DM
  until a super admin explicitly calls `revoke_admin` — and today there is no
  other way to notice that state exists. Each roster line is flagged
  `leftServer: true` only when the matching `server_roster` row has `left_at
  IS NOT NULL`; no matching row or `left_at IS NULL` both read as "not known
  to have left." No CONFIRM, no `admin_audit` row (matches `audit_view`/
  `usage_stats`, the existing read-only super-admin tools) — it mutates
  nothing and takes no arguments, so there is no untrusted-input surface.
  Env-sourced super admins are never `community_users` rows and so never
  appear in the output, same exclusion as `listAdmins`/`listAdminDisplayNames`;
  the reply says so explicitly so the list isn't mistaken for "everyone with
  elevated access." Auto-revoke on departure is deliberately out of scope —
  visibility first, matching how `grant_admin`/`revoke_admin` keep privilege
  changes human-decided rather than automatic.
- **Standing response-style preference** (`response_style_prefs`, issue
  #126): a member/guest-tier tool, `set_response_style`, lets any caller opt
  into plain-language replies without re-asking every message. The argument
  is a closed two-value enum (`standard`/`plain`) — no free text, smaller
  surface than `report_content`/`suggest_improvement`. Non-destructive and
  instantly reversible by calling it again, so it is deliberately **not**
  CONFIRM-gated. Keyed on raw `(platform, user_id)` like
  `admin_digest_sends` (not `community_users`), so it works for a guest in
  open mode too. No row means today's default (`'standard'`) behaviour —
  zero change for anyone who never calls the tool. Purge-coherent:
  `forget_me`/`purge_user_data` delete the caller's row. Extended (issue
  #430) to the eleven deterministic, non-model fallback/notice constants in
  `router.ts`/`core.ts`/`upstreamFailure.ts` that already honour a standing
  `'mi'` `language_preference` (see below) — each gains a fixed,
  human-authored `_PLAIN` counterpart, selected by the same fail-safe
  `getResponseStyle` read (degrading to `'standard'` on a lookup failure,
  never throwing or dropping the reply). **`'mi'` always takes precedence
  over `'plain'`** when a caller has both set, so this can never regress the
  already-tested `_MI` behaviour; `PENDING_NOTICE_PLAIN` keeps the literal,
  untranslated `CONFIRM`/`CANCEL` tokens byte-identical to the English/`_MI`
  templates, same invariant as `PENDING_NOTICE_MI`.
- **Standing language preference** (`language_prefs`, issue #189):
  structurally identical to `response_style_prefs` above — a member/guest-tier
  tool, `set_language_preference`, lets any caller opt into always receiving
  replies in NZ English or te reo Māori regardless of what language their own
  messages are written in, instead of relying on the existing per-message
  mirroring (issue #68). The argument is a closed three-value enum
  (`auto`/`en`/`mi`) — no free text, so no untrusted string is ever
  interpolated into the system prompt (the same reason `set_response_style`
  uses a closed enum). Non-destructive and instantly reversible by calling it
  again, so it is deliberately **not** CONFIRM-gated. Keyed on raw
  `(platform, user_id)` like `response_style_prefs`, so it works for a guest
  in open mode too. No row (or `'auto'`) means today's default per-message
  mirroring behaviour — zero change for anyone who never calls the tool. The
  `mi` instruction block does not relax the charter's existing te reo Māori
  caution: it explicitly re-states keeping replies simple/short, preserving
  macrons and diacritics, keeping Claude/API terms/product names/code in
  English, and falling back to NZ English for content the model cannot
  render confidently and accurately in te reo Māori — preventing a standing
  preference from forcing a low-quality translation of technical content.
  Purge-coherent: `forget_me`/`purge_user_data` delete the caller's row.
  Welcome-message bilingual support was originally scoped **out** of #266
  (no stored preference is knowable at genuinely first contact) — that
  premise is false for a *rejoining* Discord member, since leaving only
  clears `server_roster`, never `language_prefs`, so a standing `mi`
  preference survives a leave/rejoin cycle. Issue #282 closes that one case:
  `DiscordAdapter.onGuildMemberAdd` looks up the rejoining member's standing
  preference and serves the admin-configured `welcome_message_mi` variant
  (same `_mi`-key pattern as `community_guidelines_mi`) if one is set,
  falling back to the default-language welcome unchanged otherwise. WhatsApp
  Cloud's first-contact welcome and Baileys' group welcome remain out of
  scope: Cloud's welcome fires on a number's genuinely first-ever message
  (no prior interaction, so no preference row can exist), and Baileys posts
  one welcome per join batch to the whole group, not per individual member,
  so there is no single caller to key a lookup off.
- **Auto-moderation** (`DISCORD_MODERATION_ENABLED`, `member_warnings`, off by
  default): when enabled, the Discord adapter scans **every** in-scope guild
  message for bad language / abuse — a privacy-posture change of the same class
  as ambient archiving, so it needs a community notice before you flip it on.
  Controls and honest limits:
  - **Storage is minimal**: a flagged message records a `member_warnings` row
    with the reason and a **capped excerpt** (≤200 chars) — never the whole
    message. Keyed on raw `(platform, user_id)`; purge-coherent
    (`forget_me`/`purge_user_data` delete it, pinned by a `SECURITY:` test).
  - **Admins/super admins are exempt** — never warned or muted (same role
    resolution the router uses; pinned by a `SECURITY:` test), and a member is
    muted **only** at the strike limit, never before (pinned by a `SECURITY:`
    test).
  - **Enforcement needs privilege**: the muted role and the auto-created
    `mod-alerts` channel require the bot to hold **Manage Roles** + **Manage
    Channels** — a real expansion of the bot's blast radius. The bot only ever
    creates/assigns the one configured muted role and the one alerts channel,
    but a compromised bot token with these permissions can do more than one
    without them; grant them deliberately.
  - **Enforcement narrows three former gaps, but stays best-effort, not
    airtight**: a new text/forum channel or category now gets the
    deny-SendMessages overwrite the moment it's created (a `ChannelCreate`
    listener), a member who leaves and rejoins while still at/above the
    strike limit is automatically re-muted (with an admin alert) before any
    welcome-message logic runs, and a permission-overwrite call that fails
    (e.g. a transient Discord API error) is now retried up to 3 attempts
    total with a short fixed delay before being given up on — all three
    closing bypasses/gaps this document used to call out by name (pinned by
    `SECURITY:` tests). If a channel still exhausts every retry, super admins
    get a single debounced DM (15-minute window, mirroring the daily-budget
    check-failure alert) naming the affected channel(s), so the residual
    window is visible rather than silent-logged-only; a scan/handling with no
    failures sends nothing. This is no longer silent, but it's still not a
    hard guarantee: retries are bounded, not indefinite, so a sustained
    Discord API outage can still leave a channel unprotected until the next
    mute or restart re-scans it — treat the muted role as a strong deterrent,
    not a hard containment boundary.
  - **Stage 2 (LLM abuse) is opt-in** (`MODERATION_LLM_ABUSE_ENABLED`, off):
    only wordlist-clean messages escalate, one Claude call each on the shared
    Max pool — deliberately gated so it can't silently run up cost/scan volume.
  - `clear_warnings` (admin tier, pinned by a `SECURITY:` RBAC test) clears a
    member's active warnings and lifts the mute; it's lenient/reversible so it
    isn't CONFIRM-gated, and any admin may clear anyone's.
  - **Strike accumulation is unbounded by default, and that's now a documented
    choice, not an oversight**: `MODERATION_STRIKE_WINDOW_DAYS` (optional, unset
    by default) lets an admin opt into a rolling window so only strikes newer
    than it count toward `MODERATION_STRIKE_LIMIT` — an isolated year-old strike
    no longer counts the same as one from an hour ago. It never deletes or
    mutates `member_warnings` rows (the audit trail is untouched) and never
    auto-unmutes an already-muted member — lifting a mute still requires an
    explicit `clear_warnings` (pinned by a `SECURITY:` test). The leave/rejoin
    re-mute check deliberately **ignores** the window: on rejoin, every
    uncleared strike counts regardless of age, so leaving the server and
    waiting out the window is not an unmute path and the rejoin bypass this
    section documents as closed stays closed (pinned by a `SECURITY:` test).
- Provide a deletion path: delete rows from `interactions` (and `knowledge`)
  by `user_id` on request (`forget_me` / `purge_user_data`). If the requester's
  identity has been linked (`link_member`) to another platform identity as the
  same person, the deletion cascades to that identity too — see "Cross-platform
  identity linking" below.
- **Retention policy**: set `INTERACTION_RETENTION_DAYS` to age-purge raw
  `interactions` (default unset = disabled, no behaviour change on upgrade).
  A daily in-process timer (`src/index.ts`) deletes rows older than the
  configured window and logs the count purged. Must be `0` or **at least 7
  days** (enforced at startup) so a low value can't silently gut memory
  recall for users still mid-conversation. `knowledge` (curated, durable
  facts), `admin_audit` (accountability trail), and `sessions` (governed by
  `SESSION_MAX_TURNS`/`_AGE_HOURS`) are never touched by this purge.
- **Roster retention policy**: set `ROSTER_DEPARTED_RETENTION_DAYS` to
  age-purge `server_roster` rows for departed members (default unset =
  disabled, no behaviour change on upgrade). A daily in-process timer
  (`src/index.ts`), independent of the interactions purge above, deletes
  `left_at IS NOT NULL` rows older than the configured window and logs the
  count purged. Must be `0` or **at least 30 days** (enforced at startup).
  Currently-present rows (`left_at IS NULL`) are never touched.

### 7. Cross-platform identity linking (`link_member` / `unlink_member`)
A member's Discord account and WhatsApp number are, by default, two unrelated
`community_users` rows — `forget_me` on one silently leaves the other's data
in place, and the daily reply budget (`DAILY_REPLY_LIMIT_PER_USER`) can be
double-dipped by switching platforms. `link_member` closes this gap by
grouping identities under a shared `persons.id` (`community_users.person_id`).

**Controls**
- Admin-tier, CONFIRM-gated (both `link_member` and `unlink_member`), audited
  to `admin_audit`, and super-admin-alerted — the same treatment as every
  other privileged tool.
- **Cross-platform authority**: an admin must have at least one identity on
  their own platform. Linking two identities that are *both* on another
  platform — or unlinking a foreign identity with no on-platform co-member —
  requires super_admin, consistent with the cross-platform gate on
  `add_member` / `remove_member`. This stops a Discord-only admin from
  operating solely on WhatsApp identities (and vice versa).
- **Target validation**: both identities must already be known community
  members; linking can never grant membership, only associate two identities
  that already have it.
- **NEVER propagates tier**: linking never touches `role`. A member linked to
  an admin still resolves as member-only — tier stays strictly per-platform-
  row, which kills the obvious link-to-an-admin escalation vector. Covered by
  a `SECURITY:` test in `tests/repository.test.ts`.
- **Unlinking is total, not partial**: dropping below two linked identities
  dissolves the whole group (every remaining member's `person_id` cleared,
  the `persons` row deleted) rather than leaving a dangling one-member group
  for a future link to reattach to unexpectedly.

**Deliberate blast-radius expansion (accepted, tested)**: linking two
identities means `forget_me` — a member-tier, self-scoped tool with no
CONFIRM gate of its own — now erases stored data for **both** linked
identities, not just the caller's. This is the intended
effect (a coherent "delete everything about me" for the linked person), but it
does mean an admin who links a victim's account to a throwaway/controlled
identity gives that throwaway the power to erase the victim's data via
`forget_me`. The mitigation is that the *link* itself — not the eventual
purge — is the gated, visible, reversible step: CONFIRM + `admin_audit` +
super-admin DM alert. See the `SECURITY:` cascade test in
`tests/repository.test.ts` for the asserted behaviour.

### 8. Image generation via the host Grok CLI (`generate_image`)
Off by default (`IMAGE_GEN_ENABLED=false`). When enabled, the admin/super-admin
`generate_image` tool shells out to the host's **Grok Build CLI** (`grok`),
signed in with a SuperGrok subscription (device-code login, no API key). Unlike
every other tool, this one spawns a **third-party agentic CLI** as the service
user, so it gets its own controls:

- **Kernel-sandboxed, so it can only produce an image.** Image generation is
  grok's `/imagine` skill (built-in `image_gen` tool); the tool is not
  `--tools`-selectable, so the old `--tools GenerateImage` allowlist can't be
  used (it referenced a since-removed tool and broke agent build), and grok's
  **read tools are auto-approved**, so an injected `/imagine` description could
  otherwise read arbitrary service-user files (`.env`, etc.). The lockdown is a
  custom **bubblewrap deny sandbox** plus two supporting controls, all
  host-verified:
  - **`--sandbox imagegen`** — a custom profile the bot writes to
    `~/.grok/sandbox.toml` (via `ensureSandboxReady()`), whose **`deny` list is
    kernel-enforced by bubblewrap** (read *and* write/rename, and it closes the
    `mv secret x && cat x` bypass). It denies the bot's on-disk secrets — its
    `.env` and WhatsApp auth dir (paths derived from the bot's own cwd/config) —
    and sets `restrict_network = true` to block child-process network. Crucially
    grok **refuses to start** if bubblewrap is missing or a deny path can't be
    bound, so it **fails closed**. Verified on the host: a read of `.env` under
    this profile is kernel-denied (a `read_file` tool error) with no secret
    escaping, while `/imagine` still generates. *(The built-in `strict`
    profile's own landlock read-restriction does **not** actually block reads on
    the host — reads succeed everywhere under it — which is why we use the
    bubblewrap `deny` list, not `strict` alone. **Requires `bubblewrap` on the
    host** — see docs/DEPLOYMENT.md.)*
  - **No `--always-approve`** — headless grok then *cancels* approval-gated
    tool calls (shell, file write) instead of running them (verified: a prompt
    ordering the shell to write a file returned stopReason *"Cancelled"*). A
    `--tools` allowlist can't help (image tool not selectable) and a
    `--deny <name>` fails *open* if the name doesn't match grok's internal tool
    id — which is why the control is the kernel deny-sandbox, not a tool filter.
  - **`--disable-web-search`** removes the web tools. And a **per-process
    self-check** (`ensureSandboxReady()`) runs before the first generation: it
    plants a token in a **deny-listed** path and confirms a sandboxed grok
    cannot read it back, **failing closed** (image gen disabled for the process)
    if the kernel deny ever stops enforcing — so a silent grok regression can't
    quietly reopen arbitrary-file-read.
- **No secret inheritance.** The `grok` subprocess is spawned with a **minimal,
  explicit `env`** (`grokEnv()` in `src/media/grokImage.ts`): `PATH`, `HOME`,
  `TERM`, `LANG`/`LC_ALL`, `USER`, and any `GROK_*`/`XDG_*` knobs — **never** the
  bot's `process.env`. It therefore never sees `CLAUDE_CODE_OAUTH_TOKEN`,
  `DISCORD_BOT_TOKEN`, `DATABASE_URL`, or the WhatsApp/session secrets. grok
  authenticates from `$HOME/.grok/auth.json` (a file, not an env var), so the
  scoped env is sufficient — proven on the host with `env -i`. This keeps the
  Asset-#2 "secret exposure" boundary intact for the one tool that runs foreign
  code.
- **No shell string.** The prompt is passed as an argv element to `spawn`
  (never interpolated into a shell command), so there is no shell-injection
  surface even though the tool takes admin free text.
- **Output is read back, not written to a path we name.** Because the file
  tools are denied, grok can't copy the image anywhere we choose; `image_gen`
  saves it under its own session storage and we read it back by the session id
  from `--output-format json`, then delete the session directory. The bytes are
  **magic-byte sniffed** (`sniffImageType`) — the real format is trusted from
  the content, never a filename/extension.
- **RBAC + abuse caps.** Admin/super-admin only (`ADMIN_TOOLS`,
  `assertAtLeast('admin')`, with a `SECURITY:` test in `tests/rbac.test.ts`),
  one generation in flight per user, and a per-user **daily cap**
  (`IMAGE_GEN_DAILY_LIMIT`, default 25; 0 = unlimited). A hard timeout
  (`IMAGE_GEN_TIMEOUT_MS`) bounds a single run.

**Residual / operational.** `GROK_BIN` selects the binary; set it to an
**absolute path** on a live deploy so a writable directory earlier in `PATH`
can't hijack it (see docs/DEPLOYMENT.md). The device-code login is a person's
SuperGrok subscription — treat `~/.grok/auth.json` as a credential (it's outside
the repo, on the host). Generated images are unfiltered model output posted into
the community under an admin's name; the admin who invokes it owns that.
`generate_image` posts via `PlatformAdapter.sendImage`, which is now
implemented on all three adapters — Discord, Baileys WhatsApp, and (issue
#356) the Cloud API WhatsApp adapter. On Cloud, delivery is two Graph API
calls (media upload, then a message referencing it) over the same
authenticated `graph.facebook.com` connection `sendChunk` already uses — no
new egress destination — gated by the same 24h customer-service window, with
the caption run through `filterOutbound` before either call.

### 9. Emoji reactions (`react_to_message`, issue #231)
Member-tier, but low-consequence and tightly bounded — the tool can only ever
put one of a fixed set of emoji onto a message using the bot's own identity,
never send text or take a moderation action:

- **Closed positive/neutral allowlist.** Exactly `✅ 👍 👀 🎉`
  (`ALLOWED_REACTION_EMOJI` in `src/agent/tools.ts`) enforced by the zod
  schema — no other value, including a custom/Nitro emoji string, ever reaches
  the Discord API. Deliberately excludes anything that could read as the bot
  editorialising against a member (no 👎). Pinned by a `SECURITY:` test.
- **Target validation**, same "the bot must have actually seen it" discipline
  as `moderate`/`announce`: the message id must exist in `interactions` for
  the caller's own `(platform, conversationId)` (`isKnownMessage`). A member
  can only react within their own current conversation — there is no separate
  `conversationId` argument to redirect the reaction elsewhere.
- **In-memory per-user daily cap** (`REACTION_RATE_LIMIT_PER_DAY`, 20),
  same shape as `generate_image`'s `imageGenDaily` map — acceptable here
  (unlike `report_content`'s DB-backed, restart-proof cap) because a reaction
  is far lower-consequence than either a report row or a `grok` subprocess
  spawn, and it needs no migration.
- **Discord-only.** `PlatformAdapter.reactToMessage` is optional, mirroring
  `sendImage`; WhatsApp adapters simply don't implement it, so the tool
  degrades to a plain "not available on whatsapp" reply rather than throwing.
- **Wired to a concrete use, not just free-floating.** A successful
  `report_content` filing best-effort-reacts 👀 on the reported message
  (`ackReportedMessage`) when the platform supports it and the message is
  known — deterministic, not model-invoked, and never surfaces an error to
  the reporter (the report itself already succeeded either way).

### 10. Cosmetic community roles (`assign_community_role` / `remove_community_role`, issue #232)
Assignable, purely cosmetic Discord roles ("verified builder", regional tags,
interest groups) — deliberately **orthogonal** to the bot's own RBAC tiers
(super_admin/admin/member/guest), which come from env + `community_users`
only and never consult Discord roles at all (`resolveRole`,
`src/auth/roles.ts`). Off by default: `DISCORD_ASSIGNABLE_ROLES` unset means
both tools refuse every `roleId`.

**The real threat here is Discord's own permission model, not the bot's
RBAC** — a role handed out by the bot could carry a Discord permission bit
(Administrator, Manage Roles, Manage Channels, …) and grant real server
power, independent of anything `resolveRole` does. Controls:
- **Human-curated allowlist**: `DISCORD_ASSIGNABLE_ROLES` (comma-separated
  Discord role ids) is the only set of roles either tool will ever touch.
- **Assign-time zero-permission re-validation — the load-bearing control,
  not the allowlist alone.** A role's permission bitfield is mutable *after*
  it's added to the allowlist (TOCTOU), so `DiscordAdapter.performAdminAction`
  fetches the role **live** (`force: true`, bypassing the gateway cache) and
  refuses to assign it if its permission bitfield is non-zero, even though
  its id is on the allowlist (pinned by a `SECURITY:` test). Removal doesn't
  need this check (it can't escalate anything) but still enforces the same
  allowlist, so the tool stays scoped to cosmetic roles only.
- **RBAC-orthogonality (secondary guard, pinned by test)**: granting or
  removing a cosmetic role never touches `community_users.role` — these
  tools never call `upsertMember`/`demoteAdmin` or anything else that feeds
  `resolveRole`. The primary guarantee is the assign-time check above, not
  this one — a role that never gained a permission bit was never a `resolveRole`
  threat in the first place.
- **Admin-tier + CONFIRM + audited + super-admin-alerted**, same treatment as
  `link_member`/`grant_admin`; target must already be a known community
  member (`getMemberRole` non-null) — an unknown id is refused.
- `list_assignable_roles` (read-only, admin-tier) shows each allowlisted
  role's current name and flags one that currently carries permissions, so
  an admin can see (and fix) drift before it ever blocks an assignment.
- **Discord-only**: WhatsApp has no roles; the WhatsApp adapters simply don't
  advertise `assign_community_role`/`remove_community_role` in
  `adminCapabilities`, so the tools reply with an unsupported-platform
  message rather than erroring.

**Role-hierarchy requirement (operational, fail-safe)**: the bot's own
managed Discord role must sit **above** every role listed in
`DISCORD_ASSIGNABLE_ROLES` in the guild's role list, or Discord itself will
reject the assignment (a bot can never grant/remove a role positioned above
its own highest role) — see docs/DEPLOYMENT.md. This is fail-safe (the
assignment just fails, loudly), not a silent gap. Every role you list in
`DISCORD_ASSIGNABLE_ROLES` must be **pre-created and permission-less**
(`@everyone`-level permissions) — the allowlist assumes this at curation
time; the assign-time check above is what catches it if that ever stops
being true.

### 11. Discord thread management (`create_thread` / `archive_thread`, issue #229)
A Discord-only tool pair splitting a longer discussion out of the main
channel flow. `create_thread` is additive (same rate-capped-instead-of-
CONFIRM-gated treatment as `create_poll`); `archive_thread` hides an active
discussion, so it's CONFIRM-gated like `moderate`.

**The real risk here is a bot-manufactured moderation blind spot, not the
tools' own RBAC.** Thread messages are moderation-scanned under their
**parent** channel's allowlist membership — `DiscordAdapter.scopeChannelId`
resolves a thread's `channelId` to its parent for the scan gate in
`onDiscordMessage` (pinned by `tests/discordThreadArchive.test.ts`, issue
#48). Before this feature, that only mattered for threads a human created;
`create_thread` lets the bot spin up new spaces, so a thread opened under a
non-allowlisted parent would be unmoderated by construction. Controls:
- **Defensive self-refuse (the load-bearing control)**: `create_thread`
  refuses outright when `DISCORD_MODERATION_ENABLED` is set and
  `DISCORD_ALLOWED_CHANNEL_IDS` is non-empty and doesn't include the target
  parent channel — a code guard, not just documentation, so the tool can
  never open an unmoderated space even if the scan-side fix ever regresses
  (pinned by a `SECURITY:` test in `tests/createThreadModerationGuard.test.ts`,
  its own file/process since it needs a fixed `DISCORD_ALLOWED_CHANNEL_IDS`
  at `config.ts` import time).
- **Admin-tier + target validation**, same "the bot must have actually seen
  it" discipline as `moderate`/`announce`/`create_poll`: the parent channel
  (`create_thread`) or the thread itself (`archive_thread`) must be a
  conversation the caller is scoped to and the bot has already seen
  (`isKnownConversation`); an optional `seedMessageId` must be a message the
  bot has seen in that channel (`isKnownMessage`).
- **In-memory per-channel rate cap** (`THREAD_CREATE_RATE_LIMIT_PER_HOUR`, 5),
  same sliding-window shape as `create_poll`'s own cap.
- **`archive_thread` is CONFIRM-gated** (it hides other members' active
  discussion, the same consequence class as `delete_message`/`kick_user`);
  `create_thread` carries no such gate since opening a thread is additive and
  reversible (an admin can just archive it).
- **Discord-only**: `PlatformAdapter.adminCapabilities` on both WhatsApp
  adapters simply omits `create_thread`/`archive_thread`, so the tools reply
  with an unsupported-platform message rather than erroring.
- **Only text/announcement channels**: forum/media channels use a different,
  tag-based thread-creation API this tool doesn't support; `create_thread`
  throws rather than guessing at forum tags.
### 11. Scheduled events (`create_event`, issue #230)
Creates a real Discord `GuildScheduledEvent` (RSVP + reminders in the
server's Events tab) instead of a text announcement. Outward-facing *and*
member-notifying — a genuinely higher floor than `announce`/`create_poll` —
so it is:
- **Admin-tier + CONFIRM-gated + audited**, same treatment as
  `assign_community_role`/`grant_admin`. The CONFIRM text quotes every
  salient mutated field — the **resolved** name, ISO start time, location,
  and a truncated (80-char) description preview — verbatim, so the human
  confirms the actual artifact rather than model-composed prose — mitigating
  the main injection risk (a bogus/spam event, or a spoofed
  location/description, from a manipulated admin turn).
- **Strict input parsing**: `startTime`/`endTime` must be a concrete,
  resolved ISO 8601 instant with an explicit UTC offset or `Z` — relative or
  ambiguous text (e.g. "next Tuesday 7pm") is rejected at the zod schema
  boundary, not trusted. `startTime` must be in the future and `endTime` (if
  given) after `startTime`, checked before a pending action is ever
  registered. The model is expected to resolve relative phrases itself
  against the NZ date already grounded in the system prompt
  (`Pacific/Auckland`, `systemPrompt.ts`).
- **Location is either an external string or a validated, currently-visible
  channel** in this guild: `DiscordAdapter.performAdminAction` tries to
  resolve `location` as a real voice/stage channel live via the Discord
  client first (channel-hosted event, `endTime` optional); anything else —
  not found, a channel from a different guild, or a non-voice channel — falls
  back to treating the string as an external/physical location, which
  Discord requires an explicit `endTime` for and refuses cleanly otherwise.
- Name/description/location text pass through the same `filterOutbound`
  (secret redaction) as every other outward Discord send, applied at the
  adapter's send boundary.
- **Discord-only**: the WhatsApp adapters simply don't advertise
  `create_event` in `adminCapabilities` (WhatsApp has no scheduled-event
  primitive), so the tool replies with an unsupported-platform message.
- **New Discord permission — Manage Events**: creating a `GuildScheduledEvent`
  requires the bot's role to hold **Manage Events**, a real (if small) blast-
  radius expansion of the bot token, in the same class as the Manage
  Roles/Manage Channels grants auto-moderation needs. It is
  operator-granted, least-privilege, and feature-gated: a single atomic API
  call either creates the whole event or throws before creating anything, so
  a missing grant fails clean rather than half-creating an event. Granted as
  part of the base bot invite — see the Discord platform notes below and
  docs/DEPLOYMENT.md step 7 ("Invite the Discord bot").
- **`cancel_event`** (issue #424) is `create_event`'s destroy-adjacent
  counterpart, the same pattern `create_poll`/`end_poll` and
  `create_thread`/`archive_thread` already established: admin-tier +
  CONFIRM-gated + audited + super-admin-alerted, marking a `Scheduled` event
  `Canceled` (Discord's own UI convention — stays visible, RSVP history
  intact) rather than deleting it. Its one new input, `eventId`, is
  validated **live against `guild.scheduledEvents`** — the same "the bot must
  be able to verify what it's acting on" discipline `isKnownConversation`/
  `isKnownMessage` apply to DB-tracked targets, just sourced from Discord's
  API since scheduled events aren't stored in `interactions` — so an unknown
  or foreign-guild `eventId` is refused before any pending action is ever
  registered. Only a `Scheduled` event may transition; `Active`/`Completed`/
  already-`Canceled` are refused with a specific reason rather than attempting
  an invalid Discord status transition (re-checked again at execute time,
  since the CONFIRM's 60s TTL leaves a window for the event's state to
  change). Same **Manage Events** grant as `create_event` — no new permission.
  Discord-only, same unsupported-platform message as every sibling tool.
  `list_events`' formatted output includes each event's `id` specifically so
  there is a conversational path to a valid `eventId` — without it,
  `cancel_event` would only ever be reachable by an admin manually copying a
  snowflake out of Discord's own UI, which would defeat the tool's purpose.

### 12. GitHub issue filing (`suggest_issue`, opt-in)

`suggest_issue` lets a **super admin** file an issue on the repo from chat. It is
the bot's **only outward write capability and only GitHub credential**, so it is
deliberately narrow:

- **Least-privilege token.** `GITHUB_ISSUE_TOKEN` must be a **fine-grained PAT
  scoped to `Issues: write` on `GITHUB_ISSUE_REPO` only** (or a GitHub App with
  the same single permission) — never the `CLAUDE_CODE_OAUTH_TOKEN`. A bot
  compromise is then bounded to filing/creating issues on one repo; it cannot
  push code, merge, or read anything else. Startup fails fast if the feature is
  enabled without a token.
- **Super-admin only, CONFIRM-gated.** Members/admins can't reach it (`rbac.ts`
  + an in-handler `assertAtLeast` re-check), and it creates nothing until an
  out-of-band CONFIRM — so an injected turn can't silently file issues.
- **Secret scrub.** The title and body are run through the same
  `redactSecrets` filter as outbound messages before the API call, so a key
  pasted into chat can't be laundered into a (world-readable) issue.
- **Rate-capped + audited.** A per-super-admin daily cap bounds runaway/spam;
  every filing writes an `admin_audit` row and alerts the other super admins.
- **New egress.** Adds `api.github.com` to the bot's outbound surface — the
  first non-Anthropic/Discord/WhatsApp destination; noted with the residual-risk
  egress item below. Off by default (`GITHUB_ISSUE_ENABLED`).

### 13. WhatsApp voice-note transcription (super-admin only, opt-in)

When `WHATSAPP_VOICE_ENABLED=true`, a **super admin's** WhatsApp voice note is
transcribed to text locally and then flows through the *identical* pipeline as a
typed message — RBAC, tool gating, and CONFIRM are untouched. The controls:

- **Super-admin gate before any download.** The gate
  (`maybeTranscribeVoiceNote`) checks `isSuperAdmin('whatsapp', senderId)` — a
  pure env check against `SUPER_ADMIN_WHATSAPP_NUMBERS`, never the DB — *before*
  fetching the media. A non-super-admin's audio is never downloaded, never
  transcribed, and dropped exactly like any unhandled message type. Identity is
  the platform envelope (phone JID / resolved LID), never the audio content, so
  it can't be spoofed by what's said. Pinned by three `SECURITY:` tests.
- **Off by default.** With the flag unset, even a super admin's voice note is
  dropped (pinned) — enabling is a deliberate operator action.
- **Local transcription, no new egress or key.** Uses transformers.js Whisper —
  the same "download the model once, run locally, no external API, no extra key"
  pattern as text embeddings. Audio never leaves the host; the
  subscription-only auth posture and egress surface are unchanged. (Requires
  `ffmpeg` on the host to decode Opus → PCM.)
- **Bounded cost.** Notes longer than `WHATSAPP_VOICE_MAX_SECONDS` (default 120)
  are ignored without downloading. Any decode/model failure is swallowed and the
  note dropped — never surfaced or crash-inducing.
- **No new authority.** Transcription only *populates the message text*; it
  grants nothing. A mis-heard destructive command still can't fire without the
  (spoken or typed) CONFIRM the tool layer already demands, and the transcript
  is subject to the same super-admin tool set it always was.
- **Group scope.** Voice notes can't carry an @-mention, so in groups only a
  voice note that *replies to the bot* is addressed (its `contextInfo` is read
  from the audio payload); DMs to the bot are always addressed. This does not
  widen who can trigger the bot — the super-admin gate still applies.

## Platform-specific notes

### WhatsApp / Baileys ToS risk
Baileys uses the unofficial WhatsApp Web protocol. This **violates WhatsApp's
Terms of Service** and the number can be **banned** at any time, and the
protocol can break. Mitigations: use a dedicated number you can afford to lose,
keep volume human-like, or switch to `WhatsAppCloudAdapter`
(`WHATSAPP_PROVIDER=cloud`), the official, ToS-compliant Meta Cloud API — see
"Switching WhatsApp providers" in `docs/ARCHITECTURE.md`. Running Baileys is a
deliberate, accepted trade-off for immediate, free operation; revisit it
before scaling.

Enabling `WHATSAPP_WELCOME_ENABLED` adds an **unprompted, event-triggered
automated group post** (a static message on `group-participants.update`) to
this unofficial path — not a risk-free feature. It never DMs the joiner
(the higher-risk pattern), it's operator-gated (off by default), and it's
cooldown-bounded (`WHATSAPP_WELCOME_COOLDOWN_MINUTES`) so it can't fire on
every join in an active group — but it is still a new automation pattern the
account posts without being addressed first, which is exactly the kind of
bot-fingerprint the ToS-risk mitigations above are trying to minimise.

`WHATSAPP_ARCHIVE_GROUP_JIDS` (issue #103), by contrast, adds **no new send
behaviour at all**: archiving is receive-side only. The linked account
already receives every message in a group it's a member of — that's how
addressed-detection has always worked — so recording it changes nothing
about what the account does on the wire. Subscribing to revoke/edit
`protocolMessage`s for delete/edit-honouring is likewise passive receipt, not
a new automation fingerprint. The ToS-risk mitigations above are about
*outbound* patterns; this feature has none.

### WhatsApp Cloud API webhook
`WhatsAppCloudAdapter` exposes a public HTTP listener
(`WHATSAPP_CLOUD_WEBHOOK_PORT`) that must sit behind TLS termination (see
`docs/DEPLOYMENT.md`). Every inbound `POST` is rejected unless its
`X-Hub-Signature-256` header verifies against `WHATSAPP_CLOUD_APP_SECRET`
(HMAC-SHA256 over the raw body, timing-safe compare) — the body is never
parsed before that check passes. `WHATSAPP_CLOUD_ACCESS_TOKEN` and
`WHATSAPP_CLOUD_APP_SECRET` are secrets and must go through the same
`.env`-only, git-ignored handling as other tokens. Message content and
delivery metadata for Cloud API traffic are additionally retained by Meta
per their own terms, on top of this project's own storage.

### `/healthz` endpoint
Opt-in (`HEALTH_PORT` unset = no listening port at all — matches this
pipeline's "new surface is opt-in" pattern). Unauthenticated by design, but
the response is boolean connectivity flags only (`{status, db, adapters}`) —
no message content, no user identifiers, no internal ids. Bind to localhost
and put a reverse proxy in front if exposing it externally, same guidance as
the Cloud API webhook port above. The sustained-disconnect super-admin DM
alert reuses the existing adapter `sendDirectMessage` path — no new
privileged tool, no RBAC surface.

### Discord
- Enable only the gateway intents the bot needs (Guilds, GuildMessages,
  MessageContent, GuildMembers, DirectMessages). **Both `MessageContent` and
  `GuildMembers` are privileged intents — enable them in the Developer Portal
  or the bot will fail to log in.**
- Give the bot the least role permissions required for moderation (Timeout
  Members, Kick Members, **Ban Members** — required for the admin `ban_user`
  action; without it, `ban_user` fails cleanly as `Failed: …` rather than
  silently no-oping — Manage Messages) plus Manage Events (required for the
  admin `create_event` tool, §11), and place its role appropriately in the
  hierarchy.

## Subscription-auth caveat
Anthropic's Agent SDK docs state subscription/claude.ai login is **not
officially supported** for SDK-built products and recommend an API key. As of
June 2026, headless SDK usage on Pro/Max additionally draws from a **separate
weekly token pool** (rate-limited differently from interactive use), and the
consumer terms language against using consumer OAuth tokens in
third-party/automated services has tightened. Using your own subscription for
your own community bot remains a personal decision and a grey area. The auth
layer is isolated in `src/agent/auth.ts`; switch to an API key by setting
`ANTHROPIC_API_KEY` and removing the deletion in that file if you ever need
the supported path.

An operator wanting more headroom in this shared weekly pool during a busy
period can set `AGENT_MODEL_MEMBER` (issue #382) to run a lighter model for
member/guest turns — the highest-volume tier per §3's `AGENT_MAX_TURNS_MEMBER`
tiering — while admin/super_admin keep `AGENT_MODEL`. Unset (default):
byte-identical, every role uses `AGENT_MODEL`. Model choice is not a security
boundary here — it never affects the role-derived tool surface (§3, §RBAC).

The same lever extends (issue #394) to the two background, non-conversational
classifier `query()` calls that have no caller role at all:
`classifyAbuseWithLlm` (moderation Stage 2, opt-in) and `summarizeCluster`
(the weekly context builder). Setting `AGENT_MODEL_CLASSIFIER` runs both on a
lighter model; unset (default) both keep using `AGENT_MODEL`, byte-identical.
Same posture as `AGENT_MODEL_MEMBER`: cosmetic to cost, never affects either
call site's `tools`/`allowedTools`/`disallowedTools`/`maxTurns` (both are
already tool-less, single-turn, and fixed-format). A missed abuse
classification degrades to "clean" — the same failure mode as the opt-in
Stage-2 check being off — so this is an accuracy/cost tradeoff the operator
who sets the knob explicitly owns, not a bypass of any tier-derived tool,
CONFIRM gate, redaction, or scoped-access boundary. `researchTopic`
(`src/context/knowledgeRefresh.ts`) is deliberately untouched — it's
multi-turn, uses `WebSearch`, and writes free-text content to the knowledge
base, unlike the other two's fixed-format extraction.

## Residual risks (accepted, documented)
- **Prompt injection is mitigated, not solved.** An admin turn still processes
  untrusted channel text. The blast radius is bounded by: conversation-scoped
  targets, the CONFIRM gate on destructive actions, super-admin alerting, and
  the audit log. Non-confirm actions (`warn_user`, `announce`, `create_poll`,
  `create_thread`, each within scope) remain a lever a successful injection
  could pull; all four are bounded further by their own per-conversation rate
  cap (`WARN_USER_RATE_LIMIT_PER_HOUR` / `ANNOUNCE_RATE_LIMIT_PER_HOUR` /
  `POLL_RATE_LIMIT_PER_HOUR` / `THREAD_CREATE_RATE_LIMIT_PER_HOUR`, all
  in-memory) rather than CONFIRM, since each is lower-consequence than a
  destructive action and gating them harder would be inconsistent (issues
  #228, #229, #315). `WebSearch` — a built-in SDK tool rather than one of
  this bot's own MCP tools, and the only one with a real per-call dollar
  cost — carries the same per-conversation-rate-capped (not CONFIRM-gated)
  treatment via `AGENT_WEB_SEARCH_RATE_LIMIT_PER_HOUR` (issue #412), closing
  the enumeration gap #315 left (its own framing covered only the bot's
  custom tool set and never named the one built-in admin+ also has).
- **Membership-scope staleness (narrowed, issues #286 + #328 + #350 + #374)**:
  adapters cache an admin's conversation list for ~60s, but an *observed*
  change invalidates the affected cache entry immediately rather than
  waiting out the TTL. Discord's `GuildMemberRemove` (full guild exit)
  clears the removed user's entry the instant it fires; Discord's
  `ChannelUpdate` clears the *entire* cache the instant a genuine
  `permissionOverwrites` change lands on an in-guild text channel; Discord's
  `GuildMemberUpdate`/`GuildRoleUpdate`/`GuildRoleDelete` likewise clear the
  *entire* cache the instant a member's role set actually changes, a role's
  own `permissions` bitfield actually changes, or a role in the configured
  guild is deleted — this is arguably the *more* common Discord admin
  revocation workflow (pulling someone out of a role) versus hand-editing a
  channel's raw permission overwrites (#328), and it now narrows the same
  way (a targeted per-user/per-role diff is a documented growth path, not
  implemented; the whole-cache clear can only invalidate sooner, never grant
  scope a live check wouldn't; a partial `GuildMemberUpdate` old-member whose
  role set is unknowable fails safe and clears the cache rather than risk
  treating a real revocation as unchanged); and WhatsApp's
  `group-participants.update` with `action: 'remove'` clears the removed
  user's entry the same way — and, since #374, also the same person's
  *phone-number*-keyed entry when a bare `@lid` removal is all the event
  carries: `resolveSenderId` opportunistically learns a LID-local-part ->
  phone-number mapping (`lidToPhone`) from every group message that resolves
  one via `senderPn`/`participantPn`, and `invalidateMembershipCacheFor`
  consumes (deletes) that mapping to reach the phone-keyed entry too. The
  mapping is only ever consulted to *delete* a cache entry, never to add
  one, so a missing/stale mapping degrades to exactly the prior gap and can
  never over-invalidate an unrelated admin's scope. The residual ~60s window
  now applies only to: a participant the bot never saw post in the group
  (no prior message ⇒ no mapping ever learned) — a bare-`@lid` removal for
  them still can't resolve a phone-keyed entry, since the removal payload
  itself carries no phone number and the group's own metadata has already
  dropped the departed participant by the time the event fires, so there is
  no live lookup that recovers the mapping either. That user's phone-keyed
  entry (if any) survives the full TTL exactly as before; only a cache entry
  keyed by the LID form itself is cleared.
- **Guest invisibility in gated mode is now CONDITIONAL, not absolute**
  (issue #48, an owner-approved posture change; extended to WhatsApp groups
  by issue #103). The precise guarantee is: **guest 1:1 DMs to the bot
  (Discord or WhatsApp) are never stored; public guild-channel messages —
  including from guests and never-interacted lurkers — ARE stored when the
  operator enables `DISCORD_ARCHIVE_ALL_MESSAGES`, and WhatsApp group
  messages likewise when the group's JID is in
  `WHATSAPP_ARCHIVE_GROUP_JIDS`** (both default off/empty; off = exactly the
  old posture, pinned by test). Two metadata-only exceptions exist
  regardless of either flag: `access_requests` (identity + request count for
  guests who addressed the bot) and `server_roster` (join/leave identity
  metadata, Discord-only) — neither stores content.
- **The roster narrows the "guests are invisible" spirit, not its letter**:
  `server_roster` deliberately records the *identity* (never content) of every
  guild member — including lurkers who never touched the bot — because the
  onboarding queue ("joined but never added") and growth counts need exactly
  that. It is metadata every server member can already see in the member
  list, it is deletable (`forget_me`/`purge_user_data`), and reads are
  admin-only and guild-wide rather than conversation-scoped. Rows for people
  who left are kept (with `left_at`) for churn history, then age-purged once
  `left_at` is older than `ROSTER_DEPARTED_RETENTION_DAYS` (issue #136,
  default disabled; a 30-day floor when enabled keeps `list_roster`'s
  "left this week" pulse intact). Currently-present rows (`left_at IS NULL`)
  are never purged regardless of this setting.
- **forget_me/purge scope**: deletes the user's messages, replies to them,
  knowledge entries *sourced from* them, content reports *they submitted
  as reporter*, their response-style preference, and their auto-moderation
  warning history (`member_warnings`). Membership rows, the
  admin audit log, and reports where the user is only the *target* (not the
  reporter) are retained deliberately
  (accountability) — the same precedent already applied to `admin_audit`. If
  the identity is linked (`link_member`), this scope applies to every linked
  identity, not just the one the request came from — see "Cross-platform
  identity linking" above for why that expanded blast radius is accepted.
- **`my_data` (issue #188) is the read-only, IPP6 access-right counterpart to
  the deletion path above** — NZ Privacy Act 2020 gives individuals a right
  to see what's held about them, not just to erase it. It reports counts for
  exactly the same tables `forget_me` deletes (own messages, replies sent to
  them, knowledge sourced from them, reports/suggestions they filed, their
  response-style preference), scoped identically via `resolveLinkedIdentities`
  so it can never see another member's data. It deliberately does **not**
  count or query `member_notes` (issue #45's members-have-no-self-access
  boundary), `member_warnings` (see `my_warnings` instead), `server_roster`,
  `admin_digest_sends`, or `answer_feedback` — `forget_me` purges a strict
  superset of what `my_data` ever reports, and that asymmetry is intentional,
  not a bug to "reconcile" away.
- **DM-originated content reports are visible to every admin, not only
  super admins (issue #197).** `list_reports`/`countOpenReports`/
  `resolve_report` are otherwise scoped exactly like `moderation_history`/
  `list_access_requests`: an admin only sees reports from conversations they
  actually participate in. WhatsApp is 1:1 with the bot and Discord DMs
  likewise, so no ordinary admin is ever a "participant" of another member's
  DM — a report filed from a DM has no conversation any admin's scope array
  can ever contain. Before #197 this was a deliberate default restricting
  such reports to the unrestricted (null-scope) super-admin view; #197
  reverses that default (not an accidental scoping gap being "fixed") on the
  reasoning that a self-filed complaint intended for moderator action isn't
  confidential from admins as a class — the same treatment already given to
  guild-wide, no-natural-scope tables (`access_requests`, `suggestions`).
  The reversal carries one carve-out the general precedent doesn't need: a
  DM report whose `target_user_id` is the *viewing* admin themselves stays
  super-admin-only, so an accused admin can never see or dismiss a report
  filed against them — preserving DM as the one channel a member can use to
  report an admin without that admin knowing. `is_dm` is derived from
  platform/channel type at report-creation time (`CallerContext.isDirect`),
  never from message content, so it cannot be spoofed by a report's text.
  `target_user_id` is reporter-supplied and unauthenticated, unlike
  `moderate`/`clear_warnings`'s admin-supplied targets — `report_content`
  therefore only stores it (and lets it drive the accused-admin exclusion) if
  `isKnownUser` confirms the bot has actually seen that id before; an
  unknown/typo'd id is dropped rather than silently excluding an unrelated
  admin from a report that isn't about them. This narrows, but does not
  eliminate, the exclusion being pointed at the wrong admin — a member who
  already knows a real admin's platform id (e.g. from an @-mention) can still
  name them as the target of an unrelated report. Reports created before #197
  default `is_dm` to `false` (non-retroactive) and keep their original
  super-admin-only visibility. Issue #90's proactive super-admin DM on filing
  (`notifyReportFiled`) is unchanged — it does not fan out to every admin,
  only to super admins, as before.
- **The daily budget counts recorded replies** — if cost/usage recording fails,
  the budget degrades open (rate limiter still applies). This is a deliberate
  fail-open (issue #52: never block a real reply on a per-request DB hiccup),
  but it is no longer silent (issue #203): a `countRepliesToUser` failure logs
  an `error`-level line and DMs every super admin (at most once per 15
  minutes, process-wide — a recording failure is a systemic condition, not a
  per-user one), naming the failure with no message content or per-user
  identifiers. The alert only fires on the message hot path, not via a
  background poller — a sustained outage with no traffic produces no alert,
  which is `health.ts`'s job, not this one's.
- **Suggestion/report-resolution DMs degrade to silent skip only when the
  origin platform isn't registered in this deployment** (issue #157, closing
  the narrower gap #116/#120 left open): resolving a suggestion or report
  filed on a *different* platform than the resolving admin's current turn now
  sends the confirmation DM via that origin platform's own adapter, looked up
  through `Router`'s existing adapter registry (`getAdapter`, threaded from
  `Router.respond` through `runAgentTurn`/`execTurn` into `buildToolServer`) —
  it is never sent through the resolving admin's current-turn adapter, so a
  DM can never be misaddressed to the wrong platform. The residual limitation
  is single-platform deployments only: if the origin platform has no adapter
  registered at all (e.g. WhatsApp not configured), the DM is skipped exactly
  as before — never an error, never a misdirected send. `notifySuperAdmins`
  still has the narrower limitation this closed for suggestions/reports: it
  has no cross-turn adapter lookup at all, since its callers don't know a
  target platform to look up.
- **The `claude` CLI subprocess** still has network access (it must reach the
  Anthropic API). OS-level egress filtering is the next hardening step if
  needed.

## Behaviour policy (code answers)
`code_answers` policy (super admin, `set_policy`): `off` strips all fenced
code from replies, `snippets` (default) truncates fences beyond ~15 lines,
`full` disables the filter. Unterminated fences are treated as running to
end-of-text, so an unclosed ``` cannot bypass the policy. Enforced *outside*
the model — the filter (plus unconditional secret redaction: exact runtime
secrets incl. WhatsApp Cloud tokens + common token patterns) lives **inside
the adapters' send paths**, so every outbound message — router replies,
`announce`, `warn_user` DMs, super-admin alerts, `create_poll`'s
question/answers — passes through it; no future send path can forget. Discord additionally sends with
`allowedMentions: []` (no injected @everyone pings), and WhatsApp refuses to
route `lid:`-fallback ids as phone JIDs (a LID's digits sent as a phone
number could reach an unrelated person).

## Operational checklist
- [ ] `.env` is `chmod 600` and owned by the service user.
- [ ] `whatsapp-auth/` directory is `chmod 700`, not in git.
- [ ] Postgres is not exposed to the network.
- [ ] Bot has minimal Discord permissions.
- [ ] Community is informed that interactions are logged, **that server
      join/leave events (identity + timestamps, no content) are recorded for
      admin onboarding/growth views, and that admins may keep private
      context notes about members** (deletable on request via `forget_me`).
- [ ] **Before enabling `DISCORD_ARCHIVE_ALL_MESSAGES`**: the ambient-
      archiving notice (see "Data protection" above) is posted visibly
      (server rules / pinned message). Enabling the flag without notice
      violates the collection-notice expectations this deployment relies on.
- [ ] **Before adding a group's JID to `WHATSAPP_ARCHIVE_GROUP_JIDS`**: the
      WhatsApp ambient-archiving notice (see "Data protection" above) is
      posted visibly in *that group*. Do this per group, before each JID is
      added — adding the JID is the operator's assertion that notice was
      posted.
- [ ] **Before enabling `DISCORD_MODERATION_ENABLED`**: (1) a notice that
      messages are scanned for moderation is posted visibly (same expectation
      as the archiving notice — every message is inspected), and (2) the bot
      has been granted **Manage Roles** + **Manage Channels** (for the muted
      role and the `mod-alerts` channel). Note these two permissions widen the
      bot token's blast radius; grant them only for this feature and keep the
      rest of the bot's permissions minimal. `MODERATION_LLM_ABUSE_ENABLED`
      (Stage 2) additionally spends the shared Max pool per escalated message —
      leave it off until you want it.
- [ ] A retention/deletion policy is defined (`forget_me`/`purge_user_data`
      for per-user requests; `INTERACTION_RETENTION_DAYS` for age-based purge).
- [ ] `journalctl -u community-agent` reviewed for redaction leaks.
- [ ] **Branch protection on `main`** blocks direct and force pushes (require a
      PR + review). This is the **enforceable** guarantee for the pipeline's
      write-scoped automation — the build, autofix, and conflict-resolver workers
      each hold a `contents: write` token and run an agent with code execution
      (`node`/`npm`, needed to run the gate). Their `git push origin HEAD`
      allowlist and withheld `checkout`/`branch` raise the bar, but an agent with
      code execution could still rewrite `.git/HEAD` on disk to retarget a push,
      so the tool restrictions are defence-in-depth, not the guarantee. Branch
      protection (server-side) is what actually guarantees nothing reaches `main`
      without a human merge even if a worker is prompt-injected. Enable it before
      relying on these loops.
- [ ] **If enabling `redeploy_bot`**: the exact-match sudoers line in
      docs/DEPLOYMENT.md is added (opt-in — omit it and the tool simply fails
      clean with no new host surface granted).
