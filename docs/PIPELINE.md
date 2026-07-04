# Multi-loop development pipeline

A supervised, multi-session Claude Code pipeline that extends this repo
autonomously while keeping a human as the merge gate. Five concurrent Claude
Code sessions, each running a recurring `/loop`, coordinate **through GitHub
issues + labels** (there is no direct session-to-session channel — the repo is
the bus).

## Flow

```
research ──creates──▶ Issue [proposal, status:draft]
                            │
adversarial ──judges──▶ status:approved   or   status:rejected (closed)
                            │
build ──claims (WIP=1)──▶ status:building ──▶ branch + PR "Closes #N" ──▶ status:built
                            │
pr-review ──reviews PR──▶ approve / request changes
                            │
build ──addresses feedback──▶ …
                            │
                      ⟶  HUMAN merges  ⟵
```

## Labels (the state machine)

| Label | Meaning | Set by |
|---|---|---|
| `proposal` | This issue is a feature proposal | research |
| `status:draft` | Awaiting adversarial review | research |
| `status:approved` | Survived adversarial review; buildable | adversarial |
| `status:rejected` | Failed review (issue closed) | adversarial |
| `status:building` | Claimed by the build loop (**WIP = 1**) | build |
| `status:built` | PR open, awaiting review/merge | build |
| `needs-human` | Escalated — a human must decide | any loop |

Create them once: **Actions → "Setup pipeline labels" → Run workflow**, or
`bash scripts/setup-labels.sh` locally.

## Ownership rules (enforced by every loop; also in CLAUDE.md)

- **Only the build loop** writes code / opens PRs. PR-review comments only;
  research & adversarial touch issues only (no files ⇒ no git conflicts). One
  exception: the **autofix loop** (`pipeline-pr-autofix.yml`) may push fixes to
  an existing build-worker PR branch when its CI fails — same-repo bot PRs only,
  capped at 2 attempts, then it escalates `needs-human`. It never opens or
  merges PRs. Do not misflag its pushes as an ownership violation.
- **No loop merges PRs.** A human merges — especially important for this
  security-sensitive bot.
- **WIP caps:** ≤3 open `status:draft`. Builds run per-issue-parallel (the
  build worker's `concurrency` is keyed by issue number), so multiple
  `status:building` issues are allowed; keep the number in flight small (≈2),
  since every run draws on the shared Max pool.
- **Label transitions are the only cross-session messaging.** When blocked or
  genuinely ambiguous, add `needs-human` and stop rather than guess.
- **Everything traces to an issue number.**
- The **build** session runs in its **own git worktree** so it never collides
  with a human working tree.

## Rollout & cost

All sessions share **one** Max usage pool (5-hour rolling + weekly cap) across
Claude Code, chat, everything. Don't launch all five at once:

1. Start **pr-review + build**, watch `/usage` for a day to learn burn rate.
2. Add **research + adversarial**.
3. Add **orchestrator** last.

`/loop` tasks and cron jobs are **session-scoped and auto-expire after 7 days**
— re-arm weekly. For truly unattended automation, port the heavier loops to
GitHub Actions triggered by these same labels.

## Model selection per loop

All five sessions share one Max usage pool, so match the model to each loop's
cognitive demand × frequency. Set it per session with `/model` (or `--model`
at launch).

| Loop | Model | Rationale |
|---|---|---|
| Adversarial review | **Opus 4.8** | Highest-leverage judgement (a rejected weak proposal saves a whole build+review cycle); runs infrequently, so Opus cost is bounded. |
| PR review | **Sonnet 5** | Strong security-diff reasoning, fires often, human merges behind it. Bump to Opus for a deep security pass. |
| Build | **Sonnet 5** | Heaviest token user (many agentic turns); Sonnet 5 is tool-optimised and far cheaper per unit work. |
| Research | **Sonnet 5** | Idea generation + web research; runs slowly. Opus only if proposal quality disappoints. |
| Orchestrator | **Haiku 4.5** | Pure bookkeeping (labels, digests); cheapest and fast, ticks every 60 min. |

Principle: **Opus where a wrong call is expensive and rare, Haiku where it's
mechanical, Sonnet 5 for high-volume agentic work.**

## The five loop prompts

Launch each in its own session with the `/loop` skill. Each is written to
**exit cleanly doing nothing when there is no work** — that keeps idle wake-ups
cheap.

### 1 · PR review

```
/loop You are the PR-REVIEW worker for swampratnz/community-agent. Do NOT write application code, push commits, or merge.
Each iteration:
1. List open PRs. For each with new commits or unaddressed review threads since you last looked, review the diff for correctness, security (community bot with RBAC + prompt-injection surface — scrutinise auth, tool gating, outbound filtering, SQL scoping), and test coverage.
2. Leave concise inline comments; approve if clean, else request changes. Check CI and note failures.
3. Never merge. ALWAYS post one top-level verdict comment even when clean (e.g. "LGTM, ready for a human to merge"), so there's a visible record; don't rely on GitHub's Approve state.
4. If a change is architecturally significant or ambiguous, add the `needs-human` label and summarise the decision needed.
If no PRs need attention, do nothing and end the turn. Slow cadence; you are also woken by PR webhooks.
```

### 2 · Research / proposal

```
/loop You are the RESEARCH worker for swampratnz/community-agent. Read docs/VISION.md first (mission, value rubric, theme areas, what NOT to propose). You write PROPOSALS only — never code, never branches.
Each iteration:
1. If ≥3 issues are labeled `proposal`+`status:draft`, STOP (WIP limit) — do nothing this turn.
2. Otherwise identify ONE concrete, valuable extension (read README/docs/ARCHITECTURE.md and recent commits; e.g. WhatsApp Cloud API adapter, open-mode Discord, richer knowledge curation, analytics, onboarding UX, Baileys v7). Research it (web search allowed) — current best practice, libraries, trade-offs.
3. Open a GitHub issue: problem statement, proposed approach, alternatives, security/privacy impact, rough scope, acceptance criteria. Label `proposal`+`status:draft`.
4. One proposal per iteration; don't duplicate existing open/closed proposals.
If the WIP limit is hit or you have no high-value idea, do nothing. Cadence: every 45–60 min.
```

### 3 · Adversarial review

```
/loop You are the ADVERSARIAL-REVIEW worker for swampratnz/community-agent. Read docs/VISION.md first and judge against the same rubric research generates against. You critique PROPOSALS. Never write code.
Each iteration:
1. Find issues labeled `proposal`+`status:draft` with no adversarial verdict yet.
2. Attack each hard: does it solve a real problem? Security/privacy holes (injection, RBAC bypass, data exposure)? Fit with the gated three-tier RBAC architecture? Cost/token impact on the Max subscription? Simpler alternative? Realistic scope? WhatsApp ToS/ban risk?
3. Post a verdict comment. If it survives: relabel `status:draft`→`status:approved` and tighten acceptance criteria. If not: relabel →`status:rejected`, explain, and close the issue.
4. If genuinely borderline (a real call for the owner), add `needs-human` instead of deciding.
Rejecting weak proposals is success. If nothing awaits review, do nothing. Cadence: every 30–45 min.
```

### 4 · Build

```
/loop You are the BUILD worker for swampratnz/community-agent. You are the ONLY session that writes code or opens PRs. Work in your own git worktree; keep main clean.
Each iteration:
1. If any issue is `status:building`, that's your job — continue it. NEVER have two `status:building` at once.
2. Else pick the oldest `status:approved` issue, relabel it `status:building`, and claim it in a comment.
3. Implement on a fresh branch: follow existing conventions, write/extend tests, run `npm run typecheck && npm test && npm run build` — all must pass; exercise DB paths against local Postgres if relevant.
4. Open a PR whose body says "Closes #<n>" with change summary, security impact, verification. Relabel the issue `status:built`. Leave the PR as draft; do NOT merge — a human merges.
5. If PR-review requests changes, address them and push.
6. If the approved proposal is infeasible/unsafe as specified, add `needs-human` and explain rather than forcing it.
If nothing is approved and nothing building, do nothing. Cadence: frequent while holding a `status:building` item, slow otherwise.
```

### 5 · Orchestrator / groundskeeper

```
/loop You are the ORCHESTRATOR for the swampratnz/community-agent pipeline. You do NOT write code, review PRs, or judge proposals — you keep the pipeline healthy and report to the human.
Each iteration:
1. Enforce WIP limits: if >3 `status:draft`, comment on the excess asking research to hold; flag if >1 `status:building`.
2. Detect stuck items: `status:building` with no commit in 24h, `status:built` with an open PR untouched 48h, any `needs-human` item.
3. Detect label hygiene issues: proposals with no status, closed issues still labelled building, PRs not linked to an issue.
4. Once per day (not every iteration) post a single "Pipeline status <date>" digest: what moved, what's stuck, what needs the human, open PRs awaiting merge.
5. Never change code or merge. Surface, don't fix.
If everything is healthy and today's digest is already posted, do nothing. Cadence: every 60 min.
```

## Running as Routines (Claude cloud) — the durable way

`/loop` only fires while its session is awake and idle. In a **cloud
environment** the container is suspended when you leave, so the loop's timer
can't fire — iterations only advance when you resume the session and wake it
(i.e. you become the scheduler). To run unattended, convert each loop to a
**Routine (scheduled task)** set to **start a fresh session on each fire**: the
server-side scheduler spawns a new session on schedule, with no human present.

This works because all pipeline state lives in GitHub issues + labels, not in
session memory — a fresh session just reads repo state, does one unit of work,
and exits. Consequences to respect:

- **Prompts must be self-contained** (no "since you last looked" — use labels
  and time windows). The versions below are rewritten for that.
- **Cadence floor is hourly.** The `/loop` cadences above become hourly-or-
  longer here.
- **Every fire is a full session** against your shared Max pool. Keep cadences
  relaxed and prefer GitHub Actions for the event-driven loops.

### Recommended mapping

| Loop | Mechanism | Cadence | Model |
|---|---|---|---|
| research | Routine (fresh session) | every ~3h | Sonnet 5 |
| adversarial | Routine (fresh session) | every ~2h | Opus 4.8 |
| orchestrator | Routine (fresh session) | every ~6h | Haiku 4.5 |
| build | **GitHub Action** on `issues.labeled == status:approved` (Routine hourly as fallback) | event | Sonnet 5 |
| pr-review | **GitHub Action** on `pull_request` events (Routine hourly as fallback) | event | Sonnet 5 |

Event-driven Actions cost nothing when idle and need no live session — the
right fit for the two code loops. Routines suit the time-driven discovery loops.

### Setup

Create one Routine per time-driven loop in the Claude Code web UI (scheduled
tasks), pointing at your environment, **"create a new session each run"**, with
the standalone prompt below. Test without waiting for the schedule by **firing
the routine on demand** and watching it act within a minute.

**Heartbeat tip (to tell "healthy-idle" from "dead"):** the prompts are silent
when there's no work, so a working routine and a dead one look identical. While
validating, append to a prompt: *"First run `date -u` and post it as a comment
on issue #<heartbeat>. Then:"* — the comment timeline becomes your monitor.
Remove it once you trust the schedule.

### Standalone routine prompts

**Research** (every ~3h):
```
You are the RESEARCH worker for swampratnz/community-agent, running as a scheduled routine — a fresh session, no memory of past runs; all state is in GitHub. Do this once, then end. You write PROPOSALS only — never code.

Read docs/VISION.md first — it defines the mission, the value rubric, the theme areas, and what NOT to propose. Optimise for making the bot genuinely more useful to community members and lower-effort for admins.

1. Capacity check: count open issues labeled `proposal` with `status:draft` or `status:needs-revision`. If ≥3, STOP — end without acting.
2. Gather evidence before inventing: scan open AND closed issues, any `community-feedback` issues, recent commits (to see what's already shipped), README/docs/ARCHITECTURE.md/PIPELINE.md, and web search for what comparable communities value. Prefer proposals that address observed member/admin need over speculative features. Rotate theme areas so proposals stay diverse.
3. Pick ONE idea that scores well on the VISION rubric (member impact, reach, effort, architectural + security fit) and is shippable in roughly one PR. Do not duplicate any existing open or closed proposal, or anything already built.
4. Open an issue: problem statement (who it helps and the evidence), proposed approach, alternatives considered, security/privacy impact, rough scope + smallest viable version, and measurable acceptance criteria. Label `proposal` + `status:draft`.

One proposal per run. If nothing clears the rubric or you're at capacity, end without filing noise — a skipped run is better than a weak proposal.
```

**Adversarial** (every ~2h):
```
You are the ADVERSARIAL-REVIEW worker for swampratnz/community-agent, running as a scheduled routine — a fresh session; all state is in GitHub. Do this once, then end. You critique PROPOSALS; never write code.

Read docs/VISION.md first — judge each proposal against the SAME rubric and guardrails the research worker generates against.

1. Find open issues labeled `proposal` + `status:draft` that have no adversarial verdict comment from you yet.
2. Attack each hard: does it clear the VISION rubric (real problem, reach, effort, fit)? Security/privacy holes (injection, RBAC bypass, data exposure)? Fit with the gated three-tier RBAC architecture? Cost/token impact on the Max subscription? Simpler alternative? Realistic one-PR scope? WhatsApp ToS/ban risk? Does it violate any VISION guardrail?
3. Post a verdict comment. Survives → relabel `status:draft`→`status:approved` and tighten acceptance criteria. Fails → relabel →`status:rejected`, explain against the rubric, and close. Borderline judgement call for the owner → add `needs-human` and leave it.
End when none remain.
```

**Orchestrator** (every ~6h):
```
You are the ORCHESTRATOR for the swampratnz/community-agent pipeline, running as a scheduled routine — a fresh session; all state is in GitHub. You do NOT write code, review PRs, or judge proposals. Do this once, then end.
1. Enforce WIP: if >3 open `proposal`+(`status:draft`|`status:needs-revision`), comment on the excess asking research to hold; if >1 `status:building`, flag it.
2. Detect stuck items: `status:building` with no commit in 24h; `status:built` with an open PR untouched 48h; any `needs-human`.
3. Detect label hygiene: proposals with no status, closed issues still labelled building, PRs not linked to an issue.
4. If no "Pipeline status <today>" digest exists yet, post one: what moved, what's stuck, what needs the human, open PRs awaiting merge. If today's already exists, skip.
Never change code or merge. End.
```

Build and pr-review run as **GitHub Actions** (label/PR triggered), not live
sessions:

- `.github/workflows/pipeline-build.yml` — fires on `issues.labeled ==
  status:approved`, implements on a branch, opens a PR "Closes #N", relabels
  `status:built`. `concurrency` serialises builds (WIP=1); `--max-turns 40` +
  a 45-min job timeout bound a run.
- `.github/workflows/pipeline-pr-review.yml` — fires on `pull_request`
  events; reviews the diff (security-focused), comments/approves, never merges.

Both use `anthropics/claude-code-action@v1` with **subscription auth** via the
`CLAUDE_CODE_OAUTH_TOKEN` secret (from `claude setup-token`) — same Max pool as
the bot, not a metered key.

To go live:
1. Add repo secret **`CLAUDE_CODE_OAUTH_TOKEN`** (Settings → Secrets → Actions).
2. **Install the Claude GitHub App** on the repo so the action can comment/push.

Until both exist the workflows are inert (they log a notice and skip). Fork PRs
never receive the secret, so the review worker won't run on untrusted forks.

**Cost caution:** every run draws on the same Max 5-hour/weekly pool as the
production bot serving real members. Keep an eye on `/usage`; if the pipeline
starts starving the live bot, relax cadences or move the pipeline to a separate
plan/account.

