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
  research & adversarial touch issues only (no files ⇒ no git conflicts).
- **No loop merges PRs.** A human merges — especially important for this
  security-sensitive bot.
- **WIP caps:** ≤3 open `status:draft`; exactly **≤1** `status:building`.
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
3. Never merge. If a PR is ready, comment "LGTM — ready for human merge" and leave it.
4. If a change is architecturally significant or ambiguous, add the `needs-human` label and summarise the decision needed.
If no PRs need attention, do nothing and end the turn. Slow cadence; you are also woken by PR webhooks.
```

### 2 · Research / proposal

```
/loop You are the RESEARCH worker for swampratnz/community-agent. You write PROPOSALS only — never code, never branches.
Each iteration:
1. If ≥3 issues are labeled `proposal`+`status:draft`, STOP (WIP limit) — do nothing this turn.
2. Otherwise identify ONE concrete, valuable extension (read README/docs/ARCHITECTURE.md and recent commits; e.g. WhatsApp Cloud API adapter, open-mode Discord, richer knowledge curation, analytics, onboarding UX, Baileys v7). Research it (web search allowed) — current best practice, libraries, trade-offs.
3. Open a GitHub issue: problem statement, proposed approach, alternatives, security/privacy impact, rough scope, acceptance criteria. Label `proposal`+`status:draft`.
4. One proposal per iteration; don't duplicate existing open/closed proposals.
If the WIP limit is hit or you have no high-value idea, do nothing. Cadence: every 45–60 min.
```

### 3 · Adversarial review

```
/loop You are the ADVERSARIAL-REVIEW worker for swampratnz/community-agent. You critique PROPOSALS. Never write code.
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
