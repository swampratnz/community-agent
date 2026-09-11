import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `human-merge-ready` must not outlive the claim it makes
 * (.github/workflows/pipeline-pr-automerge.yml).
 *
 * The label ships with a comment reading "a maintainer just needs to press
 * merge". That is a statement about the PR's CURRENT state, and every input to
 * it can flip back: main advances and the PR goes CONFLICTING, a push turns CI
 * red, a new commit staledates the LGTM. PR #1382 carried the label for 22
 * hours while actually CONFLICTING — the button it promised did not exist. A
 * signal that was true once and is never re-checked is the same class of defect
 * as the CI wedge in #1348, which is the whole reason this repo now has a
 * groundskeeper sweep.
 *
 * The guard here is the `has_ready` jq (which decides whether there is anything
 * to revoke) EXTRACTED FROM THE WORKFLOW and run through real `jq`, plus two
 * structural properties of the escalation block that a string match alone would
 * not establish:
 *
 *   1. every gate that can invalidate readiness revokes before it `continue`s;
 *   2. the label add is NOT inside the marker-gated branch — after a revocation
 *      the marker comment still exists, so a marker-gated add could never
 *      restore the label, which would turn this fix into a one-way delete.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW = path.join(repoRoot, '.github/workflows/pipeline-pr-automerge.yml');
const yaml = readFileSync(WORKFLOW, 'utf8');

const jqAvailable = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = jqAvailable ? false : 'jq not installed — the workflow itself requires it on the runner';

/** Slice a single-quoted jq program out of the workflow's shell. */
function extractJq(startMarker: string, endMarker: string): string {
  const from = yaml.indexOf(startMarker);
  assert.notEqual(from, -1, `start marker not found — workflow restructured?\n  ${startMarker}`);
  const bodyStart = from + startMarker.length;
  const to = yaml.indexOf(endMarker, bodyStart);
  assert.notEqual(to, -1, `end marker not found after start — workflow restructured?\n  ${endMarker}`);
  return yaml.slice(bodyStart, to);
}

const HAS_READY_JQ = extractJq(`has_ready="$(jq -r '`, `' <<<"$struct")"`);

function runJq(program: string, input: unknown): string {
  const res = spawnSync('jq', ['-r', program], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(res.status, 0, `jq failed: ${res.stderr}`);
  return res.stdout.trim();
}

const labelled = (...names: string[]) => ({ labels: names.map((name) => ({ name })) });

test(
  'SECURITY: the auto-merge loop detects an existing human-merge-ready label, so it has something to revoke',
  { skip },
  () => {
    assert.equal(runJq(HAS_READY_JQ, labelled('human-merge-ready')), 'true');
    assert.equal(runJq(HAS_READY_JQ, labelled('dependencies', 'human-merge-ready')), 'true');
    // No label, nothing to revoke — revoke_ready must be a no-op so an ordinary
    // PR never eats a pointless `gh pr edit` call on every gate it fails.
    assert.equal(runJq(HAS_READY_JQ, labelled()), 'false');
    assert.equal(runJq(HAS_READY_JQ, labelled('dependencies')), 'false');
    // Must not be satisfied by a merely similar label.
    assert.equal(runJq(HAS_READY_JQ, labelled('human-merge-ready-soon')), 'false');
    assert.equal(runJq(HAS_READY_JQ, labelled('needs-human')), 'false');
  },
);

/**
 * Every gate that can flip from pass to fail after the label was applied. If a
 * new gate is added to the loop without a revocation, the label can once again
 * outlive its claim — which is exactly what #1382 did.
 */
const INVALIDATING_GATES: Array<{ skipLine: string; why: string }> = [
  {
    skipLine: 'mergeable=$mergeable (conflicting or still unknown)',
    why: 'the PR went CONFLICTING (this is #1382)',
  },
  { skipLine: 'not all checks are green yet', why: 'a push turned CI red' },
  { skipLine: 'no automated review verdict yet', why: 'the verdict disappeared' },
  { skipLine: 'not an LGTM approval — skip', why: 'the verdict flipped to CHANGES_REQUESTED' },
  { skipLine: 'predates the current head commit', why: 'a later push staledated the LGTM' },
  { skipLine: 'a stop label (needs-human/no-auto-merge) appeared', why: 'a human pinned it out' },
];

test('SECURITY: every gate that can invalidate readiness revokes the label before skipping', () => {
  for (const gate of INVALIDATING_GATES) {
    const at = yaml.indexOf(gate.skipLine);
    assert.notEqual(at, -1, `gate not found — workflow restructured?\n  ${gate.skipLine}`);
    // The revoke must sit between this gate's own log line and the `continue`
    // that leaves the PR behind, not merely somewhere in the file.
    const tail = yaml.slice(at);
    const untilContinue = tail.slice(0, tail.indexOf('continue'));
    assert.match(
      untilContinue,
      /revoke_ready /,
      `the "${gate.why}" gate skips without revoking human-merge-ready — the label would keep promising a merge button that is not there`,
    );
  }
});

test('the label add is re-asserted every qualifying tick, not gated on the one-per-PR comment marker', () => {
  // After a revocation the marker comment still exists. If the add stayed
  // inside the `already_flagged` branch the label could never come back, and
  // revoking would silently become a one-way delete.
  const block = yaml.slice(yaml.indexOf('already_flagged="$('));
  const addAt = block.indexOf('--add-label human-merge-ready');
  const gateAt = block.indexOf(`if [ "$already_flagged" != 'true' ]`);
  assert.notEqual(addAt, -1, 'the label add was not found in the escalation block');
  assert.notEqual(gateAt, -1, 'the already_flagged gate was not found');
  assert.ok(
    addAt < gateAt,
    'the human-merge-ready add must come BEFORE the already_flagged gate, or a revoked label can never be restored',
  );
  // The comment, by contrast, must stay inside the gate — one per PR.
  const commentAt = block.indexOf('gh pr comment');
  assert.ok(
    commentAt > gateAt,
    'the explanatory comment must stay marker-gated so it is posted at most once',
  );
});
