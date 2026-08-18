# Agent pipeline adoption playbook

**A specification for automating development, review and PR repair on a
repository — written to be handed to an AI session pointed at that repository.**

This is not a copy-paste kit. It is the design, the decision rules, the staged
rollout and the hard-won failure modes, so a session can assess a specific repo,
recommend what fits *there*, and propose a rollout the maintainer can approve one
stage at a time.

It is derived from a pipeline that has been running in production on
`swampratnz/community-agent` — every "why" below traces to something that
actually broke. Where a claim comes from a specific incident, the issue or PR
number is cited so it can be checked rather than believed.

---

## How to use this document

Point a session at the target repository with roughly this instruction:

> Read `PIPELINE-PLAYBOOK.md`. Assess this repository against §2, then produce
> the recommendation described in §9. **Do not create any workflow files yet** —
> I want the assessment and the staged plan first.

The session's job in that first pass is *diagnosis, not installation*. A rollout
that starts before §3's prerequisites hold produces automation that fails in ways
nobody can see, which is worse than no automation.

Once a stage is approved, the same document drives implementation: §5 says what
each component is, §6 what order to install in, §7 what to parameterise, §8 what
must never be weakened.

---

## 1 · What this automates, and what it does not

**The loop being automated.** An issue is approved for work → an agent implements
it on a branch and opens a PR → an agent reviews that PR → when CI fails, or the
review requests changes, or `main` moves under it and it conflicts, an agent
repairs it → a human merges. Deterministic sweeps catch anything that falls
between those steps.

| It does | It does not |
|---|---|
| Turn an approved issue into a reviewed PR without a human present | Decide *what* is worth building (unless you add the optional discovery loops) |
| Review every PR for correctness and security, with a written verdict | Replace human review on anything consequential |
| Fix its own red CI, resolve its own merge conflicts, respond to review feedback | Fix things it doesn't understand — it escalates instead |
| Recover work an agent committed but failed to push | Make an unreliable test suite reliable |
| Escalate to a human, visibly, whenever it is out of its depth | Merge (unless you deliberately enable that at the last stage) |

**The honest cost.** Every agent loop spends model tokens on a shared budget. A
build can run 30–180 minutes of wall clock. The pipeline is worth it when the
bottleneck is *implementation throughput on well-specified work*. It is not worth
it when the bottleneck is deciding what to build, or when the codebase can't tell
you whether a change is correct.

**The prerequisite that decides everything.** All of this rests on a CI gate that
genuinely distinguishes working from broken. Agents cannot tell whether their work
is correct; the gate tells them. A repo whose tests are flaky, slow, or shallow
will produce agents that confidently ship broken changes and repair loops that
thrash. *Fixing the gate is stage 0, and it is not optional.*

---

## 2 · Assessing the target repository

Work through these before recommending anything. Each finding maps to a
consequence, not just a checkbox.

### 2.1 The gate

| Check | How | If absent or weak |
|---|---|---|
| CI runs on every PR | `.github/workflows/`, branch protection | **Blocker.** Nothing downstream is safe. Stage 0. |
| Tests exist and mean something | coverage of the critical paths; do they catch a deliberate bug? | **Blocker for the build loop.** Review-only automation is still viable. |
| CI is reliable | look at the last ~30 runs: what % failed for non-code reasons? | >10% flake ⇒ install the retry loop *first*, and expect repair loops to chase ghosts until it's fixed. |
| CI is reasonably fast | median duration | >30 min makes repair loops slow and expensive; consider a fast subset for agent use. |
| The gate is one command list | a documented "run this before pushing" | If absent, define it in stage 0 — agents and CI must run the *same* checks, or "green locally" is a lie. |
| External services needed | DB, queues, browsers | Every agent workflow that runs the gate needs the same service containers as CI. |

### 2.2 Governance

| Check | If absent |
|---|---|
| Branch protection on the default branch | **Blocker.** This is the enforceable backstop behind every guardrail; tool allowlists are defence in depth, not a substitute. |
| Required status checks | Add them. Without this, "green" is advisory. |
| Who may merge | Decide before any loop can push. |
| `CODEOWNERS` for sensitive paths | Recommended before the build loop — routes review on the parts you care most about. |
| A conventions doc (`CLAUDE.md`, `CONTRIBUTING.md`) | **Required for the build loop.** A cold agent with no written conventions invents its own. |

### 2.3 Workflow and culture

| Question | Why it matters |
|---|---|
| Are issues actually used to track work? | The pipeline coordinates through issues + labels. No issue hygiene ⇒ no build loop; review automation still works. |
| Is there a `Closes #N` convention? | This is how repair loops distinguish "a PR the pipeline owns" from a Dependabot bump. If absent, adopt one — it is the cheapest possible ownership signal. |
| How many people review? | A solo maintainer gets the most from review automation. A team with fast review gets more from the build and repair loops. |
| Fork contributions? | Fork PRs must never receive secrets or run agent code. If the repo takes external PRs, every loop needs a same-repo check — non-negotiable. |
| Other bots active? | Dependabot etc. produce same-repo bot PRs that must be *excluded* by the ownership signal, or loops will try to "fix" them. |
| Monorepo? | Affects concurrency grouping and whether the gate can be scoped per package. |

### 2.4 Capacity and cost

| Question | Consequence |
|---|---|
| Which model access — subscription or metered API? | Subscription: a shared pool the loops contend for; watch usage. Metered: a per-run cost you can bound. |
| Is a production service on the same account? | Pipeline runs can starve it. Separate accounts if so. |
| Expected PR volume | Drives cadence and caps. |
| Tolerance for an unattended agent pushing to a branch | Determines whether stage 4 is acceptable at all. |

### 2.5 Codebase shape

- **Size and layout.** A large repo needs a committed orientation map (which
  module owns which behaviour), or every cold agent session re-derives it.
- **Test-to-code ratio.** Low ⇒ the build loop will produce plausible, unverified
  changes.
- **Change coupling.** If a typical change touches many files across layers, note
  which gate catches a missed one; agents systematically forget the same files.
- **Generated files, lockfiles, manifests.** These are the classic merge-conflict
  hotspots and want a deterministic regeneration path rather than hand-merging.

---

## 3 · Non-negotiable prerequisites

If any of these is false, the recommendation is stage 0 work, not automation:

1. **A CI gate that fails on broken code**, running on every PR.
2. **Branch protection on the default branch**, with required checks.
3. **A written conventions document** an agent reads before changing code.
4. **A same-repo ownership signal** (`Closes #N` or equivalent) so loops know
   which PRs are theirs.
5. **A model credential stored as a repository secret**, and — for pushes and
   comments to appear as a distinct identity — a GitHub App installed.

---

## 4 · The architecture in one page

```
      ISSUE  ──labelled ready──▶  BUILD AGENT  ──▶  branch + PR "Closes #N"
                                       │
                                       ▼
                                 REVIEW AGENT  ──▶  verdict comment (typed token)
                                       │
             ┌─────────────────────────┼─────────────────────────┐
             ▼                         ▼                         ▼
        CI failed              changes requested            conflicts
             │                         │                         │
        retry (free)              REVISE AGENT           CONFLICT AGENT
             │                         │                         │
        AUTOFIX AGENT ───────── all capped at N attempts ─────────┘
             │
             ▼
        needs-human  ◀── every loop's terminal state ──▶  HUMAN MERGES
```

Four structural properties make it safe. They are the point of the design, not
incidental:

1. **All state lives in the forge.** Issues, labels, PR fields and marker
   comments. No loop remembers anything; a dead run costs only its tokens.
2. **Deterministic wherever possible.** Every decision expressible as a shell
   condition is one. Only implementation, review and repair need a model.
3. **The workflow owns state transitions, not the agent.** Agents are granted
   no ability to relabel arbitrary issues; the workflow claims and releases lanes
   around them.
4. **Every loop has a bounded number of attempts and one terminal state**
   (`needs-human`) that takes the item out of automation entirely.

---

## 5 · Component catalogue

Each entry: what it does, what triggers it, the permissions it needs, what it
depends on, and how it fails. Install order is §6.

### 5.1 Deterministic components (no model, no token cost)

**CI retry** — re-runs a failed CI run once, blindly, before any agent engages.
Trigger: CI run completed with failure, attempt < 2. Permissions: `actions:write`,
`contents:read`. *Why blind rather than a log classifier: a classifier is another
thing to maintain and another way to be wrong; a single retry costs one bounded
run.* Include a **staleness guard** — if the branch has moved past the failed
commit, don't re-run, or you cancel the newer commit's in-flight CI and the branch
ends with no verdict at all.

**Build retry** — re-runs a failed build-agent run, capped (3 attempts total).
Same shape. Exists so transient infrastructure failures don't consume human
attention. *Note the gap it cannot cover: a run that hits its timeout reports
`cancelled`, not `failure`, and is invisible to failure-keyed retries — that's the
groundskeeper's job.*

**Groundskeeper** — hourly sweep for zombie state: an issue marked in-progress
with no open PR and no activity for N hours gets escalated to a human, both status
labels cleared. Permissions: `issues:write`, `pull-requests:read`. This is what
enforces "in-progress means a build is actually running". Without it, a timed-out
build wedges its lane forever and starves the queue.

**Branch janitor** — weekly deletion of branches whose work has landed. Deletes
only when ancestry-merged *or* every PR with that head is merged. *Squash merges
leave no ancestry trail — the PR ledger, not git ancestry, is the reliable signal.*
Ship it dry-run-by-default; a scheduled run supplies no inputs, so map the dry-run
flag to an explicit literal rather than relying on a dispatch default.

**Changelog coverage / outcome ledger** — read-only reporting. The outcome ledger
is the one that earns its place fastest: it reconstructs per-loop success,
recovery and escalation counts from marker comments the loops already post, so
"is this loop earning its tokens?" has an answer. Watch the **recovered** count —
every one is a prompt or harness defect, not a code defect.

### 5.2 Agent components

**Review agent** — reviews each PR's diff and posts one verdict comment.
Trigger: `pull_request` opened/synchronize/reopened/ready_for_review.
Permissions: `contents:read`, `pull-requests:write`. **Run it read-only**: give
the agent no write tools, capture its final message, and have a deterministic step
post the comment. That avoids permission-denial thrash and guarantees a comment on
every run, including clean ones.

*The verdict must be a typed artifact, not prose.* Have the model emit a hidden
token (`<!-- verdict:LGTM -->` / `CHANGES_REQUESTED` / `NEEDS_HUMAN`), and have the
one workflow that composes the comment stamp exactly one authoritative token.
Every consumer reads that token. Free-prose parsing across multiple consumers
drifts, and the drift is silent: a fix landing in two of three consumers left
approved PRs sitting unmerged forever with no error anywhere.

**Build agent** — implements an approved issue on a branch and opens a PR.
Trigger: issue labelled ready. Permissions: `contents`/`issues`/`pull-requests`
write. The heaviest component and the one with the most machinery around it:

- The **workflow**, not the agent, claims the lane before the run and marks it
  built after. The agent gets no ability to edit issue labels — a matcher can't
  pin an issue number, so that grant would let an injected agent mark an arbitrary
  issue ready and spawn an unreviewed build.
- **Push incrementally.** The agent's credential can expire mid-run (~1h) while
  the job budget is much longer; an unpushed tree dies with the runner.
- A **deterministic checkpoint** after the agent exits pushes anything it
  committed but never pushed. Prompt-only compliance is provably unreliable —
  agents have finished entire builds and ended their turn without pushing.
- A **verify-else-escalate** step asserts the outcome (does a PR closing this
  issue exist?) and fails loudly otherwise. An agent that narrates work it didn't
  do must never produce a green run.
- Escalate on the **final** attempt only, and clear *both* status labels so the
  item leaves the automated lanes entirely.

**Autofix agent** — repairs a build-agent PR whose CI failed. Trigger: CI run
failed, same-repo, ownership signal present, attempt ≥ 2 (after the free retry).
Capped at 2 attempts, then escalate. Must skip PRs already escalated.

**Conflict resolver** — merges the default branch into a conflicting PR and
resolves. Triggers: push to default branch, PR opened, plus a slow sweep — the
forge emits no webhook for the conflicting transition, and a PR can be *born*
conflicted. One attempt per conflict, then escalate.

**Revise agent** — responds to a changes-requested review on a green PR. Without
it, that edge has no responder: the build agent is one-shot and autofix only reacts
to CI failure. Capped at 2 attempts (the push re-triggers review, so uncapped it
becomes a reviewer-vs-reviser loop).

**Auto-merge** (optional, last) — merges fully-vetted PRs one at a time. Keep it
**deterministic — no model at all**: it reads PR fields as data and runs no
PR-controlled code, so it has none of the repair loops' injection surface.
Requires: exact author identity match, ownership signal, all checks green,
mergeable, a fresh approving verdict *newer than the head commit*, no stop labels,
and **no change to any governance path** (CI config, the check scripts, the
workflows themselves, the conventions docs). Ship it inert behind a mode variable:
unset → does nothing, `dry-run` → logs what it would merge, `live` → merges.

---

## 6 · Staged rollout

Each stage has entry criteria, a verification step, and a rollback. **Do not skip
ahead**: each stage's failure mode is cheap to see only when the earlier stages
are already trustworthy.

### Stage 0 — Foundations *(no automation)*
- **Install:** nothing. Fix the gate, turn on branch protection with required
  checks, write the conventions doc, adopt the ownership signal, create the labels.
- **Verify:** the gate command list passes locally and in CI, and it fails when you
  deliberately break something.
- **Exit:** all five prerequisites in §3 hold.

### Stage 1 — Deterministic loops *(zero token cost)*
- **Install:** CI retry, branch janitor (dry-run), changelog/outcome reporting.
  Groundskeeper only once lane labels exist.
- **Verify:** deliberately fail a CI run and watch the retry fire once, and only
  once. Run the janitor dry and read what it *would* delete.
- **Exit:** a week of clean runs. Rollback: disable the workflow.
- **Why first:** it proves the plumbing — permissions, triggers, concurrency — with
  no model and no risk, and the CI retry is a *prerequisite* for autofix (without
  it, fix agents spend tokens chasing flakes).

### Stage 2 — Review agent *(read-only)*
- **Install:** the review workflow with the read-only pattern and the typed verdict.
- **Verify:** open a PR with a deliberate flaw and check the verdict catches it;
  open a clean one and check it still comments.
- **Exit:** verdicts are useful on ~10 real PRs. Rollback: remove the workflow;
  nothing else depends on it yet.
- **Why second:** highest value per unit risk. It cannot write code, cannot merge,
  and gives an immediate read on whether the model understands this codebase — which
  is exactly the question stage 3 depends on.

### Stage 3 — Build agent
- **Entry:** stage 2 verdicts have been consistently sensible.
- **Install:** the build workflow with all four safeguards (workflow-owned lane
  labels, incremental push, checkpoint, verify-else-escalate) plus build retry.
- **Verify:** label **one** issue and watch the whole run. Read the PR as if a new
  contributor wrote it.
- **Exit:** three consecutive builds that produce a mergeable PR.
- **Rollback:** remove the trigger label from the queue; the loop goes idle.
- **Caution:** there is no dry-run for this. The moment the secret exists and an
  issue is labelled, it builds and opens a PR for real. Roll out by labelling one
  issue and watching, not by flipping a config flag.

### Stage 4 — Repair loops
- **Entry:** stage 3 produces PRs that are usually right, and CI retry has been
  running long enough to know the flake rate.
- **Install:** autofix first (it has the clearest success signal), then conflict
  resolver, then revise.
- **Verify:** each on a real instance — a genuinely red PR, a genuinely conflicted
  one. Confirm the attempt cap by watching one escalate.
- **Exit:** the outcome ledger shows more repairs than escalations, and few or no
  "recovered" events.
- **Rollback:** per-loop workflow disable.

### Stage 5 — Auto-merge *(optional, and reversible)*
- **Entry:** everything above is boring. Several weeks of it.
- **Install:** inert. Then `dry-run` for a week — read every "would merge" line and
  confirm you agree. Only then `live`.
- **Exit:** never fully; keep watching. Rollback: unset the mode variable.
- **Do not enable** if a human merge is your only backstop against a
  prompt-injected review verdict.

### Optional — Discovery loops
Research and adversarial-review agents that *propose* and *vet* work rather than
implement it. Add only when the pipeline is starved of well-specified issues, not
before: they increase the queue, and a queue of vague issues makes the build agent
worse, not busier.

---

## 7 · What to parameterise per repository

The session should produce a filled-in table like this for the target repo:

| Parameter | Example | Notes |
|---|---|---|
| Lane labels | `status:approved` → `status:building` → `status:built` | Must not collide with existing labels |
| Stop label | `needs-human` | One label, every loop honours it |
| Pin-out labels | `no-auto-merge`, `no-auto-resolve` | Per-loop manual override |
| Ownership signal | `Closes #N` in the PR body | How loops identify their own PRs |
| Agent identity | the App's bot login | Auto-merge must match this **exactly**, not "any bot" |
| Deterministic identity | the Actions bot | Must differ from the agent identity — see §8 |
| Gate commands | `npm ci && npm test && …` | Identical in CI and in every agent workflow |
| Service containers | Postgres, etc. | Mirror CI exactly |
| Required env | timezone, locale, dummy credentials | Anything the app refuses to boot without |
| Governance paths | `.github/**`, CI config, conventions docs | Never auto-merged |
| Attempt caps | 2 agent attempts, 3 build retries, 1 CI retry | Write once per loop; if duplicated, test the agreement |
| Staleness threshold | 4h | Must exceed the build timeout |
| Timeouts | build 180m, repair 45m, review 20m | Generous: a throttled run should finish slowly, not be killed |
| Model + turn budget | per loop | Match cognitive demand × frequency |
| Schedules | hourly sweep, weekly janitor | Offset from the top of the hour |

---

## 8 · Invariants that must never be weakened

These are the properties that make the difference between automation and an
unattended write credential. A rollout that trades any of them away has kept the
shape and lost the substance.

1. **Fork PRs never receive secrets and never run agent code.** Workflows
   triggered by a completed run carry secrets even for fork PRs — those need an
   explicit same-repo check in the job condition.
2. **The agent identity and the deterministic identity are different.** The agent
   must not be able to write into channels the deterministic steps read — verdict
   comments, lane labels, handoff notes. If both are the same account, an injected
   agent can forge its own approval.
3. **Verify-else-escalate fails loudly.** A run that produced nothing must never be
   green.
4. **Every self-retriggering loop has an attempt cap** and a terminal escalation.
5. **Governance paths always require a human merge.** A pipeline that can
   auto-merge a change to its own gates has no gates. The list is configurable;
   having a non-empty list is not.
6. **Branch protection is the enforceable backstop.** Tool allowlists raise the
   bar — the agents have code execution, so they are defence in depth, never a
   guarantee.
7. **Untrusted content is data, never instructions.** Issue text, PR bodies, review
   comments, CI logs. Where such content flows into a later agent's prompt, bound
   it, quote it, strip control tokens, and tell the reader it may only *add*
   scrutiny, never remove it.
8. **The stop label is a hard stop for every loop.** No loop re-claims an escalated
   item.

---

## 9 · The recommendation the session should produce

Not a plan to execute — a proposal for the maintainer to approve.

1. **Fit summary** (short): what this repo would gain, what it would not, and the
   single biggest obstacle.
2. **Prerequisite gaps** — each of §3's five, with current state and the concrete
   work to close it.
3. **Per-component recommendation** — for each component in §5: *adopt now / adopt
   later / skip*, with a repo-specific reason. Skipping is a legitimate and common
   answer.
4. **The staged plan**, mapped onto §6 with this repo's specifics: what gets
   installed at each stage, how to verify it *here*, and what would trigger a
   rollback.
5. **The filled-in parameter table** (§7).
6. **Repo-specific risks** — flaky tests, fork traffic, a slow gate, existing bot
   noise, a monorepo layout, a production service sharing the model budget.
7. **Estimated cost**, in runs per week and rough token spend, at the first stage
   that spends anything.

Then stop, and let a human choose the stage to start.

---

## 10 · Failure modes worth knowing before you design

Every one of these looks correct on paper and is wrong in practice. They are the
most valuable part of this document.

**Forge mechanics**

- **Events created with the default token never trigger workflows.** A comment or
  label written by a workflow will not start another one. Anywhere you need
  workflow-to-workflow handoff, use an explicit dispatch — that is one of the few
  exceptions. (This also means a default-token push does not re-run CI, which is
  what makes checkpoint pushes free of side effects.)
- **A shared concurrency group silently cancels queued runs.** A group holds one
  pending run; a third arrival evicts the second. And a *cancelled* run is not a
  *failure*, so failure-keyed retries never see it. Use per-item groups.
- **A job-level timeout kills even always-run steps**, so checkpoint and escalate
  machinery never runs on a timed-out job. The timeout must be a genuine outlier,
  and a separate sweep must catch what it leaves behind.
- **Composite actions ignore unknown inputs silently.** A renamed input degrades to
  its default with no error. Reusable workflows reject them — but only at run time.
- **A locally-referenced action resolves from the workspace**, which on a PR-repair
  workflow is the pull request's own head. Reference shared actions by a ref pinned
  to the default branch, or PR content defines the step that judges it.
- **CLI tools print error bodies to stdout.** A failed API lookup can yield a
  plausible-looking string that flows into a comparison. Validate the *shape* of
  anything you branch on.

**Agent behaviour**

- **Agents end their turn waiting for work that will never resume.** In a one-shot
  job there is no async resume — the process exits. State it plainly in the prompt
  *and* add a deterministic post-step, because the prompt alone provably does not
  hold: two loops ended their turns waiting on background tasks with completed work
  committed, and both escalated with nothing to show.
- **Agents narrate work they did not do.** A run can finish "successfully" having
  produced nothing. Assert outcomes, never self-reports.
- **Agent credentials expire mid-run.** Push incrementally; recover with the job's
  own token afterwards.

**Process**

- **A blind retry beats a failure classifier.** Cheaper, and one fewer thing to be
  wrong about.
- **Free-prose parsing across multiple consumers drifts silently.** Make
  cross-workflow contracts typed, stamp them in exactly one place, and test that
  the copies agree.
- **Duplicated constants drift.** Where a cap must appear twice (a cheap gate plus
  a backstop), test the agreement rather than commenting "keep in sync".
- **Squash merges break ancestry-based cleanup.** Use the PR ledger.
- **A stale orientation map is worse than none** — it sends a cold session
  confidently to a path that moved. Gate it, or don't keep one.
- **Shared append points cause pairwise conflicts.** A single counter or changelog
  section that every PR edits will make every concurrent PR conflict. Prefer
  per-file entries and sorted manifests so unrelated changes land in different
  hunks.

---

## 11 · Operating it

- **One kill switch.** Removing the model credential should make every agent loop
  inert. Verify that early.
- **Watch the recovered count.** Work that had to be rescued by a checkpoint is a
  harness defect, and it is the failure mode that costs the most.
- **Watch escalation rate per loop.** A loop that mostly escalates is mis-scoped or
  being handed work it can't do.
- **Watch the budget.** Parallel agent runs contend; bursts throttle each other
  into timeouts. Stagger approvals rather than releasing a queue at once.
- **Re-read the invariants (§8) whenever you change a workflow.** They are the part
  a well-meaning refactor quietly erodes.
