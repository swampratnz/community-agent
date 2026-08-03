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

> **The framework is a package.** The turn engine, router spine, platform
> adapters, storage, RBAC and config live in
> [`@swampratnz/agent-base`](https://github.com/swampratnz/agent-base) and are
> consumed as a dependency. What is in this repo is `src/module/` — this
> community's tools, prose, personas, skills, jobs and integrations — plus
> `src/index.ts`, which hands `src/module/agentModule.ts`'s manifest to the
> package's `createAgent`. Paths spelled `@swampratnz/agent-base/…` below name
> a module inside that package, not a file here.

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
- **`whats_new` / `catch_up`**: what changed in the bot lately (from the
  changelog) and what the community discussed while you were away.
- **Voice notes**: opt-in local transcription of WhatsApp and Discord voice
  messages so spoken questions get answered too.
- **Auto-answer mode** (Discord, opt-in): recognises repeat questions in
  allowed channels and offers the KB answer without being addressed.

**Community & members**
- **Discord slash commands** (opt-in): `/kb`, `/whois`, `/projects`,
  `/guidelines` — zero-model-call, ephemeral lookups.
- **Peer help & discovery**: members share projects and interests
  (`share_project`, `who_is_into`), and opt into a helper pool the bot can
  match askers to (`find_helper`).
- **Onboarding & welcomes**: opt-in welcome flows on both platforms;
  gated-mode access requests land in a triageable queue.
- **Privacy self-service**: `my_data` shows what's stored about you;
  `forget_me` deletes it. Cross-platform identity linking is member-initiated.

**Community tools (admins)**
- **Moderation**: timeout / kick / warn / delete, plus opt-in **auto-moderation**
  — a bad-word/abuse scan that issues **strikes** and, past a threshold, assigns
  a **Muted** role until an admin clears them.
- **Engagement**: post announcements, native Discord **polls**, scheduled
  **events**, **threads**, emoji **reactions**, and assignable **cosmetic roles**.
- **Community guidelines** members can read on demand; **admin digests**,
  question digests, and an opt-in **member-facing weekly digest** surface what
  the community is asking about.
- **Moderation appeals**: members can appeal a strike/action; admins resolve
  from a queue. Member notes, roster views, and engagement stats give admins
  context without raw data access.
- **Super-admin ops**: pause/resume the bot, redeploy, usage stats, audit
  view, policy toggles, plus confirmation-gated `suggest_issue` (files a
  GitHub issue from chat) and `dev_team_dispatch` (sends an assess/deliver
  job to a remote build service).

**Member feedback loops**
- **Rate answers** (helpful/unhelpful), file **content reports** and
  **suggestions** — each lands in a triageable queue instead of dying in
  chat — and (admin-gated) **image generation** via the Grok Build CLI.

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
  index.ts                composition root — the only file that may import both halves
  base/                   the community-agnostic framework (never imports src/module/)
    config.ts             env loading + validation
    router.ts             inbound → agent → outbound orchestration
    agent/                auth, core turn loop, prompt spine, tool kernel, skills manifest
    moderation/           bad-word/abuse scan, strikes, muted-role enforcement
    auth/rbac.ts          admin/user roles + per-role tool gating
    platforms/            PlatformAdapter interface + Discord/WhatsApp adapters
    storage/              Postgres pool, schema, migrations, embeddings, repo
    media/                on-host voice-note transcription
    jobs/                 background-job registry mechanism
  module/                 the NZ Claude Community module (free to import @swampratnz/agent-base/)
    agent/                MCP tool registry, prompt sections, personas, skills bundle
    context/              offline context builder, docs ingest, export, knowledge refresh
    platforms/            adapter text packs, slash commands, adapter factories
    media/                image generation (Grok Build CLI)
    status/               Anthropic status-page checker
    github/               GitHub issue filing (suggest_issue)
    devTeam/              remote dev-team build-service client
scripts/                  CI gate helpers (security-test floor, changelog coverage, labels)
tests/                    Node test-runner suites (SECURITY: invariants, knowledge eval, …)
deploy/                   Ubuntu provisioning script + systemd unit
docs/                     ARCHITECTURE, SECURITY, DEPLOYMENT, VISION, PIPELINE, PERSONAS, …
```

The split is one-way and enforced (`npm run imports:check` plus an eslint
rule): `@swampratnz/agent-base/` may never import `src/module/`, not even a type, so the
framework half stays liftable on its own. Anything base needs from the
community side arrives through a registry slot the module fills at import
time, and `src/index.ts` carries those side-effect imports. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) → "Two halves and a composition
root".

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
[VISION.md](docs/VISION.md), a **build** loop (GitHub Actions) implements
approved ones on a branch and opens a PR, and an automated **review** loop
vets it. Bounded support loops keep PRs moving without a human in the loop
(one free CI rerun, CI-failure autofix, merge-conflict resolution,
review-response revisions, zombie-state cleanup), and a deterministic,
tightly gated **auto-merge** loop lands fully-vetted bot PRs — anything
touching governance, CI, or the loops' own guardrails still **requires a
human merge**, and branch protection on `main` is the backstop. See
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
- [Capability ideas](docs/CAPABILITY-IDEAS.md) — curated backlog of candidate
  directions (not commitments)
- [Pipeline](docs/PIPELINE.md) — the self-improving research/review/build loops
- [Personas](docs/PERSONAS.md) — the bot's voice ("Dave")
- [Community context](docs/COMMUNITY-CONTEXT.md) — auto-generated, anonymised
  export of what the community discusses (aggregate-only, opt-in)
- [Standards](docs/STANDARDS.md) · [Red-team](docs/RED-TEAM.md)
- [Slide deck](docs/SLIDE-DECK.md) — presentable 11-slide overview of the repo,
  the pipeline, and how the design maps to agentic best practice
