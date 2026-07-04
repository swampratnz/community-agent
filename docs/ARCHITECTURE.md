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
| `src/storage/*` | Postgres pool, schema, migrations, embeddings, repository. |
| `src/router.ts` | Orchestrates inbound → agent → outbound and persistence. |
| `src/health.ts` / `src/healthState.ts` | `/healthz` endpoint + sustained-disconnect super-admin alerting; `healthState.ts` holds the pure, tested debounce/payload logic. |

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
4. Admins can promote durable facts into `knowledge` via `save_knowledge`, and
   curate existing entries with `list_knowledge` (browse by scope),
   `update_knowledge` (correct + re-embed), and `delete_knowledge` (retire,
   CONFIRM-gated). `question_digest` closes the discovery gap: it greedily
   clusters recent addressed-to-bot messages by embedding similarity (reusing
   the same vectors, no new embedding calls) to surface "N people asked this"
   patterns worth turning into a knowledge entry.

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
  group membership (cached ~60s) and that list becomes a SQL filter.
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
| `report_content` (flag harassment/spam/rule violations to admins) | ❌ | ✅ *(rate-capped, 5/24h)* | ✅ | ✅ |
| Memory/history across conversations | ❌ | ❌ | ✅ *their conversations* | ✅ all |
| `moderate` / `announce` | ❌ | ❌ | ✅ *their conversations*, confirm-gated | ✅ anywhere |
| `save_knowledge` / `list_knowledge` / `update_knowledge` / `delete_knowledge` | ❌ | ❌ | ✅, delete confirm-gated | ✅ |
| `list_access_requests` | ❌ | ❌ | ✅ *(not conversation-scoped — see below)* | ✅ |
| `question_digest` (recurring-question clusters) | ❌ | ❌ | ✅ *their conversations* | ✅ all |
| `moderation_history` (warn/timeout/kick/delete/announce log, filterable by member/action) | ❌ | ❌ | ✅ *their conversations* | ✅ all |
| `list_reports` / `resolve_report` (member-submitted content reports) | ❌ | ❌ | ✅ *their conversations* | ✅ all |
| `add_member` / `remove_member` | ❌ | ❌ | ✅ (member tier only) | ✅ |
| `link_member` / `unlink_member` (cross-platform identity linking) | ❌ | ❌ | ✅, confirm-gated, tier never propagates | ✅ |
| Web search & summarise (`WebSearch`; `WebFetch` never) | ❌ | ❌ | ✅ | ✅ |
| `grant_admin` / `revoke_admin`, `purge_user_data`, `audit_view`, `usage_stats`, `pause_bot`, `set_policy` | ❌ | ❌ | ❌ | ✅ |

Behaviour guardrails on top: per-user daily reply budget
(`DAILY_REPLY_LIMIT_PER_USER`), session caps (`SESSION_MAX_TURNS`/`_AGE_HOURS`),
and an outbound filter on every reply — secret redaction plus the
`code_answers` policy (`off`/`snippets`/`full`, set via `set_policy`).

## Onboarding (gated mode)

Two pieces make the default gated experience less friction-y without
weakening it:

1. **Welcome message.**
   - **Discord**: off unless `DISCORD_WELCOME_ENABLED=true`. On join,
     `DiscordAdapter` sends a static, non-agent DM (no LLM call, no cost)
     pointing the new member at an admin; if their DMs are closed, it falls
     back to posting in `DISCORD_WELCOME_CHANNEL_ID` if configured.
   - **WhatsApp** (Baileys only — the Cloud API is 1:1-only, no group-join
     event to hook): off unless `WHATSAPP_WELCOME_ENABLED=true`.
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
2. **Pending-access queue**. When a gated guest addresses the bot,
   `router.ts` upserts a row into `access_requests` (platform, user id/name,
   first/last-requested timestamps, request count) — deliberately *never*
   their message content, preserving the existing no-storage invariant for
   guests. Admins call `list_access_requests` to see who's waiting instead of
   relying on informal pings; `add_member` clears the row for that user once
   actioned.

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
   itself can't become a spam vector against admin attention.
2. Admins triage with `list_reports` (conversation-scoped, same pattern as
   `moderation_history`) and `resolve_report` (marks `resolved`/`dismissed`,
   audited, non-destructive so no CONFIRM gate).
3. No automation beyond intake: the queue is purely informational. Admins
   still decide and act via the existing `moderate` tool.

Because `list_reports` is conversation-scoped, a report filed from a DM (no
ordinary admin is ever a "participant" of another member's 1:1 conversation)
is only reachable by a super admin — see SECURITY.md's residual-risks note.

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

## Concurrency model

- The router **serialises turns per conversation** (a promise chain keyed by
  `platform:conversationId`) because session resume is not safe to run
  concurrently for the same session.
- Different conversations run in parallel.
- A light **per-user rate limit** (8 msg / 60s) protects against spam and
  runaway cost.

### Known cost/latency characteristic

Each `query()` call spawns a Claude Code CLI subprocess and (when resuming)
re-reads the conversation's session file. On a small VPS expect roughly one to
a few seconds of overhead per answered message, growing with session length.
If this becomes a problem: cap session length (start fresh after N turns), or
move to the SDK's streaming-input mode with a persistent process per busy
conversation.

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
- `WhatsAppCloudAdapter.isConnected()` reflects whether its local HTTP
  listener is up, not whether Meta can currently reach it — it's a
  stateless webhook receiver with no persistent connection to track the way
  Baileys/Discord have.

The debounce/payload logic lives in `src/healthState.ts`, deliberately free
of config/HTTP/adapter imports so it's unit-tested directly (`src/health.ts`
is the thin I/O wrapper around it).

## Usage & shared Max-pool alerting

The bot authenticates against a Claude **subscription** (see SECURITY.md
"Subscription-auth caveat"), and that same weekly token pool is shared with
the automated multi-loop pipeline sessions (see PIPELINE.md). `src/usageAlert.ts`
adds an opt-in proactive check on top of the existing (pull-only, super-admin)
`usage_stats` tool:

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
defeated by a chunk boundary.

`WHATSAPP_ALLOWED_JIDS` is shared between both adapters but each entry can be
either a bare phone-number digit string or a full Baileys-style JID
(`64211234567@s.whatsapp.net`) — the Cloud adapter matches against the part
before `@`, so the same list works for either adapter without reformatting.

Nothing in `router.ts`, `agent/*`, or `storage/*` changes — they only depend on
the `PlatformAdapter` interface.
