# Contribution standards

A short, human-facing page. For the automated build/review pipeline's own
rules see [PIPELINE.md](PIPELINE.md); for the mission and what's in/out of
scope see [VISION.md](VISION.md); for the threat model see
[SECURITY.md](SECURITY.md).

## Code style

Style is enforced by `eslint.config.js` and Prettier — run `npm run lint` and
`npm run format:check` before opening a PR; don't hand-debate style in review
that the config already settles.

## Tests

- `npm run typecheck`, `npm test`, and `npm run build` must all be green
  before a PR is opened or updated (see root `CLAUDE.md`).
- If your change touches a gated area — tool gating (`src/auth/`), the
  CONFIRM flow (`src/agent/pendingActions.ts`), outbound filtering
  (`src/agent/outbound.ts`), or anything else on the security spine — extend
  the matching test file under `tests/` (e.g. `rbac.test.ts`,
  `pendingActions.test.ts`, `outbound.test.ts`) rather than relying on
  incidental coverage. Don't weaken or delete an existing security assertion
  without discussing it in the PR description.
- DB-touching changes should pass against a real Postgres + pgvector locally
  (`npm run migrate` then `npm test`) in addition to CI's service container.

## Commits and PRs

- No model identifiers in commit messages, PR titles/bodies, or code.
- Never commit secrets: `.env` is git-ignored; `whatsapp-auth/` and
  `src/auth/` are distinct — the latter is source and stays tracked.
- Every PR uses the template (`.github/pull_request_template.md`): Summary,
  Security / privacy impact, How verified. Keep those sections scoped to the
  diff — no secrets, tokens, env values, or hostnames in a PR body.
- Paths on the security spine (see `.github/CODEOWNERS`) are reviewed by the
  code owner before merge.
