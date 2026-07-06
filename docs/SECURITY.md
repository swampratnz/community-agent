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
5. **Moderation authority** — the ability to timeout/kick/announce, and (when
   auto-moderation is enabled) to mute/block members via a Discord role.

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
- **Privileged targets are validated**: `moderate`/`announce` refuse targets
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
- `AGENT_MAX_TURNS` caps the agentic loop per request.
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
  boolean)` — **no free-text input at all**, a smaller surface than
  `report_content`/`suggest_improvement` (which have a `reason`/`content`
  field), since this was the explicit condition #60 set for revisiting a
  rating mechanism. Write-only at member tier, DB-backed rolling-24h cap
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
  the aggregate helpful/unhelpful trend survives.
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
- **Server roster** (`server_roster`, issue #47): join/leave events plus a
  startup backfill persist **identity metadata for every guild member** —
  platform user id, display name, join/leave timestamps, rejoin count —
  including non-members and lurkers who have never interacted with the bot.
  It stores **no message content** (pinned by a `SECURITY:` test, plus a
  structural column check so a content-bearing column can't appear
  silently). Reads are **admin-tier and guild-wide** (`list_roster` is not
  conversation-scoped — same precedent as `list_access_requests`), display
  names are wrapped as untrusted data, and `forget_me`/`purge_user_data`
  delete the person's roster row. Roster rows are durable (like
  `community_users`) for members still present; departed members'
  (`left_at IS NOT NULL`) rows are age-purged after
  `ROSTER_DEPARTED_RETENTION_DAYS` (issue #136, unset/0 = disabled, floor of
  30 days if set — mirrors `INTERACTION_RETENTION_DAYS`).
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
  other admin-identity-keyed data.
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
  `forget_me`/`purge_user_data` delete the caller's row.
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
  - **Enforcement is best-effort, not airtight**: the muted role's
    deny-SendMessages overwrites are applied to channels that exist when a mute
    happens — **channels created later won't inherit them** until the next mute
    re-applies. A determined member could also leave/rejoin to shed the role.
    Treat it as a strong deterrent, not a hard containment boundary.
  - **Stage 2 (LLM abuse) is opt-in** (`MODERATION_LLM_ABUSE_ENABLED`, off):
    only wordlist-clean messages escalate, one Claude call each on the shared
    Max pool — deliberately gated so it can't silently run up cost/scan volume.
  - `clear_warnings` (admin tier, pinned by a `SECURITY:` RBAC test) clears a
    member's active warnings and lifts the mute; it's lenient/reversible so it
    isn't CONFIRM-gated, and any admin may clear anyone's.
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

- **Locked to one built-in tool.** The subprocess runs
  `grok --tools GenerateImage …` — an *allowlist* that removes every other
  built-in tool, including Bash, file-write, and exec. So even though the CLI is
  driven with `--always-approve` (unattended, no interactive prompt), there is
  no shell/file/exec tool for it to approve: the worst an admin turn — or a
  prompt-injected one — can drive is "produce an image". Verified on the host:
  with only `GenerateImage` allowed, the model's attempts to reach `Bash`/`Write`
  are rejected as *"Tool not found"*. This is the deliberate difference from a
  bare agentic CLI, and why `--always-approve` is acceptable here.
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
  tools are denied, grok can't copy the image anywhere we choose; `GenerateImage`
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
  Members, Kick Members, Manage Messages) and place its role appropriately in
  the hierarchy.

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

## Residual risks (accepted, documented)
- **Prompt injection is mitigated, not solved.** An admin turn still processes
  untrusted channel text. The blast radius is bounded by: conversation-scoped
  targets, the CONFIRM gate on destructive actions, super-admin alerting, and
  the audit log. Non-confirm actions (`warn_user`, `announce` within scope)
  remain a lever a successful injection could pull.
- **Membership-scope staleness**: adapters cache an admin's conversation list
  for ~60s, so an admin removed from a channel/group can retain data scope for
  up to that window.
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
- **DM-originated content reports are visible only to super admins.**
  `list_reports` is scoped exactly like `moderation_history`/
  `list_access_requests`: an admin only sees reports from conversations they
  actually participate in. WhatsApp is 1:1 with the bot and Discord DMs
  likewise, so no ordinary admin is ever a "participant" of another member's
  DM — a report filed from a DM therefore only reaches the unrestricted
  (null-scope) super-admin view, never a scoped admin. This is a deliberate,
  documented default (not a silent drop): the report is still recorded and
  retrievable, just only by super admins, until/unless a routing mechanism
  for DM-originated reports is added. This risk is narrowed, not eliminated,
  by issue #90: filing a report now proactively DMs every super admin the
  moment it's created (`notifyReportFiled`), so a DM-originated report no
  longer sits unseen until someone thinks to poll `list_reports` —
  conversation-scoped admins still can't see it via `list_reports` until
  that routing mechanism exists.
- **The daily budget counts recorded replies** — if cost/usage recording fails,
  the budget degrades open (rate limiter still applies).
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
`announce`, `warn_user` DMs, super-admin alerts — passes through it; no
future send path can forget. Discord additionally sends with
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
