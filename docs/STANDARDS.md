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

- The full gate must be green before a PR is opened or updated: `typecheck`,
  `lint`, `format:check`, `migrate`, `test`, `build`, `test:security`,
  `context:check`, `imports:check`. The copy-pasteable command block is in
  `docs/agents/recipes.md` ("Run the full gate"); see root `CLAUDE.md` for what
  each one is protecting.
- If your change touches a gated area — tool gating, the CONFIRM flow,
  outbound filtering, or anything else on the security spine — extend the
  matching test file under `tests/` rather than relying on incidental
  coverage: `rbac.test.ts` (tier→tool derivation), `tools.test.ts` (the tool
  layer itself: allowlist gate, target validation, CONFIRM),
  `router.test.ts` (the router-side confirm/execute path) and
  `outbound.test.ts` (secret redaction, code policy). The implementations are
  in the package now, but the invariants are ours to hold: these tests run
  against the installed `@swampratnz/agent-base` and fail here if a version
  bump regresses one. Don't weaken or delete an existing security assertion
  without discussing it in the PR description.
- DB-touching changes should pass against a real Postgres + pgvector locally
  (`npm run migrate` then `npm test`) in addition to CI's service container.
  If you don't have one, **get one** — see "Get a local Postgres + pgvector" in
  `docs/agents/recipes.md`; it needs no Docker daemon and takes about two
  minutes. Without `DATABASE_URL` roughly a fifth of the suite SKIPS while the
  run still prints `fail 0`, so "the full suite passed" is false in a way
  nobody chose. `npm test` prints a banner saying so.

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

## The framework package, this module, and the composition rules

The framework is not in this tree. `src/` is:

- **`src/module/`** — this deployment's content and wiring: the tool registry
  and its `ToolDef` domain files, prose, personas, skills, the notice pack,
  community jobs and digests, the integrations, its schema fragments, and the
  composition wiring (`routerWiring.ts`, `platforms/factories.ts`,
  `jobs/registry.ts`, `commands.ts`). `agentModule.ts` is the manifest that
  names every extension point this deployment fills.
- **`src/index.ts`** — the composition root: the only file that may call
  `createAgent`. It hands it the manifest, then wires adapters, the router and
  the jobs. It carries no side-effect imports; `createAgent` owns the ordering.
- **`src/migrate.ts`** — `npm run migrate`.

**`@swampratnz/agent-base`** — the community-agnostic framework (agent kernel
and prompt spine, adapters, storage, router spine, jobs mechanism, RBAC,
config, the notice mechanism, alert/health infra, leaf utils) — is a
dependency. You cannot add a file to it from here. A framework-level fix is a
PR against `swampratnz/agent-base` that reaches this repo as a version bump,
and the package's own internal discipline (no framework file carrying
community content) is enforced in that repo, not this one.

Adding an extension point is therefore not a registry-slot-plus-side-effect-
import exercise any more: export the value from the file that owns the content
and **name it in `agentModule.ts`**. Do NOT add a module-scope `register*()`
call, and never render a `notice()` at module scope — the pack is registered by
`createAgent` after every module has been imported, so an import-time render
throws before the process can say why. If the package has no slot for what you
need, that slot is the upstream change.

Three composition rules are gated here, by eslint (fast, on the specifier text,
scoped to `src/module/**`) and by `scripts/check-import-direction.mjs` (which
resolves specifiers against the file system and has no config to weaken), both
run by `npm run imports:check` in CI's lint job:

1. **`src/base/` must not exist.** A local copy of the framework forks it
   silently: the same file compiling in two places, one of them missing
   upstream fixes.
2. **`src/module/` may never import the composition root.** `src/index.ts` sits
   at the top of the graph; nothing it wires may reach back up to it.
3. **Only the composition root may compose** — no module may import
   `createAgent`, `planComposition` or `assertRegistrationsComplete`. A module
   contributes a manifest; the registration ORDER is exactly what `createAgent`
   exists to own.

See `docs/ARCHITECTURE.md` → "The framework package, this module, and the
composition root" for the full picture and `docs/SECURITY.md` → "Where the
controls live" for why the boundary matters.

## Commits and PRs

- No model identifiers in commit messages, PR titles/bodies, or code.
- Never commit secrets: `.env` is git-ignored, as are the runtime credential
  directories `/auth/` and `/whatsapp-auth/`. Both patterns are **anchored to
  the repo root** in `.gitignore`, so an unanchored `auth/` must never be
  re-added — it would swallow any source directory of that name at any depth.
- Every PR uses the template (`.github/pull_request_template.md`): Summary,
  Security / privacy impact, How verified. Keep those sections scoped to the
  diff — no secrets, tokens, env values, or hostnames in a PR body.
- Paths on the security spine (see `.github/CODEOWNERS`) are reviewed by the
  code owner before merge.
