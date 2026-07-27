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

const pr = (number: number, bodies: string[], createdAt = recent()) => ({
  number,
  title: `PR ${number}`,
  url: `https://example.invalid/${number}`,
  comments: bodies.map((body) => ({ body, createdAt })),
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
  assert.match(out, /\| autofix \| 2 \| 0 \(0%\) \| 1 \(50%\) \| 1 \(50%\) \|/);
  assert.match(out, /\| revise \| 1 \| 1 \(100%\) \| 0 \(0%\) \| 0 \(0%\) \|/);
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
  assert.match(out, /\| conflict-resolver \| 1 \| 0 \(0%\) \| 1 \(100%\) \| 0 \(0%\) \|/);
});

test('pipeline-outcomes treats an auto-merge blocked notice as friction worth reporting', () => {
  const out = run([pr(70, ['<!-- pipeline-automerge-blocked -->\ncould not merge'])]);
  assert.match(out, /\| auto-merge \| 1 \|/);
});

test('pipeline-outcomes survives malformed input rather than failing the workflow', () => {
  const result = spawnSync('node', [SCRIPT], { input: 'not json at all', encoding: 'utf8' });
  assert.equal(result.status, 0, 'a bad pipe must never fail the caller');
  assert.match(result.stderr, /expected an array/);
});

test('pipeline-outcomes tolerates PRs with no comments field at all', () => {
  const out = run([{ number: 80, title: 'no comments key' }]);
  assert.match(out, /No pipeline loop engaged/);
});
