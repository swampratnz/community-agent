# Contribution standards

A short, human-facing page. For the automated build/review pipeline's own
rules see [PIPELINE.md](PIPELINE.md); for the mission and what's in/out of
scope see [VISION.md](VISION.md); for the threat model see
[SECURITY.md](SECURITY.md).

## Code style

Style is enforced by `eslint.config.js` and Prettier — run `npm run lint` and
`npm run format:check` before opening a PR; don't hand-debate style in review
that the config already settles.

## Line endings

`.gitattributes` normalises tracked text files to LF (`* text=auto eol=lf`).
This only takes effect on a fresh `git clone`. If you cloned before this was
added — most noticeably on Windows with `core.autocrlf=true`, where git
otherwise materialises CRLF and breaks tests that match source files against
a literal `\n` — pick it up in an existing clone with:

```
git rm --cached -r . && git reset --hard
```

## Tests

- `npm run typecheck`, `npm test`, and `npm run build` must all be green
  before a PR is opened or updated (see root `CLAUDE.md`).
- If your change touches a gated area — tool gating (`@swampratnz/agent-base/auth/`), the
  CONFIRM flow (`@swampratnz/agent-base/agent/pendingActions.ts`), outbound filtering
  (`@swampratnz/agent-base/agent/outbound.ts`), or anything else on the security spine — extend
  the matching test file under `tests/` (e.g. `rbac.test.ts`,
  `pendingActions.test.ts`, `outbound.test.ts`) rather than relying on
  incidental coverage. Don't weaken or delete an existing security assertion
  without discussing it in the PR description.
- DB-touching changes should pass against a real Postgres + pgvector locally
  (`npm run migrate` then `npm test`) in addition to CI's service container.

### Injected deps must be all-or-nothing

Several background jobs take an injectable `deps` object whose fields default to
real repository reads (`memberDigest.ts`, `usageCostDigest.ts`,
`backgroundJobCostAlert.ts`). Those deps types have **no optional fields** on
purpose: a *partial* object silently leaves the un-stubbed reads pointing at
live Postgres, so a "unit" test quietly queries the DB. Because `node:test` runs
test **files** in parallel, those stray reads land on tables other files are
counting — one of the sources of this suite's cross-file flakiness.

So: pass **nothing at all** (production, and any on-demand caller) to get the
repository defaults, or pass **every** field (tests). To stub only the reads your
test cares about, spread a base whose every field *throws* — see
`throwingRunDeps`/`throwingContentDeps` in `tests/memberDigest.test.ts`. Don't
build a base of inert `async () => 0` stubs: a newly added signal would silently
acquire a plausible zero nobody chose and the test meant to cover it would pass
vacuously.

### `npm run typecheck:tests` — the tests typecheck ratchet

`tsconfig.json` covers `src/**` only, and `tsx` strips types without checking
them, so for a long time nothing typechecked `tests/` at all — which is exactly
how the partial-deps bug above went unnoticed. `tsconfig.tests.json` closes that
gap, and `npm run typecheck` now runs it (so CI and the build worker pick it up
with no workflow change).

`tests/` still has a large backlog of pre-existing type errors, so this is an
**incremental ratchet**: `tsconfig.tests.json`'s `include` lists only the test
files that are type-clean today, and a listed file can never regress. **Adding a
file is the unit of progress** — bring it to zero errors, then add it to the
list, alphabetically, one per line (so concurrent PRs land in different hunks,
same reasoning as `tests/security-floor.json`). Don't remove a file to make a
red build green.

## Finding your way around

`docs/agents/` is a committed context pack: `module-map.md` (one line per `src/`
subsystem and module, security spine marked) and `recipes.md` (what a given kind
of change touches, and which gate catches a missed file). It is aimed at the
pipeline's cold sessions, but it is the fastest orientation for a human too.

If you **add, remove or rename a module**, describe it in `module-map.md` in the
same diff — `npm run context:check` (CI's lint job) fails otherwise, and
`npm run context:fix` handles the mechanical part. The pack is orientation, not
authority: read the code before trusting a one-liner, and fix the line if it is
wrong.

## Base and module, and the one-way import rule

`src/` has two halves and a composition root:

- **`@swampratnz/agent-base/`** — the community-agnostic framework: agent kernel and prompt
  spine, adapters, storage, router spine, jobs mechanism, RBAC, config, the
  notice-catalogue mechanism, alert/health infra, leaf utils. A new base file
  must carry **no community content** — no Claude/Anthropic/NZ prose, no te reo
  or plain-language strings, no product decision this deployment made. If it
  does, it belongs in `src/module/`.
- **`src/module/`** — this deployment's content and wiring: the tool registry
  and its `ToolDef` domain files, prose, personas, skills, the notice pack,
  community jobs, the integrations, and the composition wiring.
- **`src/index.ts`** — the composition root, the only file that may import
  both halves and where the community side-effect imports live.

**Base may never import module**, not even a type; **module may never import
the composition root**. When a base file needs something a module owns, don't
weaken the rule — invert it: declare a registry slot in base, register into it
from the module at its own import time, and add the side-effect import to
`index.ts`. `@swampratnz/agent-base/agent/turnState.ts`, `@swampratnz/agent-base/strings/catalogue.ts` and
`@swampratnz/agent-base/commands/registry.ts` are the worked examples. For a `typeof
<community export>` in a base deps interface, write the type structurally in
base instead (`@swampratnz/agent-base/agent/toolServer.ts`'s `ToolServerToolDef` shows the
shape).

Keep new slots **fail-closed** like the existing ones: a slot holding required
content throws when read before registration rather than returning an empty
value, and an additive slot rejects a duplicate or unknown name rather than
shadowing what is already registered. An empty-on-unregistered tier list or
bad-word list is a silent downgrade nobody sees.

Enforced by eslint and, authoritatively, by `npm run imports:check` (CI's lint
job); see `docs/ARCHITECTURE.md` → "Two halves and a composition root" for the
full picture and `docs/SECURITY.md` → "Where the controls live" for why the
boundary matters.

## Commits and PRs

- No model identifiers in commit messages, PR titles/bodies, or code.
- Never commit secrets: `.env` is git-ignored; `whatsapp-auth/` and
  `@swampratnz/agent-base/auth/` are distinct — the latter is source and stays tracked.
- Every PR uses the template (`.github/pull_request_template.md`): Summary,
  Security / privacy impact, How verified. Keep those sections scoped to the
  diff — no secrets, tokens, env values, or hostnames in a PR body.
- Paths on the security spine (see `.github/CODEOWNERS`) are reviewed by the
  code owner before merge.
