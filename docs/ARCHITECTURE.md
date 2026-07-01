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
| `src/platforms/whatsapp/cloudAdapter.ts` | Stub for the official Meta Cloud API — the documented upgrade path. |
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

## RBAC (admin vs user)

Roles are resolved at the **adapter boundary** from platform-native identity:

- **Discord** — admin if the author's id is in `DISCORD_ADMIN_USER_IDS`, or they
  hold a role in `DISCORD_ADMIN_ROLE_IDS`.
- **WhatsApp** — admin if their number is in `WHATSAPP_ADMIN_NUMBERS`.

The role rides on every `IncomingMessage`. The agent core then calls
`toolsForRole(role)` and passes the result as the SDK's `allowedTools`, so a
normal user's turn is **structurally incapable** of invoking a privileged tool —
the tool isn't even offered to the model. Each privileged tool *also* calls
`assertAdmin()` before any side effect (defence in depth), and every privileged
action is written to the append-only `admin_audit` table.

| Capability | user | admin |
|---|:--:|:--:|
| Ask questions, search memory/knowledge | ✅ | ✅ |
| `moderate` (timeout / kick / delete / warn) | ❌ | ✅ |
| `announce` to a channel | ❌ | ✅ |
| `save_knowledge` | ❌ | ✅ |
| `user_history` lookup | ❌ | ✅ |

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
against WhatsApp ToS — ban risk). To move to the official Meta **Cloud API**:

1. Implement `WhatsAppCloudAdapter` (webhook intake + Graph API send).
2. Set `WHATSAPP_PROVIDER=cloud` and the `WHATSAPP_CLOUD_*` env vars.

Nothing in `router.ts`, `agent/*`, or `storage/*` changes — they only depend on
the `PlatformAdapter` interface.
