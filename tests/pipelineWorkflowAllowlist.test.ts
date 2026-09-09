import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression guard for issue #1305 / security review #1290.
//
// The `Bash(...)` allowlist matcher pins a command PREFIX and nothing more —
// it cannot constrain a trailing argument. So `Bash(gh issue comment:*)` does
// not authorise "comment on the issue this run is for"; it authorises
// `gh issue comment <ANY number>`, under the trusted bot identity, which is a
// working social-engineering primitive against maintainers reading pipeline
// comments. changelog-autofill.yml documents exactly this reasoning for
// withholding the grant, and autofix/conflict-resolver already keep `gh`
// read-only; the build and revise loops were the two outliers.
//
// Both now write a note FILE that a deterministic step posts, pinned to the
// workflow's own $ISSUE_NUMBER/$PR_NUMBER. These assertions exist so a future
// edit cannot quietly hand either grant back — the reason this is a `SECURITY:`
// test and not a comment.
function workflow(name: string): string {
  const path = new URL(`../.github/workflows/${name}`, import.meta.url);
  const source = readFileSync(path, 'utf8');
  // Positive control: a renamed/moved workflow must redden here rather than
  // let the absence-assertions below pass vacuously.
  assert.ok(
    source.includes('--allowedTools'),
    `${name} must still contain an --allowedTools grant list — if this moved, re-point this test rather than deleting it`,
  );
  return source;
}

/**
 * Just the `--allowedTools "…"` values — what is actually GRANTED. Scoped
 * deliberately: the surrounding prose explains why these grants were removed
 * and has to be free to name them, so a whole-file substring search would
 * forbid documenting the very fix it guards.
 */
function grantedTools(name: string): string {
  const matches = [...workflow(name).matchAll(/--allowedTools\s+"([^"]*)"/g)].map((m) => m[1] ?? '');
  assert.notEqual(matches.length, 0, `${name} must have at least one --allowedTools "..." value to check`);
  return matches.join('\n');
}

test('SECURITY: the build worker holds no gh issue comment grant — it writes blocker.md/needs-human.md and a deterministic step posts them (issue #1305)', () => {
  assert.equal(
    grantedTools('pipeline-build.yml').includes('Bash(gh issue comment'),
    false,
    'pipeline-build.yml must not grant the agent gh issue comment: the Bash matcher cannot pin the ' +
      'trailing issue number, so the grant reaches ANY issue. Post from a deterministic step using ' +
      'the workflow-resolved ${ISSUE_NUMBER} instead.',
  );
});

test('SECURITY: the revise worker holds no gh pr comment grant — it writes refusal.md and a deterministic step posts it (issue #1305)', () => {
  assert.equal(
    grantedTools('pipeline-pr-revise.yml').includes('Bash(gh pr comment'),
    false,
    'pipeline-pr-revise.yml must not grant the agent gh pr comment: the Bash matcher cannot pin the ' +
      'trailing PR number, so the grant reaches ANY pr/issue. Post from a deterministic step using ' +
      'the workflow-resolved ${PR_NUMBER} instead.',
  );
});

test('SECURITY: both loops still post the agent’s explanation deterministically — removing the grant must not have removed the trace (issue #1305)', () => {
  // The grant existed for a real reason: a run that ends without a PR/push has
  // to explain itself, or a maintainer reverse-engineers it from run logs
  // (#251). Deleting the grant outright would have regressed that, so these
  // pin the replacement path rather than just the absence.
  const build = workflow('pipeline-build.yml');
  assert.match(
    build,
    /blocker\.md/,
    'pipeline-build.yml must still read blocker.md — the agent needs some way to explain a gate it could not get green',
  );
  assert.match(
    build,
    /gh issue comment "\$\{ISSUE_NUMBER\}"/,
    'the deterministic post step must target the workflow-resolved ${ISSUE_NUMBER}, never agent-chosen text',
  );

  const revise = workflow('pipeline-pr-revise.yml');
  assert.match(
    revise,
    /refusal\.md/,
    'pipeline-pr-revise.yml must still read refusal.md — the agent needs some way to explain a principled refusal',
  );
  assert.match(
    revise,
    /gh pr comment "\$\{PR_NUMBER\}"/,
    'the deterministic post step must target the workflow-resolved ${PR_NUMBER}, never agent-chosen text',
  );
});
