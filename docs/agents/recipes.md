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
  && npm run test:security && npm run context:check
```

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
| `src/agent/tools.ts` | The tool definition, its input schema, and its **tier requirement**. |
| `src/agent/core.ts` | Only if the tool needs a new gating rule — the tool surface is derived from the caller's tier here. |
| `src/agent/pendingActions.ts` | **If the tool is destructive.** It must register a pending action for the router to execute after an explicit confirmation, never act directly. |
| `src/agent/systemPrompt.ts` | Only if members need to be told the capability exists. |
| `tests/` + `tests/security-floor.json` | A `SECURITY:` test for the tier gate, plus the manifest bump in the **same diff**. |

Two invariants that are not negotiable: a privileged tool **re-asserts the
tier** inside its own implementation rather than trusting that gating kept it
out of reach, and the caller's identity comes from the platform envelope only —
never from message content.

**Gates:** `npm run test:security` fails on a missing manifest bump (use
`npm run test:security:fix`). CI's `security-invariants` job additionally
refuses a PR that lowers the floor versus its base.

---

## Add a configuration setting

| File | Why |
|---|---|
| `src/config/<slice>.ts` | The var's zod chain + doc comment, in its domain slice (llm, discord, whatsapp, alerts, behaviour, …). Slice-local floors/refinements live here too. |
| `src/config.ts` | The composition barrel — surface the parsed var in the `config` object literal, or nothing reads it. Still what fails loudly on a bad deploy. |
| `.env.example` | So an operator can discover the setting. Never a real value. |
| `docs/DEPLOYMENT.md` | If an operator has to do something about it. |

Default it to the current behaviour. A setting that changes behaviour when
unset is a silent breaking change for the running deployment.

---

## Touch the database

| File | Why |
|---|---|
| `src/storage/schema/<NN-domain>.sql` | Schema changes go in the owning fragment (`migrate` concatenates them in `manifest.ts` order and replays the result as ONE query). **Every statement must be `IF NOT EXISTS`** — the replay is idempotent and re-runs on every deploy. A brand-new fragment must also be listed in `src/storage/schema/manifest.ts` (explicit array, never a glob — the sync test in `tests/schemaConstraintIdempotency.test.ts` fails otherwise). |
| `src/storage/repository/<domain>.ts` | Put a new query in its **domain module** (`preferences`, `memberNotes`, …). `repository.ts` re-exports them, so callers still import from `repository.js`. Admin-facing reads are **conversation-scoped in SQL**, not by the caller. |
| `src/storage/repository.ts` | Pure `export *` barrel (the audit-L14 split is complete) — the only edit it ever takes is one new `export *` line for a brand-new domain module, which also needs its `docs/agents/module-map.md` entry in the same diff. |
| `tests/repository.test.ts` | DB tests skip cleanly without `DATABASE_URL` and run in CI against a real `pgvector/pgvector:pg16` service. |

Run `npm run migrate` before `npm test` locally, or the DB tests fail with
`relation does not exist` rather than skipping.

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
| `src/<job>.ts` (or `src/backgroundJobs.ts`) | The run function + `startX` starter via `startTrackedJob` (tracked, cost-accounted, health-monitored), and the module's exported `JobSpec`. |
| `src/jobs/registry.ts` | Add the spec to `JOB_REGISTRY` (at the END — start order is pinned). `index.ts` needs no edit: it starts and stops whatever the registry holds. |
| `src/config/<slice>.ts` + `src/config.ts` | Its enable flag and schedule (slice fragment + barrel surface). Background jobs are **opt-in**. |
| `tests/jobsRegistry.test.ts` | Add the job's row (name, enabling env) to the table the registry-completeness test pins. |

Cost and consecutive-failure alerting come free from registration — do not
hand-roll either. A job that can fail repeatedly should say so once per outage,
which `backgroundJobHealth.ts` already handles.

---

## Add a member-facing notice

There is a strong existing convention here: one small file per notice, holding
(where the notice repeats) a **pure debounce helper** with no config, HTTP or
DB imports, so it is directly unit-testable.

The text itself now lives in the strings catalogue
(`src/strings/notices.ts`): add one entry with the English base plus any
`mi`/`plain` variants, and select it at the call site with
`notice(id, { language, style })` — never re-encode the "'mi' beats 'plain'"
precedence per site; the catalogue owns it (`src/strings/catalogue.ts`), and
`tests/stringsCatalogue.test.ts` pins the semantics for every entry
automatically. If other files need the value as a constant, export a derived
const (`export const X = notice('id')`) the way `rateLimitNotice.ts` does.

Copy the shape of `rateLimitNotice.ts` — `pauseNotice.ts`,
`budgetCheckFailureNotice.ts` and `mutedRoleAlertNotice.ts` are all deliberate
mirrors of it. Pick the right window: per-user for a per-user event, once
process-wide for a systemic one.

---

## Change a platform adapter

Adapters normalise native events into `IncomingMessage` and own the **send
path**, which is where outbound filtering (`src/agent/outbound.ts`) and
chunking (`src/platforms/textChunk.ts`) apply. A new send path that bypasses
the filter is a security bug, not a style issue.

Keep pure wire helpers in their own files (`whatsapp/wire.ts`,
`whatsapp/cloudWire.ts`) so they stay testable without a socket.

---

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
