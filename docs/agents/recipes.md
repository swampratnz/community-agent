# Change recipes

The shape of the changes this repo actually gets, so a cold session does not
have to infer each one from the tree. Each recipe lists the files a change of
that kind normally touches and **which gate fails if you miss one** — the gate
is the part that turns a forgotten file into a red PR an hour later.

These are starting points, not permissions. [`../VISION.md`](../VISION.md)
decides what is worth building and [`../PIPELINE.md`](../PIPELINE.md) decides
who may build it.

---

## Every change, without exception

Run the full gate before opening or updating a PR — CI runs the identical set,
so a red PR only makes rework:

```
npm run typecheck && npm run lint && npm run format:check \
  && npm run migrate && npm test && npm run build \
  && npm run test:security && npm run context:check && npm run imports:check
```

**Does your change belong here at all?** The framework is
**`@swampratnz/agent-base`**, a package: the turn engine, the router spine, the
platform adapters, storage, RBAC, config, the notice mechanism. This repo is
`src/module/` (this deployment's NZ-community content and wiring),
`src/index.ts` (the composition root, which hands
`src/module/agentModule.ts`'s manifest to the package's `createAgent`) and
`src/migrate.ts`. A framework-level fix belongs upstream in agent-base and
reaches this repo through a version bump — **do not** re-create `src/base/`,
`npm run imports:check` fails outright if it reappears. Module code may never
import `src/index.ts`, and may never import `createAgent` (only the composition
root composes); both are gated by that script and by eslint.

**Adding an extension point?** Export the value from the file that owns the
content and name it in `src/module/agentModule.ts` — do not add a module-scope
`register*()` call, and never render a `notice()` at module scope: the pack is
registered by `createAgent`, after every module has been imported, so an
import-time render throws. Tests opt into the same registrations one at a time
through `tests/support/register*.ts`.

`npm run typecheck` also typechecks the **allowlisted** test files
(`tsconfig.tests.json`, an incremental ratchet — `tests/` has a backlog of
pre-existing errors, so only clean files are listed). If it fails on a test file,
fix the test — do **not** remove its entry to go green. If you make another test
file type-clean, add it to the list; that's the intended unit of progress. The
most likely thing it catches: a `deps` object missing a field. Those deps types
are all-required on purpose, because an omitted field falls through to a real
repository read and makes a "unit" test query live Postgres
(`docs/STANDARDS.md` → "Injected deps must be all-or-nothing").

Then:

- **`CHANGELOG.md`** — a member-legible entry under today's **Pacific/Auckland**
  date (`TZ='Pacific/Auckland' date +%F`; a bare `date` in CI is a day behind).
  Reuse today's section if it exists. Purely internal work (CI, deps, tooling,
  pipeline) instead goes in the skip ledger comment at the top of the file.
- **`docs/SECURITY.md`** — if the change adds, removes or moves anything on the
  security spine, or introduces a new input, egress or trust boundary. Note
  that touching this file (or `.github/**`, `scripts/**`, `package.json`,
  `CLAUDE.md`, `docs/PIPELINE.md`) routes the PR to a **human merge** — that is
  intended, not a problem to design around.
- **`docs/agents/module-map.md`** — if you added, removed or renamed a `src/`
  module. `npm run context:check` fails otherwise; `npm run context:fix`
  does the mechanical part.

---

## Add or change an agent tool

The single most common change, and the one with the most gates.

| File | Why |
|---|---|
| `src/module/agent/tools/<domain>.ts` | The `defineTool` entry: description, input schema, **`minTier`**, optional `platforms`/`featureFlag`/`confirm`/`audit`, and the handler. Find the right domain file by tool name first (`moderation.ts`, `knowledgeAdmin.ts`, `social.ts`, …); a brand-new domain file also needs a `docs/agents/module-map.md` entry. |
| `src/module/agent/tools/index.ts` | Spread the domain array into `TOOL_REGISTRY`. Nothing else: the tier lists (`registerToolTiers`), the tool server's inventory (`registerToolServerParts`) and the feature-flag filter (`registerFlaggedToolPredicates`) are all **derived** from the registry at this file's module scope. Do not hand-add the name to a tier array — there isn't one to add it to any more. |
| `@swampratnz/agent-base/agent/core.ts` | Only if the tool needs a genuinely new *kind* of gating rule. Tier and flag filtering already flow from the registry. |
| `@swampratnz/agent-base/agent/pendingActions.ts` | **If the tool is destructive.** It must register a pending action for the router to execute after an explicit confirmation, never act directly. |
| `src/module/agent/communityPromptSections.ts` | Only if members need to be told the capability exists (the community prose sections; `systemPrompt.ts`/`promptSpine.ts` own assembly and the security spine). Any prompt-text change must regenerate `tests/fixtures/systemPromptByteStability.json` in the same diff. |
| `tests/` + `tests/security-floor.json` | A `SECURITY:` test for the tier gate, plus the manifest bump in the **same diff**. |

Two invariants that are not negotiable: a privileged tool **re-asserts the
tier** inside its own implementation rather than trusting that gating kept it
out of reach, and the caller's identity comes from the platform envelope only —
never from message content.

A `platforms` restriction is not free-form: `assertToolAvailabilityConsistent`
(startup + `tests/platformRegistry.test.ts`) requires the offered set to equal
exactly the platforms whose registered adapters declare the capability the tool
needs, so restrict by capability or not at all.

**Gates:** `npm run test:security` fails on a missing manifest bump (use
`npm run test:security:fix`). `tests/toolRegistry.test.ts` pins the derivation
invariants. CI's `security-invariants` job additionally refuses a PR that
lowers the floor versus its base.

---

## Add a configuration setting

| File | Why |
|---|---|
| `@swampratnz/agent-base/config/<slice>.ts` | ⚠️ **UPSTREAM.** The var's zod chain + doc comment live in the package's domain slice (llm, discord, whatsapp, alerts, behaviour, …), so a new setting is an agent-base change plus a version bump here. There is no per-module config slice yet — `AgentModule` has no `configSchema` field (plan §3 has one; `createAgent` does not implement it). |
| `@swampratnz/agent-base/config.ts` | ⚠️ **UPSTREAM**, same story: the composition barrel is where the parsed var reaches the `config` object literal. |
| `.env.example` | So an operator can discover the setting. Never a real value. |
| `docs/DEPLOYMENT.md` | If an operator has to do something about it. |

Default it to the current behaviour. A setting that changes behaviour when
unset is a silent breaking change for the running deployment.

---

## Touch the database

| File | Why |
|---|---|
| `src/module/storage/schema/<NN>-<domain>.sql` | This deployment's schema changes go in a MODULE fragment (the 80+ band), listed in `src/module/storage/schema/manifest.ts` and contributed through `AgentModule.migrations` — `migrate` concatenates base's fragments first, then these, and replays the result as ONE query. **Every statement must be `IF NOT EXISTS`**, and a CHECK needs its own DROP/ADD pair. Never re-declare a fragment the package ships, and never DROP or reshape a constraint it owns — `tests/schemaConstraintIdempotency.test.ts` fails on both. Changing a BASE table's shape is ⚠️ **upstream**. |
| `@swampratnz/agent-base/storage/repository/<domain>.ts` | ⚠️ **UPSTREAM.** Queries over the BASE tables live in the package's domain modules (`preferences`, `memberNotes`, …), re-exported from `repository.js`. Admin-facing reads are **conversation-scoped in SQL**, not by the caller — keep it that way upstream too. |
| `tests/repository.test.ts` | DB tests skip cleanly without `DATABASE_URL` and run in CI against a real `pgvector/pgvector:pg16` service. |

Run `npm run migrate` before `npm test` locally, or the DB tests fail with
`relation does not exist` rather than skipping.

**Fragments live in base even when the table is community.** The numbering
carries the distinction instead: `00`–`27` base, `50`–`54` community, `70`
adapter, with deliberate gaps for insertion. Per-module migration contribution
is Phase 3 work (`docs/AGENT-BASE-PLAN.md`) — until then, add a community table
to a `5x` fragment and list it in `manifest.ts`. If the erasure promise has to
reach it, call `registerPurgeContributor` (`@swampratnz/agent-base/storage/lifecycle.ts`) from
the repository domain module that owns the table, the way every existing
domain does, rather than adding another delete to a central purge query.

**Widening an enum `CHECK` (a new `kind`, `status`, …):** edit the existing
`DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` pair's value list **in place**.
Never append a second pair for the same constraint name — in any fragment.
`migrate()` replays the entire fragment concatenation as one multi-statement
query, so both pairs run in order on every
future migration; the earlier, narrower one is validated against live rows, and
a single row using a value only the later pair allows aborts it — rolling back
the whole migration. This is not theoretical: stacked
`shortcut_hits_kind_check` pairs meant one WhatsApp `!`-command hit blocked
every subsequent migration. **CI cannot catch it** (it always starts from an
empty database), so `tests/schemaConstraintIdempotency.test.ts` guards it
statically. Note `ADD CONSTRAINT` has no `IF NOT EXISTS` form — the preceding
`DROP ... IF EXISTS` is what makes it re-runnable, and that test checks each
one has it.

---

## Add a background job

| File | Why |
|---|---|
| `src/module/<job>.ts` (or `src/module/backgroundJobs.ts`) | The run function + `startX` starter via `startTrackedJob` (tracked, cost-accounted, health-monitored), and the module's exported `JobSpec`. A community job is module code — the base half is only the mechanism (`@swampratnz/agent-base/jobs/`: `types.ts`, `runner.ts`, `trackedJob.ts`), and it must not learn this job's name. |
| `src/module/jobs/registry.ts` | Add the spec to `JOB_REGISTRY` (at the END — start order is pinned). `index.ts` needs no edit: `startRegisteredJobs`/`stopRegisteredJobs` sweep whatever list the composition root hands them. |
| `@swampratnz/agent-base/config/<slice>.ts` + `@swampratnz/agent-base/config.ts` | Its enable flag and schedule (slice fragment + barrel surface). Background jobs are **opt-in**. |
| `tests/jobsRegistry.test.ts` | Add the job's row (name, enabling env) to the table the registry-completeness test pins. |

Cost and consecutive-failure alerting come free from registration — do not
hand-roll either. A job that can fail repeatedly should say so once per outage,
which `backgroundJobHealth.ts` already handles.

---

## Add a member-facing notice

There is a strong existing convention here: one small file per notice, holding
(where the notice repeats) a **pure debounce helper** with no config, HTTP or
DB imports, so it is directly unit-testable.

The text itself lives in the **module** notice pack
(`src/module/strings/notices.ts`) — never in a base file, whichever half the
notice is *sent* from: add one entry with the English base plus any `mi`/`plain`
variants (and its `NoticeIdMap` augmentation, which keeps the per-id return
type), and select it at the call site with `notice(id, { language, style })`.
Never re-encode the "'mi' beats 'plain'" precedence per site; the catalogue
mechanism owns it (`@swampratnz/agent-base/strings/catalogue.ts`), and
`tests/stringsCatalogue.test.ts` pins the semantics for every entry
automatically.

**Never render a notice at module scope** — no `export const X = notice('id')`.
The pack is registered by `createAgent`, after every module in the composition
has been imported, so an import-time render throws before the process can even
report why. (agent-base deleted its own `X`/`X_MI`/`X_PLAIN` families for
exactly this reason; the tests that pinned their values now derive them in
`tests/support/legacyNotices.ts`.) `notice()` throws rather than returning an
empty string, so a missing registration fails loudly instead of as blank text
in someone's DM.

If the notice repeats, copy the debounce shape of the package's
`rateLimitNotice.ts`/`pauseNotice.ts` leaf modules. Pick the right window:
per-user for a per-user event, once process-wide for a systemic one.

---

## Change a platform adapter

Adapters normalise native events into `IncomingMessage` and own the **send
path**, which is where outbound filtering (`@swampratnz/agent-base/agent/outbound.ts`) and
chunking (`@swampratnz/agent-base/platforms/textChunk.ts`) apply. A new send path that bypasses
the filter is a security bug, not a style issue.

Keep pure wire helpers in their own files (`whatsapp/wire.ts`,
`whatsapp/cloudWire.ts`) so they stay testable without a socket.

Adapters themselves are the package's (⚠️ a change to one is upstream); what
lives here is the wiring. Platforms are registered, not typed: adding one means
a descriptor in `@swampratnz/agent-base/platforms/registry.ts` (⚠️ upstream:
id + `memberIdRules.ts`), a factory in
`src/module/platforms/factories.ts` (constructor + declared tool-capability set),
and — if any tool should be restricted to it — a `requiresCapability` on the
ToolDef, which `assertToolAvailabilityConsistent` and
`tests/platformRegistry.test.ts` check against the declared capabilities.
Model-facing platform zod enums stay CLOSED; widen them only as a conscious
security decision.

---

## I got an `imports:check` failure

Three rules, each with its own message:

```
check-import-direction: src/base/ exists again.
```

The framework is `@swampratnz/agent-base`, a package. A local `src/base/` forks
it silently — the same file compiling in two places, with only one of them
getting upstream fixes. Put framework-level work upstream and take it here as a
version bump; put this deployment's content in `src/module/`.

```
check-import-direction: the composition-direction rules are broken.
  src/module/foo.ts:12  ../index.js  ->  src/index.ts
    src/module/ must not import the composition root
```

`src/index.ts` sits at the top of the graph. If a module file needs something
the composition root has, inject it (`src/module/routerWiring.ts` is the one
place production names the real implementation behind every `RouterDeps`
field) or export it from the module and let the root wire it.

```
  src/module/foo.ts:3  @swampratnz/agent-base (createAgent)
    only the composition root may compose the agent
```

A module CONTRIBUTES a manifest; it never composes one. Add your extension
point to `src/module/agentModule.ts` and let `src/index.ts` hand the manifest
to `createAgent`, which owns the ordering (plan → init → singleton
registrations → additive registrations → readiness probe → migrate → start).
Importing the manifest TYPE (`AgentModuleManifest`) is fine.

## The framework needs something it doesn't have

When a change genuinely belongs upstream — a new base config var, a new slot,
a wrong signature — the honest sequence is: fix it in `swampratnz/agent-base`,
publish, bump the dependency here. Do NOT re-create the file locally to work
around it. One known gap to expect, real today: `AgentModule` has no
`configSchema` field, so a new env var is an upstream change. (Subpath exports
were the other one — `@swampratnz/agent-base@0.1.1` publishes `./*`, so
`@swampratnz/agent-base/<module>.js` resolves from the package itself and the
postinstall shim that used to add that entry has been deleted.)

## Change the pipeline itself

Read [`../PIPELINE.md`](../PIPELINE.md) fully first — it is the authority, and
the workflow YAML is dense with hard-won rationale in its comments. Do not
delete a comment you do not understand; several of them are the only record of
an incident that shaped the design.

- **`CLAUDE.md` and `docs/PIPELINE.md` must stay in sync** with each other and
  with the YAML.
- Shell helpers duplicated across workflows (the verdict contract's
  `canonical_verdict` / `legacy_verdict`) are **drift-tested** by
  `tests/reviewVerdict.test.ts`. Change all copies together.
- Every governance path routes to a human merge. Expect the
  `human-merge-ready` label, not an auto-merge.
