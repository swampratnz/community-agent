# CI/CD reference

The complete mechanical reference for everything under `.github/workflows/`
plus the delivery path that follows a merge — written so the system can be
**read as a design**, not just as fifteen YAML files, and so the reusable half
can be lifted out of this repo (see [§8 Extraction guide](#8-extraction-guide)).

**How this relates to the other docs.** They are complementary, not
overlapping:

| Doc | Answers |
|---|---|
| **this file** | *What* runs, on what trigger, with what permissions; the mechanisms shared across workflows; what is portable |
| [`PIPELINE.md`](PIPELINE.md) | *Why* the agent loops are shaped the way they are — the incidents, the ownership rules, the loop prompts |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | The production host: systemd units, the redeploy timer, rollback |
| [`SECURITY.md`](SECURITY.md) | The threat model the guardrails below implement |
| [`STANDARDS.md`](STANDARDS.md) | What a contributor must do before pushing |
| [`PIPELINE-PLAYBOOK.md`](PIPELINE-PLAYBOOK.md) | How to adopt this automation on a DIFFERENT repo — assessment, staged rollout, portable failure modes |

When this file and `PIPELINE.md` disagree about a loop's *rationale*,
`PIPELINE.md` wins. When they disagree about a trigger, permission or
condition, **the workflow file wins** and both docs are wrong — fix them in the
same PR.

---

## 1 · The three layers

```
        ┌──────────────────────────────────────────────────────────┐
LAYER 1 │  THE GATE — what "green" means                           │
        │  ci.yml (build · lint · security-invariants)             │
        │  + the gate scripts in scripts/*.mjs                     │
        │  Runs on every push to main, every PR, every merge group │
        └────────────────────────┬─────────────────────────────────┘
                                 │ the same commands, run by
                                 ▼
        ┌──────────────────────────────────────────────────────────┐
LAYER 2 │  AUTONOMY — the loops that produce and repair PRs        │
        │  build · pr-review · autofix · conflict · revise         │
        │  automerge · groundskeeper · retries · janitors          │
        │  Coordinated ONLY through GitHub issues + labels         │
        └────────────────────────┬─────────────────────────────────┘
                                 │ merge to main
                                 ▼
        ┌──────────────────────────────────────────────────────────┐
LAYER 3 │  DELIVERY — pull-based, off GitHub                       │
        │  scripts/redeploy.sh + systemd timer on the prod host    │
        │  (nightly 1am NZ; optionally chat-triggered)             │
        └──────────────────────────────────────────────────────────┘
```

Three properties hold across all three layers and are the load-bearing design
decisions:

1. **All state lives in GitHub.** No workflow remembers anything between runs.
   Every agent worker is a cold session; every deterministic loop reconstructs
   its view from issues, labels, PR fields and marker comments. A dead run
   costs nothing but the tokens it burnt.
2. **The gate is defined once and run everywhere.** Layer 1's command list is
   what the build worker runs before opening a PR, what the repair loops run
   before pushing, and what a human runs locally. Divergence between them is
   the failure mode the design most guards against.
3. **Deterministic where possible, agentic only where necessary.** Six of the
   fifteen workflows run no model at all. Every decision expressible as a shell
   condition is one.

---

## 2 · Workflow inventory

All fifteen workflows, with the facts you need to reason about blast radius.
`GITHUB_TOKEN` permissions are the workflow-level grant; **⚡** marks a workflow
that invokes `anthropics/claude-code-action` and therefore spends the shared Max
pool.

| Workflow | Trigger | Concurrency | Permissions | Timeout | Enabled by |
|---|---|---|---|---|---|
| **`ci.yml`** | push `main`, `pull_request`, `merge_group` | `ci-<ref>`, cancel on PR | `contents:read` | job default | always |
| `ci-retry.yml` | `workflow_run` [CI] completed | — | `actions:write`, `contents:read` | 5 min | always |
| **`pipeline-build.yml`** ⚡ | `issues.labeled == status:approved` | `pipeline-build-<issue>`, no cancel | `contents`,`issues`,`pull-requests`:write, `id-token:write` | 180 min | `CLAUDE_CODE_OAUTH_TOKEN` |
| `pipeline-build-retry.yml` | `workflow_run` [build] completed | — | `actions:write` | 5 min | always |
| **`pipeline-pr-review.yml`** ⚡ | `pull_request` opened/synchronize/reopened/ready_for_review | per-PR, **cancel-in-progress** | `contents:read`, `pull-requests:write`, `actions:write`, `id-token:write` | 20 min | the secret |
| `pipeline-pr-autofix.yml` ⚡ | `workflow_run` [CI] completed | per head branch | `contents`,`issues`,`pull-requests`:write, `id-token:write` | 45 min | the secret |
| `pipeline-pr-revise.yml` ⚡ | `workflow_dispatch` (`pr_number`) | per-PR | as autofix | 45 min | the secret |
| `pipeline-pr-conflict.yml` ⚡ | push `main`, PR opened/ready, hourly, `workflow_dispatch` (`resolve_matrix`) | per-run / per-PR | **discover** (job override): `contents`,`pull-requests`:read + `actions:write`; **resolve** (inherits): `contents`,`issues`,`pull-requests`:write, `id-token:write` | 10 min (discover) / 45 min (resolve) | the secret |
| `pipeline-pr-automerge.yml` | `*/15 * * * *`, `workflow_run` [CI, PR review], dispatch | single group | `contents`,`issues`,`pull-requests`:write, `actions:write` | 10 min | secret **and** `vars.AUTOMERGE_MODE` |
| `pipeline-groundskeeper.yml` | `17 * * * *`, dispatch | single group | `issues:write`, `pull-requests:read` | 10 min | always |
| `pipeline-outcomes.yml` | `23 20 * * 1`, dispatch (`window_days`) | single, cancel | `contents:read`, `issues:write`, `pull-requests:read` | 10 min | always |
| `changelog-coverage.yml` | `17 19 * * *`, dispatch | single, cancel | `contents:read`, `issues:write`, `pull-requests:read` | 10 min | always |
| `changelog-autofill.yml` ⚡ | `47 19 * * *`, dispatch | single group | `contents`,`pull-requests`:write, `id-token:write` | 30 min | the secret |
| `branch-janitor.yml` | `0 3 * * 1`, dispatch (`dry_run`, `extra`) | single group | `contents:write`, `pull-requests:read` | 15 min | always |
| `setup-labels.yml` | `workflow_dispatch` only | — | `contents:read`, `issues:write` | — | manual |

Three workflows in that table are thin callers: `ci-retry.yml` and
`pipeline-build-retry.yml` delegate to `reusable-rerun-failed-run.yml`, and
`branch-janitor.yml` to `reusable-branch-janitor.yml`. The two `reusable-*.yml`
files are `workflow_call`-only — they never run on their own, hold no trigger,
and appear in the Actions list without runs of their own (a caller's run
contains their jobs). See [§8.3](#83-proposed-shape-of-the-reusable-solution).

Two notes on that permissions column. A **job-level `permissions:` block
replaces the workflow-level grant outright** rather than adding to it — which is
what lets the conflict resolver keep every write scope confined to the job that
runs the agent, while its discover job holds read plus the single `actions:write`
it needs to self-dispatch. And auto-merge's `issues:write` is not an oversight:
`gh label create` (ensuring `human-merge-ready` exists) goes through the issues
API, and `actions:write` is how it dispatches the conflict resolver after a
merge.

**The single kill switch:** remove the `CLAUDE_CODE_OAUTH_TOKEN` secret and
every ⚡ workflow goes inert (they log a notice and skip). There is no per-loop
enable switch except `AUTOMERGE_MODE`; to disable one loop individually, disable
it in the Actions UI.

**Model and turn budget** for the ⚡ workflows — all currently Sonnet, pinned in
the workflow file (a session's `/model` does not affect them):

| Workflow | `--max-turns` | Tool grant shape |
|---|---|---|
| `pipeline-build.yml` | 300 | broad write set (edit, commit, push, `gh pr create`, `npm`) |
| `pipeline-pr-autofix.yml` | 200 | write set, push pinned to `git push origin HEAD` |
| `pipeline-pr-revise.yml` | 200 | as autofix, plus `gh pr comment` |
| `pipeline-pr-conflict.yml` | 30 (fast path) / 200 | as autofix |
| `pipeline-pr-review.yml` | 60 | **read-only** — `gh pr diff/view`, Read, Grep, Glob |
| `changelog-autofill.yml` | 60 | narrow: edit `CHANGELOG.md`, one pinned push, one pinned `gh pr create` |

---

## 3 · Layer 1 — the CI gate (`ci.yml`)

Three parallel jobs. The split is deliberate and each boundary carries meaning.

| Job | Services | Runs | Catches |
|---|---|---|---|
| **`build`** | `pgvector/pgvector:pg16` | `npm ci` → `typecheck` → `migrate` → `test` → `build` | type errors, broken migrations, behaviour regressions, missing runtime assets in `dist/` |
| **`lint`** | none | `npm ci` → `lint` → `format:check` → `context:check` → `imports:check` | style, stale agent context pack, composition-direction violations |
| **`security-invariants`** | **none, deliberately** | `npm ci` → `test:security` | a deleted/disabled `SECURITY:` test, and the security spine itself |

### 3.1 Why the jobs split this way

- **`lint` has no database and no model** — every check in it is pure and
  static, so it returns in seconds and gives the fastest signal on the two
  gates most likely to be forgotten (`context:check`, `imports:check`).
- **`security-invariants` deliberately leaves `DATABASE_URL` unset.** The
  DB-backed `SECURITY:` tests key their skip on `Boolean(process.env.DATABASE_URL)`.
  A *set-but-unreachable* URL would make them **run and fail**; unset makes them
  skip cleanly. The count gate treats a skip as a pass, so the required count
  stays stable either way. This job must stay deterministic regardless of DB
  reachability — that is the whole point of separating it from `build`.
- **`build` is the only job with Postgres**, so DB-touching changes are
  genuinely exercised rather than skipped.

### 3.2 The environment contract

Both `build` and `security-invariants` set the same dummy-credential env. Every
one of these exists for a reason, and a fork of this pipeline will need its own
equivalent list:

| Var | Value in CI | Why it must be set |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `ci-dummy-token` | config's zod schema requires it; nothing in CI calls Claude |
| `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` | dummies | same — config validation, not connectivity |
| `WHATSAPP_PROVIDER` | `disabled` | keeps the adapter out of the boot path |
| `DISPLAY_TIMEZONE` | `Pacific/Auckland` | `agentModule.init()` is **boot-fatal** without it (framework defaults to UTC) |
| `DISPLAY_LOCALE` | `en-NZ` | same |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | pinned so the cache key derives from it |
| `DATABASE_URL` | service container URL (`build` only) | unset in `security-invariants` — see above |

### 3.3 The embedding-model cache

`npm ci` wipes `node_modules/@huggingface/transformers/.cache`, so every run
re-fetched the local embedding model from huggingface.co — wall-clock cost plus
an external fetch that can flake. `actions/cache` is therefore placed **after**
`npm ci` (restore happens at the step's position; save happens post-job), and
the key is `hf-embedding-model-${{ env.EMBEDDING_MODEL }}` — derived from the
job's own env rather than a hand-bumped suffix, so a model change can never
serve a stale cache. The same block is repeated in `security-invariants` and in
the build worker.

### 3.4 The security-floor lowering guard

`security-invariants` sets two extra variables that implement an
audit finding (H1): a PR may not *reduce* the declared `SECURITY:` test counts
without a deliberate, labelled human act.

| Var | Source | Effect |
|---|---|---|
| `SECURITY_FLOOR_BASELINE_REF` | `github.event.pull_request.base.sha` | the base manifest to diff against; empty on push/merge_group, so the guard is PR-only |
| `ALLOW_SECURITY_FLOOR_LOWER` | `contains(labels.*.name, 'allow-security-floor-lower')` | the labelled override |

The checkout uses `fetch-depth: 0` specifically so the guard can
`git show <base>:tests/security-floor.json`; a shallow clone would not have the
base commit.

> ⚠️ **Gap:** the `allow-security-floor-lower` label is *consumed* by `ci.yml`
> but is **not created** by `scripts/setup-labels.sh` (19 labels, this is not
> one of them). A maintainer needing the override must create the label by
> hand first. See [§7](#7-known-gaps).

### 3.5 The gate scripts

Layer 1's real content is a family of Node scripts. They share a house style —
each is a *manifest with a gate*, has a mechanical fixer where a fixer can be
correct, and refuses to have one where it cannot.

| Script | npm script | Manifest / data it enforces | Fixer | Exit behaviour |
|---|---|---|---|---|
| `check-security-test-count.mjs` | `test:security` | `tests/security-floor.json` — per-file map of declared `SECURITY:` tests, **exact match**, kept sorted | `test:security:fix` (only ever *raises*; `--allow-lower` for a genuine removal) | fails on count mismatch, unsorted manifest, or any failing test |
| `check-context-pack.mjs` | `context:check` | `docs/agents/module-map.md` — one entry per `src/` subsystem, unique, sorted, no stubs | `context:fix` — **deliberately cannot make the gate green** (inserts a `TODO` stub) | fails on missing/dangling/unsorted/stub entry |
| `check-import-direction.mjs` | `imports:check` | three composition rules (no `src/base/`; `src/module/` may not import the root; only the root may call `createAgent`) | none | fails on violation |
| `check-dist-schema.mjs` | end of `build` | `dist/module/storage/schema/` must match the compiled manifest | none | fails on a forgotten `.sql` copy |
| `check-db-coverage.mjs` | `pretest` | prints a banner when `DATABASE_URL` is unset so a partial suite is legible | none | banner only, unless `REQUIRE_DATABASE_URL=1` |
| `check-changelog-coverage.mjs` | `changelog:check` | `CHANGELOG.md` vs merged PRs in a window; skip-ledger HTML comment counts as documented | the autofill loop | **always exits 0** — the caller decides |
| `pipeline-outcomes.mjs` | (workflow only) | reconstructs a per-loop ledger from marker comments | — | always exits 0 |
| `handoff-note.mjs` | (workflow only) | renders/resolves the build→review handoff comment | — | best-effort |

The two `--write` fixers differ on purpose: a **count** is derivable from the
code, so `test:security:fix` may finish the job; a **description** is not, so
`context:fix` must not. A fixer that could auto-satisfy the context gate would
defeat the gate's only purpose — stopping a module entering the tree
undescribed.

### 3.6 The full local gate

The command block a contributor or agent runs before pushing — identical to
what CI runs, which is the invariant that keeps "green locally" meaningful:

```bash
npm run typecheck && npm run lint && npm run format:check \
  && npm run migrate && npm test && npm run build \
  && npm run test:security && npm run context:check && npm run imports:check
```

(Also in [`docs/agents/recipes.md`](agents/recipes.md) → "Run the full gate".)

---

## 4 · Layer 2 — the autonomy loops

`PIPELINE.md` documents each loop's purpose, ownership rules and history. What
follows is the part that document does not isolate: the **mechanisms shared
across loops**. These, not the individual loops, are the reusable core.

### 4.1 The eleven shared mechanisms

**M1 · The inert gate.** Every ⚡ workflow's first step evaluates
`HAS_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' }}` and every subsequent
step is `if: env.HAS_TOKEN == 'true'`. A workflow merged into a repo without the
secret logs one notice and does nothing. This is what makes the whole pipeline
safe to merge before it is configured.

**M2 · Fork safety.** GitHub withholds secrets from fork PRs, so `HAS_TOKEN` is
empty there and agent workflows skip. The `workflow_run`-triggered loops
(autofix, automerge) get secrets even for fork PRs, so they *additionally*
hard-require `head_repository.full_name == github.repository` in the job `if:`.

**M3 · The two-hop dispatch.** `claude-code-action` does not run under
`push`-shaped payloads, and **GitHub never starts a workflow from a
`GITHUB_TOKEN`-created event**. Both constraints are dodged the same way: a
deterministic *discover/post* job self-dispatches the agent job via
`workflow_dispatch`, which is one of the two documented exceptions to the
GITHUB_TOKEN rule. Used by the conflict resolver (discover → resolve) and by
review → revise. Recursion is bounded to depth 1.

**M4 · Never trust the payload.** A dispatch payload carries **identifiers
only** (a PR number, a list of PR numbers). The receiving job re-derives the
branch and re-verifies the entire eligibility contract from the API before
checkout. Anyone with write access can hand-craft a dispatch, so the payload is
treated as attacker-shapeable; this also makes a superseded duplicate run no-op
rather than mislabel.

**M5 · The eligibility contract.** Every PR-touching loop filters on the same
shape, in this order — cheap structural checks first:

- same-repo (never a fork)
- authored by the expected identity (see [§4.2](#42-the-identity-model))
- body contains `Closes #<n>` — the build worker's contract, which is what
  distinguishes a pipeline PR from a Dependabot bump
- not labelled `needs-human` (any loop's escalation = a hard stop)
- not labelled the loop's own pin-out label (`no-auto-resolve`, `no-auto-merge`)
- plus a per-loop live condition (still CONFLICTING; verdict still pending; …)

**M6 · Attempt caps via marker comments.** There is no per-PR counter store, so
attempts are counted by grepping the PR's comments for a marker HTML comment.
Two attempts, then escalate `needs-human` and stop. Without the cap a
fix→fail→fix cycle would drain the weekly token pool.

**M7 · The deterministic checkpoint.** Runs `if: always()` **after the agent
exits**, and pushes anything the agent committed but never pushed, using the
job's `GITHUB_TOKEN` (valid for the whole job, unlike the ~1h App token). It
only ever **fast-forwards**; a diverged remote parks the work on a
`-ckpt-<run_id>` ref rather than rewriting someone else's push. This exists
because prompt-only compliance provably fails — agents have finished whole
builds, and whole conflict resolutions, and then ended their turn without
pushing. Present in build, autofix, revise and conflict — as ONE implementation
since the extraction: [`.github/actions/agent-checkpoint`](../.github/actions/agent-checkpoint/action.yml)
(see [§8.3](#83-proposed-shape-of-the-reusable-solution)).

**M8 · Verify-else-escalate.** The step after the checkpoint asserts the
*outcome* deterministically — is there an open PR closing this issue? was a
commit pushed? — and if not, labels `needs-human`, comments, and **fails the job
loudly**. An agent that narrates work it did not do must not produce a green
run. The three PR loops share one implementation,
[`.github/actions/agent-verify-push`](../.github/actions/agent-verify-push/action.yml);
the build worker keeps its own, because its version asserts a *PR exists* rather
than a commit landing and additionally owns the lane labels, the resume pointer
and the recovery-PR path — a different contract that merely shares a name.

Note that M7 and M8 stay **separate steps** even though they always run
together: a checkpoint may legitimately publish work *and* the verify still
escalate, because checkpointed work never cleared the agent's own gate. Folding
them into one action would collapse "recovered" and "succeeded" into the same
outcome, which is exactly the distinction `pipeline-outcomes.yml` reports on.

**M9 · Deterministic lane ownership.** The workflow, not the agent, owns every
label transition: a Claim step sets `status:building` before the agent runs; the
verify step sets `status:built` after it confirms the PR. The agent signals a
deliberate refusal by writing a git-ignored `needs-human.md` file, which the
verify step turns into the label. The agent is granted **no `gh issue edit`** —
the tool matcher cannot pin an issue number, so that grant would let an injected
agent label an *arbitrary* issue `status:approved` and spawn an unreviewed build.

**M10 · Least-privilege tool grants.** `--allowedTools` is an explicit
allowlist, never a blanket `Bash(gh:*)`. Push is granted as the *exact* string
`git push origin HEAD` (no `:*`), `gh` is read-only except where a loop must
comment, and `git checkout`/`switch` are withheld so HEAD cannot leave the
branch. Checkouts use `persist-credentials: false` so the job token is not left
readable in `.git/config` where an agent that reads untrusted content could
exfiltrate it; `GH_TOKEN` is set per-step on deterministic steps only, never on
the agent step. **This is defence in depth, not a guarantee** — the agents have
Edit/Write and `node`, i.e. code execution. The enforceable stop is branch
protection on `main`.

**M11 · The verdict token contract.** Three workflows consume a review verdict,
and free-prose parsing drifted between them. The verdict is now a typed
artifact: the model is asked for `<!-- verdict:LGTM -->` /
`<!-- verdict:CHANGES_REQUESTED -->` / `<!-- verdict:NEEDS_HUMAN -->`, and
`pipeline-pr-review.yml` — the only place a review comment is composed —
decides once, strips any model-emitted whole-line token, and stamps exactly one
authoritative token right after its marker. Consumers read the first token, so a
review that legitimately quotes one mid-sentence cannot be misread. Both shell
helpers (`canonical_verdict`, `legacy_verdict`) are duplicated across the three
workflows and `tests/reviewVerdict.test.ts` fails on drift. An unrecognisable
verdict routes **nowhere** — a malformed review stalls visibly rather than
guessing.

### 4.2 The identity model

Three distinct identities act on this repo, and several gates depend on telling
them apart:

| Identity | Is | Used for | Notable property |
|---|---|---|---|
| `claude[bot]` (renders as `app/claude` via GraphQL) | the Claude GitHub App token, minted per-run via OIDC | everything the *agent* does: commits, its PRs, its comments | the **only** identity auto-merge will merge; its pushes **do** re-trigger CI |
| `github-actions[bot]` | the job's `GITHUB_TOKEN` | deterministic steps: labels, verdict comments, checkpoints, recovery PRs | its events **never** start workflows (hence M3); its PRs can never auto-merge |
| a human | — | merges everything the loops won't touch | branch protection is the backstop |

Two consequences worth internalising: the build agent **cannot write into the
handoff channel it feeds** (only `github-actions[bot]` comments are read back),
and **checkpoint-recovered or workflow-recovered work can never launder itself
into a merge**, because it is authored by the wrong identity for the auto-merge
gate.

### 4.3 Marker comment registry

Markers are the pipeline's only persistent per-PR state. All are HTML comments,
matched on **line 1** so a comment that merely quotes a marker is not mistaken
for the channel.

| Marker | Written by | Read by |
|---|---|---|
| `<!-- pipeline-handoff:build -->` + `<!-- handoff-body:begin/end -->` | build (post step) | review (resolve step, polls ≤60s) |
| `<!-- pipeline-autofix-attempt -->` | autofix | autofix (cap), outcomes |
| `<!-- pipeline-autofix-checkpoint -->` | autofix | outcomes |
| `<!-- pipeline-autofix-escalation -->` | autofix | outcomes |
| `<!-- pipeline-pr-revise-attempt / -checkpoint / -escalation -->` | revise | revise (cap), outcomes |
| `<!-- pipeline-pr-conflict-attempt / -checkpoint / -escalation -->` | conflict | conflict (cap), outcomes |
| `<!-- pipeline-automerge-blocked -->` | automerge | itself (post once) |
| `<!-- pipeline-automerge-human-ready -->` | automerge | itself (post once) |
| `<!-- module-map:begin/end -->` | humans / `context:fix` | `check-context-pack.mjs` |

`pipeline-outcomes.yml` exists precisely because these markers already encode
the record: it counts engaged / recovered / escalated per loop weekly with no
new state and no writes to any PR. **Recovered** is the number that matters —
every one is a prompt/harness defect in that loop, not a code defect in the PR.

### 4.4 Escalation and retry map

What happens when each thing fails, in order of who gets there first:

| Failure | First responder | Then | Finally |
|---|---|---|---|
| CI red on any PR | `ci-retry.yml` — one blind machine rerun (`run_attempt < 2`), with a staleness guard so a superseded commit is not re-run | `pipeline-pr-autofix.yml` from attempt 2, ≤2 agent attempts | `needs-human` |
| Build run **fails** | `pipeline-build-retry.yml` — rerun, ≤3 attempts total | build worker escalates on its **final** attempt only, clearing both `status:building` *and* `status:approved` | `needs-human` |
| Build run **times out** (reports `cancelled`, invisible to the retry loop) | — | `pipeline-groundskeeper.yml` hourly: `status:building` + no open PR + 4h idle | `needs-human` |
| Build pushed a branch but skipped `gh pr create` | the build workflow's own verify step opens a **draft** recovery PR and sets `status:built` | never overrides a deliberate refusal, never touches a branch that ever had a PR | CI + review adjudicate |
| Agent committed but never pushed | the checkpoint step (M7) | recovery comment states the work never cleared the gate | CI adjudicates |
| PR goes CONFLICTING | `pipeline-pr-conflict.yml`, one attempt (deterministic fast path for a `security-floor.json`-only conflict) | `needs-human` | human merges `main` |
| Review says "Changes requested" | `pipeline-pr-revise.yml`, ≤2 attempts | `needs-human` | human |
| Review says "Needs a human decision" | review labels `needs-human` directly | — | human |
| PR green + LGTM but touches a governance path | automerge labels `human-merge-ready` + one comment | keeps scanning for other PRs | human merges |
| Merged PR has no changelog entry | `changelog-coverage.yml` opens/refreshes one self-closing tracking issue | `changelog-autofill.yml` drafts a PR 30 min later | human merges the autofill PR |
| Merged branch left behind | `branch-janitor.yml` weekly, ancestry- or all-PRs-merged only | never touches never-PR'd or `-ckpt-` refs | `extra` dispatch input |

---

## 5 · Layer 3 — delivery

Delivery is **pull-based and runs off GitHub entirely** — no workflow deploys.
The production host fast-forwards itself. Full detail in
[`DEPLOYMENT.md`](DEPLOYMENT.md); the shape:

- `scripts/redeploy.sh`, invoked by `deploy/community-agent-redeploy.timer`
  (systemd, nightly 1am `Pacific/Auckland`).
- Order is **fail-safe**: fast-forward → `npm ci` → `build` → `migrate` →
  *then* restart. A broken build or migration leaves the running service
  untouched.
- Outcomes: already current → cheap no-op; dirty tree or non-fast-forward →
  abort; build/migrate failure → restore old code, do not restart; restarted but
  never healthy → roll back code and restart the old build.
- **Rollback restores code only.** An applied migration is never rolled back,
  so migrations must stay backward-compatible within a deploy.
- `flock` serialises the timer against the opt-in chat-triggered redeploy
  (`redeploy_bot` tool → a pinned `sudo systemctl start` of the same oneshot
  unit).

The CI/CD seam is therefore just `main`: Layer 2 decides what lands there,
Layer 3 picks it up on a timer.

---

## 6 · Shared configuration reference

**Secrets** (Settings → Secrets and variables → Actions → Secrets)

| Name | Used by | Effect if absent |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | every ⚡ workflow + automerge's inert check | all agent loops inert; automerge inert |
| `GITHUB_TOKEN` | automatic | — |

**Variables** (… → Variables)

| Name | Values | Effect |
|---|---|---|
| `AUTOMERGE_MODE` | unset (default) / `dry-run` / `live` | inert / log the PR it would merge / actually merge |

**Also required, and not a secret:** the **Claude GitHub App** must be installed
on the repo, and **branch protection on `main`** must (a) require the CI checks
and (b) permit the Actions identity to merge if auto-merge is to work — the
automated review verdict is a *comment*, not an approving review, so protection
requiring a human review will refuse the merge (the loop then posts one
`pipeline-automerge-blocked` note rather than silently retrying forever).

**Labels** — 19 created by `scripts/setup-labels.sh` (via the `setup-labels.yml`
workflow, idempotent `--force`): `proposal`, `status:draft|approved|rejected|building|built`,
`needs-human`, `no-auto-resolve`, `no-auto-merge`, `human-merge-ready`,
`community-feedback`, and eight `theme:*` labels. `changelog-autofill` is
created at runtime by its own workflow. `allow-security-floor-lower` is created
by nothing — see [§7](#7-known-gaps).

**External dependencies**, all SHA-pinned with a trailing version comment and
kept fresh by Dependabot (`github-actions` weekly; `npm` grouped monthly, to
keep Dependabot PRs from streaming through the PR-review worker and spending the
Max pool):

| Action | Pin |
|---|---|
| `actions/checkout` | v7.0.1 |
| `actions/setup-node` | v7.0.0 (Node 24; `engines` says `>=22`) |
| `actions/cache` | v6.1.0 |
| `anthropics/claude-code-action` | v1.0.191 |

**`.github/CODEOWNERS`** routes review for the security spine (`/.github/`,
`/scripts/`, the tool registry, the module manifest, schema fragments,
`security-floor.json`, `SECURITY.md`). It is **advisory** — derived by hand from
the 🔒 markers in `docs/agents/module-map.md`, and a path that no longer exists
is silently ignored by GitHub, so a move can quietly drop the routing.

---

## 7 · Known gaps

Found while writing this reference. Each is a real divergence between intent and
wiring; none is fixed here, because each is a behaviour change that deserves its
own PR.

1. **`allow-security-floor-lower` is never created.** `ci.yml` reads it, but it
   is not in `scripts/setup-labels.sh`'s 19 labels. A maintainer exercising the
   documented override must create the label by hand first, and will most likely
   discover this mid-incident. *Fix: one `label` line in `setup-labels.sh`.*
2. **`REQUIRE_DATABASE_URL` is documented as CI behaviour but is set nowhere.**
   `scripts/check-db-coverage.mjs` says setting it to `1` is "what CI does, so a
   misconfigured CI job that silently stopped running the DB half is caught
   rather than passing quietly" — no workflow sets it. The intended guard
   against a `build` job that loses its `DATABASE_URL` and silently skips every
   DB test is therefore **not armed**. *Fix: add `REQUIRE_DATABASE_URL: '1'` to
   `ci.yml`'s `build` job env (and the build worker's, which runs the same
   gate).*
3. **`ci.yml` had no prose documentation before this file.**
   `scripts/check-context-pack.mjs` justifies excluding workflows from the
   context-pack gate on the grounds that "workflows are already documented far
   better in `docs/PIPELINE.md`" — true of the pipeline loops, but `PIPELINE.md`
   never covered the CI gate itself, the gate scripts, or the delivery path.
   That is the hole this document fills; keep it filled.
4. **`CODEOWNERS` and `module-map.md`'s 🔒 markers are hand-synced.** Nothing
   gates the pair, so a 🔒 added without a `CODEOWNERS` line silently drops
   review routing.
5. **This file is not a governance path.** The auto-merge matcher governs
   `CLAUDE.md`, `docs/PIPELINE.md`, `docs/SECURITY.md` and `docs/VISION.md`, so
   a bot PR editing *those* always waits for a human — but a bot PR editing
   `docs/CICD.md` can auto-merge. That is arguably correct (this file is a
   reference; the workflow files are the authority) and arguably not (a
   confidently wrong CI/CD reference misleads exactly the cold agent sessions
   it is written for). Left as a maintainer decision — adding it to the matcher
   is a one-line change in `pipeline-pr-automerge.yml`, which is itself a
   governance path and so needs a human merge either way.

---

## 8 · Extraction guide

What it would take to lift this into a reusable pipeline for other repos.

### 8.1 Portability tiers

| Tier | Meaning | Workflows |
|---|---|---|
| **A — portable as-is** | no repo knowledge beyond `GITHUB_TOKEN` | ~~`ci-retry.yml`, `pipeline-build-retry.yml`, `branch-janitor.yml`~~ — **extracted**: now `reusable-rerun-failed-run.yml` + `reusable-branch-janitor.yml`, called by those three |
| **B — portable with inputs** | logic is generic; label names, identities and thresholds are the only couplings | `pipeline-groundskeeper.yml`, `pipeline-pr-automerge.yml`, `pipeline-outcomes.yml`, `setup-labels.yml`, `changelog-coverage.yml` |
| **C — portable with inputs + a project-supplied gate** | as B, plus each needs to know how to run *this project's* checks and services | `pipeline-build.yml`, `pipeline-pr-review.yml`, `pipeline-pr-autofix.yml`, `pipeline-pr-revise.yml`, `pipeline-pr-conflict.yml`, `changelog-autofill.yml` |
| **D — project-specific by nature** | the definition of green for one codebase | `ci.yml`, `scripts/check-*.mjs` |

Tier D is not a failure of the design — it is the correct boundary. The
reusable artifact should *call* a project's gate, never contain it.

### 8.2 The coupling-point inventory

Everything a fork would have to change, grouped by kind. This is the parameter
list for the reusable version.

**Vocabulary** (appears in ~85 places for `needs-human` alone)

| Coupling | Current value |
|---|---|
| lane labels | `status:draft|approved|rejected|building|built` |
| stop label | `needs-human` |
| pin-out labels | `no-auto-resolve`, `no-auto-merge` |
| routing label | `human-merge-ready` |
| override label | `allow-security-floor-lower` |
| PR→issue contract | body matches `Closes #<n>` |
| trigger label | `status:approved` starts a build |

**Identity**

| Coupling | Current value |
|---|---|
| build-worker identity auto-merge requires | `claude[bot]` / `app/claude` |
| review-verdict author auto-merge trusts | `github-actions[bot]` |
| maintainer allowlist (conflict resolver) | `MAINTAINER_LOGINS: 'swampratnz'` |
| CODEOWNERS owner | `@swampratnz` |

**Project gate** (the Tier-C dependency)

| Coupling | Current value |
|---|---|
| package manager + node | `npm ci`, Node 24 |
| gate commands | `typecheck`, `lint`, `format:check`, `migrate`, `test`, `build`, `test:security`, `context:check`, `imports:check` |
| service container | `pgvector/pgvector:pg16` + its health options |
| boot-required env | `DISPLAY_TIMEZONE`, `DISPLAY_LOCALE`, `DISCORD_*`, `WHATSAPP_PROVIDER`, `EMBEDDING_MODEL` |
| cache path/key | `node_modules/@huggingface/transformers/.cache` |
| conflict fast path | knows `tests/security-floor.json` is regenerable via `test:security:fix` |

**Policy**

| Coupling | Current value |
|---|---|
| governance paths (never auto-merged) — the literal matcher | `^(\.github/\|scripts/\|CLAUDE\.md$\|docs/PIPELINE\.md$\|docs/SECURITY\.md$\|docs/VISION\.md$\|src/module/agentModule\.ts$\|package(-lock)?\.json$\|tsconfig([.-].*)?\.json$\|eslint\.config\.\|\.prettier)` |
| attempt caps | 2 (agent loops), 3 (build reruns), 2 (CI reruns) |
| staleness threshold | 4h (groundskeeper) |
| schedules | hourly / 15-min / daily 19:17+19:47 UTC / weekly Mon |
| model + turns | Sonnet; 300/200/60/30 |
| timeouts | 180/45/30/20/15/10/5 min |
| changelog date rule | NZ calendar day, not UTC |

**Prose** — the agent prompts embedded in the ⚡ workflows are the largest
single chunk of repo-specific content (the build prompt alone is several hundred
lines) and carry project conventions, the context-pack pointer, and the
security posture. These want to be **files a project supplies**, not workflow
literals.

### 8.3 Proposed shape of the reusable solution

Three artifacts, in the order they pay off:

**1 · A composite action for the agent-run triad — DONE.** M7 (checkpoint) and
M8 (verify-else-escalate) were near-identical in build, autofix, revise and
conflict, and their bugs had historically been *fixed in one copy and not the
others*. They now live in two composite actions:

```
.github/actions/agent-checkpoint/action.yml    ← build, autofix, revise, conflict
.github/actions/agent-verify-push/action.yml   ← autofix, revise, conflict
```

Three things that extraction settled, and that any port of this pattern has to
settle too:

- **The reference must be pinned to the default branch, never `./`.** A local
  `uses: ./.github/actions/…` resolves from the *workspace* when the step runs,
  and the three PR loops check out the pull request's head branch — so `./`
  would let PR-controlled content define the step that publishes an agent's work
  and the step that decides whether the run escalates. The repo-qualified
  `swampratnz/community-agent/.github/actions/…@main` form is fetched from the
  default branch, which is the property these workflow *files* already have
  (their triggers only ever run `main`'s copy). `tests/agentRunActions.test.ts`
  pins it as a `SECURITY:` test. There is no bootstrap gap: workflow and action
  land on `main` in the same merge.
- **Composite actions ignore unknown `with:` keys silently.** A renamed input
  degrades to its default with no error anywhere — for the checkpoint that means
  no recovery comment; for the verify step it means the escalation loses the
  marker `pipeline-outcomes.yml` counts. The same test cross-checks every passed
  key against the action's declared inputs.
- **One implementation means taking the union of the drift.** At extraction the
  three PR loops had two hardenings the build worker never received (the 40-hex
  guard on the `gh api` lookup; the `merge-base --is-ancestor` pre-check), while
  the build worker had a push-failure fallback to the side ref that the other
  three lacked. The shared action keeps all three.

The cost/job-summary step was left alone: it appears in only two workflows
(build and review) and they format different things.

**2 · Reusable workflows (`workflow_call`) for Tiers A and B — Tier A DONE.**
The deterministic loops carry no prompts and no project gate, so they
parameterise cleanly. Tier A now lives in two `workflow_call` workflows:

```
.github/workflows/reusable-rerun-failed-run.yml  ← ci-retry, pipeline-build-retry
.github/workflows/reusable-branch-janitor.yml    ← branch-janitor
```

Two things that extraction settled:

- **`on:` triggers cannot be parameterised**, so the split is not "move the
  whole workflow". Each caller keeps its trigger, its event-payload `if:` gate
  and its cap, and passes the payload facts as inputs; the reusable workflow
  owns the mechanism. That is why the attempt cap is written twice — once in
  the caller's `if:` (the cheap gate that claims no runner) and once as
  `max-attempts` (the backstop, for a caller whose `if:` is wrong). Both
  `SECURITY:` tests in `tests/reusableWorkflows.test.ts` exist because that
  duplication is structural and drifts silently.
- **The two retry loops were the same mechanism**, differing only in cap, in
  `--failed`, and in whether a branch-staleness guard applies. Collapsing them
  was real deduplication rather than packaging: a fix to the staleness guard or
  the rerun call now lands once. `branch-janitor` is the pure-packaging case —
  its body already knew nothing about this repo.

A reusable workflow rejects an undeclared input at run time (unlike a composite
action, which ignores unknown `with:` keys silently), so that class of mistake
fails loudly — but only once the loop next fires, which for a retry loop means
the next red CI. The wiring test catches it at merge time instead.

For a consuming repo the shape is the same, with the local path swapped for a
pinned remote one:

```yaml
uses: <org>/agent-pipeline/.github/workflows/automerge.yml@v1
with:
  build-worker-identity: 'claude[bot]'
  reviewer-identity: 'github-actions[bot]'
  governance-paths: |
    .github/**
    scripts/**
  labels-stop: 'needs-human,no-auto-merge'
  mode-variable: AUTOMERGE_MODE
```

**3 · A "project gate" contract for Tier C.** The clean seam is that a
consuming repo declares its gate once and every agent loop calls it:

```yaml
# .github/pipeline.yml (consumed by the reusable workflows)
gate:
  setup: npm ci
  commands: [typecheck, lint, format:check, migrate, test, build, test:security]
  services: [{ image: pgvector/pgvector:pg16, health: pg_isready }]
  env: { DISPLAY_TIMEZONE: Pacific/Auckland, ... }
prompts:
  build: .github/prompts/build.md
  review: .github/prompts/review.md
vocabulary:
  stop-label: needs-human
  ...
```

The gate scripts (Tier D) are better shipped as an **optional starter kit** a
project copies and owns — `security-floor.json`, the context pack, the import
direction rules are patterns worth teaching, but a reusable pipeline must not
require them.

### 8.4 What must not become a parameter

These are the invariants that make the system safe. A reusable version that lets
a consumer weaken them has extracted the shape and lost the substance:

1. **Fork PRs never receive secrets or run agent code.** Not an input.
2. **The identity distinction is structural** — the agent must not be able to
   write into the channels the deterministic steps read (handoff notes, verdict
   stamps, lane labels).
3. **Governance paths are always human-merged.** A pipeline that can auto-merge
   a change to its own gates has no gates. The *list* is a parameter; having a
   non-empty list must not be.
4. **Verify-else-escalate must fail loudly.** A run that produced nothing must
   never be green.
5. **Branch protection is the enforceable backstop**, and tool allowlists are
   defence in depth on top of it — never a substitute. Any packaged version must
   say so as loudly as the workflows currently do.
6. **Attempt caps exist**, with escalation to a human, on every loop that can
   re-trigger itself.

### 8.5 Suggested extraction order

1. ~~The composite action (§8.3.1)~~ — **done**; see above.
2. ~~Tier A workflows~~ — **done**; see §8.3. The retry pair deduplicated;
   the janitor proved the packaging.
3. Tier B, starting with the groundskeeper and outcomes loops (read-mostly, low
   blast radius) and ending with auto-merge (highest stakes).
4. Tier C, once the prompt-as-file seam exists.
5. The gate-script starter kit last, as documentation-plus-code rather than a
   dependency.
