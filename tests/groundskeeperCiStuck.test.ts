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

test('the groundskeeper declares every permission scope its gh calls need', () => {
  // Actions permissions are ADDITIVE: naming any key sets every unnamed one to
  // `none`, not to the repo default. So a missing scope here is not a loud
  // 403 in the logs of a step that then fails — every one of these calls has a
  // fallback, so the sweep would quietly decide there is nothing to do, for
  // every PR, on every run, forever. That is exactly the invisible-failure
  // shape issue #1348 exists to remove, one level up, and it is precisely what
  // the jq tests above cannot see: they exercise the filters against synthetic
  // data and never touch the workflow's actual grant.
  // Comment lines are stripped, not merely skipped over. The first version of
  // this test sliced the raw block, and the block's own comment explains why
  // `contents: read` is needed — so deleting the actual grant left the phrase
  // in the comment and the test happily passed. A guard satisfied by the prose
  // describing it is not a guard.
  const block = yaml.slice(yaml.indexOf('\npermissions:'), yaml.indexOf('\nconcurrency:'));
  assert.notEqual(block.length, 0, 'permissions block not found — workflow restructured?');
  const perms = block
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  // Each entry is (scope, the call that needs it), so a future reader can tell
  // whether a scope is still required by looking for that call.
  const NEEDED: Array<[string, string]> = [
    ['issues: write', 'gh issue edit / gh issue comment (first sweep)'],
    ['pull-requests: write', 'gh pr edit / gh pr comment (second sweep)'],
    ['actions: read', 'gh api repos/.../actions/runs'],
    ['contents: read', 'gh api repos/.../commits/<sha> for the head-commit date'],
  ];
  for (const [scope, why] of NEEDED) {
    assert.ok(perms.includes(scope), `the permissions block is missing \`${scope}\`, needed for: ${why}`);
  }
});

test('SECURITY: a failed CI-run lookup skips the PR instead of reading as "confirmed zero runs"', () => {
  // `|| echo '[]'` here would make an API failure indistinguishable from a
  // genuinely un-CI'd head, and the two are not symmetric: the PR-selection
  // filter excludes anything already labelled `needs-human`, so a mass false
  // positive never re-evaluates itself. One rate-limited or degraded hourly
  // sweep would label EVERY open PR over 45 minutes old, and a human would
  // unpick each one by hand. Same skip-rather-than-guess idiom the head-commit
  // lookup a few lines further down already uses.
  const step = yaml.slice(yaml.indexOf('Escalate PRs whose CI never executed'));
  const lookup = step.slice(step.indexOf('actions/runs?head_sha='));
  assert.doesNotMatch(
    lookup.slice(0, lookup.indexOf('live=')),
    /\|\|\s*echo\s*'\[\]'/,
    'an empty-array fallback on a failed runs lookup escalates on missing evidence',
  );
  assert.match(step, /if ! runs="\$\(gh api/, 'the runs lookup must branch on its own exit status');
  assert.match(step, /could not read CI runs for \$\{sha\} — skipping rather than guessing/);
});

test('the groundskeeper CI-stuck comment is built without the shell indentation that would render it as a code block', () => {
  // A multi-line double-quoted bash string keeps this block's ~10 spaces of
  // YAML indentation inside the string, and GFM renders a paragraph indented
  // 4+ spaces as preformatted text — the escalation would arrive with its
  // bold and backticks shown literally. printf with one argument per line
  // keeps the indentation outside the quotes.
  const step = yaml.slice(yaml.indexOf('Escalate PRs whose CI never executed'));
  const comment = step.slice(step.indexOf('gh pr edit'));
  assert.match(comment, /printf '%s\\n' \\/, 'the body must be built argument-per-line');
  assert.match(comment, /\| gh pr comment "\$\{num\}" -R "\$\{REPO\}" --body-file -/);
  // Every argument line of the printf starts its content at the quote, so no
  // line of the posted body can carry leading whitespace.
  const args = comment
    .slice(comment.indexOf("printf '%s"))
    .split('\n')
    .slice(1)
    .filter((l) => l.trim().startsWith('"'));
  assert.ok(args.length >= 5, `expected the full body, got ${args.length} argument lines`);
  for (const line of args) {
    assert.doesNotMatch(line, /^\s*"\s/, `body line begins with whitespace inside the quotes: ${line}`);
  }
});

test("SECURITY: the groundskeeper CI-stuck marker is counted only on github-actions[bot]'s own comments, so no commenter can suppress an escalation", () => {
  // audit 2026-07-28 N3: an unauthenticated marker count lets any commenter
  // suppress an escalation. This one filters to github-actions[bot] in both
  // gh renderings before counting.
  const step = yaml.slice(yaml.indexOf('Escalate PRs whose CI never executed'));
  assert.match(step, /author\.login == \\"github-actions\\"/);
  assert.match(step, /author\.login == \\"github-actions\[bot\]\\"/);
});
