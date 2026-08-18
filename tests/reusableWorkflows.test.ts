import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The reusable workflows (.github/workflows/reusable-*.yml) and their callers.
 *
 * `ci-retry.yml` and `pipeline-build-retry.yml` were the same mechanism with
 * different caps, and `branch-janitor.yml` carried a sweep whose body knew
 * nothing about this repo; all three now call a `workflow_call` workflow and
 * keep only their trigger, gating and parameters. That split is worth pinning
 * because two of its invariants are silent when broken:
 *
 *   1. THE ATTEMPT CAP IS WRITTEN TWICE — once in the caller's job `if:`
 *      (`run_attempt < N`, the cheap gate that claims no runner) and once as
 *      `max-attempts: N` (the backstop inside the reusable workflow). GitHub
 *      cannot express the `if:` inside a reusable workflow, because triggers
 *      and their payload conditions belong to the caller, so the duplication
 *      is structural. If the two drift, the loop either retries past its cap
 *      or refuses a retry it should make — neither fails loudly.
 *   2. THE DRY-RUN MAPPING deletes branches when it is wrong, and the failure
 *      is invisible until refs are gone. The weekly cron supplies no inputs,
 *      so `inputs.dry_run` renders empty on that path and the caller must map
 *      it to an explicit literal.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflow = (name: string) => readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8');

const RERUN = './.github/workflows/reusable-rerun-failed-run.yml';
const JANITOR = './.github/workflows/reusable-branch-janitor.yml';

/** Declared `workflow_call` input names of a reusable workflow. */
function declaredInputs(source: string): Set<string> {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'inputs:');
  assert.notEqual(start, -1, 'no `inputs:` block');
  const names = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^ {6}([a-z0-9-]+):\s*$/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

/** Required input names of a reusable workflow. */
function requiredInputs(source: string): Set<string> {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'inputs:');
  const names = new Set<string>();
  let current = '';
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const head = /^ {6}([a-z0-9-]+):\s*$/.exec(line);
    if (head) current = head[1];
    else if (/^ {8}required:\s*true\s*$/.test(line) && current) names.add(current);
  }
  return names;
}

/** The `with:` keys a caller passes at its `uses:` of a reusable workflow. */
function withKeys(source: string, usesRef: string): string[] {
  const lines = source.split('\n');
  const at = lines.findIndex((line) => line.trim() === `uses: ${usesRef}`);
  assert.notEqual(at, -1, `no caller job uses ${usesRef}`);
  const keys: string[] = [];
  let seenWith = false;
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === 'with:') {
      seenWith = true;
      continue;
    }
    if (!seenWith) continue;
    if (/^\s{0,4}\S/.test(line)) break;
    const match = /^\s{6}([a-z0-9-]+):/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/** The numeric bound in a caller's `run_attempt < N` gate. */
function attemptGate(source: string): number {
  const match = /run_attempt\s*<\s*(\d+)/.exec(source);
  assert.ok(match, 'no `run_attempt < N` gate found in the caller');
  return Number(match[1]);
}

/** The `max-attempts:` literal the caller passes. */
function maxAttempts(source: string): number {
  const match = /max-attempts:\s*(\d+)/.exec(source);
  assert.ok(match, 'no `max-attempts:` passed by the caller');
  return Number(match[1]);
}

const CALLERS = [
  { name: 'ci-retry.yml', ref: RERUN, reusable: 'reusable-rerun-failed-run.yml' },
  { name: 'pipeline-build-retry.yml', ref: RERUN, reusable: 'reusable-rerun-failed-run.yml' },
  { name: 'branch-janitor.yml', ref: JANITOR, reusable: 'reusable-branch-janitor.yml' },
] as const;

test('each caller delegates to its reusable workflow and keeps no inline implementation', () => {
  for (const { name, ref } of CALLERS) {
    const source = workflow(name);
    assert.ok(source.includes(`uses: ${ref}`), `${name} does not call ${ref}`);
    assert.equal(
      /^\s+run: \|/m.test(source),
      false,
      `${name} still carries an inline run block — the implementation belongs to the reusable workflow`,
    );
  }
});

test('every `with:` key a caller passes is a declared input of the reusable workflow', () => {
  // Unlike a composite action (which ignores unknown keys silently), a
  // reusable workflow REJECTS an undeclared input at run time — which for
  // these loops means discovering it only when CI has already gone red.
  for (const { name, ref, reusable } of CALLERS) {
    const declared = declaredInputs(workflow(reusable));
    for (const key of withKeys(workflow(name), ref)) {
      assert.ok(declared.has(key), `${name} passes \`${key}\`, which ${reusable} does not declare`);
    }
  }
});

test('every required input of a reusable workflow is passed by its callers', () => {
  for (const { name, ref, reusable } of CALLERS) {
    const required = requiredInputs(workflow(reusable));
    const passed = withKeys(workflow(name), ref);
    for (const key of required) {
      assert.ok(passed.includes(key), `${name} omits required input \`${key}\` of ${reusable}`);
    }
  }
});

test("SECURITY: the attempt cap in a caller's gate equals the max-attempts it passes", () => {
  // The cap is deliberately written twice (see the file header). Drift is
  // silent: too high and a loop retries past its bound, burning runs and — for
  // the build worker — delaying the needs-human escalation that a human is
  // waiting on; too low and a retry that should happen never does.
  for (const name of ['ci-retry.yml', 'pipeline-build-retry.yml']) {
    const source = workflow(name);
    assert.equal(
      attemptGate(source),
      maxAttempts(source),
      `${name}: the \`run_attempt < N\` gate and \`max-attempts\` disagree`,
    );
  }
});

test('the build-retry cap stays in sync with the build worker it re-runs', () => {
  // pipeline-build.yml escalates `needs-human` on its FINAL attempt, keyed to
  // the same number. If the retry loop's cap exceeds it, the issue is
  // escalated while retries are still running.
  const build = workflow('pipeline-build.yml');
  const cap = maxAttempts(workflow('pipeline-build-retry.yml'));
  assert.ok(
    new RegExp(`>=\\s*${cap}\\b`).test(build),
    `pipeline-build.yml has no \`>= ${cap}\` final-attempt check matching the retry cap`,
  );
});

test('SECURITY: the branch janitor never hands its sweep an ambiguous dry-run value', () => {
  // The weekly cron supplies NO inputs, so `inputs.dry_run` renders empty on
  // that path — the dispatch default does not apply. Passed bare, the reusable
  // workflow's "anything but 'true' is live" rule would read that empty string
  // as a live sweep: right today, but by accident. The caller must map every
  // path to an explicit literal.
  const caller = workflow('branch-janitor.yml');
  assert.match(
    caller,
    /dry-run:\s*\$\{\{\s*inputs\.dry_run\s*\|\|\s*'false'\s*\}\}/,
    'branch-janitor.yml must map dry_run to an explicit literal for the scheduled path',
  );
  // And the reusable workflow's own default must be the SAFE one, so an
  // omitted input can never delete.
  const reusable = workflow('reusable-branch-janitor.yml');
  const block = reusable.slice(reusable.indexOf('dry-run:'));
  assert.match(
    block.slice(0, block.indexOf('extra-branches:')),
    /default:\s*'true'/,
    "reusable-branch-janitor.yml's dry-run default must be 'true' (dry) so an omitted input never deletes",
  );
});

test('the reusable workflows carry no reference to this repository', () => {
  // The point of tier A: the bodies are portable. `github.repository` resolves
  // to whichever repo calls them, so a hardcoded owner/repo would be a bug.
  for (const name of ['reusable-rerun-failed-run.yml', 'reusable-branch-janitor.yml']) {
    const source = workflow(name);
    const body = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    assert.equal(
      /swampratnz|community-agent/.test(body),
      false,
      `${name} names this repository outside a comment — it must stay repo-agnostic`,
    );
  }
});
