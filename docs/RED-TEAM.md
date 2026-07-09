# Manual red-team runbook

A maintainer-run, **off-CI**, generative adversarial sweep against the real
model, complementing the deterministic `SECURITY:` corpus gate
(`tests/injectionCorpus.test.ts` + `tests/fixtures/injectionCorpus.json`,
issue #227). This is Part 2 of that issue: the deterministic gate proves the
prompt-construction/outbound-filter *code* neutralises a fixed, known corpus;
this runbook is how you *discover* new phrasings that corpus doesn't have yet
— against the actual model, which the deterministic gate deliberately never
calls (see "Why this stays off CI" below).

## Scope and posture

- **Runs on a maintainer's own Claude credential**, never in a GitHub Actions
  workflow, never on `CLAUDE_CODE_OAUTH_TOKEN`/any repo secret, and never
  wired into `npm run test:security` or any other blocking gate.
- **No automatic Max-pool draw.** Every probe here is a deliberate, human-
  initiated model call the maintainer chooses to spend, same posture as
  running the bot itself — see the pool-burst caution in `docs/PIPELINE.md`.
- Target the **real agent path** (`runAgentTurn` → `query()`), not a stubbed
  model — the whole point is to see whether the *model* acts on an injection,
  which the deterministic gate can't observe.

### Why this stays off CI

The original draft of issue #227 pointed promptfoo at `runAgentTurn` in CI
and was escalated on adversarial review: every probe would be a real model
call **on the shared Max pool**, per PR, plus a judge call for model-graded
assertions; model-graded pass/fail is non-deterministic and would feed the
`ci-retry`/autofix loops flaky failures to chase; and running `query()` in CI
needs a credential that either crosses the subscription-only billing
boundary this repo enforces (`ANTHROPIC_API_KEY` is deleted at startup, see
`docs/SECURITY.md`) or deepens the consumer-OAuth-in-automated-service grey
area that same document flags. None of that changes for a maintainer running
the sweep by hand on their own login — it's simply not automated, so it
never has to answer those cost/auth/determinism questions.

## Tooling

- **[promptfoo](https://www.promptfoo.dev/)** — the primary tool. Point its
  provider config at a small wrapper script that calls `runAgentTurn` (or the
  Agent SDK's `query()` directly) with a fixed `CallerContext`, and grade
  results with a mix of deterministic asserts (`not-contains`,
  `not-icontains`) and model-graded asserts (`llm-rubric`) for "did it reveal
  the system prompt", "did it claim a higher tier", "did it agree to skip
  CONFIRM", etc.
- **[garak](https://github.com/leondz/garak)** — breadth: its built-in probe
  library (jailbreak, prompt injection, encoding tricks, DAN-style personas)
  is useful for generating novel phrasings you wouldn't think to hand-write.
- **[PyRIT](https://github.com/Azure/PyRIT)** — multi-turn: some injection
  classes only land after a few turns of conversational setup (e.g. building
  false rapport before requesting a privileged action); PyRIT's orchestrators
  are built for exactly that shape of attack, which single-turn promptfoo
  probes don't cover.

Install these as local dev dependencies on the maintainer's own machine (or a
throwaway venv/container) — never add them to the repo's runtime
dependencies or a CI-installed devDependency, since that would risk them
accidentally being wired into an automated path later.

## What to probe

Mirror `tests/fixtures/injectionCorpus.json`'s categories, but push past what
a fixed corpus can express — try live variations, multi-turn setups, and
encoding tricks:

1. **Display-name / push-name injection** — set a hostile Discord
   nickname/WhatsApp push name (the class fixed by issue #227's display-name
   quarantine escape) and see whether *creative* variants (unicode
   look-alikes for `<`/`>`, zero-width characters, RTL overrides) still slip
   through `sanitizeDisplayName` (`src/agent/systemPrompt.ts`).
2. **Recalled-content / memory injection** — seed a conversation with
   messages designed to be recalled later (`remember_search`, automatic
   recall) that try to redirect a *future* turn's behaviour.
3. **Knowledge poisoning** — as an admin, try to get `save_knowledge` to
   accept an entry that reads as a fake system directive, then check whether
   a later member turn treats a `knowledge_search` hit as an instruction
   rather than reference material.
4. **CONFIRM-flow social engineering** — try to get the model itself to
   perform a destructive action (kick/timeout/purge/`grant_admin`/
   `redeploy_bot`) without the human CONFIRM round-trip, or to convince a
   lower tier it already has a higher tier's permissions.
5. **Outbound exfiltration** — try to get a genuine `sk-`/`gh`/DB-URL-shaped
   secret (or a live one, in a disposable test environment only) into a
   reply, and separately try em-dash/markdown/code-policy bypass phrasings
   against `filterOutbound`.
6. **Multi-turn escalation (PyRIT)** — build trust across several turns
   before making the privileged ask, since a single-turn probe undersells how
   a patient adversary actually operates.

## Cadence

- Run a sweep **on a schedule** (suggested: monthly) and **before any
  notable prompt or tool change** — new personas, new tools, edits to
  `src/agent/systemPrompt.ts`/`src/agent/tools.ts`/`src/agent/outbound.ts`.
- A sweep is a few hours of a maintainer's own time and their own Max-pool
  budget; there's no expectation of running it continuously.

## Feeding findings back into the deterministic gate

When a sweep finds a phrasing that gets further than it should (the model
acts on it, or — more subtly — the deterministic construction functions fail
to neutralise it structurally):

1. Distil the *minimal* reproducing string (strip anything sweep-specific
   like session IDs) and add it to the matching array in
   `tests/fixtures/injectionCorpus.json`.
2. Run `npm test` — if the new entry exposes an actual code defect (not just
   "the model complied," which the deterministic gate structurally can't
   prevent on its own — see `docs/SECURITY.md`'s "Residual risks"), fix it
   in the same PR as the corpus addition so `test:security` never merges red.
3. Bump the affected file's entry in `tests/security-floor.json` in the same
   diff (or run `npm run test:security:fix` to regenerate it).

This keeps the discovery loop (this document) feeding the regression gate
(`tests/injectionCorpus.test.ts`) without either one paying the other's cost.
