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
- **Agent Skills** (opt-in, `AGENT_SKILLS_ENABLED`): six bundled skills the
  model loads only when a turn needs one — reviewing a member's prompt or tool
  schema, critiquing an agent/pipeline design, walking through Claude Code
  setup, choosing a model or plan, sequencing a learning path, and handling
  project showcases. Enabling it also moves the prompt-review checklist out of
  the always-on system prompt and into a skill loaded only when needed, so the
  per-turn cached prefix shrinks for the majority of turns that never invoke
  it.

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

The framework — agent kernel and prompt spine, router spine, platform
adapters, storage, RBAC, config, the notice mechanism, jobs, alert/health
infra — is the **[`@swampratnz/agent-base`](https://github.com/swampratnz/agent-base)**
package, not a directory here. What this repo holds is the deployment:

```
src/
  index.ts                composition root — the only file that may call createAgent
  migrate.ts              npm run migrate: base schema fragments, then this module's
  module/                 the NZ Claude Community module
    agentModule.ts        THE manifest — every extension point this deployment fills
    routerWiring.ts       the router's deps, assembled from module + package pieces
    commands.ts           the community command set
    agent/                tool registry (tools/), prompt sections, personas, skills bundle
    platforms/            adapter factories, adapter text packs, Discord slash commands
    jobs/                 the job registry (pinned start order) + community jobs
    storage/              this deployment's schema fragments + policy keys
    strings/              the notice pack (ids, axes, entries)
    moderation/           the community bad-word list
    context/              offline context builder, docs ingest, export, knowledge refresh
    media/                image generation (Grok Build CLI)
    status/               Anthropic status-page checker
    github/               GitHub issue filing (suggest_issue)
    devTeam/              remote dev-team build-service client
scripts/                  CI gate helpers (security-test floor, context pack, imports, labels)
tests/                    Node test-runner suites (SECURITY: invariants, knowledge eval, …)
deploy/                   Ubuntu provisioning script + systemd unit
docs/                     ARCHITECTURE, SECURITY, DEPLOYMENT, VISION, PIPELINE, PERSONAS, …
```

Three composition rules are enforced by `npm run imports:check` (CI's lint job)
and, for the last two, by an eslint rule scoped to `src/module/**`: `src/base/`
must not exist — a local copy of the framework forks the package silently;
`src/module/` may never import the composition root; and only the composition
root may call `createAgent`, because the registration order is precisely what
`createAgent` exists to own. A module contributes a manifest and nothing else:
there are no side-effect imports in `index.ts`. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) → "The framework package, this
module, and the composition root".

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
- [Agent-base plan](docs/AGENT-BASE-PLAN.md) — the plan the framework
  extraction followed: what split base from module, the module API, and what
  the extraction still owes. Kept as the record of what was decided, with
  per-phase status notes, not as a description of the tree
- [Tool registry design](docs/TOOL-REGISTRY-DESIGN.md) — the pre-work design
  sketch for the declarative tool registry that replaced the hand-maintained
  tier arrays. Shipped; likewise a record rather than current documentation —
  for how it works now, read `docs/agents/module-map.md` and the code
- [Standards](docs/STANDARDS.md) · [Red-team](docs/RED-TEAM.md)
- [Slide deck](docs/SLIDE-DECK.md) — presentable 12-slide overview of the repo,
  the pipeline, and how the design maps to agentic best practice
