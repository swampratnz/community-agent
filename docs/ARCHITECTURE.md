# Architecture

The Community Agent is a single long-running Node service that connects the
**NZ Claude Community** Discord server and a dedicated **WhatsApp** number to a
Claude-powered agent, with a Postgres-backed memory for learning.

## High-level flow

```
                 ┌──────────────┐        ┌──────────────┐
   Discord  ───► │ DiscordAdapter│       │BaileysAdapter│ ◄─── WhatsApp
                 └──────┬───────┘        └──────┬───────┘
                        │  IncomingMessage      │
                        │  (normalised)         │
                        ▼                       ▼
                     ┌──────────────────────────────┐
                     │            Router             │
                     │  - record every message       │
                     │  - decide whether to reply    │
                     │  - serialise per conversation │
                     │  - per-user rate limit        │
                     └──────────────┬───────────────┘
                                    ▼
                     ┌──────────────────────────────┐
                     │         Agent core            │
                     │  - recall memory (pgvector)   │
                     │  - build role-scoped prompt   │
                     │  - build role-gated tools     │
                     │  - query() w/ subscription auth│
                     │  - resume per-convo session   │
                     └──────────────┬───────────────┘
                                    ▼
                     ┌──────────────────────────────┐
                     │   PostgreSQL + pgvector       │
                     │  interactions / knowledge /   │
                     │  sessions / admin_audit       │
                     └──────────────────────────────┘
```

## Components

| Module | Responsibility |
|---|---|
| `src/config.ts` | Loads + validates all env (zod). Fails fast on misconfig. |
| `src/platforms/types.ts` | `PlatformAdapter` interface + normalised `IncomingMessage`. The seam that decouples the agent from any specific chat platform. |
| `src/platforms/discord/adapter.ts` | discord.js client; normalises messages, resolves roles, performs moderation actions. |
| `src/platforms/whatsapp/baileysAdapter.ts` | WhatsApp via Baileys (linked-device protocol, dedicated number). |
| `src/platforms/whatsapp/cloudAdapter.ts` | The official Meta Cloud API adapter — webhook intake + Graph API send, the documented upgrade path from Baileys. |
| `src/auth/rbac.ts` | Role resolution (`admin`/`user`) + the per-role allowed-tool lists. |
| `src/agent/core.ts` | Runs one agent turn: memory recall → prompt → `query()` → reply. |
| `src/agent/tools.ts` | In-process MCP tools (search memory/knowledge, moderate, announce, …). |
| `src/agent/auth.ts` | Forces Claude **subscription** auth via `CLAUDE_CODE_OAUTH_TOKEN`. |
| `src/agent/upstreamFailure.ts` | Classifies a usage-limit/overload `query()` failure vs. a generic internal error, + the debounce latch for the optional super-admin DM. |
| `src/storage/*` | Postgres pool, schema, migrations, embeddings, repository. |
| `src/router.ts` | Orchestrates inbound → agent → outbound and persistence. |
| `src/health.ts` / `src/healthState.ts` | `/healthz` endpoint + sustained-disconnect super-admin alerting; `healthState.ts` holds the pure, tested debounce/payload logic. |

## Ambient archiving

With `DISCORD_ARCHIVE_ALL_MESSAGES=true` (issue #48; **off by default**),
storage is decoupled from response: every message in the guild's allowed
channels is recorded to `interactions` (kind `ambient` when not addressing
the bot, with the Discord message id), while the addressed-check continues to
solely govern whether the agent replies. That gives conversation-scoped
recall, `question_digest`, and the context pipeline visibility into actual
channel discussion — "what did we decide about X last week?" becomes
answerable. Discord deletes/edits are honoured against the stored copy
(hard-delete / re-embed by message id), ambient rows age out via
`INTERACTION_RETENTION_DAYS` and are covered by `forget_me`. This reverses
part of the gated-mode guest guarantee for public channels — see SECURITY.md
for the posture statement, the notice precondition, and the ready-to-pin
community notice text.

`WHATSAPP_ARCHIVE_GROUP_JIDS` (issue #103) extends the same mechanism to the
WhatsApp Baileys path, scoped to an explicit allowlist of group JIDs rather
than a single flag (WhatsApp groups have no "public channel" equivalent, so
each group opts in individually once its notice is posted). The Baileys
adapter populates `IncomingMessage.messageId` from the WhatsApp message key,
and honours "delete for everyone" (always) and edits (best-effort — Baileys'
protocol fidelity for edits is less reliable than for revokes) by watching
for `protocolMessage` events in archived groups. Archiving is receive-side
only — no new outbound/send behaviour, so it adds no new Baileys ToS/ban-risk
surface (see SECURITY.md's Baileys section).

## WhatsApp voice-note transcription

`WHATSAPP_VOICE_ENABLED` (Baileys only; **off by default**) transcribes a
voice note locally (transformers.js Whisper, `WHATSAPP_VOICE_MODEL`, default
`Xenova/whisper-base.en` — **English-only**, a known and disclosed
transcription-quality caveat for te reo Māori and other non-English speech)
and actions the transcript through the exact same pipeline a typed message
would use — RBAC, tool gating, and CONFIRM are all untouched.
`WHATSAPP_VOICE_MIN_ROLE` (issue #507) sets the minimum tier eligible to use
voice, defaulting to `'super_admin'` — byte-identical to the original
super-admin-only rollout, since the gate stays a pure `isSuperAdmin` env check
with no DB call at that default. Lowering it to `'admin'`, `'member'`, or
`'guest'` reuses the same `resolveRole`/`atLeast` primitives every other
tier-gated surface uses, enforced *before* any media is downloaded.
`WHATSAPP_VOICE_RATE_LIMIT_PER_HOUR` (default `0` = unlimited) adds a
per-sender rolling-hour cap once an operator opts into a wider population —
see SECURITY.md §13 for the full posture and the residual-risk note about
leaving the rate limit unset while lowering `minRole`.

## Memory & "learning"

Because the agent authenticates with a Claude **subscription** (not the API),
there's no fine-tuning. "Learning" is implemented as **retrieval-augmented
memory**:

1. **Every** inbound and outbound message is written to `interactions` with a
   locally-computed embedding (transformers.js, `all-MiniLM-L6-v2`, 384-dim).
2. On each turn the agent semantically searches prior interactions in the
   *current conversation* (`pgvector` cosine distance, HNSW index) and injects
   the top hits into the **user turn** inside a delimited untrusted-data block
   (never the system prompt — see SECURITY.md on prompt injection).
3. The `remember_search` / `knowledge_search` tools let the model query memory
   on demand mid-turn. Cross-conversation search is admin-only.
   `knowledge_search`'s result ordering is similarity-descending except for a
   narrow tie-break (issue #308): when two relevant hits land within
   `KNOWLEDGE_TIE_MARGIN` of each other and exactly one is stale (per
   `isKnowledgeStale`/`KNOWLEDGE_STALE_DAYS`), the fresher one is listed
   first — a real relevance gap always wins regardless of staleness.
   `isKnowledgeStale` also honors an optional absolute content-age ceiling,
   `KNOWLEDGE_STALE_MAX_AGE_DAYS` (issue #380, off unless set), OR-ed into the
   same predicate: it fires on a hit's edit age alone, closing the gap where a
   popular entry's frequent retrieval otherwise resets `KNOWLEDGE_STALE_DAYS`'s
   clock forever.
4. Admins can promote durable facts into `knowledge` via `save_knowledge`, and
   curate existing entries with `list_knowledge` (browse by scope),
   `update_knowledge` (correct + re-embed), and `delete_knowledge` (retire,
   CONFIRM-gated). `scope` (`'global'` | a platform | a conversation id) is
   enforced at retrieval time: `knowledge_search` only ever surfaces
   `'global'` entries plus entries scoped to the caller's own platform or
   conversation (see docs/SECURITY.md, issue #106). `list_knowledge` is the
   deliberate exception — an admin curating browses by explicit scope,
   unrestricted by their own conversation. Every `list_knowledge` result line
   also carries a bracketed `created_by_role` provenance tag (`[auto]`
   unreviewed web-research, `[docs]` trusted backfill, or the human tier
   verbatim), and an optional `provenance` filter narrows the browse to just
   one of those (issue #294) — the same trust signal `knowledge_search`
   already uses to decide quarantine, now visible to the one tool built for
   browsing it. `question_digest` closes the
   discovery gap: it greedily
   clusters recent addressed-to-bot messages by embedding similarity (reusing
   the same vectors, no new embedding calls) to surface "N people asked this"
   patterns worth turning into a knowledge entry. `src/adminDigest.ts` (issue
   #97) pushes this same signal proactively instead of relying on an admin to
   call the tool: a daily timer (off unless `ADMIN_DIGEST_ENABLED`) DMs each
   `community_users` admin at most once a week — restart-safe via the
   `admin_digest_sends` freshness table — with their own scoped
   `recentQuestionClusters` result, plus (issue #133) a guild-wide pending
   access-request count and their own scoped open-report count, plus (issue
   #193) a guild-wide pending-suggestion count, plus (issue #199, off unless
   `KNOWLEDGE_STALE_DAYS` is set) a guild-wide count of knowledge entries
   neither edited nor retrieved in that many days — the digest's "run
   `list_knowledge` to review" pointer resolves to `list_knowledge`'s
   `staleOnly` filter (issue #280), which reuses that exact same predicate
   to return just that stale subset, most-overdue first — plus (issue #246) their own
   scoped count of `knowledge_gaps` (below-floor `knowledge_search` misses, the
   pull-only complement to `list_knowledge_gaps`) — conversation-scoped like the
   open-report count because that table has a `conversation_id` — plus (issue
   #284) a guild-wide pending `knowledge_candidates` review-queue count (the
   pull-only complement to `list_knowledge_candidates`) — plus (issue #324)
   their own scoped count of knowledge entries with repeated unhelpful
   ratings (`unhelpfulCount >= 2`, the pull-only complement to
   `list_low_rated_knowledge`), conversation-scoped like the knowledge-gaps
   count because `answer_feedback` also has a `conversation_id` — plus (issue
   #344) a guild-wide joined-this-week/left-this-week roster pulse (both
   Discord and, since issue #407, WhatsApp), sourced from
   `rosterCounts(admin.platform)` — the same
   `{ total, joinedThisWeek, leftThisWeek }` aggregate `list_roster` already
   computes over `server_roster` (issue #47), now pushed instead of pull-only —
   plus (issue #357) a guild-wide count of members currently muted by
   auto-moderation, sourced from `countMutedMembers(admin.platform,
   config.moderation.strikeLimit, config.moderation.strikeWindowDays)`, which
   reuses `countActiveWarnings`'s exact `platform`/`user_id`/`cleared_at IS
   NULL`/optional-rolling-window shape so the digest's "muted" definition can
   never drift from the actual mute trigger in `src/moderation/moderator.ts`
   — the pull-only complement to `moderation_history`/`clear_warnings`.
   As bare integers with no member name/id, it's guild-wide like the
   access-request/suggestion/candidate counts, not conversation-scoped;
   `server_roster` now covers WhatsApp groups too (issue #407), so
   `rosterCounts('whatsapp')` reports real numbers for any deployment with
   WhatsApp roster rows, with zero code change to `rosterCounts` itself.
   Alongside it, `rosterCounts(admin.platform).notMembers` (issue #460) is the
   *standing* size of the onboarding queue — present-but-never-added guests,
   unwindowed unlike joined/left-this-week — forwarded to the digest only
   when `config.rbac.accessMode[admin.platform] === 'gated'` (an `'open'`-mode
   guest already has full member-tool access, so the count would be a
   meaningless nag there); a bare integer, same privacy shape as every other
   signal here.
   Plus (issue #371) their
   own scoped count of outbound replies that hit `AGENT_MAX_TURNS`/
   `AGENT_MAX_TURNS_MEMBER` before finishing, sourced from
   `countMaxTurnsFailures(scope, ...)` — conversation-scoped like the
   knowledge-gaps count because `interactions` also has a `conversation_id`.
   It counts both the primary `reply.maxTurnsExceeded === true` stamp (the
   first, non-repeated time a turn hits `error_max_turns`, `src/agent/core.ts`)
   and the `repeatMaxTurnsShortcut: true` stamp issue #306's shortcut already
   writes for a replayed wall-hit, since each is a distinct member-facing
   failure — a bare integer only, no message content, question text, user id,
   or conversation id. All these counts are
   sourced from dedicated `COUNT(*)` reads (`countAccessRequests`/`countOpenReports`/
   `countPendingSuggestions`/`countStaleKnowledge`/`countKnowledgeGaps`/
   `countPendingKnowledgeCandidates`/`countLowRatedKnowledge`/`rosterCounts`/
   `countMutedMembers`/`countMaxTurnsFailures`)
   so a backlog past `list_access_requests`/`list_reports`/`list_suggestions`/
   `list_knowledge_gaps`/`list_knowledge_candidates`/`list_low_rated_knowledge`'s
   own list `limit` is never understated. The DM sends when *any* of the
   eleven signals is non-zero, and sends nothing on a quiet week (all zero, no
   DM, no noise); a persistently untriaged queue re-appears every subsequent
   weekly tick until it's cleared. Super admins are not enrolled; they keep
   the on-demand, all-conversation-scoped
   `question_digest`/`list_access_requests`/`list_reports`/`list_suggestions`/`list_knowledge`/`list_roster`
   tools instead. Off unless `ADMIN_DIGEST_TRENDS_ENABLED` (issue #497), every
   one of these bare counts also carries a week-over-week trend suffix — a
   ` (▲+N since last week)` / ` (▼-N since last week)` fragment appended to a
   line whose count moved since the prior send, silent when it's unchanged or
   there's no prior snapshot. The comparison point is `last_counts`, a JSONB
   snapshot column on `admin_digest_sends` written every run regardless of the
   flag (so flipping it on is retroactively useful from the very next tick)
   and whitelist-sanitized at the write boundary to the known signal-name set
   — the exact same integers the digest already sends, never anything else.
   A quiet week (no DM sent) still snapshots the current counts via a
   dedicated write path that deliberately never touches `sent_at`, keeping the
   trend snapshot fully decoupled from the freshness guard above it.
   The weekly push above was, until issue #499, the only way to see this
   picture — an admin who wanted it mid-week had to wait or manually run each
   underlying `list_*`/`count_*` tool separately. `admin_digest` (admin-tier,
   no arguments, read-only, no CONFIRM) closes that gap: an on-demand pull of
   the same signals, scoped to the caller only (it takes no id argument, so
   an admin can never pull another admin's snapshot), returning the fixed
   string `Nothing to report right now.` on a quiet week. Both the weekly
   push and this pull call one shared helper, `buildAdminDigestForAdmin`
   (extracted from `runAdminDigestOnce`'s per-admin loop) — a single
   gathering/formatting implementation, so the two paths can never drift
   apart on scoping or content. The pull deliberately never touches
   `wasAdminDigestSentRecently`/`recordAdminDigestSent`: pulling any number
   of times has no effect on when the next weekly DM arrives, and it works
   identically whether `ADMIN_DIGEST_ENABLED` is on or off (that flag only
   gates the proactive timer, never the admin's standing authorization to
   read their own already-scoped counts).

Conversation continuity uses the Agent SDK's session resume: the Claude
`session_id` for each `(platform, conversation)` is stored in `sessions` and
passed back as `resume` on the next turn.

## RBAC (three tiers + gated access)

Tiers: **super_admin > admin > member > guest**.

- **super_admin** — env-bootstrapped (`SUPER_ADMIN_DISCORD_IDS` /
  `SUPER_ADMIN_WHATSAPP_NUMBERS`); never grantable via chat. Full access.
- **admin** — granted by a super admin (`grant_admin`); stored in
  `community_users`. Privileged data access is **scoped to conversations the
  admin actually participates in** — the adapter resolves their real channel/
  group membership (cached ~60s) and that list becomes a SQL filter. Leaving
  the Discord server/WhatsApp group does **not** revoke `role='admin'` — only
  an explicit `revoke_admin` does — so a departed admin can still DM the bot
  with admin-tier tools; `list_admins` (super-admin, read-only, issue #428) is
  the visibility tool that surfaces this state (flags a `community_users`
  admin whose `server_roster` row shows `left_at` set) so a super admin can
  notice and decide whether to revoke. `src/departedAdminAlert.ts` (off
  unless `DEPARTED_ADMIN_ALERT_ENABLED`, issue #472) turns that same signal
  proactive — see "Departed-admin alert" below.
- **member** — granted by an admin (`add_member`); stored in `community_users`.
- **guest** — everyone else. In **gated** mode (`ACCESS_MODE_*=gated`, the
  default) guests get a "ask an admin to add you" pointer and their message
  content is **not stored** — only that they asked (identity + count, in
  `access_requests`; see "Onboarding" below). In `open` mode guests get
  member-level tools.

The router resolves the tier (env + DB — never message content), and the agent
core passes `toolsForRole(tier)` as `allowedTools`, so lower tiers are
**structurally incapable** of invoking higher-tier tools — the tool isn't even
offered to the model. Each privileged tool re-asserts the tier
(`assertAtLeast`), destructive actions additionally require an out-of-band
CONFIRM reply (handled deterministically by the router, never by the model),
and every privileged action is audited and alerted to super admins by DM.

| Capability | guest (gated) | member | admin | super_admin |
|---|:--:|:--:|:--:|:--:|
| Talk to the bot | ❌ | ✅ | ✅ | ✅ |
| Search memory (own conversation), knowledge, `forget_me` | ❌ | ✅ | ✅ | ✅ |
| `my_data` (read-only summary of the caller's own stored footprint — the IPP6 access counterpart to `forget_me`) | ❌ | ✅ | ✅ | ✅ |
| `report_content` (flag harassment/spam/rule violations to admins) | ❌ | ✅ *(rate-capped, 5/24h)* | ✅ | ✅ |
| `appeal_moderation` (ask admins to review the caller's OWN active warning(s)/mute; refuses cleanly with none) | ❌ | ✅ *(rate-capped, 1 per `MODERATION_APPEAL_COOLDOWN_HOURS`, default 24h)* | ✅ | ✅ |
| `community_guidelines` (read the community's rules, verbatim, or a not-set-yet message) | ❌ | ✅ | ✅ | ✅ |
| `suggest_improvement` (file a bot-improvement idea; write-only) | ❌ | ✅ *(rate-capped, 3/24h)* | ✅ | ✅ |
| `set_response_style` (standing plain-language reply preference; self-service, no CONFIRM) | ❌ | ✅ | ✅ | ✅ |
| `set_language_preference` (standing reply-language preference: auto/en/mi; self-service, no CONFIRM) | ❌ | ✅ | ✅ | ✅ |
| `react_to_message` (emoji ack instead of a text reply; closed ✅/👍/👀/🎉 allowlist, target must be a message the bot has seen in the caller's own conversation, rate-capped 20/24h; Discord only) | ❌ | ✅ | ✅ | ✅ |
| `list_suggestions` / `resolve_suggestion` (triage the idea queue) | ❌ | ❌ | ✅ | ✅ |
| Memory/history across conversations | ❌ | ❌ | ✅ *their conversations* | ✅ all |
| `moderate` / `announce` | ❌ | ❌ | ✅ *their conversations*, confirm-gated | ✅ anywhere |
| `create_poll` (native Discord poll; announce-class outward post, rate-capped instead of confirm-gated — Discord only) | ❌ | ❌ | ✅ *their conversations* | ✅ anywhere |
| `create_thread` (open a Discord thread; additive, rate-capped, self-refuses under an unscanned moderation allowlist — Discord only) / `archive_thread` (confirm-gated) | ❌ | ❌ | ✅ *their conversations* | ✅ anywhere |
| `create_event` (real Discord Scheduled Event; outward + member-notifying, confirm-gated, guild-wide not conversation-scoped — Discord only) / `cancel_event` (marks it Canceled, not deleted; confirm-gated; live target validation against Discord's own scheduled events before any CONFIRM is registered) | ❌ | ❌ | ✅ | ✅ |
| `save_knowledge` / `list_knowledge` / `update_knowledge` / `delete_knowledge` | ❌ | ❌ | ✅, delete confirm-gated | ✅ |
| `set_community_guidelines` (set/clear the rules text shown to members; content curation, not runtime control — same tier as `save_knowledge`) | ❌ | ❌ | ✅ | ✅ |
| `set_welcome_message` (set/clear the new-member welcome text, in place of the hardcoded default; same shape as `set_community_guidelines`) | ❌ | ❌ | ✅ | ✅ |
| `list_access_requests` | ❌ | ❌ | ✅ *(not conversation-scoped — see below)* | ✅ |
| `list_roster` (joins/leaves/onboarding queue, identity only) | ❌ | ❌ | ✅ *(guild-wide, not conversation-scoped)* | ✅ |
| `list_context_digests` (offline-distilled community topics) | ❌ | ❌ | ✅ | ✅ |
| `list_knowledge_candidates` / `accept_knowledge_candidate` / `decline_knowledge_candidate` (review queue turning a digest into knowledge; decline no CONFIRM) | ❌ | ❌ | ✅ | ✅ |
| `add_member_note` / `list_member_notes` / `delete_member_note` (person-scoped admin context) | ❌ | ❌ | ✅ *(audited; delete confirm-gated)* | ✅ |
| `question_digest` (recurring-question clusters) | ❌ | ❌ | ✅ *their conversations* | ✅ all |
| `admin_digest` (on-demand pull of the caller's own weekly admin-digest snapshot; no arguments, no CONFIRM — never affects the weekly push's cadence) | ❌ | ❌ | ✅ *caller only* | ✅ |
| `list_knowledge_gaps` (recurring below-floor knowledge_search misses — the miss-specific complement to `question_digest`) | ❌ | ❌ | ✅ *their conversations* | ✅ all |
| `moderation_history` (warn/timeout/kick/delete/announce log, filterable by member/action) | ❌ | ❌ | ✅ *their conversations* | ✅ all |
| `list_member_warnings` (one member's full `member_warnings` history — auto + admin strikes, with reason/excerpt — the read `moderation_history` can't reach) | ❌ | ❌ | ✅ *(platform/user-scoped, not conversation-scoped — same as `clear_warnings`)* | ✅ |
| `list_muted_members` (currently-muted members by identity — user id, strike count, `active`/`stale` status, last-warning timestamp; never reason/excerpt; closes the growth path #403 named for the digest's bare `🔇 N` count) | ❌ | ❌ | ✅ *(guild-wide, not conversation-scoped — same as `clear_warnings`)* | ✅ |
| `list_reports` / `resolve_report` (member-submitted content reports) | ❌ | ❌ | ✅ *their conversations* | ✅ all |
| `add_member` / `remove_member` | ❌ | ❌ | ✅ (member tier only) | ✅ |
| `link_member` / `unlink_member` (cross-platform identity linking) | ❌ | ❌ | ✅, confirm-gated, tier never propagates | ✅ |
| `assign_community_role` / `remove_community_role` / `list_assignable_roles` (cosmetic Discord roles, strictly orthogonal to tiers — see docs/SECURITY.md §10) | ❌ | ❌ | ✅, confirm-gated (list read-only), Discord only | ✅ |
| Web search & summarise (`WebSearch`; `WebFetch` never) | ❌ | ❌ | ✅ | ✅ |
| `grant_admin` / `revoke_admin`, `purge_user_data`, `audit_view`, `usage_stats`, `pause_bot`, `set_policy` | ❌ | ❌ | ❌ | ✅ |
| `list_admins` (current admin-tier roster, read-only, no arguments — flags an admin whose `server_roster` row shows they've left the server/group; issue #428) | ❌ | ❌ | ❌ | ✅ |
| `admin_activity` (per-admin `admin_audit` action-volume rollup over a trailing window — days-windowed, read-only, unscoped; the aggregated complement to `audit_view`'s flat log; issue #488) | ❌ | ❌ | ❌ | ✅ |
| `redeploy_bot` (trigger an immediate redeploy from `origin/main`; no arguments, confirm-gated) | ❌ | ❌ | ❌ | ✅ |

Behaviour guardrails on top: per-user daily reply budget
(`DAILY_REPLY_LIMIT_PER_USER`), session caps (`SESSION_MAX_TURNS`/`_AGE_HOURS`),
and an outbound filter on every reply — secret redaction plus the
`code_answers` policy (`off`/`snippets`/`full`, set via `set_policy`). A
member/guest may also set their own standing `response_style`
(`standard`/`plain`, via `set_response_style`) — a per-caller preference
(`response_style_prefs`, keyed like `admin_digest_sends`) read alongside
`code_answers` on every turn; `plain` appends a short jargon-avoidance
instruction block to the system prompt. The same caller may also set a
standing `language_preference` (`auto`/`en`/`mi`, via
`set_language_preference`, issue #189) — a per-caller preference
(`language_prefs`, keyed the same way) read alongside `response_style`;
`en`/`mi` append a fixed instruction block telling the model to always reply
in that language regardless of the member's own message language, while `mi`
explicitly preserves the charter's existing te reo Māori caution (simple,
short, macrons preserved, Claude/API terms and code left in English) and
allows falling back to English for content it can't render accurately.
`auto` (the default) leaves today's per-message language-mirroring (issue
#68) completely unchanged. None of the router's silent-drop
conditions stay silent: hitting the rate limit, the daily budget, or (issue
#128) a super-admin `pause_bot` all send the member a static, debounced notice
instead of nothing — once per window per user (`src/rateLimitNotice.ts`, the
inline `budgetNotified` check, and `src/pauseNotice.ts` respectively), so none
of them read as the bot being broken. A push-side complement to the hard
cutoff above (issue #511, opt-in via `DAILY_REPLY_BUDGET_WARN_ENABLED`,
default off): once a non-super-admin caller's remaining daily replies fall to
`DAILY_REPLY_BUDGET_WARN_REMAINING` (default 5) or fewer, the router appends
one fixed line naming the remaining count to the real reply's text — never a
separate send, never replacing the model's answer, mirroring `offerEscalation`
(#479)'s append-only shape. It reuses the `used`/`limit` pair the daily-budget
check above already reads (no new query), is debounced to once per rolling
24h per caller (`budgetWarned`, same window and sweep cadence as
`budgetNotified`), and honours the caller's standing `'mi'`/`'plain'`
preference the same way the other fixed notices do. These three deterministic, non-agent
notices (issue #300) also honour a standing `'mi'` `language_preference`,
same as `community_guidelines` (#266): the debounced send reads
`getLanguagePreference` once per notified window and picks each notice's
fixed `_MI` constant instead of the English default. The gated-guest
member-only notice (sent on every addressed message from a gated guest that
reaches the static-notice branch, i.e. not rate-limited) gets the same
treatment (issue #363): a former member who set `'mi'` before being removed
and is now gated still sees the fixed, human-authored `GATED_NOTICE_MI`
translation, not the English notice — the mi branch is checked first and, if
hit, is served as-is instead of the dynamic, admin-naming English builder
(`buildGatedNotice`/`GATED_NOTICE`, issue #360) below. The auto-moderation
warn/block DMs (`Moderator.scan()`, `src/moderation/moderator.ts`) also honour
a standing `'mi'` preference (issue #333), same pattern: `getLanguagePreference`
is read once per flagged message (defensively, degrading to `'auto'` on
failure so a lookup error can never skip or delay warning/mute enforcement)
and picks `warnDmTextMi`/`blockedDmTextMi` instead of the English default. The
same treatment extends to the four membership/admin-grant and
suggestion/report-resolution DMs (`notifyMemberApproved`/`notifyAdminApproved`/
`notifySuggestionResolved`/`notifyReportResolved` in `src/agent/tools.ts`,
issue #331): each now takes the target's `platform`, reads their standing
preference, and picks the matching `_MI` variant (every status branch, for the
two resolution DMs), while the member's own echoed suggestion/report text stays
untranslated. The `code_answers` policy's own omitted/truncated note — appended
by `applyCodePolicy` to the model's own (already language-mirrored) reply — gets
the same treatment on the router's single main-reply send path (issue #339):
`runAgentTurn` surfaces the `languagePreference` it already resolves for the
system prompt on `AgentReply`, and the router threads a `'mi'` value into
`adapter.sendMessage`'s optional `language` field, picked up by each adapter's
`filtered()` helper. Every other `filtered()`/`sendMessage` call site (DMs,
poll question/answers, thread name/description, announce, warn) is untouched
and stays English-only. `runAgentTurn`'s own four fixed failure fallbacks —
internal-error, max-turns, generic non-success, and upstream usage-limit —
also honour a standing `'mi'` preference the same way (issue #396): gated on
`outcome.ok === false`, never on the text itself, so a genuine model answer
can never be substituted. The router's own CONFIRM/CANCEL intercept — the
deterministic, out-of-band path that handles a reply to a pending destructive
action, reachable by every tier via `forget_me`'s `guest`-floor confirm gate —
gets the same treatment (issue #405): the `'Cancelled.'` reply, the
tier-revoked-mid-TTL "permissions changed" outcome, and the authoritative
"⚠️ Pending: ..." notice `respond()` emits after a tool registers a new pending
action each pick a fixed `_MI` variant off the same `getLanguagePreference`
read, with `pending.description` embedded unchanged in both language variants
and the `CONFIRM`/`CANCEL` reply tokens left untranslated so
`classifyConfirmReply` keeps matching them. A tenth addition (issue #490)
closes the one gap #405 named out of scope: the generic `'Failed: '` shell
that fronts a `requireConfirm` outcome — whether `pending.execute()`'s own
return value or the router's own catch-block fallback — is now swapped for a
fixed `FAILED_PREFIX_MI` on a standing `'mi'` preference, leaving the dynamic
`result`/error text after it byte-identical to the English case; a plain
string-prefix match at the single existing send site, so it covers every
`requireConfirm` call site sharing that template without touching
`agent/tools.ts`. What stays out of scope and English-only: any bespoke,
non-`Failed:`-templated outcome/description string a `requireConfirm` tool
authors directly, and the symmetric `'Done: '` success shell (deferred — see
below). The five opt-in,
off-by-default shortcut-reply strings `respond()` uses to skip a full agent
turn — `ACK_REPLY_TEXT`, `KNOWLEDGE_SHORTCUT_SUFFIX`,
`GUEST_KNOWLEDGE_SHORTCUT_NUDGE`, `REPEAT_SHORTCUT_NOTICE`, and
`REPEAT_MAX_TURNS_SHORTCUT_NOTICE` — get the same treatment as the closing
installment of this series (issue #435): each reads `getLangPref` once (the
guest-knowledge site shares one read across its two strings) and picks its
`_MI` sibling. The repeat-question shortcut's replayed `cachedReplyText` (a
stored, already-served real answer) is left untranslated, same "translate the
shell, not the dynamic payload" discipline as #339/#405; the repeat-max-turns
shortcut instead swaps in the already-existing `MAX_TURNS_REPLY_MI` (issue
#396) alongside its own notice, since that failure text is itself a fixed
constant, not caller-derived content. Separately, the eleven deterministic
fallback/notice constants across `router.ts`/`core.ts`/`upstreamFailure.ts`
also gain a
fixed, human-authored `_PLAIN` counterpart honouring a standing `'plain'`
`response_style` (issue #430) — the sibling preference's own gap on this
exact non-model path, mirroring the `_MI` sweep mechanically via
`getResponseStyle` instead of `getLanguagePreference`. **`'mi'` takes
precedence over `'plain'`** whenever both are set (each call site only
consults `getResponseStyle` after `getLanguagePreference` resolves to
something other than `'mi'`), since every hand-authored `_MI` string is
already short and plain by the charter's own te reo Māori register.
`CANCEL_TEXT` deliberately has no `_PLAIN` counterpart (already at the floor
of simplicity), and the gated-guest notice's `_PLAIN` substitution applies
only to the static `GATED_NOTICE` fallback, never the dynamic, admin-naming
`buildGatedNotice` output.

## Onboarding (gated mode)

Two pieces make the default gated experience less friction-y without
weakening it:

1. **Welcome message.** The text itself is admin-configurable via
   `set_welcome_message` (issue #253, mirroring `set_community_guidelines`'s
   #212 pattern — a single free-text `policies` row, a 30s-cached getter with
   a documented default fallback, admin-tier + audited, no CONFIRM gate),
   falling back to a hardcoded per-platform default when unset.
   - **Discord**: off unless `DISCORD_WELCOME_ENABLED=true`. On join,
     `DiscordAdapter` sends a static, non-agent DM (no LLM call, no cost)
     pointing the new member at an admin; if their DMs are closed, it falls
     back to posting in `DISCORD_WELCOME_CHANNEL_ID` if configured. A
     rejoining member with a standing `set_language_preference('mi')`
     (issue #189) gets the admin-configured `welcome_message_mi` variant
     instead, if one is set (issue #282, same `_mi`-variant pattern as
     `set_community_guidelines`'s #266) — the appended guidelines stay
     default-language regardless.
   - **WhatsApp (Baileys)**: off unless `WHATSAPP_WELCOME_ENABLED=true`.
     `BaileysAdapter` subscribes to Baileys' `group-participants.update` and,
     on `action: 'add'`, posts ONE static, non-agent message **to the group
     itself** — never a 1:1 DM to the new participant, since an unsolicited
     DM to a stranger's number is exactly the kind of Baileys ban-risk
     pattern this avoids (see `docs/SECURITY.md`). Respects
     `WHATSAPP_ALLOWED_JIDS` and a per-group cooldown
     (`WHATSAPP_WELCOME_COOLDOWN_MINUTES`, default 180) that collapses both a
     simultaneous bulk add and a burst of sequential joins into a single
     message per window, so the bot can't turn into a per-join spammer in an
     active group.
   - **WhatsApp (Cloud API)** (issue #255): the Cloud API is 1:1-only with no
     group/membership concept, so there's no join event to hook — instead,
     off unless `WHATSAPP_CLOUD_WELCOME_ENABLED=true`, `WhatsAppCloudAdapter`
     treats a sender's own first-ever inbound message as the "join" moment.
     `onCloudMessage` checks `isKnownConversation('whatsapp', from)`
     (`src/storage/repository.ts`) after the sender-allowlist gate and before
     the message reaches the agent handler; if the sender has never been seen
     before, it sends ONE static, non-agent welcome (with guidelines appended
     if set) through the same filtered `sendText` path as every other reply,
     then processing continues to the sender's actual message as normal. An
     in-memory per-process `Set` closes the race where a burst of messages
     from the same brand-new number could otherwise both see
     `isKnownConversation` return `false` before the first is recorded. Like
     Discord/Baileys, it reads `set_welcome_message` (issue #253) via
     `getWelcomeMessage()`, falling back to the hardcoded
     `WHATSAPP_CLOUD_WELCOME_MESSAGE` when unset.
   - Either platform's welcome text is followed by the admin-configured
     community guidelines, if set (see below) — the two are independent
     `policies` keys, concatenated at send time, never through the model.
2. **Pending-access queue**. When a gated guest addresses the bot,
   `router.ts` upserts a row into `access_requests` (platform, user id/name,
   first/last-requested timestamps, request count) — deliberately *never*
   their message content, preserving the existing no-storage invariant for
   guests. Admins call `list_access_requests` to see who's waiting instead of
   relying on informal pings; `add_member` clears the row for that user once
   actioned.
3. **Server roster** (issue #47, extended to WhatsApp by issue #407). The
   Discord adapter records every `guildMemberAdd`/`guildMemberRemove` into
   `server_roster` (identity metadata only — see SECURITY.md) and
   idempotently backfills the current member list once on startup, skipping
   bots. No new gateway intent: the `GuildMembers` intent the bot already
   holds for role resolution streams these events anyway; a `GuildMember`
   partial is enabled so leaves of uncached members still fire. The Baileys
   adapter mirrors this for WhatsApp groups: `onGroupParticipantsUpdate`
   (already subscribed to `group-participants.update` for membership-cache
   invalidation and the welcome message) now also upserts/marks-left on every
   `add`/`remove`, scoped by `WHATSAPP_ALLOWED_JIDS` and independent of
   `WHATSAPP_WELCOME_ENABLED`, plus an idempotent startup backfill via
   `groupFetchAllParticipating()`; both exclude the bot's own number/LID. No
   new subscription, schema change, or repository function — `server_roster`,
   `upsertRosterMember`, and `markRosterLeave` were already platform-generic.
   `list_roster` (admin) answers "who joined this week?", "who joined but was
   never added as a member?" (the gated-mode onboarding queue — the exact
   conversion funnel `add_member` serves), and "who left?", with a
   total/joined/left weekly pulse line, for either platform. Rejoins clear
   `left_at` and bump `rejoined_count`. The WhatsApp multi-group caveat noted
   in the first version of this feature — a `remove` from one group marking
   the row "left" even if the person remains in another allowed group — is
   resolved (issue #501): before marking a `remove` as a leave,
   `onGroupParticipantsUpdate` checks live membership across every *other*
   `WHATSAPP_ALLOWED_JIDS` group via `groupFetchAllParticipating()` (the same
   call `conversationsForUser`/`backfillRoster` already make), matching
   phone/LID id forms the same tolerant way those two do, and skips the
   leave-mark if the person is still present anywhere else in scope. A thrown
   fetch degrades to the old unconditional mark-left (logged as a warning),
   never a silent skip. Two residual, self-healing gaps remain, both narrower
   than the original caveat: (1) a person who leaves *every* allowed group in
   the same tick may be read as still-present for one event if another
   group's live metadata hasn't yet reflected their departure — the next
   remove event or the nightly backfill corrects it; (2) a participant removed
   via a bare `@lid` JID with no resolvable phone number, who is present
   elsewhere only under a phone-address form Baileys doesn't reciprocally
   link back to that LID, still can't be matched — the same identity-linking
   limit already documented above for `lidToPhone`.
4. **Gated notice names an admin** (`src/gatedNotice.ts`, issue #360). The
   static "ask a community admin" pointer a gated guest gets on every
   addressed message named no one to ask. `listAdminDisplayNames(platform)`
   (`src/storage/repository.ts`) resolves display names for every
   `community_users` `role = 'admin'` row on that platform — same
   community_users→server_roster precedence as `resolveDisplayName` — and
   `buildGatedNotice` renders up to `GATED_NOTICE_MAX_ADMIN_NAMES` (3) of
   them into the notice (e.g. "Ask a community admin — Alice or Bob — ..."),
   TTL-cached (30s, mirroring `storage/policies.ts`) so this hot, repeated
   path never adds a DB round-trip per gated message. Zero resolvable names
   (fresh deploy, or admins with no stored/rostered display name) renders
   the unchanged static `GATED_NOTICE`, byte-for-byte — never an empty-list
   sentence. Env-sourced super admins are excluded, same rationale as
   `listAdmins()`'s digest recipients: operator-level, not a member's first
   point of contact. Every name is run through `sanitizeName`
   (`src/agent/systemPrompt.ts`) inside `renderGatedNotice` before
   interpolation — same treatment `resolveSanitizedLabel` gives any other
   platform-supplied display name (issue #227) — because this notice is
   auto-sent, unsolicited, to every gated guest, and a `display_name` sourced
   from a Discord nickname has no length or newline limit an admin couldn't
   abuse to forge Markdown link syntax or a fake system message. A name that
   sanitizes to empty is omitted, not shown blank.
5. **Real-time access-request alert** (issue #480, off unless
   `ACCESS_REQUEST_ALERT_ENABLED=true`). The pending-access queue above is
   pull-only (`list_access_requests`) plus a passive weekly digest count
   (issue #133) — this closes the gap with a push notification the moment a
   gated guest's addressed message creates a FRESH `access_requests` row.
   `recordAccessRequest` reports insert-vs-update via Postgres's own
   `xmax = 0` trick on its `RETURNING` clause — no new column or query shape —
   and `router.ts` fires `notifyAccessRequest` only when that read reports
   `inserted === true`; a repeat ping from the same still-pending guest
   (`inserted === false`) never notifies again, so the upsert's own dedup IS
   the debounce. Guild-wide `listAdmins()` audience, same recipients the
   weekly digest's `pendingAccessRequests` count already reaches — not
   `superAdminIds()`, since this is routine admin business. The DM names only
   the guest's platform and (`sanitizeName`-cleaned) display name, never
   message content, matching `access_requests`' own storage contract. A
   guild-wide rolling-hour cap (`ACCESS_REQUEST_ALERT_RATE_LIMIT_PER_HOUR`,
   default 10) bounds worst-case DM volume under a raid; once exhausted, later
   first-time requests in that hour are still recorded (so nothing is lost —
   `list_access_requests`/the digest still see them) but do not notify, and a
   fresh hour resumes notifying. Never routed through the agent/model loop —
   this is a router-level side effect off an existing DB upsert's return
   value, so it adds no new prompt-injection surface. `add_member`'s existing
   `clearAccessRequest` call means the next gated address from that same user
   after being added (and later, if regated) is treated as a fresh insert and
   notifies once more.
6. **`community_info` names every tool the caller actually has.** The
   `community_info` tool (issue #92) answers "what can you do?" with
   `MEMBER_CAPABILITIES_TEXT`, a plain-language line for every `MEMBER_TOOLS`
   entry, pinned against drift by an anti-drift coverage test (issue #311).
   An admin/super_admin caller additionally gets `ADMIN_CAPABILITIES_TEXT`
   (issue #367) — the same discipline applied to `ADMIN_TOOLS`, replacing the
   old one-line "ask what's new" pointer the grant DM (`ADMIN_APPROVED_MESSAGE`,
   issue #201) had promised would give "a rundown, including your new admin
   tools" but never did.

## Offline context builder

`src/context/builder.ts` (issue #51) is the learning step on top of storage:
a ~daily in-process job (timer in `src/index.ts`, mirroring the retention
purge; off unless `CONTEXT_BUILDER_ENABLED`) that reads across the window's
inbound interactions, greedily clusters them by embedding similarity (same
pgvector-fed technique and threshold as `question_digest`), and writes each
recurring theme to `context_digests` as a topic label + model-written
aggregate summary + interaction-id refs. Admins read them via
`list_context_digests`.

Guardrails, all enforced in code (binding conditions from the issue review):

- **Hard cost cap**: at most `CONTEXT_BUILDER_MAX_SUMMARIES` tool-less,
  single-turn model calls per run — a busy window truncates (logged), never
  overruns — and a run is skipped outright while the rolling-24h reply count
  is at/over `USAGE_ALERT_DAILY_REPLIES`, so background analysis can't drain
  the shared Max pool a busy live bot is using.
- **k-floor** (`CONTEXT_BUILDER_MIN_DISTINCT_USERS`, ≥2): clusters carried
  by fewer distinct authors are dropped (logged) so a digest never becomes a
  de-facto profile of one person.
- **Deletion coherence**: digests store interaction *ids*, never copied
  content, and `purgeUserData` invalidates any digest referencing a purged
  interaction — the next run regenerates the topic without that person.
  Digests deliberately survive the age-based retention purge (that's their
  point); only privacy purges invalidate them.
- **Restart-safe cadence**: the timer ticks 6-hourly but a freshness guard
  on the last digest's `created_at` makes it ~one run per day, so the
  nightly redeploy restart can't double-run it.

Each per-cluster summarisation call is tool-less, single-turn, and
fixed-format, so its model is optionally tiered by the same
`AGENT_MODEL_CLASSIFIER` knob as the moderation LLM abuse check above (issue
#394) — unset (default) it uses `AGENT_MODEL` unchanged.

### Knowledge candidates (issue #102)

The `knowledge_candidates` review queue deferred from #51 turns a digest
into a durable `knowledge` entry without an admin composing `save_knowledge`
from scratch. Behind `CONTEXT_CANDIDATES_ENABLED` (off by default, and a
no-op while the builder itself is off), the SAME per-cluster summarisation
call that writes a digest also asks whether the cluster is one stable,
answerable question and, if so, drafts a Q&A candidate — **no extra model
call**, so the builder's hard per-run cost cap is unchanged with this on.

- **Human-curated, like `knowledge` generally**: a candidate lands in
  `knowledge_candidates` as `'pending'`. Nothing reaches `knowledge` (and
  therefore no tier's `knowledge_search`) until an admin calls
  `accept_knowledge_candidate`, which publishes via the existing
  `save_knowledge` path (so the #93 near-duplicate nudge and embedding path
  apply unchanged) and marks the candidate accepted. `decline_knowledge_candidate`
  is a non-destructive status flip (no CONFIRM) that retains the row as
  `'declined'` rather than deleting it. `list_knowledge_candidates` is the
  admin browse view. All three tools are admin-tier only.
- **Dedup guard**: the builder skips drafting a candidate whose topic
  already has a `knowledge_candidates` row in *any* status (including
  `'declined'` — a decline must stick on the very next run, not just until
  the cluster re-summarises to the same topic label) or whose topic an
  existing `knowledge` entry already covers above the relevance floor
  (`KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD`). The topic match itself is two
  layers (issue #503): a cheap exact (case-insensitive) string comparison
  first, then — only when that misses — a semantic check against every
  stored `topic_embedding` at/above `KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD`
  (0.92, the same bar `saveKnowledge`'s near-duplicate nudge uses), so a
  declined topic re-drafted under different wording on a later run (the
  free-text `TOPIC:` summary has no stability guarantee across runs) still
  gets caught. `candidateTopicAlreadyReviewed` computes the topic's
  embedding at most once per attempted cluster and reuses that same vector
  for the semantic check, `knowledgeCoversTopic`, and the candidate insert
  itself — no added local-embedding cost. Fails open (not blocked) on an
  embedding error, same posture as `knowledgeCoversTopic`. `topic_embedding`
  is nullable and **not backfilled** for rows inserted before this column
  existed — those older rows are still covered by the (unchanged) exact-match
  path but never surface a semantic match, mirroring this repo's existing
  non-retroactive precedent (e.g. #197's `is_dm`). The column is
  write-and-compare-only: never returned by `list_knowledge_candidates`,
  `accept_knowledge_candidate`, or `decline_knowledge_candidate`, matching
  `knowledge.embedding`/`knowledge_gaps.embedding`.
- **Deletion coherence inherits from #51**: a candidate's `topic` is
  denormalized from its source digest at insert time. When a purge
  invalidates a digest, its still-*pending* candidates are deleted with it;
  accepted/declined candidates survive (their digest FK is `ON DELETE SET
  NULL`) with the same accountability treatment as `knowledge`/`admin_audit`
  generally.

### Knowledge gaps (issue #208)

`question_digest`, `countStaleKnowledge`, and `knowledge_candidates` each
surface a different curation signal, but none of them looks at
`KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD` — the mechanism that decides, on
every member turn, whether a `knowledge_search` hit was confident enough to
serve. That decision used to be made and thrown away in the same request;
`knowledge_gaps` persists it as the miss-specific complement to
`question_digest`:

- **Hook point**: inside the existing `knowledge_search` handler, after
  `hits` is filtered by the relevance floor. If `hits.length > 0 &&
  relevantIds.length === 0` — hits existed but none cleared the floor — the
  handler first tries `searchKnowledgeLexical` (issue #362), a substring-robust
  `pg_trgm` `word_similarity()` fallback for the input class dense sentence
  embeddings underweight (rare SNAKE_CASE/camelCase identifiers, error codes)
  that a member may paste verbatim even though a `knowledge` entry contains
  the literal string. Only if that also comes up empty does the handler
  fire-and-forget `recordKnowledgeGap(caller.platform, caller.conversationId,
  caller.userId, args.query)` — a lexical-fallback hit is served (and
  recorded as a retrieval, same as a semantic hit) instead. The `hits.length >
  0` guard matters: `searchKnowledge` also returns `[]` on an `embed()`
  failure, and gating on "zero hits" alone would silently log every query
  during an embedding outage as a genuine knowledge gap.
- **Storage**: a dedicated `knowledge_gaps` table (query text, capped at 500
  chars, plus the same local `embed()` vector every other memory/knowledge
  feature uses — no paid model call). Same rolling-24h per-`(platform,
  user_id)` insert cap as `answer_feedback`/`suggestions` (`
  KNOWLEDGE_GAP_DAILY_LIMIT`, 20/day) so a chatty or adversarial member can't
  flood the signal with junk queries.
- **Read side**: `list_knowledge_gaps` (admin-tier, conversation-scoped via
  `callerScope()`) clusters recent gap rows by embedding similarity — the
  exact same greedy cosine-similarity clustering `recentQuestionClusters`
  uses, just sourced from `knowledge_gaps` instead of `interactions` — and
  returns "asked N times, never confidently answered" topics, `untrusted()`-
  wrapped like `list_suggestions`/`list_reports`/`list_knowledge_candidates`
  since it's member-authored text an admin reads. `args.query` is the
  model's reformulated search string, not necessarily a member's verbatim
  message, so both the tool description and this doc frame entries as
  "searches with no confident answer," not "member questions."
- **Purge coherence**: `forget_me`/`purge_user_data` delete the caller's own
  `knowledge_gaps` rows, same treatment as `suggestions`/`content_reports`/
  `answer_feedback`. No dedicated age-based retention timer — purge-on-request
  only, same precedent as those three tables. Deleted regardless of the
  resolution state below.
- **Resolution (issue #422)**: a gap used to sit in `list_knowledge_gaps`/the
  digest count for up to 30 days even after an admin fixed it, because both
  read paths only filtered on `created_at`. `save_knowledge` and
  `update_knowledge` now reuse the embedding they already compute for their
  own write to run one extra `UPDATE`: any *unresolved* `knowledge_gaps` row
  that now clears `KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD` against the new/
  edited content is stamped `resolved_at = now()` — the exact inverse of the
  recording rule above, so it's internally consistent by construction (a
  future identical query would no longer record a gap). Fire-and-forget, like
  `recordKnowledgeGap`: a resolution failure never blocks the save/update.
  Scope-filtered like `searchKnowledge`'s visibility model, but *narrower* for
  the conversation-scoped case: a `global`-scope entry may resolve any
  matching gap, a platform-scoped entry only gaps on that platform, and a
  conversation-scoped entry only gaps on that *same platform and*
  conversation — never cross-platform, even if a conversation id string
  happened to collide across platforms. `list_knowledge_gaps`/
  `recentKnowledgeGapClusters` and the digest's `countKnowledgeGaps` both add
  `resolved_at IS NULL`, so a resolved gap disappears immediately rather than
  waiting out the `created_at` window.
  `saveKnowledge`/`updateKnowledge` are shared by every knowledge write, not
  only the admin `save_knowledge`/`update_knowledge` tools — the daily
  research refresh and docs-ingest backfill (`createdByRole: 'auto'`/`'docs'`)
  go through the same functions. Gap resolution is gated on
  `createdByRole !== 'auto'`: an unreviewed, machine-scraped 'auto' entry
  (already quarantined/untrusted at retrieval) must never silently clear the
  "never confidently (human-)answered" signal with zero human curation. A
  trusted `'docs'` backfill or any human-authored entry (admin `save_knowledge`
  /`update_knowledge`, or `accept_knowledge_candidate`'s admin-reviewed
  publish) may resolve gaps as normal.

On top of the digests sits the **anonymised community-context export**
(issue #53, `CONTEXT_EXPORT_ENABLED`): after a producing builder run,
`src/context/export.ts` regenerates its copy at `CONTEXT_EXPORT_PATH` —
aggregate-only (its own k-floor + PII scrub; the egress boundary lives in
SECURITY.md). That default path is an **untracked** `var/` file (issue
#108), not the committed `docs/COMMUNITY-CONTEXT.md` — the exporter running
unattended on the server must never dirty a tracked file (it would
permanently wedge the nightly redeploy's clean-tree check, #50). A human
periodically points `CONTEXT_EXPORT_PATH` at `docs/COMMUNITY-CONTEXT.md`,
runs `npm run export:context` against production, reviews, and commits —
which the research loop then reads (file-only, no DB access).

## Anthropic status check

`src/status/anthropicStatus.ts` (issue #206, off unless
`STATUS_CHECK_ENABLED`) answers the most common support question in any
Claude/API community — "is this me, or is Anthropic having an incident?" —
with an authoritative source instead of general knowledge. A background
timer (`startStatusCheck` in `src/index.ts`, same shape as `startDocsIngest`)
polls Anthropic's official public Statuspage summary endpoint
(`STATUS_CHECK_API_URL`, defaulting to the real endpoint, override-only,
`https://`-enforced) every `STATUS_CHECK_POLL_MINUTES` and parses it into a
small in-memory cache — no new DB table, no migration, since the data is
already public, ephemeral, and re-fetchable.

The member-tier `check_status` tool (no arguments, read-only) reads ONLY
that cache — a member's turn never triggers a live fetch. A fetch failure or
a malformed response body both degrade to the last-known-good cached value
(with its age stated) rather than an error; before the first successful poll
it says so plainly rather than guessing "operational". The formatted message
also never asserts "no known incident" means the member's own issue is on
their end — Anthropic's status page can lag or omit partial/region/model-
specific degradations, so it's evidence, not proof.

No model is in the fetch/parse loop — deterministic JSON parsing of one
fixed, official, first-party HTTPS source, the same trust framing docs
ingest already establishes (see SECURITY.md).

## Suggestion capture

`suggest_improvement` (issue #46) closes the "the suggestion died in chat"
gap: when a member proposes something the bot should do, the idea now lands
in a triageable `suggestions` queue instead of evaporating (or being
shoehorned into a knowledge note). Same pull-queue shape as
`access_requests` and `content_reports`:

1. A member calls `suggest_improvement(content)` — capped at 3 per rolling
   24h with the same DB-backed count-inside-insert pattern as
   `report_content`, and capped at 1000 chars server-side. The bot confirms
   capture and sets expectations ("a human reviews these; no promises").
   Members have **no read path**: the queue is write-only at member tier.
2. Admins triage with `list_suggestions` (content `untrusted()`-wrapped — a
   suggestion is member-authored text aimed at an admin turn, i.e. an
   injection vector) and `resolve_suggestion` (reviewed/declined/done,
   audited, non-destructive so no CONFIRM). Resolving a suggestion best-effort
   DMs the submitter naming the outcome (`notifySuggestionResolved`, issue
   #116, same fire-and-forget shape as `notifyMemberApproved`), routed through
   the suggestion's *origin* platform's adapter rather than the resolving
   admin's current-turn one (issue #157, via the `getAdapter` lookup threaded
   from `Router`'s adapter registry) — see SECURITY.md's residual risks for
   the single-platform-deployment limitation that remains.
3. **The bridge to the pipeline stays human**: an admin files anything
   worthwhile as a GitHub `proposal` issue themselves. The bot never touches
   the repo — untrusted chat must never be able to write into the issue
   queue a build worker implements from (see SECURITY.md).

`forget_me`/`purge_user_data` delete the user's suggestions.

## Member context notes

`member_notes` (issue #45) gives admins a person-scoped home for durable
facts about a member ("runs the Chch meetup", "is the Claude Ambassador")
that previously had nowhere to live except the **global** knowledge FAQ —
the wrong container, since `knowledge_search` surfaces entries to every
tier. Notes are keyed to known `community_users` identities (unknown targets
refused, same validation pattern as the membership tools), capped at 1000
chars, human-entered only, and readable exclusively through the admin-tier
`list_member_notes` (content `untrusted()`-wrapped — notes are data, never
instructions). Writes and deletes are audited without the note text, and
deletion is CONFIRM-gated (same as `delete_knowledge`);
`forget_me`/`purge_user_data` delete the subject's notes. See SECURITY.md
for the privacy boundary and the owner-accepted no-self-access decision.

## Abuse reporting

`report_content` closes a gap neither platform covers on its own: a member
who is harassed, spammed at, or sees a rule violation had no structured way
to flag it to *this community's* admins (Discord's native report goes to
Discord Trust & Safety, not the server; WhatsApp has nothing at all). It's
the same pull-queue shape as `access_requests`/`list_access_requests`,
applied to abuse reports instead of pending guests:

1. A member (or admin/super admin) calls `report_content(reason,
   targetUserId?, messageId?)`. The conversation is always the caller's
   current one — a member can only report within a conversation they're
   actually in. Capped at 5 submissions per rolling 24h, enforced with a
   DB-backed count (survives a restart; see SECURITY.md), so the queue
   itself can't become a spam vector against admin attention. Filing a
   report also proactively DMs every super admin (`notifyReportFiled`,
   issue #90, same fire-and-forget shape as `notifySuperAdmins`'s other
   callers) instead of relying on someone remembering to poll
   `list_reports` — the reporter-supplied reason is quoted so it can't
   cosmetically impersonate the alert's own `🔔` system prefix.
2. Admins triage with `list_reports` (conversation-scoped, same pattern as
   `moderation_history`) and `resolve_report` (marks `resolved`/`dismissed`,
   audited, non-destructive so no CONFIRM gate). Resolving a report
   best-effort DMs the reporter naming the outcome (`notifyReportResolved`,
   issue #120, same fire-and-forget shape as `notifySuggestionResolved`),
   routed through the report's *origin* platform's adapter the same way
   `resolve_suggestion` is (issue #157) — see SECURITY.md's residual risks
   for the single-platform-deployment limitation that remains.
3. No automation beyond intake: the queue is purely informational. Admins
   still decide and act via the existing `moderate` tool.

`list_reports` is conversation-scoped, but a report filed from a DM (no
ordinary admin is ever a "participant" of another member's 1:1 conversation)
is additionally surfaced to every admin via `is_dm`, except one filed
against the viewing admin themselves, which stays reachable only by a super
admin (issue #197) — see SECURITY.md's note on this.

## Answer feedback

`rate_answer`/`list_answer_feedback` (issue #118) close the deferred half of
#60: #60 taught the model to attribute knowledge-base answers and flag
general-knowledge ones, but explicitly deferred a rating mechanism as its own
proposal. There was previously no calibrated signal on whether an answer
actually helped — only that one was sent. Issue #366 closed a parity gap on
the attribution side: `formatKnowledgeCitationNote` (issue #214) has always
computed a real `source: <label> (<url>) · last verified <age>` clause for a
trusted, `source_url`-bearing `knowledge_search` hit, but until #366 the model
was told to drop it in favour of an informal, linkless "per our community
notes..." — even though the deterministic knowledge shortcut (below) already
relayed that same clause verbatim. The model-mediated path now relays the
real link and date too when the tool result carries one, at parity with the
shortcut path, while still forbidding it from ever surfacing a URL lifted
from a hit's content body rather than the tool-computed citation clause.

1. A member (or admin/super admin) calls `rate_answer(helpful: boolean)`. No
   free-text input at all — a smaller surface than `report_content`/
   `suggest_improvement`, which was the explicit condition #60 set for
   revisiting this. The handler resolves the interaction to bind to via
   `repository.ts`'s `resolveAnswerFeedbackTarget`: it prefers the caller's
   OWN most recent outbound reply in the current conversation
   (`meta->>'replyToUserId' = caller`, the same stamp `router.ts` writes on
   every send and `countRepliesToUser`/`purgeSingleIdentity` already key on),
   falling back to the conversation's most-recent outbound reply only when no
   caller-scoped match exists (e.g. a row predating that meta field). Without
   the caller-scoped preference, a busy multi-member Discord channel could
   silently bind member A's "thanks, that helped" to the answer the bot just
   gave member B. Capped at `RATE_ANSWER_DAILY_LIMIT` (default 20) per rolling
   24h, the same DB-backed count-inside-the-insert pattern as
   `report_content`/`suggest_improvement`; higher than those two because a
   rating carries no admin-triage cost per submission, so the cap only needs
   to bound DB writes. If there is no answer to bind to yet, the tool declines
   gracefully rather than recording a meaningless row.
2. The system prompt's `GUIDELINES` pin a conservative trigger: call
   `rate_answer` only on a clear, explicit member cue about the bot's own
   last answer ("that helped, thanks" / "that's wrong" / a 👍 or 👎) — never
   on general positivity or ambiguous chatter. A missed rating is harmless; a
   wrong one corrupts the aggregate signal this feature exists to produce.
3. Admins read the aggregate with `list_answer_feedback(unhelpfulOnly?)`,
   conversation-scoped exactly like `list_reports`/`moderation_history`. No
   member-tier read path exists — a member can only ever write their own
   rating, never browse the queue.
4. `forget_me`/`purge_user_data` delete the rater's own `answer_feedback`
   rows. If the *rated* interaction is later purged (the recipient's own
   forget_me/purge, a different identity than the rater), the
   `interaction_id` foreign key is `ON DELETE SET NULL`, so the row survives
   with its interaction reference cleared rather than being deleted or left
   dangling — the aggregate helpful/unhelpful trend stays intact.
5. `list_low_rated_knowledge(minUnhelpful?, limit?)` (issue #287) is the
   grouped complement to `list_answer_feedback`'s flat per-row view: it
   `GROUP BY`s `answer_feedback` on `(interactions.meta->>'knowledgeEntryId')`
   through the SAME join and conversation-scope filter, so an entry's
   accumulating unhelpful ratings are visible without manually tallying
   scrollback. Only entries with `unhelpfulCount >= minUnhelpful` (default 2,
   so a single troll/misclick rating never flags an entry) are returned,
   sorted worst-first. Ratings on interactions with no `knowledgeEntryId`
   still never join to a `knowledge` row and so are never counted.
   `knowledgeEntryId` used to be stamped only by the deterministic knowledge
   shortcut, which meant the model-mediated `knowledge_search` path — the
   common case — was invisible to this tool no matter how many times its
   answers were rated unhelpful (#269/#287 explicitly deferred fixing this as
   over-scoped for one PR). Issue #411 closes that gap: `knowledge_search`'s
   handler now writes the top-scoring id of its most recent hit that clears
   `KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD` into a turn-scoped ref
   (`buildToolServer`'s `ToolServerTurnState`), which threads through
   `TurnOutcome`/`AgentReply` (the same pattern `languagePreference`/
   `maxTurnsExceeded` already use) into the router's normal outbound-record
   `meta.knowledgeEntryId` — the identical key the shortcut path writes, so
   neither aggregation query changed. This is a **best-effort correlation**,
   not a guarantee: it names the last qualifying `knowledge_search` call in
   the turn, not necessarily the entry the model's final prose actually drew
   from (e.g. a multi-topic turn that queries twice and answers from the
   first hit stamps the second). Treat a flagged entry as a strong lead worth
   reading, not as proof that entry caused every attributed unhelpful rating.
6. `KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL` (off by default, issue #337)
   gates a member-facing caveat appended to a served hit once its unhelpful
   count clears the threshold, prompting the member to `rate_answer` too.
   Issue #337 shipped this only on the deterministic knowledge-shortcut path
   (`sendKnowledgeShortcut`); `knowledge_search` — the dominant path, since
   the shortcut only fires above `KNOWLEDGE_SHORTCUT_THRESHOLD`'s strict 0.9
   cosine floor — always rendered the caveat off regardless of config. Issue
   #432 closes that display-side asymmetry the same way #411 closed the
   matching attribution one: the handler batches a lookup
   (`areKnowledgeEntriesLowRated`) over every hit that cleared the relevance
   floor and threads the resulting id set into `formatKnowledgeSearchResults`,
   which appends the caveat to each low-rated hit's own line — never as a
   single result-wide line like the conflict caveat (#389) above it.

## Auto-moderation (Discord)

Where `report_content` is a member-initiated pull, auto-moderation is a
proactive push: when `DISCORD_MODERATION_ENABLED` is on, the Discord adapter
scans **every** in-scope guild message (not just ones addressing the bot) via
`src/moderation/`. It is off by default and a privacy-posture change when
enabled (every message is inspected) — treat it like ambient archiving.

- **Two-stage classifier** (`makeClassifier`): Stage 1 is a zero-cost,
  case-insensitive, whole-word wordlist (`MODERATION_BAD_WORDS` on top of a
  small built-in default) that catches bad language on every message. Stage 2
  (`MODERATION_LLM_ABUSE_ENABLED`, off by default) escalates only
  wordlist-clean messages to a single tool-less LLM abuse check — one Claude
  call per escalated message on the shared Max pool, so it's opt-in. That
  call's model is optionally tiered by `AGENT_MODEL_CLASSIFIER` (issue #394):
  unset (default) it uses `AGENT_MODEL` like every other call; set, it runs
  the fixed-format, tool-less classification on a lighter model instead.
- **Strikes** live in `member_warnings` (keyed on raw `(platform, user_id)`,
  like `response_style_prefs`). Each detection records one `source='auto'`
  warning; the member gets a warning DM and the alert goes to a private
  admin channel. **Admins and super admins are never warned or muted** —
  `isExempt` uses the same role resolution the router does.
- **Block at the limit**: once a member's *active* (uncleared) strike count
  reaches `MODERATION_STRIKE_LIMIT` (default 3) the bot assigns a **muted
  role** (created on demand, with deny-SendMessages overwrites on every text
  channel) so they can no longer post, and posts a block alert to the admin
  channel. The muted role is real Discord enforcement, not just the bot
  ignoring them. `MODERATION_STRIKE_WINDOW_DAYS` (optional, unset/unbounded by
  default) lets an admin age old strikes out of that active count via
  `countActiveWarnings`' optional rolling window, so an isolated old strike
  doesn't count toward the limit forever — it never deletes rows or
  auto-unmutes; `clear_warnings` is still the only way to lift a mute, and
  the rejoin re-mute check ignores the window entirely (anti-evasion: on
  rejoin every uncleared strike counts, whatever its age).
- **Admin channel**: the bot creates a private `mod-alerts` channel on demand
  (denied to `@everyone`, allowed to the bot + configured super admins;
  Discord Administrators see it regardless) and posts every warning and block
  there — up to a guild-wide rolling-hour cap (`MODERATION_ALERT_RATE_LIMIT_PER_HOUR`,
  default 30, issue #517): once exhausted, further alerts from `scan()`
  collapse into one summary line reporting the exact suppressed count instead
  of one message per hit, so a raid/flood can't bury the channel in
  near-duplicate posts. Enforcement (the warning DM, mute, and audit trail)
  is never gated by this cap — only the admin notification throttles.
- **Clearing**: the admin-tier `clear_warnings(targetUserId)` tool clears all
  of a member's active warnings (stamping who/when) and lifts the mute (a new
  `unmute_user` adapter action removing the role). It's lenient/reversible so
  it isn't CONFIRM-gated, and any admin can clear anyone's warnings. Clears are
  audited and surface in `moderation_history`.
- **Reading**: `list_member_warnings(targetUserId)` (issue #410) is the
  admin-facing counterpart `my_warnings`' docstring always promised — a
  chronological, reason/excerpt-included view of one member's `member_warnings`
  rows (both `source: 'auto'` and `source: 'admin'`), since `moderation_history`
  reads only `admin_audit` and structurally can't surface auto-detected
  strikes. Same `(platform, userId)`-only scope as `clear_warnings`.
- **Appeal**: `my_warnings` gave a member visibility into their own
  moderation status but no way to act on it — `appeal_moderation` (issue
  #496) is that missing action, a member/guest-tier tool with the same
  self-scoping discipline as `my_warnings`: it reads the caller's own
  `countActiveWarnings(caller.platform, caller.userId)` only (never a
  tool-argument-supplied id) and refuses cleanly ("no active warnings to
  appeal") when it's zero, so it can't become a generic side channel to
  message admins — `suggest_improvement`/`report_content` already cover that.
  An eligible caller may attach one optional, sanitized, length-capped free-
  text reason (same bound as `report_content`'s `reason`); calling it
  proactively DMs super admins via the SAME `notifySuperAdmins` fan-out
  `notifyReportFiled`/`notifyReportWithdrawn` already use (`notifyAppealFiled`)
  — no new conversation-scoped push helper. Rate-capped **per caller**, not
  per-conversation (an appeal is about one person's own status), one per
  `MODERATION_APPEAL_COOLDOWN_HOURS` (default 24h) — an in-memory,
  best-effort cap, deliberately no new table for the MVP. Never itself
  changes a warning count or mute state: resolution stays exactly
  `clear_warnings`.
- **Enumerating**: `list_muted_members()` (issue #487) answers "who is muted
  right now", the question `list_member_warnings` structurally can't (it
  requires an already-known `targetUserId`) and the digest's bare `🔇 N`
  count (issue #357) was never meant to answer. It unions `countMutedMembers`'
  and `countStaleMutedMembers`' (issue #403) predicates into one identity
  list — each row tagged `active` (currently over the windowed strike limit)
  or `stale` (over the unwindowed limit only — strikes aged out of the
  window but never explicitly cleared, so the member *may* still be muted;
  the tool hedges this explicitly, never asserting it as confirmed), with
  strike count and last-warning timestamp. Never reason/excerpt — that stays
  behind `list_member_warnings`. Same guild-wide, non-conversation-scoped
  boundary as `clear_warnings`; capped at 50 rows, newest first.

Enabling requires the bot to hold **Manage Roles** and **Manage Channels** —
see SECURITY.md for the blast-radius and enforcement caveats.

## Cross-platform identity linking

One human is often two unrelated `community_users` rows — a Discord account
and a WhatsApp number — with heavy overlap being the norm for this community.
Without linking, `forget_me`/`purge_user_data` only erase one platform
identity, and `DAILY_REPLY_LIMIT_PER_USER` can be double-dipped by switching
platforms.

- **Schema**: a `persons` table plus a nullable `community_users.person_id`
  FK. No backfill — links are created explicitly, never inferred.
- **`link_member(platformA, userIdA, platformB, userIdB)`** groups two
  identities into one person (or merges their existing groups). Both must
  already be known community members. Admin tier, CONFIRM-gated, audited,
  super-admin-alerted — the same pattern as every other privileged tool.
- **`unlink_member(userId, platform?)`** removes an identity from its group;
  if that leaves fewer than two linked identities, the whole group is
  dissolved (no dangling `person_id`, no orphaned `persons` row).
- **Effects of a link**: `resolveLinkedIdentities` (repository.ts) is the one
  place that expands a single identity into its full linked set. `forget_me`/
  `purge_user_data` and the daily reply budget (`countRepliesToUser`) both
  consult it, so either now operates across every linked identity. `user_history`
  surfaces the linkage to admins.
- **Invariant: tier never propagates.** Linking never touches `role` — a
  member linked to an admin still resolves as member-only. See SECURITY.md
  for the accepted blast-radius trade-off this design makes (linking expands
  what a single `forget_me` call erases) and the tests that pin both
  invariants.

## Auto-answer mode (Discord, opt-in)

`AUTO_ANSWER_CHANNEL_IDS` (issue #477) lets an operator allowlist specific
Discord channels (typically help/forum channels) where a top-level human post
gets an answer even when it doesn't mention/reply to the bot. Unset/empty is
the default and is byte-identical to today's behaviour — the router's summon
gate (`!msg.addressedToBot && !msg.isDirect`) only relaxes for a message whose
`conversationId` is in the allowlist, is on Discord, and isn't
bot/webhook-authored (`IncomingMessage.isBotAuthor`, a router-level backstop
alongside the adapter never constructing a message for one in the first
place).

Everything downstream of that one relaxed check is reused verbatim — role
resolution (`resolveRole`), the gated-guest exclusion (evaluated earlier in
`handle()`, so it applies to auto-answer for free), the tier-derived tool
surface (`toolsForRole`), the per-user rate limit, the daily reply budget, and
the repeat-question/repeat-max-turns shortcuts. Two things are genuinely new:

- **A per-channel rolling-hour cap** (`AUTO_ANSWER_RATE_LIMIT_PER_HOUR`,
  default 10), a sliding-window limiter local to `Router` mirroring
  `agent/tools.ts`'s `reserveAnnounceSlot` shape but operator-tunable, since
  an allowlisted channel's traffic is far less predictable than the
  admin-only `announce` tool's.
- **Threaded replies.** The router asks the adapter
  (`PlatformAdapter.startAutoAnswerThread`, Discord-only, optional — same
  `channel.threads.create({ name, startMessage })` primitive as
  `create_thread`'s admin action) to open a thread anchored to the origin
  post, then redirects every send for that turn (including a shortcut hit)
  into the new thread via an optional `replyConversationId` parameter threaded
  through `respond()`/`sendKnowledgeShortcut()`/`sendRepeatShortcut()`/
  `sendRepeatMaxTurnsShortcut()`. Caching keys (`convoKey`/`callerKey`, and
  therefore the repeat-question shortcut and per-user rate limit) stay keyed
  on the **parent channel**, not the newly created thread — each auto-answered
  post gets its own thread, but "the same member asking the same thing again
  in this channel" still needs to match across threads for the shortcut to
  fire. A thread-creation failure degrades to answering directly in the
  channel rather than dropping the reply.

**Thread follow-ups (issue #519).** The summon gate above only ever matched
the *channel* a message was posted in, so a member's own follow-up typed
inside the auto-answer thread it just opened — "what about X", "that didn't
work" — reported the thread's own id as `conversationId`, never a member of
`autoAnswerChannelIds`, and silently reverted to mention-required one message
into the exact back-and-forth the feature exists for. The router closes this
by also treating a message as an auto-answer candidate when its
`conversationId` is a live entry in `autoAnswerThreadParents` — the same
thread → parent-channel map, and the same creation-anchored
`ESCALATION_WINDOW_MS` (10 min) TTL, the CONFIRM/CANCEL and escalation
intercepts already consult to resolve a thread reply back to its parent. Two
follow-on adjustments keep this correct, not just permissive:

- A follow-up reply is sent **into the existing thread** (`replyConversationId
  = msg.conversationId`) — `startAutoAnswerThread` is only called for the
  origin post in the parent channel, never for a message already inside a
  known thread, so a live back-and-forth never spawns a second thread.
- The per-channel rolling-hour cap (`reserveAutoAnswerSlot`) is reserved
  against the **parent** channel id, not the thread id, for a thread
  follow-up exactly as for the origin post — the thread id has never had a
  slot reserved against it, so keying on it would open an uncapped
  side-channel around `AUTO_ANSWER_RATE_LIMIT_PER_HOUR`.

The TTL is **not refreshed** by a follow-up — it is set once, at thread
creation, and only counted down from there. A back-and-forth that outlives
the 10-minute window from the thread's creation reverts to mention-required,
same as any other expired entry in this map; there is no indefinitely
auto-answerable thread. This is a deliberate scope limit for the smallest
viable version, not a defect — a longer or refreshing TTL is a named growth
path if it proves too tight in practice.

Discord-only by construction (WhatsApp/Baileys auto-answer carries separate
ToS/ban risk — a different, deferred proposal); see docs/SECURITY.md §14 for
the full security posture and its test references.

## Concurrency model

- The router **serialises turns per conversation** (a promise chain keyed by
  `platform:conversationId`) because session resume is not safe to run
  concurrently for the same session.
- Different conversations run in parallel.
- A light **per-user rate limit** (8 msg / 60s) protects against spam and
  runaway cost.
- **Shutdown drains in-flight turns** (issue #210): `Router.drain(timeoutMs)`
  snapshots the same per-conversation chains once, then waits for them to
  settle or `SHUTDOWN_DRAIN_TIMEOUT_MS` (default 20s) to elapse, whichever is
  first. `src/index.ts`'s `shutdown()` calls it before any `adapter.stop()`,
  so a reply generated during the drain window still sends on a live
  connection instead of being silently dropped by the nightly 1am redeploy
  restart (see `docs/DEPLOYMENT.md`). The snapshot is taken exactly once — a
  message that arrives mid-drain starts a new chain that is deliberately not
  waited on, so a busy conversation can't hold shutdown open past the
  timeout. Zero in-flight chains is a fast no-op: no timer is armed.

### Known cost/latency characteristic

Each `query()` call spawns a Claude Code CLI subprocess and (when resuming)
re-reads the conversation's session file. On a small VPS expect roughly one to
a few seconds of overhead per answered message, growing with session length.
If this becomes a problem: cap session length (start fresh after N turns), or
move to the SDK's streaming-input mode with a persistent process per busy
conversation.

**Memory recall relevance floor** (`MEMORY_RELEVANCE_THRESHOLD`, default `0` =
off, issue #474): automatic per-turn memory recall (the "Memory & 'learning'"
section above) and `remember_search` both funnel through `searchMemory`, which
until #474 had no similarity floor at all — every configured `MEMORY_TOP_K`
slot was filled regardless of relevance. Because recalled messages ride in the
**user turn**, not the system prompt, they sit downstream of the Agent SDK's
cached prefix, so a low-relevance recalled message is full-price input token
spend on every single reply, not a cache hit. `MEMORY_RELEVANCE_THRESHOLD` adds
a cosine-similarity floor (`1 - (embedding <=> query) >= threshold`) to that
query, mirroring `knowledge_search`'s own `KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD`
(0.35) — but kept as a separate, independently-tunable value rather than
reusing that constant, since it was empirically derived for longer curated
knowledge-base content and there's no equivalent eval fixture yet for raw
conversational message embeddings. Default `0` is a true no-op (byte-identical
to pre-#474 behaviour); an operator raises it once they've observed their own
corpus's `similarity` distribution (visible today via `remember_search`'s
`(NN% match)` display).

**Requester name relocated out of the system prompt** (issue #508): the system
prompt's `Context:` block used to include a `- Requester: NAME (role)` line
built from the per-message sender's platform display name. In a shared
channel (a Discord channel or WhatsApp group with more than one participant —
the dominant traffic pattern for a community bot), that line made the whole
system-prompt string vary on essentially every turn from a different poster,
which defeats the Agent SDK's prompt cache: caching is breakpoint-delimited,
matching only when the *entire* content up to the trailing breakpoint is
byte-identical, so any per-speaker variance inside that one opaque block was a
guaranteed full-price cache miss regardless of #169's day-granularity date
work (a prior attempt, #342, tried fixing this by reordering the block instead
of removing the variance and was rejected for exactly that reason — reordering
a single opaque string changes nothing about where its one trailing breakpoint
falls). `buildSystemPrompt` no longer includes `caller.userName` anywhere;
`runAgentTurn` (`core.ts`) now prepends a sanitized `[Requester: NAME]` tag
(via `renderRequesterTag`, reusing the same `sanitizeName` the old line used)
to the **user turn** instead, alongside the existing `renderMemoryContext`
block — mirroring how #474's memory-relevance fix already treats per-turn
content as living downstream of the cached prefix. This makes the system
prompt byte-identical across different speakers of the same role in the same
conversation on the same day, which is the actual precondition for a cache
hit; mixed-role channels (e.g. a member turn followed by an admin turn) still
differ because `ROLE_NOTES[role]` varies, so the benefit is scoped to
consecutive same-role turns, not every message. No dollar/token saving is
claimed here — `execTurn` now reads `usage.cache_read_input_tokens` and
`usage.cache_creation_input_tokens` off the SDK's `result` message (mirroring
the existing `total_cost_usd` read) and logs them at debug level per turn, so
the actual hit rate can be measured from real traffic instead of asserted.

**Ack shortcut** (`ACK_SHORTCUT_ENABLED`, off by default): a pure
acknowledgement reply to the bot ("thanks", "ok", "👍" and a handful of other
exact matches — see `src/ackClassifier.ts`) skips the agent turn entirely and
gets one static reply via `send()` instead, avoiding a wasted `query()` spawn
for a message with nothing for the model to act on. It runs as a router-level
classifier (same shape as `classifyConfirmReply`), exact-match only so a
message that merely starts or ends with an ack word ("thanks but...") always
still reaches the agent, and it's routed through the same per-conversation
chain as a real turn so it can never be delivered ahead of one already in
flight. The message is still recorded inbound as normal; because no outbound
`recordInteraction` is written for the canned reply (only `respond()` writes
one), ack replies are not counted against `dailyReplyLimitPerUser` — an ack
isn't a real answer, so it doesn't draw down the budget. Off by default; an
operator opts in once the canned reply tone fits their community.

**Knowledge shortcut** (`KNOWLEDGE_SHORTCUT_ENABLED`, off by default): checked
immediately after the ack shortcut, this skips the agent turn when a message
scores at or above `KNOWLEDGE_SHORTCUT_THRESHOLD` (default 0.9 cosine
similarity — deliberately much stricter than `knowledge_search`'s own 0.35
relevance floor, since this gates an unsupervised full-turn skip rather than a
hedged suggestion) against an existing knowledge entry, using the same
caller-scoped `searchKnowledge()` the `knowledge_search` tool itself calls
(top-1 only). The matched entry's content is sent directly, suffixed with an
attribution line so the member always has an escape hatch to a real agent
turn by asking again. Unlike the ack shortcut, this reply stands in for a real
answer: it updates `retrieval_count`/`last_retrieved_at` on the served entry
(same as a normal `knowledge_search` hit) and is recorded via the normal
outbound `recordInteraction`, so it counts against `dailyReplyLimitPerUser`
and shows up in admin history/digest views like any other reply. The lookup
runs before the message is routed into the per-conversation chain (so a slow
embed/DB round-trip for one conversation never blocks another), but the send
itself is still routed through that chain so it can never be delivered ahead
of a turn already in flight; a lookup or DB failure falls through to a normal
agent turn rather than dropping the message. Off by default; an operator opts
in after confirming the threshold behaves well against their own knowledge
base's size and content.

**Guest knowledge shortcut** (`GUEST_KNOWLEDGE_SHORTCUT_ENABLED`, off by
default, issue #165): extends the same mechanism to a gated guest's first
message, checked *before* the static "ask an admin" pointer. Uses the identical
`KNOWLEDGE_SHORTCUT_THRESHOLD` floor and the same zero-token local-embedding
lookup, but calls `searchKnowledge()` with `scopeRestriction: 'global-only'`
so a guest — who has no meaningful conversation scope — can never be served a
platform- or conversation-scoped entry that may assume member context. On a
hit, the guest gets the entry's content plus the usual attribution line and a
short nudge to ask an admin for membership; `retrieval_count`/
`last_retrieved_at` is bumped like any other shortcut hit. On a miss (or the
flag off), the gated-guest path falls through to exactly today's behaviour —
the `access_requests` upsert still happens either way. Unlike the member-tier
shortcut, a served guest reply is never recorded via `recordInteraction`: the
"gated-guest content is never stored" invariant (docs/SECURITY.md) covers the
bot's reply here too, not just the guest's own message.

**Repeat-max-turns shortcut** (`REPEAT_MAX_TURNS_SHORTCUT_ENABLED`, off by
default, issue #306): when the SAME caller (platform + conversation + user)
resends the exact whitespace-normalized text of a message that just exhausted
`AGENT_MAX_TURNS` (`resultSubtype === 'error_max_turns'`) within the same
2-minute window the success-only repeat-question shortcut uses, the bot
replies with the same canned "too many steps" message instead of spending a
second full, guaranteed-to-repeat `AGENT_MAX_TURNS` budget — that class of
turn is the single most expensive one this bot runs (a full spent budget with
no answer). Deliberately a separate map and flag from the repeat-question
shortcut above (which is scoped to genuine answers only): a max-turns failure
is cached only when `AgentReply.maxTurnsExceeded === true`, keyed and swept
identically, and never replayed across a different platform, conversation, or
user. Off by default; an operator opts in independently of the success-repeat
shortcut.

**Real-time admin escalation after a max-turns failure**
(`ESCALATION_TO_ADMIN_ENABLED`, off by default, issue #479): closes the
"member hits `AGENT_MAX_TURNS` and gets nothing but a static fallback" gap —
the one deflection failure the bot already detects structurally
(`reply.maxTurnsExceeded === true`) but never followed up on. The whole flow
lives in `router.ts`, entirely outside the model/tool layer:

- **Atomic offer.** When the flag is on and a turn (or the repeat-max-turns
  shortcut replaying one) ends with `maxTurnsExceeded === true`, the router
  appends one line to `MAX_TURNS_REPLY`/`MAX_TURNS_REPLY_MI` — "Want me to
  flag this for a community admin? Reply yes within 10 minutes." — and, in
  the same step, records a pending entry in an in-memory
  `platform:conversationId:userId -> {query, at}` map
  (`Router.pendingEscalations`), keyed and swept exactly like
  `lastMaxTurnsFailure` (issue #306) but on its own 10-minute TTL
  (`ESCALATION_WINDOW_MS`). The offer line is never shown without a live
  entry behind it and vice versa (`offerEscalation`) — both call sites that
  can serve this failure text (a fresh turn in `respond()`, and the
  repeat-max-turns shortcut's replay of the same text) go through the same
  helper, closing the "dead offer / orphaned entry" hazard the adversarial
  review for #479 flagged.
- **Deterministic confirmation intercept.** A short affirmative
  (`yes`/`y`/`āe`, case-insensitive, trimmed) from the same caller within the
  TTL is matched in `handle()` BEFORE the addressed-to-bot check (same
  positioning as the CONFIRM/CANCEL intercept, so a bare reply works in a
  group) and before any shortcut/model routing. A match: consumes the
  pending entry (single-shot — a replayed "yes" finds nothing the second
  time), reserves a slot against the guild-wide rolling-hour
  `ESCALATION_RATE_LIMIT_PER_HOUR` cap (default 5, same sliding-window shape
  as `ANNOUNCE_RATE_LIMIT_PER_HOUR`), and on success calls `notifyAdmins`
  (`agent/tools.ts`) — the real-time counterpart to `notifyReportFiled`'s
  `notifySuperAdmins`, but sourced from `listAdmins()` (every
  `community_users.role = 'admin'` row guild-wide, the same recipient set
  the weekly digest already uses) across every connected adapter, echoing
  the member's own truncated original question (`truncateForEcho`, the same
  helper `notifyReportFiled`/`notifySuggestionResolved` use). A "yes" with no
  live pending entry (never offered, or past the TTL) falls straight through
  to the model as an ordinary message. Once the hourly cap is exhausted, a
  further confirmed "yes" gets a plain "already at the hourly cap" reply
  instead of a notification.
- **No new tool, no new privileged data access.** The trigger is the
  existing structural `maxTurnsExceeded` signal, never a model-callable
  affordance — a crafted question can't make the *model* trigger an alert,
  only a genuine max-turns exhaustion followed by the member's own "yes"
  can. `listAdmins()` and the echoed question text are both already visible
  to admins via the weekly digest/`list_knowledge_gaps`; this only changes
  *when* they're seen.

## Health & monitoring

`Restart=always` (`deploy/community-agent.service`) and the startup
`healthcheck()` only catch the process crashing or the DB being unreachable
at boot — neither catches "process alive, one platform connection silently
dead" (e.g. a banned WhatsApp number stuck in Baileys' reconnect loop).
`src/health.ts` covers that steady-state gap:

- **Sustained-disconnect alerting** (always on, no config to disable) — a
  30s periodic check across every registered adapter's `isConnected()`. Past
  `HEALTH_ALERT_AFTER_MINUTES` (default 5) of continuous disconnection, it
  DMs configured super admins via whichever adapter(s) are still up and logs
  at `error`. Debounced: one alert per outage, not one per check tick;
  reconnecting clears the state silently (no "it's back!" spam).
- **`/healthz`** (opt-in via `HEALTH_PORT`) — unauthenticated `GET` returning
  `{status: "ok"|"degraded", db: boolean, adapters: {discord: boolean,
  whatsapp: boolean}}`. No message content or user ids in the response.
  Intended for an external uptime monitor; bind to localhost and put a
  reverse proxy in front if exposing it, same guidance as the Cloud API
  webhook port.
- **`jobs` field on `/healthz`** (issue #467) — every opt-in background job
  (the alerting series below) already tracks its own consecutive-failure
  state in memory (`JobFailureTracker`/`backgroundJobHealth.ts`), but until
  now that state was a local closure only the job's own one-time debounced
  super-admin DM could see — invisible to `/healthz`, which an external
  uptime monitor may be the operator's *only* window into. `backgroundJobs.ts`
  (and `usageAlert.ts`'s own inlined tracker) now also mirror every tracker
  update into a small in-memory registry (`recordJobRun`/`getJobHealthSnapshot`
  in `backgroundJobHealth.ts`), which `/healthz` threads through as an
  additional, optional `jobs?: Record<string, {consecutiveFailures: number,
  lastRunAt: string, lastSuccessAt: string | null}>` field — present only once
  at least one background job has run this process. Each value is a fixed
  `BackgroundJobName` enum key, an integer, or an ISO timestamp only — never
  an error message or stack (same "never echo the raw error" convention as
  the DM template). A job whose tracker has crossed its own alert threshold
  (`alerted === true`, a *confirmed* outage) also flips top-level `status` to
  `"degraded"`, even when `db` and every adapter are healthy; a single
  sub-threshold failure never does, and a job's next successful run clears
  its contribution (same silent-recovery convention every tracker already
  follows). `/readyz` is deliberately untouched by this — see below.
- `WhatsAppCloudAdapter.isConnected()` — a stateless webhook receiver has no
  persistent connection to track the way Baileys/Discord have, so this
  instead reflects the local HTTP listener being up AND the last 3
  consecutive real message sends not having all failed (an expired/revoked
  token or broken egress path fails every send; an ordinary per-recipient
  failure doesn't, because the next successful send anywhere resets the
  counter). Recovery is sticky — once flipped `false`, it only returns to
  `true` on the next successful send, so an idle deployment stays reported
  as disconnected until outbound traffic resumes even after the underlying
  issue is fixed. Best-effort typing-indicator failures never affect this
  signal. A `429` (Meta's normal per-number rate-limit response, not an
  outage) is retried exactly once, honoring `Retry-After` (clamped to 5s),
  before counting toward this threshold — so a legitimate traffic burst
  self-heals silently instead of both dropping the member's reply and
  falsely tripping the disconnect alert (issue #470).

The debounce/payload logic lives in `src/healthState.ts`, deliberately free
of config/HTTP/adapter imports so it's unit-tested directly (`src/health.ts`
is the thin I/O wrapper around it).

Per-request DB failures degrade rather than alert: a memory-recall or
session-lookup failure mid-turn falls back (no memory context / fresh
session) and the router's pre-send backstop guarantees the member still gets
a reply (issue #52). That degradation is per-request only — a *persistent*
DB outage still fails `healthcheck()` at startup and flips `db: false` on
`/healthz`, so it is never masked from monitoring.

**Pool-level query/connection bounds** (issue #502) close a gap #52 never
covered: every one of #52's safeguards is a `.catch()`, which only ever fires
on a *rejected* query — a query that never resolves or rejects (a lock wait,
a stalled network round-trip, slow autovacuum, disk pressure) hangs the
connection indefinitely instead. With the shared `pool` (`src/storage/db.ts`)
capped at `max: 10`, a handful of stuck connections exhausts it, and every
subsequent turn — including `/healthz`'s own `healthcheck()`, which runs on
the same pool — queues forever behind them. `pool` is now constructed with
three config-driven bounds, all on by default (pure safety hardening, no
happy-path behaviour change for any query that completes normally):

- `DB_STATEMENT_TIMEOUT_MS` (default `15000`) → `statement_timeout`,
  enforced **server-side** by Postgres itself; covers the dominant cases
  (lock waits, slow autovacuum, disk pressure, a runaway query).
- `DB_QUERY_TIMEOUT_MS` (default `15000`) → `query_timeout`, the
  **client-side** mirror — bounds an in-flight query even in the one case
  `statement_timeout` alone can't reach: a stalled network round-trip where
  the packet never reaches Postgres (so the server-side timer never starts)
  or the response never returns.
- `DB_CONNECT_TIMEOUT_MS` (default `10000`) → `connectionTimeoutMillis` —
  bounds how long a caller waits to acquire/establish a connection, so it
  fails fast instead of queuing forever when the pool is saturated.

A timeout firing surfaces as an ordinary query rejection through the exact
same `.catch()` degrade-gracefully paths #52 already built — this doesn't
add new failure-handling logic, it just guarantees a hang eventually becomes
the rejection that logic already handles safely (never echoing the raw
Postgres error text to a member).

## Usage & shared Max-pool alerting

The bot authenticates against a Claude **subscription** (see SECURITY.md
"Subscription-auth caveat"), and that same weekly token pool is shared with
the automated multi-loop pipeline sessions (see PIPELINE.md). `src/usageAlert.ts`
adds an opt-in proactive check on top of the existing (pull-only, super-admin)
`usage_stats` tool:

- Beyond interaction-derived cost, `usage_stats` also surfaces spend and
  savings that never write an `interactions` row: a background-job cost
  breakdown (moderation/context-builder/knowledge-refresh `query()` calls,
  issue #438) and a shortcut-hit count (issue #440) — how often the four
  env-gated turn-skipping shortcuts (ack, knowledge, repeat-question,
  repeat-max-turns) fired, with a rough dollar estimate of Max-pool spend
  avoided at the member-tier average reply cost. Both lines are appended only
  when non-zero, byte-identical to today's output otherwise.

- Off unless `USAGE_ALERT_DAILY_REPLIES` is set — no timer is created, zero
  extra queries, when unconfigured.
- When set, an hourly check calls `usageStats(1)` (rolling 24h) and compares
  the **outbound reply count** — not `cost_usd` — against the threshold.
  Reply count is a coarse proxy for shared Max-pool draw (a short reply and a
  long one draw very differently), so tune the threshold to your own
  traffic; `cost_usd` is still shown in the alert as supplementary context,
  but SECURITY.md already documents that it can silently under-report if
  recording degrades open, so it's never the trigger condition.
- Debounced with a rolling-window latch (`stepUsageAlertTracker`, pure and
  unit-tested like `healthState.ts`'s disconnect tracker): one DM per
  crossed window, no repeat while still over, no "back to normal" DM when it
  drops back below — it just silently re-arms.
- The alert DM rides the same `sendDirectMessage` super-admin path
  `health.ts`'s disconnect alert already uses. No new privileged tool, no
  new RBAC surface, no auto-`pause_bot` — a super admin decides whether to
  pause manually.
- The poller is also wired into the shared background-job consecutive-failure
  tracker (`backgroundJobHealth.ts`'s `JobFailureTracker`, the same mechanism
  covering context-builder/knowledge-refresh/docs-ingest/both retention
  purges/embedding-model/admin-digest/anthropic-status-check): three
  consecutive `usageStats(1)` failures DM super admins so the operator's
  runaway-usage alarm can't itself go dark silently (issue #426). This is
  independent of the threshold-crossing latch above — a check-failure alert
  never suppresses or duplicates a threshold alert, or vice versa.

`usageAlert.ts` is a **proactive** check on successful outbound reply
*counts* — it says nothing about a turn actively **failing** because the
upstream Claude call itself was rejected for hitting a limit or being
overloaded. `src/agent/upstreamFailure.ts` covers that distinct signal:

- `execTurn`'s `catch` block (agent/core.ts) classifies a thrown `query()`
  error by matching its message against a small, anchored set of known
  substrings (`rate_limit`, `usage limit`, `429`, `overloaded_error`,
  `quota` — case-insensitive). Only the SDK/CLI's own error message is
  inspected, never user-supplied text, and the reply is always one of two
  fixed strings — the raw error is never echoed to the member.
- On a match, the member gets an honest "this bot has hit its shared usage
  limit, not a bug, try again later" reply instead of the generic
  `INTERNAL_ERROR_REPLY` — "please try again" is actively misleading when
  the shared pool is genuinely exhausted. The `resultSubtype !== 'success'`
  branch (e.g. `error_max_turns`) is untouched: per the SDK's own behaviour,
  a usage-limit/overload condition surfaces as a thrown error, not a clean
  result subtype.
- Off unless `UPSTREAM_LIMIT_ALERT_ENABLED` is set (consistent with this
  repo's convention for new proactive DMs). When on, a debounced latch
  (`stepUsageLimitTracker`, pure and unit-tested like `healthState.ts`'s
  disconnect tracker) DMs super admins on the platform that saw the
  failure — one DM per ongoing window, silent re-arm the next time a turn
  doesn't hit the classifier. The reply text only claims "an admin has been
  notified" when this flag is actually on.
- No auto-`pause_bot` — same posture as `usageAlert.ts`: a super admin
  decides.

## Departed-admin alert

`src/departedAdminAlert.ts` (off unless `DEPARTED_ADMIN_ALERT_ENABLED`, issue
#472) closes the growth path #428 itself named and deliberately deferred:
`listAdminRoster()`/`list_admins` already compute and surface `leftServer`
per admin, but only on pull — a super admin only learns a departed admin
still holds bot-admin privilege via DM if they think to run `list_admins`.

- Routed through the shared `startTrackedJob` (the same 6h cadence as
  context-builder/knowledge-refresh/docs-ingest/both retention purges/
  admin-digest), so a throwing `runOnce` (e.g. a DB error from
  `listAdminRoster`) gets the existing consecutive-failure alerting for
  free — no bespoke tracker.
- Each tick calls `listAdminRoster()` and counts entries with `leftServer
  === true`, then steps a pure threshold-1 latch — `usageAlert.ts`'s own
  `stepUsageAlertTracker`, reused by **import**, not copy, per the
  adversarial-review note on issue #472 — against that count. The latch
  fires exactly once on the tick the count first transitions `0 → >0`, and
  re-arms only once the count returns to exactly `0`; a partial decrease
  (e.g. 3 departed admins down to 1) never re-arms and never re-alerts.
- On trip, DMs every super admin via the same `sendDirectMessage` +
  `superAdminIds` path `usageAlert.ts`/`health.ts` already use. The message
  is a bare integer count plus fixed template text only — never a display
  name, platform user id, or platform string, matching every other digest/
  alert signal's convention in this codebase.
- No schema change, no new tool, no new RBAC surface: this only threads an
  already-super-admin-gated read (`listAdminRoster`, backing `list_admins`)
  through already-proven alert machinery. Auto-revoke on departure remains
  deliberately out of scope, same as `list_admins` itself — this closes the
  visibility gap, not the decision to revoke.

## Switching WhatsApp providers

The Baileys adapter is the default (immediate, free, dedicated number, but
against WhatsApp ToS — ban risk). The official Meta **Cloud API** is
implemented as `WhatsAppCloudAdapter` and is the recommended path for any
bot expected to run continuously:

1. Set `WHATSAPP_PROVIDER=cloud` and `WHATSAPP_CLOUD_PHONE_NUMBER_ID`,
   `WHATSAPP_CLOUD_ACCESS_TOKEN`, `WHATSAPP_CLOUD_VERIFY_TOKEN`,
   `WHATSAPP_CLOUD_APP_SECRET`, and optionally `WHATSAPP_CLOUD_WEBHOOK_PORT`
   (default `8080`).
2. Point your Meta app's webhook subscription at
   `http://<host>:<port>/` (any path — the adapter listens on all paths) with
   the same verify token, and expose it over HTTPS via a reverse proxy (see
   `docs/DEPLOYMENT.md`).

The adapter verifies every inbound webhook's `X-Hub-Signature-256` HMAC
against `WHATSAPP_CLOUD_APP_SECRET` before parsing the body. Because the
Cloud API is 1:1-only (no groups), `adminCapabilities` only advertises
`warn_user`; other moderation actions report as unsupported. Free-form
outbound replies are only sent within Meta's 24h customer-service window
(tracked in-process from the timestamp of the sender's last inbound
message); sends outside that window fail with a clear error rather than
being attempted. Replies over Meta's 4096-char text limit are chunked into
sequential messages (same `chunkText` helper Discord uses at its own
2000-char limit), filtered as a whole before splitting so redaction can't be
defeated by a chunk boundary. `sendImage` (issue #356) has full parity with
Baileys and Discord: it uploads the bytes via Meta's media-upload endpoint,
then sends a message referencing the returned media id — the same 24h-window
check and caption filtering as every text send, so `generate_image` works on
this adapter too.

`WHATSAPP_ALLOWED_JIDS` is shared between both adapters but each entry can be
either a bare phone-number digit string or a full Baileys-style JID
(`64211234567@s.whatsapp.net`) — the Cloud adapter matches against the part
before `@`, so the same list works for either adapter without reformatting.

Nothing in `router.ts`, `agent/*`, or `storage/*` changes — they only depend on
the `PlatformAdapter` interface.
