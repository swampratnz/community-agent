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
4. Admins can promote durable facts into `knowledge` via `save_knowledge`.

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
  content is **not stored**. In `open` mode guests get member-level tools.

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
| Memory/history across conversations | ❌ | ❌ | ✅ *their conversations* | ✅ all |
| `moderate` / `announce` | ❌ | ❌ | ✅ *their conversations*, confirm-gated | ✅ anywhere |
| `add_member` / `remove_member` | ❌ | ❌ | ✅ (member tier only) | ✅ |
| Web search & summarise (`WebSearch`; `WebFetch` never) | ❌ | ❌ | ✅ | ✅ |
| `grant_admin` / `revoke_admin`, `purge_user_data`, `audit_view`, `usage_stats`, `pause_bot`, `set_policy` | ❌ | ❌ | ❌ | ✅ |

Behaviour guardrails on top: per-user daily reply budget
(`DAILY_REPLY_LIMIT_PER_USER`), session caps (`SESSION_MAX_TURNS`/`_AGE_HOURS`),
and an outbound filter on every reply — secret redaction plus the
`code_answers` policy (`off`/`snippets`/`full`, set via `set_policy`).

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
being attempted.

`WHATSAPP_ALLOWED_JIDS` is shared between both adapters but each entry can be
either a bare phone-number digit string or a full Baileys-style JID
(`64211234567@s.whatsapp.net`) — the Cloud adapter matches against the part
before `@`, so the same list works for either adapter without reformatting.

Nothing in `router.ts`, `agent/*`, or `storage/*` changes — they only depend on
the `PlatformAdapter` interface.
