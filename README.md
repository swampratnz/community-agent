# NZ Claude Community Agent

A Claude-powered assistant that manages the **NZ Claude Community** Discord
server and a dedicated **WhatsApp** number from a single Ubuntu service. It
remembers every interaction (Postgres + pgvector) so it can recall past
discussions, and it gives **admins** moderation/announcement powers that normal
users don't have.

Built with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview),
authenticated with a **Claude subscription** (no per-token API billing).

## What it does
- **Answers questions** about Claude, the API, and the community in Discord and
  WhatsApp.
- **Learns**: stores all interactions with embeddings and retrieves relevant
  history on each turn (retrieval-augmented memory).
- **Moderates (admins only)**: timeout / kick / warn / delete, post
  announcements, and curate a knowledge base — all audited.
- **One platform-agnostic core**: Discord and WhatsApp are pluggable adapters.

## Tech stack
| Concern | Choice |
|---|---|
| Runtime | TypeScript on Node 22+ (Node 24 LTS in production) |
| Agent | `@anthropic-ai/claude-agent-sdk` (subscription auth) |
| Discord | `discord.js` v14 |
| WhatsApp | Baileys (dedicated number) — Cloud API adapter stubbed |
| Memory | PostgreSQL + `pgvector`, local embeddings (`transformers.js`) |
| Service | systemd on Ubuntu |

## Repository layout
```
src/
  config.ts               env loading + validation
  router.ts               inbound → agent → outbound orchestration
  agent/                  auth, core turn loop, system prompt, MCP tools
  auth/rbac.ts            admin/user roles + per-role tool gating
  platforms/              PlatformAdapter interface + Discord/WhatsApp adapters
  storage/                Postgres pool, schema, migrations, embeddings, repo
deploy/                   Ubuntu provisioning script + systemd unit
docs/                     ARCHITECTURE.md, SECURITY.md, DEPLOYMENT.md
```

## Quick start (local dev)
```bash
npm install
cp .env.example .env        # fill in tokens + DATABASE_URL
npm run migrate             # create schema (needs Postgres + pgvector)
npm run whatsapp:link       # scan QR with the bot's WhatsApp (one-time)
npm run dev                 # run with hot reload
```

Production deployment on Ubuntu: see **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Roles (super admin / admin / member)
Three tiers with **gated access** by default: only registered members get
replies; admins add members (`add_member`); super admins (env-configured via
`SUPER_ADMIN_*`) grant admins and control policies. Admin data access is
scoped to conversations the admin actually participates in, destructive
actions require an out-of-band CONFIRM reply, and everything privileged is
audited + alerted. Set `ACCESS_MODE_DISCORD=open` later to let non-members ask
basic questions. See **[docs/SECURITY.md](docs/SECURITY.md)** and
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full tool matrix.

## Important caveats
- **Subscription auth** is a grey area in Anthropic's SDK terms (see SECURITY.md).
  The auth layer is isolated so you can switch to an API key easily.
- **Baileys WhatsApp** uses the unofficial protocol and violates WhatsApp ToS —
  the number can be banned. Use a number you can afford to lose, or implement
  the Cloud API adapter.
- **Privacy**: all interactions are logged. Tell your community, and define a
  retention/deletion policy (NZ Privacy Act 2020).

## Design docs
- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Deployment](docs/DEPLOYMENT.md)
