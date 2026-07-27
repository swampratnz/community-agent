# Slide deck — `community-agent` repo overview

An 11-slide walkthrough of the repo: what the bot does, how it's built, the
self-improving pipeline that develops it, and how the design lines up with
published agentic-engineering practice. Each slide has headline bullets plus
a short talk track for the presenter. Sources: `README.md`,
`docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/PIPELINE.md`,
`docs/VISION.md`, `CLAUDE.md`.

---

## Slide 1 — Title: "Dave — the NZ Claude Community Agent"

- A Claude-powered assistant running the **NZ Claude Community** — one service,
  two platforms: **Discord + WhatsApp**.
- Built on the **Claude Agent SDK** with subscription auth (no per-token
  billing).
- One repo, **two stories**: the bot itself, and the **self-improving
  pipeline** that proposes, reviews, and builds its own features.

> **Talk track:** frame the deck around the two halves — slides 2–5 cover the
> product, slides 6–9 cover the pipeline that builds it, slide 10 wraps up,
> and slide 11 maps the design onto published agentic best practice.

---

## Slide 2 — What Dave does

- **Answers & knowledge**: questions about Claude/the API, grounded in a
  curated knowledge base with **source citations and freshness signals**;
  ingests Anthropic's official docs weekly; live `check_status` for incidents.
- **Memory**: every interaction embedded and stored (Postgres + pgvector);
  relevant history recalled each turn; an offline context builder distils
  recurring topics into durable digests.
- **Admin tools**: moderation (timeout/kick/warn/delete, opt-in
  auto-moderation with strikes), announcements, polls, events, threads, roles.
- **Feedback loops**: members rate answers, file reports and suggestions;
  digests surface what the community is asking.

> **Talk track:** "not just an answer service" — the VISION doc explicitly
> targets member→member and member→community value, not only bot→member.

---

## Slide 3 — Architecture: one pipeline, pluggable platforms

```
Discord ─► DiscordAdapter ─┐                 ┌─ BaileysAdapter ◄─ WhatsApp
                           ▼                 ▼
                    Router (record · reply-gate · serialise · rate-limit)
                           ▼
                    Agent core (recall memory · role-scoped prompt ·
                                role-gated tools · resume session)
                           ▼
                    PostgreSQL + pgvector
                    (interactions · knowledge · sessions · admin_audit)
```

- **PlatformAdapter** is the seam: Discord and WhatsApp (Baileys or official
  Meta Cloud API) are swappable adapters over a platform-agnostic core.
- TypeScript on Node 22+, discord.js v14, local embeddings via
  transformers.js, systemd on Ubuntu.
- ~72 source modules, ~32k lines of TypeScript.

> **Talk track:** the router decides *whether* to reply; storage is decoupled
> from response (opt-in ambient archiving), so recall works even for messages
> the bot never answered.

---

## Slide 4 — Security posture: designed for untrusted public chat

- **Three-tier RBAC** (super admin / admin / member) — roles come from env +
  the database, **never from message content**; tool surface is tier-derived
  and privileged tools re-assert the tier.
- Built-in Claude Code tools **disabled every turn** (`tools: []`); only
  admin+ turns get `WebSearch`; `WebFetch` for no one.
- **Destructive actions are CONFIRM-gated** and executed by the router, not
  the model; secret redaction and code policy run in the adapters' send paths.
- Admin data access is **scoped in SQL** to conversations the admin is in;
  everything privileged is audited and alerted.

> **Talk track:** these are stated invariants in CLAUDE.md ("do not regress")
> and enforced by a dedicated security test suite — next slides show how.

---

## Slide 5 — Memory & knowledge quality

- Retrieval-augmented memory: embeddings on every interaction, per-turn
  recall, conversation-scoped context.
- Docs ingest from `platform.claude.com/llms.txt` as trusted RAG chunks,
  refreshed weekly by content diff; opt-in daily refresh for fast-moving
  topics.
- Admins curate the KB (`save_knowledge`, candidate review queue).
- **Retrieval quality is regression-tested**: a golden-query eval
  (`tests/knowledgeEval.test.ts`) measures precision@K against paraphrased
  queries with distractors — new knowledge entries must ship with matching
  golden queries.

> **Talk track:** the eval rule ("paraphrases, never near-verbatim quotes, or
> the eval proves nothing") is a nice example of the repo's culture of making
> quality claims testable.

---

## Slide 6 — The self-improving pipeline

```
research ──creates──► Issue [proposal, status:draft]
adversarial ──judges──► status:approved / status:rejected
build ──claims──► status:building ──► branch + PR "Closes #N" ──► status:built
pr-review ──reviews──► approve / request changes ──► revise loop responds
auto-merge ──merges fully-vetted bot PRs──► main   (humans merge the rest)
```

- Multiple concurrent Claude Code sessions coordinate **only through GitHub
  issues + labels** — the repo is the bus; no session-to-session channel.
- `docs/VISION.md` is the shared bar: research proposes against it,
  adversarial judges against it. **Tune quality by editing the vision, not
  the prompts.**
- `needs-human` is a lane, not a flag: escalated items leave the automated
  queue entirely and wait for a person.

> **Talk track:** 15 GitHub Actions workflows implement this; ownership rule —
> only the build loop writes code, everything else touches issues or comments.

---

## Slide 7 — The support loops: keeping PRs moving without humans

- **ci-retry** — one free machine rerun before any agent engages (flakes cost
  zero agent time).
- **autofix** — pushes fixes to a bot PR whose CI fails (max 2 attempts, then
  `needs-human`); self-heals the two dominant mechanical failures first.
- **conflict-resolver** — merges `main` into CONFLICTING PRs (hourly sweep +
  event-driven); one attempt, then escalate.
- **revise** — responds to "Changes requested" reviews, the case autofix
  (CI-keyed) never sees.
- **groundskeeper** — deterministic hourly reconciler that unwedges zombie
  `status:building` issues.
- **auto-merge** — deterministic, no-LLM loop that merges only fully-vetted
  build-worker PRs; governance/CI/config paths **always require a human**.

> **Talk track:** every fixing loop is bounded (attempt caps), re-verifies
> eligibility from the API before touching anything, and can escalate but
> never open or merge PRs itself.

---

## Slide 8 — Quality gates: what "green" means here

- **CI parity**: the build worker runs the full CI gate (typecheck, lint,
  format, migrate, tests against a real pgvector Postgres container, build,
  security suite) *before* opening a PR — "green locally" is defined as
  matching CI.
- **Security floor**: ~990 `SECURITY:`-prefixed tests across ~120 files,
  enforced by a per-file manifest (`tests/security-floor.json`) — exact
  counts, so a deleted security test can't slip through silently; per-file
  entries so concurrent PRs don't conflict.
- 164 test files overall; DB-touching tests skip cleanly without a local
  Postgres so contributors aren't blocked.
- **Branch protection on `main`** is the enforceable backstop for every loop.

> **Talk track:** the security floor design (exact match + sorted manifest +
> `--allow-lower` requiring a PR explanation) is itself a lesson from running
> concurrent agent PRs — merge-conflict-free by construction.

---

## Slide 9 — Lessons baked into the design

- **Prompt-only compliance is unreliable** → a deterministic post-agent
  *checkpoint step* pushes committed-but-unpushed work; born from real
  incidents (PRs #606/#609 where agents ended their turn "waiting" and the
  work died with the runner).
- **Retries need resume pointers** → failed build attempts publish their
  branch + commit so the next attempt continues instead of rebuilding from
  scratch (#667, #701).
- **Rescued work is never laundered** → checkpointed/recovered branches still
  face CI and automated review; recovery PRs open as drafts under an identity
  auto-merge won't touch.
- **Escalations carry diagnosis** → a loop that gives up posts the agent's own
  final summary, so a human isn't reverse-engineering run logs.

> **Talk track:** the pipeline docs read like a post-incident log — each
> guardrail cites the PR/issue number that motivated it. That's the most
> transferable idea in the repo.

---

## Slide 10 — Status, caveats, and where next

- **Live and self-developing**: 26 changelog sections and counting; a human
  remains the merge gate for anything touching governance, CI, or its own
  guardrails.
- **Known caveats, documented not hidden**: Baileys WhatsApp violates WhatsApp
  ToS (official Cloud API adapter is the upgrade path); subscription auth is a
  grey area (auth layer isolated for easy switch to API key); all interactions
  are logged — community notice + NZ Privacy Act 2020 retention policy
  required.
- **Where next**: `docs/VISION.md` (north-star metrics: answer quality,
  knowledge leverage) and `docs/CAPABILITY-IDEAS.md` (curated backlog) steer
  the research loop.
- **Takeaway**: a working template for agent-built software with humans at
  the guardrails — coordination through labels, bounded loops, deterministic
  backstops.

> **Talk track:** end on the takeaway — the bot is useful, but the
> reproducible asset is the pipeline pattern. Slide 11 backs this up by
> mapping the design onto published agentic-engineering practice.

---

## Slide 11 — How the design maps to agentic best practice

Benchmarked against the published pattern vocabulary — Andrew Ng's four
agentic design patterns and Anthropic's five workflow patterns (e.g. the
"Graph Engineering for Multi-Agentic Systems" synthesis of both):

- **Multi-agent with artifact contracts** — pipeline roles (research /
  adversarial / build / review / revise) each catch a different error class,
  and coordinate only through typed GitHub issues, labels, and PRs ("the repo
  is the bus") — artifacts and shared state, never conversation transcripts.
- **Evaluator-Optimizer with stopping rules** — build → review → revise is
  the classic generate/evaluate loop; every loop has an attempt cap (2/2/1/3)
  and escalates `needs-human` — the prescribed "escalate rather than retry a
  third time." Deterministic checks (CI, 991 security tests) always run
  before subjective LLM review.
- **Explicit, immutable rubric** — `VISION.md` is the shared scoring rubric;
  quality is tuned by editing it, not the loop prompts.
- **Control matched to risk** — the highest-stakes actions (auto-merge,
  groundskeeper, ci-retry) are deterministic no-LLM chains with hard gates;
  bounded agents handle only the lower-risk fix/resolve/revise work; cheapest
  mechanism always tries first (free machine rerun before any agent).
- **Traceability test passed** — "every important output traces to a task, a
  plan, an artifact, a source, an evaluator decision, and a bounded execution
  record" maps 1:1 onto issue → proposal → PR → citations → review verdict →
  CI run + attempt counters.
- **Deliberate divergence** — no typed knowledge graph: memory is pgvector
  RAG + relational state, the playbook's own "graph earns itself" waypoint;
  graduate only when a measured failure demands it.

> **Talk track:** the repo independently converged on (or consciously
> implements) the published patterns — including the parts most teams skip:
> stopping rules, artifact contracts, deterministic gates around LLM
> judgement, and adding complexity only after a specific observed failure.
