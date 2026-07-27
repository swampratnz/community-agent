import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The review-verdict artifact contract (issue #731 follow-up).
 *
 * Three workflows consume a PR-review verdict: the review worker routes on it,
 * the auto-merge loop gates on it, and the revise worker re-verifies it. Each
 * used to parse the SAME free prose with its OWN regex, and they drifted: the
 * #731 fix (a bolded `**Changes requested**` is not a markdown bullet) landed
 * in review + revise but NOT in auto-merge, so a bolded `**LGTM**` stayed
 * invisible to the merge gate and a fully-approved PR would sit forever.
 *
 * The fix is a contract rather than a better regex. The review workflow — the
 * one place that composes the comment — normalises the verdict into a single
 * canonical HTML-comment token on line 2, and every consumer reads THAT.
 * These tests pin both halves: the shared shell helpers must stay identical
 * across all three workflows, and their behaviour must survive the formatting
 * variations a model actually produces.
 */

const workflow = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)), 'utf8');

const CONSUMERS = ['pipeline-pr-review.yml', 'pipeline-pr-automerge.yml', 'pipeline-pr-revise.yml'] as const;

/**
 * Pull a shell function body out of a workflow file and strip the YAML block
 * indentation, so the three copies can be compared regardless of how deeply
 * each one is nested in its own job/step.
 */
function extractFn(source: string, fnName: string): string {
  const lines = source.split('\n');
  const startIndex = lines.findIndex((line) => line.trim().startsWith(`${fnName}() {`));
  assert.notEqual(startIndex, -1, `${fnName} not found`);
  const body: string[] = [];
  for (const line of lines.slice(startIndex)) {
    body.push(line.trim());
    if (line.trim() === '}') return body.join('\n');
  }
  assert.fail(`${fnName} has no closing brace`);
}

/** Run a snippet against a body on stdin and return trimmed stdout. */
function runShell(snippet: string, body: string): string {
  const result = spawnSync('bash', ['-c', snippet], { input: body, encoding: 'utf8' });
  assert.equal(result.status, 0, `shell exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim();
}

const CANONICAL_FN = extractFn(workflow('pipeline-pr-review.yml'), 'canonical_verdict');
const LEGACY_FN = extractFn(workflow('pipeline-pr-review.yml'), 'legacy_verdict');

test('SECURITY: the canonical_verdict helper is byte-identical across all three verdict consumers — the drift that made a bolded LGTM invisible to auto-merge cannot recur silently (issue #731 follow-up)', () => {
  for (const name of CONSUMERS) {
    assert.equal(
      extractFn(workflow(name), 'canonical_verdict'),
      CANONICAL_FN,
      `${name}'s canonical_verdict has drifted from pipeline-pr-review.yml's`,
    );
  }
});

test('SECURITY: the legacy_verdict prose fallback is byte-identical across all three verdict consumers, including the #731 bullet-filter fix (a bolded verdict is not a bullet)', () => {
  assert.match(
    LEGACY_FN,
    /\[-\*\]\[\[:space:\]\]/,
    'the fallback must require whitespace after the bullet marker, else a bolded **verdict** is eaten (issue #731)',
  );
  for (const name of CONSUMERS) {
    assert.equal(
      extractFn(workflow(name), 'legacy_verdict'),
      LEGACY_FN,
      `${name}'s legacy_verdict has drifted from pipeline-pr-review.yml's`,
    );
  }
});

const TOKEN_CASES: Array<{ name: string; body: string; expect: string }> = [
  {
    name: 'a plain token',
    body: 'PR review (automated):\n<!-- verdict:LGTM -->\nLGTM, looks good\n',
    expect: 'LGTM',
  },
  {
    name: 'changes requested',
    body: 'PR review (automated):\n<!-- verdict:CHANGES_REQUESTED -->\n**Changes requested**\n',
    expect: 'CHANGES_REQUESTED',
  },
  {
    name: 'needs human',
    body: 'PR review (automated):\n<!-- verdict:NEEDS_HUMAN -->\nNeeds a human decision\n',
    expect: 'NEEDS_HUMAN',
  },
  {
    name: 'lowercase/extra-space token (model formatting drift)',
    body: 'PR review (automated):\n<!--   verdict:lgtm   -->\n',
    expect: 'LGTM',
  },
  {
    name: 'no token at all (pre-contract comment)',
    body: 'PR review (automated):\nLGTM, looks good and ready for a human to merge\n',
    expect: '',
  },
];

for (const testCase of TOKEN_CASES) {
  test(`canonical_verdict extracts ${testCase.name}`, () => {
    assert.equal(runShell(`${CANONICAL_FN}\ncanonical_verdict`, testCase.body), testCase.expect);
  });
}

test('SECURITY: canonical_verdict takes the FIRST token, so a decoy token quoted later in a review body cannot override the authoritative one the review workflow injects on line 2', () => {
  const body = [
    'PR review (automated):',
    '<!-- verdict:CHANGES_REQUESTED -->',
    '**Changes requested**',
    '',
    '- The workflow should emit `<!-- verdict:LGTM -->` here; it does not.',
  ].join('\n');
  assert.equal(
    runShell(`${CANONICAL_FN}\ncanonical_verdict`, body),
    'CHANGES_REQUESTED',
    'a review that legitimately QUOTES a token (reviews of this very machinery do) must not flip its own verdict',
  );
});

test('SECURITY: the legacy prose fallback reads a BOLDED verdict — the exact case that silently stalled auto-merge before this contract (issue #731)', () => {
  const bolded =
    'PR review (automated):\n\n**LGTM, looks good and ready for a human to merge**\n\nNo issues found.\n';
  const extracted = runShell(`${LEGACY_FN}\nlegacy_verdict`, bolded);
  assert.match(
    extracted,
    /LGTM/i,
    'a bolded LGTM must survive the bullet filter, or a fully-approved PR never auto-merges',
  );

  const boldedChanges = 'PR review (automated):\n\n**Changes requested**\n\n- a finding\n';
  assert.match(runShell(`${LEGACY_FN}\nlegacy_verdict`, boldedChanges), /Changes requested/i);
});

test('SECURITY: the legacy prose fallback still drops real bullet lines, so a finding that mentions a verdict phrase cannot misroute the PR (issue #222)', () => {
  const body = [
    'PR review (automated):',
    'LGTM, looks good and ready for a human to merge',
    '',
    '- the previous changes requested were addressed',
  ].join('\n');
  const extracted = runShell(`${LEGACY_FN}\nlegacy_verdict`, body);
  assert.doesNotMatch(
    extracted,
    /changes requested/i,
    'a finding bullet must never be read as the verdict — that spins up the reviser to find nothing',
  );
});

test('every review-verdict consumer prefers the canonical token and keeps the prose fallback for pre-contract comments', () => {
  for (const name of CONSUMERS) {
    const source = workflow(name);
    assert.match(source, /canonical_verdict/, `${name} must read the canonical token`);
    assert.match(source, /legacy_verdict/, `${name} must keep the pre-contract prose fallback`);
  }
});

test('the review worker instructs the model to emit the canonical token, and injects one deterministically regardless', () => {
  const source = workflow('pipeline-pr-review.yml');
  assert.match(source, /<!-- verdict:LGTM -->/, 'the prompt must show the model the exact token format');
  assert.match(
    source,
    /VERDICT_TOKEN/,
    'the post step must inject the authoritative token rather than trusting the model to have emitted one',
  );
});
