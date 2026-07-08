# NZ Claude Community Agent

**Dave** — a Claude-powered assistant that manages the **NZ Claude Community**
Discord server and a dedicated **WhatsApp** number from a single Ubuntu service.
It answers questions grounded in Anthropic's official docs and a curated
knowledge base, remembers past discussions (Postgres + pgvector), moderates, and
gives **admins** community-management powers that normal members don't have.

Built with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview),
authenticated with a **Claude subscription** (no per-token API billing). The repo
also runs a **self-improving development pipeline** (see below) that proposes,
reviews, and builds its own features.

## What it does

**Answers & knowledge**
- **Answers questions** about Claude, the API, and the community on Discord and
  WhatsApp — grounded in a **knowledge base** with **source citations** and a
  **freshness** signal, not just the model's training cutoff.
- **Ingests Anthropic's official docs** (`platform.claude.com/llms.txt`) into the
  knowledge base as trusted RAG chunks, refreshed weekly by content diff; an
  opt-in **daily refresh** researches fast-moving Claude/Anthropic topics.
- **Remembers**: stores interactions with embeddings and retrieves relevant
  history each turn (retrieval-augmented memory); an offline **context builder**
  distils recurring topics into durable digests, and admins curate the KB
  (`save_knowledge`, candidate review queue).
- **`check_status`**: reports Anthropic's live service status (its official
  status page) so "is it me or an incident?" gets an authoritative answer.

**Community tools (admins)**
- **Moderation**: timeout / kick / warn / delete, plus opt-in **auto-moderation**
  — a bad-word/abuse scan that issues **strikes** and, past a threshold, assigns
  a **Muted** role until an admin clears them.
- **Engagement**: post announcements, native Discord **polls**, scheduled
  **events**, **threads**, emoji **reactions**, and assignable **cosmetic roles**.
- **Community guidelines** members can read on demand; **admin digests** and
  question digests surface what the community is asking about.

**Member feedback loops**
- **Rate answers** (helpful/unhelpful), file **content reports** and
  **suggestions**, and (admin-gated) **image generation** via the Grok Build CLI.

**Platform-agnostic core** — Discord and WhatsApp are pluggable adapters; every
privileged action is RBAC-gated, CONFIRM-guarded where destructive, and audited.

## Tech stack
| Concern | Choice |
|---|---|
| Runtime | TypeScript on Node 22+ (Node 24 LTS in production) |
| Agent | `@anthropic-ai/claude-agent-sdk` (subscription auth) |
| Discord | `discord.js` v14 |
| WhatsApp | Baileys (dedicated number) or the official Meta Cloud API |
| Memory | PostgreSQL + `pgvector`, local embeddings (`transformers.js`) |
| Service | systemd on Ubuntu |

## Repository layout
```
src/
  config.ts               env loading + validation
  router.ts               inbound → agent → outbound orchestration
  agent/                  auth, core turn loop, system prompt, personas, MCP tools
  context/                offline context builder, docs ingest, export, knowledge refresh
  moderation/             bad-word/abuse scan, strikes, muted-role enforcement
  auth/rbac.ts            admin/user roles + per-role tool gating
  platforms/              PlatformAdapter interface + Discord/WhatsApp adapters
  storage/                Postgres pool, schema, migrations, embeddings, repo
deploy/                   Ubuntu provisioning script + systemd unit
docs/                     ARCHITECTURE, SECURITY, DEPLOYMENT, VISION, PIPELINE, PERSONAS, …
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

Most features beyond the core Q&A are **opt-in and off by default** — enable them
per your community's needs via `.env` (see `.env.example`); the privacy-affecting
ones (ambient archiving, docs/context export) require a community notice first
(see SECURITY.md).

## Roles (super admin / admin / member)
Three tiers with **gated access** by default: only registered members get
replies; admins add members (`add_member`); super admins (env-configured via
`SUPER_ADMIN_*`) grant admins and control policies. Admin data access is
scoped to conversations the admin actually participates in, destructive
actions require an out-of-band CONFIRM reply, and everything privileged is
audited + alerted. Set `ACCESS_MODE_DISCORD=open` later to let non-members ask
basic questions. See **[docs/SECURITY.md](docs/SECURITY.md)** and
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full tool matrix.

## Self-improving pipeline
A multi-loop development pipeline proposes, hardens, and builds the bot's own
features, coordinated entirely through GitHub issues + labels: a **research**
loop files proposals, an **adversarial** loop reviews them against
[VISION.md](docs/VISION.md), and a **build** loop (GitHub Actions) implements
approved ones on a branch and opens a PR — **a human always merges**. See
**[docs/PIPELINE.md](docs/PIPELINE.md)**.

## Important caveats
- **Subscription auth** is a grey area in Anthropic's SDK terms (see SECURITY.md).
  The auth layer is isolated so you can switch to an API key easily.
- **Baileys WhatsApp** (the default) uses the unofficial protocol and violates
  WhatsApp ToS — the number can be banned. Use a number you can afford to
  lose, or set `WHATSAPP_PROVIDER=cloud` to use the official Meta Cloud API
  adapter instead (see docs/ARCHITECTURE.md "Switching WhatsApp providers").
- **Privacy**: all interactions are logged. Tell your community, and define a
  retention/deletion policy (NZ Privacy Act 2020).

## Design docs
- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Vision](docs/VISION.md) — the north star + value rubric for the pipeline
- [Pipeline](docs/PIPELINE.md) — the self-improving research/review/build loops
- [Personas](docs/PERSONAS.md) — the bot's voice ("Dave")
- [Standards](docs/STANDARDS.md) · [Red-team](docs/RED-TEAM.md)
