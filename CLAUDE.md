# CLAUDE.md — conventions for this repo

Guidance for any Claude Code session working in `swampratnz/community-agent`.

## What this is

A TypeScript/Node service (the "NZ Claude Community" agent) that bridges a
Discord server and a WhatsApp number to a Claude Agent SDK agent with
persistent Postgres + pgvector memory and a gated three-tier RBAC model. Start
with `README.md`, then `docs/ARCHITECTURE.md` and `docs/SECURITY.md`.

## Build / test / verify

- `npm run typecheck` — must be clean.
- `npm test` — Node test runner via tsx; must pass. Security invariants live
  here (tool gating, confirm flow, secret redaction, WhatsApp wire helpers) —
  when you touch those areas, extend the tests.
- `npm run test:security` — runs every `SECURITY:`-prefixed test and enforces
  `tests/security-floor.json`, a per-file map of how many `SECURITY:` tests
  each test file declares (exact match, not a floor). When you add (or
  intentionally remove) a `SECURITY:` test, update that file's entry in the
  SAME diff — the gate's error message tells you exactly which entry, or run
  `npm run test:security:fix` to regenerate the manifest to the true counts.
  That helper only ever RAISES a count; a genuine removal needs `--allow-lower`
  plus a PR explanation, so it can't silently paper over a deleted security
  test. Per-file entries exist so concurrent PRs don't all conflict on one
  shared counter line, which is what the old global `MIN_SECURITY_TESTS`
  constant caused.
- `tests/knowledgeEval.test.ts` + `tests/fixtures/knowledgeEval.json` — a
  golden-query regression eval for `knowledge_search` retrieval quality
  (precision@K against a curated, paraphrased query set with distractors).
  When you add or edit knowledge entries in a way that should be
  discoverable by a new phrasing, add a matching golden query there —
  queries must be paraphrases of the target entry, never near-verbatim
  quotes, or the eval proves nothing.
- `npm run build` — tsc + copies `schema.sql` into `dist/`.
- DB-touching changes: CI runs `tests/repository.test.ts` against a real
  `pgvector/pgvector:pg16` service container (see `.github/workflows/ci.yml`),
  so this is enforced, not just a manual reminder. Do it locally too for the
  tight loop: run `npm run migrate` against a local Postgres 16 + pgvector
  with `DATABASE_URL` set, then `npm test` — DB-touching tests skip cleanly
  (not fail) when `DATABASE_URL` is unset, so a contributor without local
  Postgres isn't blocked.
- Run all three (typecheck, test, build) green before opening/updating a PR.

## Security posture (do not regress)

This bot processes untrusted public chat. Preserve these invariants:

- Built-in Claude Code tools are disabled per turn (`tools: []`); only admin+
  turns additionally get `WebSearch`. `WebFetch` is disallowed for everyone.
- Roles come from env (super admins) + the `community_users` table — **never**
  from message content. Tool surface is tier-derived; privileged tools also
  re-assert the tier.
- Destructive actions are CONFIRM-gated and executed by the router, not the
  model. Outbound filtering (secret redaction + code policy) lives in the
  adapters' send paths.
- Admin data access is scoped in SQL to conversations the admin is in.

## Multi-loop pipeline

This repo is developed by a supervised multi-session pipeline — see
`docs/PIPELINE.md`. If you are running as one of those loops, obey the
ownership rules:

- **Only the build loop** writes code or opens PRs. PR-review comments only;
  research & adversarial touch issues only. One exception: the **autofix loop**
  (`pipeline-pr-autofix.yml`) may push fixes to an existing build-worker PR
  branch when its CI fails — bounded to 2 attempts; same-repo bot PRs with a
  `Closes #` body only (unrelated bot PRs like Dependabot bumps and PRs
  already labelled `needs-human` are skipped); and only from CI
  `run_attempt` ≥ 2 (the ci-retry loop below gets one free machine rerun
  first, so agents never chase one-off flakes), then it escalates
  `needs-human`. It never opens or merges PRs. Before assuming a code defect it
  checks the two mechanical causes that dominate a concurrent queue and
  self-heals them rather than escalating: a `security-floor.json` per-file
  count mismatch (regenerated via `npm run test:security:fix`) and a flaky,
  unrelated test (re-run in isolation, and if it passes there, CI is
  re-triggered with an empty commit instead of pushing a bogus "fix"). When it
  genuinely can't fix something, its escalation comment now carries the agent's
  own final summary (the same diagnosability the build worker got in #251) so a
  maintainer isn't reverse-engineering it from run logs.
- The **conflict-resolver loop** (`pipeline-pr-conflict.yml`) may push a
  `main`-merge to an existing PR branch when that PR is
  CONFLICTING. It is two-hop: a `discover` job (triggered on every push to
  `main`, on PR opened/ready-for-review — a PR can be *born* conflicted — and
  on an **hourly** backstop sweep) finds conflicting same-repo PRs and
  self-dispatches the `resolve` job via `workflow_dispatch`, because
  claude-code-action won't run under a `push` event. The dispatch payload
  carries PR **numbers only**; resolve re-derives the branch from the API and
  re-verifies the full eligibility contract before checkout: same-repo (never a
  fork), not `needs-human`/`no-auto-resolve`, still CONFLICTING, and **either** a
  bot PR with `Closes #` **or** a maintainer PR whose author is in the
  `MAINTAINER_LOGINS` allowlist. So a hand-crafted dispatch can't aim it at an
  arbitrary branch, and a superseded duplicate run no-ops instead of
  mislabelling. It resolves a `security-floor.json` conflict by regenerating the
  manifest (`npm run test:security:fix`) rather than hand-counting, and its
  escalation comment carries the agent's final summary so an unresolved conflict
  says WHICH files couldn't be reconciled instead of the old opaque "incompatible
  or needs a workflows change". One attempt per conflict: a
  failed resolution escalates `needs-human`, and the eligibility filter skips
  `needs-human` PRs so it never thrashes. Same push guardrails as autofix
  (read-only `gh`, exact `git push origin HEAD`). It never opens or merges
  PRs.
- The **revise loop** (`pipeline-pr-revise.yml`) may push review-response
  commits to an existing build-worker PR branch when the PR-review worker's
  verdict is "Changes requested" — the green-CI case autofix (CI-failure
  keyed) never touches. Two-hop like the conflict resolver: the review
  workflow's post step self-dispatches it via `workflow_dispatch` (a
  GITHUB_TOKEN-posted comment can never trigger a workflow), the payload
  carries the PR number only, and eligibility (same-repo, bot, `Closes #`,
  no `needs-human`) plus the still-pending verdict are re-verified from the
  API before checkout. Bounded to 2 attempts per PR via marker comments,
  then it escalates `needs-human`; a "Needs a human decision" verdict labels
  `needs-human` directly from the review workflow. Same push guardrails as
  autofix (exact `git push origin HEAD`; `gh` read-only except
  `gh pr comment` for explaining a principled refusal). It never opens or
  merges PRs.
- The **build-retry loop** (`pipeline-build-retry.yml`) auto-re-runs a build
  worker run that failed to produce a PR, via `gh run rerun`, bounded by
  `run_attempt` (≤3 total attempts). The build worker escalates `needs-human`
  only on its final attempt, so transient/infra failures recover unattended and
  a human is pinged only for persistent ones — don't re-add manual re-trigger
  steps for build failures. (A GITHUB_TOKEN label toggle can't re-trigger the
  build worker, which is why this uses rerun, not a label change.)
- The **ci-retry loop** (`ci-retry.yml`) gives a failed CI run one blind
  machine rerun (`gh run rerun --failed`, `run_attempt` < 2) before any agent
  engages — transient npm-registry/runner failures recover for zero agent
  cost. It holds `actions: write` only, touches no code, and hands off to
  autofix from attempt 2.
- The build worker runs the **full CI gate** (typecheck, lint, format:check,
  migrate, test against a real pgvector Postgres, build, test:security) BEFORE
  opening a PR, so "green locally" matches CI. Keep it that way when editing
  either `pipeline-build.yml` or `ci.yml` — they must run the same checks.
- **No loop merges PRs** — a human merges.
- WIP caps: ≤3 open `status:draft`. Builds run **per-issue** (each issue its own
  `concurrency` group, so distinct issues run in parallel and none evicts
  another — a single shared group would silently *cancel* queued builds, and
  cancellations aren't retried). Every run draws on the shared Max pool, so
  don't release large bursts at once: parallel builds throttle each other, and
  the mitigation is a generous build `timeout-minutes` (contended builds finish
  slowly rather than being killed), not a hard cap. A true FIFO lock is the
  proper fix if bursts keep saturating the pool.
- Coordinate only through issue labels; when blocked or ambiguous, add
  `needs-human` and stop rather than guess.
- Everything traces to an issue number; the build session works in its own git
  worktree.

## Conventions

- Match existing style; keep comments at the density of surrounding code.
- Never commit secrets. `.env` is git-ignored; `whatsapp-auth/` and `src/auth/`
  are distinct — the latter is source and must stay tracked.
- Do not put model identifiers in commits, PR bodies, or code.
- Human-facing conventions (style, test expectations, commit/PR rules) are
  also written up in `docs/STANDARDS.md` — keep the two in sync if either
  changes.
