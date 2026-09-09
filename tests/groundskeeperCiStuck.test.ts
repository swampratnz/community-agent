import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The groundskeeper's "CI never executed" sweep
 * (.github/workflows/pipeline-groundskeeper.yml, issue #1348).
 *
 * The sweep exists because a GITHUB_TOKEN-authored push (the conflict
 * resolver's checkpoint, a merge commit landing on a branch) cannot trigger
 * workflows, and GitHub records that as a `completed` run with
 * `conclusion: action_required` and zero jobs. Nothing else in the pipeline
 * watches for that state, so the PR goes invisible — #1248 and #1288 each sat
 * days that way.
 *
 * Two of its three jq programs decide who gets labelled `needs-human`, so
 * they are EXTRACTED FROM THE WORKFLOW and executed against real `jq` with
 * real `gh --json` shapes, the same technique
 * tests/conflictResolverEligibility.test.ts uses. A string match would happily
 * pass on a filter that parses and selects the wrong set — which is the only
 * failure that matters here, because the most damaging mistake this sweep
 * could make is escalating FORK PRs: `action_required` on a fork is the
 * ordinary "a maintainer must approve this run" state, and labelling those
 * would bury the real signal in noise.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW = path.join(repoRoot, '.github/workflows/pipeline-groundskeeper.yml');
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

const SELECT_JQ = extractJq(`--json number,headRefOid,isCrossRepository,labels \\\n            --jq '`, `'`);
const LIVE_JQ = extractJq(`live="$(jq '`, `' <<<"\${runs}")"`);
const VERDICT_JQ = extractJq(`verdicts="$(jq '`, `' <<<"\${runs}")"`);

function runJq(program: string, input: unknown, args: string[] = []): string {
  const res = spawnSync('jq', [...args, program], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `jq failed: ${res.stderr}`);
  return res.stdout.trim();
}

interface PrShape {
  number: number;
  headRefOid: string;
  isCrossRepository: boolean;
  labels: Array<{ name: string }>;
}

function pr(number: number, over: Partial<PrShape> = {}): PrShape {
  return {
    number,
    headRefOid: `sha-${number}`,
    isCrossRepository: false,
    labels: [],
    ...over,
  };
}

const SELECT_CASES: Array<{ name: string; pr: PrShape; selected: boolean }> = [
  { name: 'same-repo PR with no labels', pr: pr(1), selected: true },
  {
    name: 'same-repo PR with an unrelated label',
    pr: pr(2, { labels: [{ name: 'dependencies' }] }),
    selected: true,
  },
  {
    // The whole point of the fork exclusion: `action_required` on a fork PR is
    // GitHub's normal "approve this run" state, not the wedge.
    name: 'FORK PR (action_required there is healthy, never escalate)',
    pr: pr(3, { isCrossRepository: true }),
    selected: false,
  },
  {
    name: 'already escalated (needs-human) — never re-label',
    pr: pr(4, { labels: [{ name: 'needs-human' }] }),
    selected: false,
  },
  {
    name: 'needs-human alongside other labels still excluded',
    pr: pr(5, { labels: [{ name: 'dependencies' }, { name: 'needs-human' }] }),
    selected: false,
  },
];

for (const c of SELECT_CASES) {
  test(`groundskeeper CI-stuck sweep selects the right PRs: ${c.name}`, { skip }, () => {
    // `-r` because `gh --jq` emits raw strings, which is what the shell's
    // `while read` loop consumes; plain jq would JSON-quote them.
    const out = runJq(SELECT_JQ, [c.pr], ['-r']);
    assert.equal(
      out === `${c.pr.number} ${c.pr.headRefOid}`,
      c.selected,
      `expected selected=${c.selected}, got ${JSON.stringify(out)}`,
    );
  });
}

test('groundskeeper CI-stuck sweep treats an in-flight run as healthy and leaves it alone', { skip }, () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
    const runs = [{ status, conclusion: null }];
    assert.equal(runJq(LIVE_JQ, runs), '1', `status=${status} must count as live`);
  }
  assert.equal(runJq(LIVE_JQ, [{ status: 'completed', conclusion: 'success' }]), '0');
});

test('groundskeeper CI-stuck sweep counts only success/failure as a real verdict', { skip }, () => {
  // success and failure both mean CI actually ran and reached a conclusion.
  // failure is deliberately "healthy" HERE — autofix owns red CI, and two
  // loops escalating the same PR would double-label it.
  assert.equal(runJq(VERDICT_JQ, [{ status: 'completed', conclusion: 'success' }]), '1');
  assert.equal(runJq(VERDICT_JQ, [{ status: 'completed', conclusion: 'failure' }]), '1');

  // The wedge itself, and its neighbours: none of these is a verdict, so a PR
  // showing only these is what the sweep must escalate.
  for (const conclusion of ['action_required', 'cancelled', 'skipped', 'stale', null]) {
    assert.equal(
      runJq(VERDICT_JQ, [{ status: 'completed', conclusion }]),
      '0',
      `conclusion=${conclusion} must not count as a verdict`,
    );
  }

  // Zero runs at all — the other shape of "CI never executed".
  assert.equal(runJq(VERDICT_JQ, []), '0');
});

test(
  'groundskeeper CI-stuck sweep: a real wedge (action_required, zero jobs) is both non-live and non-verdict',
  { skip },
  () => {
    // The exact run shape observed on PRs #1248 and #1288.
    const wedged = [{ status: 'completed', conclusion: 'action_required' }];
    assert.equal(runJq(LIVE_JQ, wedged), '0', 'a terminal run is not in flight');
    assert.equal(runJq(VERDICT_JQ, wedged), '0', 'action_required is not a verdict');
  },
);

test("SECURITY: the groundskeeper CI-stuck marker is counted only on github-actions[bot]'s own comments, so no commenter can suppress an escalation", () => {
  // audit 2026-07-28 N3: an unauthenticated marker count lets any commenter
  // suppress an escalation. This one filters to github-actions[bot] in both
  // gh renderings before counting.
  const step = yaml.slice(yaml.indexOf('Escalate PRs whose CI never executed'));
  assert.match(step, /author\.login == \\"github-actions\\"/);
  assert.match(step, /author\.login == \\"github-actions\[bot\]\\"/);
});
