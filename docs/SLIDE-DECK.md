# Slide deck — `community-agent` repo overview

A 12-slide walkthrough of the repo: what the bot does, how it's built, the
framework it was split into, the self-improving pipeline that develops it, and
how the design lines up with published agentic-engineering practice. Each slide has headline bullets plus
a short talk track for the presenter. Sources: `README.md`,
`docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/PIPELINE.md`,
`docs/VISION.md`, `docs/agents/`, `CLAUDE.md`.

Figures (module/test/security-test counts) are approximate and drift as the
pipeline ships — re-check them against the repo before presenting. **Last
verified against `main` on 2026-08-04.** Note that since the framework was
extracted (slide 6), the source counts below measure THIS repo only — the
framework's own modules and tests live in `swampratnz/agent-base`, so a drop
in these numbers is not the system shrinking. The one-liners to re-run:

```bash
find src -name '*.ts' | wc -l                       # source modules
find src -name '*.ts' | xargs wc -l | tail -1       # lines of TypeScript
find tests -name '*.test.ts' | wc -l                # test files
node -e "const m=require('./tests/security-floor.json');const k=Object.keys(m).filter(x=>x[0]!=='\$');\
console.log(k.length,'files',k.reduce((a,x)=>a+(m[x].count??m[x]),0),'SECURITY: tests')"
grep -c '^## ' CHANGELOG.md                         # changelog sections
```

---

## Slide 1 — Title: "Dave — the NZ Claude Community Agent"

- A Claude-powered assistant running the **NZ Claude Community** — one service,
  two platforms: **Discord + WhatsApp**.
- Built on the **Claude Agent SDK** with subscription auth (no per-token
  billing).
- **Three stories**: the bot itself, the **framework** it was split into and
  published as a package, and the **self-improving pipeline** that proposes,
  reviews, and builds its own features.

> **Talk track:** frame the deck in three parts — slides 2–5 cover the
> product, slide 6 the framework extraction, slides 7–10 the pipeline that
> builds it, slide 11 wraps up, and slide 12 maps the design onto published
> agentic best practice.

---

## Slide 2 — What Dave does

- **Answers & knowledge**: questions about Claude/the API, grounded in a
  curated knowledge base with **source citations and freshness signals**;
  ingests Anthropic's official docs weekly; live `check_status` for incidents.
- **Memory**: every interaction embedded and stored (Postgres + pgvector);
  relevant history recalled each turn; an offline context builder distils
  recurring topics into durable digests.
- **Peer discovery** (the member→member half): members publish projects and
  interests; `who_is_into` / `/whois` matches "members like me" from your own
  published interests with no query at all, `list_projects` flags projects
  **seeking collaborators**, and `find_helper` DMs a member who opted into the
  helper pool.
- **Admin tools**: moderation (timeout/kick/warn/delete, opt-in
  auto-moderation with strikes), announcements, polls, events, threads, roles.
- **Multimodal & zero-cost paths**: opt-in voice-note transcription (local
  Whisper) and image attachments on all three surfaces — Discord, WhatsApp
  Baileys, WhatsApp Cloud API; Discord slash commands (`/kb`, `/whois`,
  `/projects`, `/guidelines`, `/digest`) and their WhatsApp `!`-prefixed
  counterparts answer the commonest lookups with **no model call at all**.
- **Feedback loops**: members rate answers, file reports, suggestions and
  knowledge tips (and can withdraw their own); digests surface what the
  community is asking.

> **Talk track:** "not just an answer service" — the VISION doc explicitly
> targets member→member and member→community value, not only bot→member, and
> the peer-discovery bullet is that goal made concrete. The zero-cost
> shortcuts matter too: every one is a question answered without spending an
> agent turn.

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

     every box above now ships in @swampratnz/agent-base (slide 6);
     this repo supplies the tools, prose and wiring that fill it
```

- **PlatformAdapter** is the seam: Discord and WhatsApp (Baileys or official
  Meta Cloud API) are swappable adapters over a platform-agnostic core.
- TypeScript on Node 22+, discord.js v14, local embeddings via
  transformers.js, systemd on Ubuntu.
- **68 source modules, ~17k lines of TypeScript** in this repo — down from
  ~100/~36k because the framework moved into a package (slide 6), not because
  the system got smaller.

> **Talk track:** the router decides *whether* to reply; storage is decoupled
> from response (opt-in ambient archiving), so recall works even for messages
> the bot never answered.

---

## Slide 4 — Security posture: designed for untrusted public chat

- **Three-tier RBAC** (super admin / admin / member) — roles come from env +
  the database, **never from message content**; tool surface is tier-derived
  and privileged tools re-assert the tier. **117 tools in all: 34 member,
  63 admin, 20 super-admin**, further filtered by platform and feature flag —
  only ever subtractively.
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
- **Agent Skills** (opt-in, off by default): six procedural playbooks —
  getting started, Claude Code setup, picking a model/plan, prompt review,
  agent-architecture review, project showcase — deliberately kept **separate
  from the knowledge base, which holds facts**. The enabled set is a
  hand-written allowlist in code, never `'all'`, so a new skill folder needs a
  second deliberate edit to go live.
- **Retrieval quality is regression-tested**: a golden-query eval
  (`tests/knowledgeEval.test.ts`) measures precision@K against paraphrased
  queries with distractors — new knowledge entries must ship with matching
  golden queries.

> **Talk track:** the eval rule ("paraphrases, never near-verbatim quotes, or
> the eval proves nothing") is a nice example of the repo's culture of making
> quality claims testable.

---

## Slide 6 — The extraction: from one codebase to a framework + a module

```
swampratnz/agent-base            swampratnz/community-agent
  @swampratnz/agent-base   ◄──── src/module/   NZ content + wiring
  (public npm, MIT)               src/index.ts  createAgent({ modules })
  agent kernel · adapters
  storage · router spine
  RBAC · jobs · registries
```

- The framework half — turn engine, Discord/WhatsApp adapters, storage,
  router security spine, RBAC, jobs — is now **`@swampratnz/agent-base` on
  public npm**. This repo is a *deployment*: its tools, prose, personas,
  te reo Māori strings, digests and integrations, plus the composition root.
- **The boundary is enforced, not intended.** The framework may not import the
  deployment; the deployment may not import the composition root; only the
  composition root may compose. Checked by an eslint rule *and* an independent
  resolver script, both run in CI.
- **A module contributes a manifest, not calls.** Tools, jobs, notice packs,
  policy keys, prompt slots, commands, schema fragments and adapter text packs
  are all data handed to `createAgent`, which owns registration order and
  refuses to return an agent if anything required is missing.
- **Releases publish by OIDC** — tag, and GitHub Actions publishes with no npm
  token existing anywhere. A daily **canary** builds this repo against the
  framework's `main`, so a breaking change upstream is caught before a release.

> **Talk track:** the honest version — the split was done by inverting every
> coupling *first* (registries, injected deps, manifests) and moving files
> *last*, so the physical move was mechanical. The interesting bit for an
> audience: every defect this exposed was in build, release and test
> machinery, never in product logic — including a startup crash that all
> 2,830 tests and a green CI run missed, because nothing booted the built
> app. That is now the top of the backlog: a smoke test that starts it.

---

## Slide 7 — The self-improving pipeline

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

> **Talk track:** ten GitHub Actions workflows implement the code-touching and
> support loops (plus five repo-hygiene ones); the two time-driven discovery
> loops — research and adversarial — run as scheduled Claude Routines instead,
> since Actions cost nothing when idle but need an event to fire. Ownership
> rule: only the build loop writes code, everything else touches issues or
> comments.

---

## Slide 8 — The support loops: keeping PRs moving without humans

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
  Ships **inert**: a repo variable (`AUTOMERGE_MODE`) has to be set to
  `dry-run`, then `live`, so the first loop allowed to write to `main` gets an
  observation window before it ever merges. *(Presenter: check the repo
  variable before claiming it's merging live in this deployment.)*
- **outcomes** — weekly, read-only, no-LLM: reconstructs each loop's record
  (engaged / checkpoint-recovered / escalated) from marker comments the loops
  already post, to answer *"is each loop earning its tokens?"*

> **Talk track:** every fixing loop is bounded (attempt caps), re-verifies
> eligibility from the API before touching anything, and can escalate but
> never open or merge PRs itself.

---

## Slide 9 — Quality gates: what "green" means here

- **CI parity**: the build worker runs the full CI gate (typecheck, lint,
  format, migrate, tests against a real pgvector Postgres container, build,
  security suite, context-pack freshness) *before* opening a PR — "green
  locally" is defined as matching CI.
- **Security floor**: **1,099** `SECURITY:`-prefixed tests across **149 files**
  here (plus 180 more in the framework repo),
  enforced by a per-file manifest (`tests/security-floor.json`) — exact
  counts, so a deleted security test can't slip through silently; per-file
  entries so concurrent PRs don't conflict.
- **181 test files** here; DB-touching tests skip cleanly without a local
  Postgres so contributors aren't blocked. `tests/` is also being brought
  under the typechecker on an **incremental ratchet** — an allowlist of files
  clean today, never shrunk to turn a build green.
- **Branch protection on `main`** is the enforceable backstop for every loop.

> **Talk track:** the security floor design (exact match + sorted manifest +
> `--allow-lower` requiring a PR explanation) is itself a lesson from running
> concurrent agent PRs — merge-conflict-free by construction.

---

## Slide 10 — Lessons baked into the design

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
- **Every worker is a cold session** → each run is a fresh Actions job with no
  memory, so it re-derives the same repo layout every time. Repo context is
  now committed once (`docs/agents/`, gated — a stale map is worse than none,
  because it is confidently wrong and a cold session can't tell), and
  work-item context is handed forward build → review as a bounded note that
  the reviewer is told is **untrusted data which may only add scrutiny, never
  remove it** (#767).
- **An unchecked seam hides a whole bug class** → `tsc` covered `src/**` only
  and `tsx` strips test types without checking them, so `tests/` went entirely
  untypechecked. Under that gap, an injected `deps` object missing a field
  fell through to the *real* repository function — a "unit" test quietly
  querying live Postgres, and since test files run in parallel those stray
  reads landed on tables other files were counting. That is where a chunk of
  the cross-file flakiness reddening unrelated PRs came from (#896).
- **A test can assert the right thing about the wrong value** → the first live
  handoff run broke twice: the consumer matched an API field using a value
  that field never emits (so the test passed and production failed), and the
  reviewer started 21 seconds before the note existed. Fixed with a real
  captured value and a draft → post → ready handshake (#770).

> **Talk track:** the pipeline docs read like a post-incident log — each
> guardrail cites the PR/issue number that motivated it. That's the most
> transferable idea in the repo.

---

## Slide 11 — Status, caveats, and where next

- **Live and self-developing**: 32 dated changelog sections covering ~5 weeks
  (2026-07-02 → 2026-08-03) and ~400 referenced PRs; **12 of the last 15
  merges to `main` were authored by the build loop**. A human remains the merge gate for
  anything touching governance, CI, or its own guardrails.
- **Known caveats, documented not hidden**: Baileys WhatsApp violates WhatsApp
  ToS — the official Meta Cloud API adapter has shipped as the supported
  production path (`WHATSAPP_PROVIDER=cloud`) and now reaches feature parity
  down to image input; subscription auth is a grey area (auth layer isolated
  for easy switch to API key); all interactions are logged — community notice
  + NZ Privacy Act 2020 retention policy required.
- **Where next**: `docs/VISION.md` (north-star metrics: answer quality,
  knowledge leverage) and `docs/CAPABILITY-IDEAS.md` (curated backlog) steer
  the research loop — and the loop has started closing on the vision itself:
  VISION's "time-to-first-answer" metric had no measurement behind it until
  the pipeline shipped the `response_latency` admin tool that measures it.
- **Takeaway**: a working template for agent-built software with humans at
  the guardrails — coordination through labels, bounded loops, deterministic
  backstops.

> **Talk track:** end on the takeaway — the bot is useful, but the
> reproducible asset is the pipeline pattern — and now, literally, the
> framework it produced. Slide 12 backs this up by mapping the design onto
> published agentic-engineering practice.

---

## Slide 12 — How the design maps to agentic best practice

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
  third time." Deterministic checks (CI, ~1,100 security tests) always run
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
  graduate only when a measured failure demands it. The same call was made
  again for cross-session context: the pipeline is *already* a graph (a
  label-driven state machine) and stateless Actions runs are the wrong host
  for an in-memory orchestrator, so the fix was to **write the context down**
  — a committed context pack plus stage-to-stage handoff notes — not to adopt
  a graph library.

> **Talk track:** the repo independently converged on (or consciously
> implements) the published patterns — including the parts most teams skip:
> stopping rules, artifact contracts, deterministic gates around LLM
> judgement, and adding complexity only after a specific observed failure.
