import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * scripts/pipeline-outcomes.mjs — the pipeline's self-measurement (see the
 * script header). It reconstructs each loop's outcomes from the marker
 * comments the loops already post, so these tests pin the counting rules
 * against synthetic PR payloads rather than live GitHub data.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/pipeline-outcomes.mjs', import.meta.url));

const recent = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
const ancient = () => new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

function run(prs: unknown, args: string[] = []): string {
  const result = spawnSync('node', [SCRIPT, ...args], {
    input: JSON.stringify(prs),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `script exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

const pr = (number: number, bodies: string[], createdAt = recent(), login = 'github-actions[bot]') => ({
  number,
  title: `PR ${number}`,
  url: `https://example.invalid/${number}`,
  comments: bodies.map((body) => ({ body, createdAt, author: { login } })),
});

test('pipeline-outcomes reports nothing when no loop engaged', () => {
  const out = run([pr(1, ['just a normal human comment'])]);
  assert.match(out, /No pipeline loop engaged/);
});

test('pipeline-outcomes counts an engagement, a checkpoint recovery and an escalation per loop', () => {
  const out = run([
    pr(10, ['<!-- pipeline-autofix-attempt -->\nattempt 1']),
    pr(11, [
      '<!-- pipeline-autofix-attempt -->\nattempt 1',
      '<!-- pipeline-autofix-escalation -->\ngiving up',
    ]),
    pr(12, [
      '<!-- pipeline-pr-revise-attempt -->\nattempt 1',
      '<!-- pipeline-pr-revise-checkpoint -->\nrecovered work',
    ]),
  ]);
  // Columns: Engaged | Recovered | Escalated | Routed | Clean.
  assert.match(out, /\| autofix \| 2 \| 0 \(0%\) \| 1 \(50%\) \| 0 \(0%\) \| 1 \(50%\) \|/);
  assert.match(out, /\| revise \| 1 \| 1 \(100%\) \| 0 \(0%\) \| 0 \(0%\) \| 0 \(0%\) \|/);
});

test('pipeline-outcomes lists the PRs where a loop did not finish, newest first', () => {
  const out = run([
    pr(20, ['<!-- pipeline-autofix-attempt -->', '<!-- pipeline-autofix-escalation -->']),
    pr(30, ['<!-- pipeline-pr-conflict-checkpoint -->']),
    pr(25, ['<!-- pipeline-autofix-attempt -->']),
  ]);
  const section = out.slice(out.indexOf('### PRs where a loop did not finish'));
  assert.match(section, /- #30 — \*\*conflict-resolver\*\* checkpoint-recovered 1×/);
  assert.match(section, /- #20 — \*\*autofix\*\* escalated 1×/);
  assert.doesNotMatch(section, /#25/, 'a clean engagement is not "did not finish"');
  assert.ok(
    section.indexOf('#30') < section.indexOf('#20'),
    'notable PRs are listed newest (highest number) first',
  );
});

test('pipeline-outcomes ignores markers outside the window', () => {
  const out = run([pr(40, ['<!-- pipeline-autofix-attempt -->'], ancient())]);
  assert.match(out, /No pipeline loop engaged/);
});

test('pipeline-outcomes honours --window-days', () => {
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const payload = [pr(50, ['<!-- pipeline-autofix-attempt -->'], eightDaysAgo)];
  assert.match(run(payload, ['--window-days', '14']), /\| autofix \| 1 \|/);
  assert.match(run(payload, ['--window-days', '3']), /No pipeline loop engaged/);
});

test('pipeline-outcomes counts a loop that escalated without an attempt marker as still having engaged', () => {
  // The conflict resolver's escalation and checkpoint markers predate its
  // attempt marker, so an escalation-only PR must not report "0 engaged, 1
  // escalated" (which would render a nonsensical rate).
  const out = run([pr(60, ['<!-- pipeline-pr-conflict-escalation -->\nunresolvable'])]);
  assert.match(out, /\| conflict-resolver \| 1 \| 0 \(0%\) \| 1 \(100%\) \| 0 \(0%\) \| 0 \(0%\) \|/);
});

test('pipeline-outcomes treats an auto-merge blocked notice as a genuine escalation', () => {
  // `pipeline-automerge-blocked` means branch protection REFUSED the merge —
  // the loop wanted to merge and could not. That is real friction, unlike the
  // governance routing below.
  const out = run([pr(70, ['<!-- pipeline-automerge-blocked -->\ncould not merge'])]);
  assert.match(out, /\| auto-merge \| 1 \| 0 \(0%\) \| 1 \(100%\) \| 0 \(0%\) \| 0 \(0%\) \|/);
  assert.match(out, /### PRs where a loop did not finish/, 'a blocked merge is worth a human glance');
});

test('a governance routing counts as Routed, never as Escalated', () => {
  // `pipeline-automerge-human-ready` is auto-merge meeting a governance-path PR
  // and handing it to a person exactly as policy requires. Counting it as an
  // escalation made the loop read "80% escalated" when it was succeeding.
  const out = run([pr(71, ['<!-- pipeline-automerge-human-ready -->\nplease merge'])]);
  assert.match(out, /\| auto-merge \| 1 \| 0 \(0%\) \| 0 \(0%\) \| 1 \(100%\) \| 0 \(0%\) \|/);
});

test('a window whose ONLY auto-merge outcome is a governance routing has no "did not finish" section, so the tracking issue can close', () => {
  // pipeline-outcomes.yml opens/refreshes the tracking issue only when the
  // report contains that heading, and closes it otherwise. While routings were
  // listed there, #777 could never close and the genuine recoveries were
  // buried under by-design rows.
  const out = run([
    pr(72, ['<!-- pipeline-automerge-human-ready -->']),
    pr(73, ['<!-- pipeline-automerge-human-ready -->']),
  ]);
  assert.match(out, /\| auto-merge \| 2 \| 0 \(0%\) \| 0 \(0%\) \| 2 \(100%\) \| 0 \(0%\) \|/);
  assert.doesNotMatch(
    out,
    /### PRs where a loop did not finish/,
    'a by-design routing must not pin the tracking issue open',
  );
});

test('a routed engagement still appears in the ledger alongside a real failure on another PR', () => {
  const out = run([
    pr(74, ['<!-- pipeline-automerge-human-ready -->']),
    pr(75, ['<!-- pipeline-automerge-blocked -->']),
  ]);
  assert.match(out, /\| auto-merge \| 2 \| 0 \(0%\) \| 1 \(50%\) \| 1 \(50%\) \| 0 \(0%\) \|/);
  const section = out.slice(out.indexOf('### PRs where a loop did not finish'));
  assert.match(section, /#75/, 'the genuinely blocked merge is listed');
  assert.doesNotMatch(section, /#74/, 'the by-design routing is not');
});

test('Clean counts a genuinely clean PR even when a SIBLING PR of the same loop both recovered and escalated (issue #750 review)', () => {
  // Regression: Clean used to be derived by subtracting loop totals
  // (engaged - recovered - escalated). Because the two failure kinds overlap
  // on a single engagement, a #609-style attempt+checkpoint+escalation PR
  // subtracted TWICE and cancelled out the clean engagement on an unrelated
  // PR of the same loop — reporting "0 clean" when one genuinely clean run
  // existed, which is precisely the signal this report exists to give.
  const out = run([
    pr(1, ['<!-- pipeline-pr-conflict-attempt -->']),
    pr(2, [
      '<!-- pipeline-pr-conflict-attempt -->',
      '<!-- pipeline-pr-conflict-checkpoint -->',
      '<!-- pipeline-pr-conflict-escalation -->',
    ]),
  ]);
  assert.match(
    out,
    /\| conflict-resolver \| 2 \| 1 \(50%\) \| 1 \(50%\) \| 0 \(0%\) \| 1 \(50%\) \|/,
    'the clean engagement on PR #1 must survive the double failure on PR #2',
  );
});

test('a single engagement that both recovered and escalated counts as ONE failed engagement, not two', () => {
  const out = run([
    pr(3, [
      '<!-- pipeline-autofix-attempt -->',
      '<!-- pipeline-autofix-checkpoint -->',
      '<!-- pipeline-autofix-escalation -->',
    ]),
  ]);
  assert.match(out, /\| autofix \| 1 \| 1 \(100%\) \| 1 \(100%\) \| 0 \(0%\) \| 0 \(0%\) \|/);
});

test('pipeline-outcomes falls back to the default window when --window-days is non-numeric, instead of reporting "NaN days" and matching nothing (issue #750 review)', () => {
  const out = run([pr(90, ['<!-- pipeline-autofix-attempt -->'])], ['--window-days', 'not-a-number']);
  assert.doesNotMatch(out, /NaN/, 'a bad window must never render as "last NaN days"');
  assert.match(out, /last 14 days/, 'it falls back to the documented default');
  assert.match(out, /\| autofix \| 1 \|/, 'and still counts in-window markers');
});

test('pipeline-outcomes survives malformed input rather than failing the workflow', () => {
  const result = spawnSync('node', [SCRIPT], { input: 'not json at all', encoding: 'utf8' });
  assert.equal(result.status, 0, 'a bad pipe must never fail the caller');
  assert.match(result.stderr, /expected an array/);
});

test('SECURITY: a marker posted by anyone other than the pipeline bots is ignored, so a commenter cannot skew the ledger or manufacture a clean window (issue #750 review)', () => {
  const spoofed = run([pr(100, ['<!-- pipeline-autofix-escalation -->'], recent(), 'random-user')]);
  assert.match(
    spoofed,
    /No pipeline loop engaged/,
    'a hand-written marker from an arbitrary commenter must contribute nothing',
  );
});

test('both gh renderings of the marker-posting identity are accepted, so the identity gate never silently matches nothing', () => {
  // GraphQL renders "github-actions", REST renders "github-actions[bot]";
  // matching only one is how an identity gate ends up matching nothing at all.
  for (const login of ['github-actions', 'github-actions[bot]']) {
    const out = run([pr(101, ['<!-- pipeline-autofix-attempt -->'], recent(), login)]);
    assert.match(out, /\| autofix \| 1 \|/, `${login} must be recognised as a pipeline author`);
  }
});

test('SECURITY: a marker posted as claude[bot] is ignored — the revise agent uniquely holds `gh pr comment`, runs under that identity, and reads prompt-injectable PR content, so a marker from it is never authentic (issue #750 review)', () => {
  // Every real marker is written by a DETERMINISTIC step using GITHUB_TOKEN,
  // so it always lands as github-actions. Counting claude[bot] would let a
  // prompt-injected revise agent fabricate ledger rows — worse than no gate,
  // because the gate implies the rows can be trusted.
  for (const login of ['claude', 'claude[bot]']) {
    const out = run([
      pr(
        102,
        ['<!-- pipeline-pr-revise-escalation -->', '<!-- pipeline-pr-revise-checkpoint -->'],
        recent(),
        login,
      ),
    ]);
    assert.match(
      out,
      /No pipeline loop engaged/,
      `a marker attributed to ${login} must contribute nothing to the ledger`,
    );
  }
});

test('pipeline-outcomes tolerates PRs with no comments field at all', () => {
  const out = run([{ number: 80, title: 'no comments key' }]);
  assert.match(out, /No pipeline loop engaged/);
});
