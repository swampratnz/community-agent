import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The conflict resolver's eligibility filter
 * (.github/workflows/pipeline-pr-conflict.yml).
 *
 * This filter decides which PR branches an agent may be pointed at and PUSH
 * to, so a mistake here is a security bug rather than a bug: loosening it
 * hands an automated pusher a branch nobody vetted. It is also written twice
 * on purpose — once in `discover` to select candidates, once in `resolve` to
 * re-verify before checkout, because the dispatch payload carries PR numbers
 * only and is attacker-shapeable by anyone with write access. Two copies of
 * one rule is exactly the shape that drifts (the same failure mode
 * tests/agentRunActions.test.ts exists for), so both are pinned here.
 *
 * The jq programs are EXTRACTED FROM THE WORKFLOW and executed against the
 * real `jq`, rather than asserted as strings: a string match would pass on a
 * filter that parses but selects the wrong set. Fixtures below are the actual
 * PR shapes `gh pr list --json` returns.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW = path.join(repoRoot, '.github/workflows/pipeline-pr-conflict.yml');
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

const DISCOVER_JQ = extractJq(`| jq -c --argjson maint "$maint" '`, `')"`);
const RESOLVE_JQ = extractJq(`eligible="$(jq -r --argjson maint "$maint" '`, `' <<<"$info")"`);

const MAINT = JSON.stringify(['swampratnz']);

function runJq(program: string, input: unknown, args: string[]): string {
  const res = spawnSync('jq', [...args, '--argjson', 'maint', MAINT, program], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `jq failed: ${res.stderr}`);
  return res.stdout.trim();
}

interface PrShape {
  number: number;
  author: { is_bot: boolean; login: string };
  isCrossRepository: boolean;
  labels: Array<{ name: string }>;
  body: string;
  headRefName: string;
  state?: string;
  mergeable?: string;
}

function pr(number: number, over: Partial<PrShape> = {}): PrShape {
  return {
    number,
    author: { is_bot: true, login: 'claude[bot]' },
    isCrossRepository: false,
    labels: [],
    body: 'Closes #42',
    headRefName: 'feature/x',
    state: 'OPEN',
    mergeable: 'CONFLICTING',
    ...over,
  };
}

const AUTOFILL_BRANCH = 'chore/changelog-autofill';

/** Every case, with the verdict the filter must reach. */
const CASES: Array<{ name: string; pr: PrShape; eligible: boolean }> = [
  { name: 'build-worker bot with a `Closes #` body', pr: pr(1), eligible: true },
  {
    name: 'changelog-autofill bot on its fixed branch, no `Closes #`',
    pr: pr(2, { body: 'auto-drafted', headRefName: AUTOFILL_BRANCH }),
    eligible: true,
  },
  {
    name: 'maintainer human',
    pr: pr(3, { author: { is_bot: false, login: 'swampratnz' }, body: 'no closes' }),
    eligible: true,
  },
  // --- everything below must stay OUT ---
  {
    name: 'an unrelated bot PR (Dependabot bump): bot, but no `Closes #` and not the autofill branch',
    pr: pr(4, {
      author: { is_bot: true, login: 'dependabot[bot]' },
      body: 'Bumps foo from 1 to 2',
      headRefName: 'dependabot/npm_and_yarn/foo-2',
    }),
    eligible: false,
  },
  {
    name: 'a FORK claiming the autofill branch name',
    pr: pr(5, { isCrossRepository: true, body: 'x', headRefName: AUTOFILL_BRANCH }),
    eligible: false,
  },
  {
    name: 'a non-bot non-maintainer on the autofill branch name',
    pr: pr(6, {
      author: { is_bot: false, login: 'randomuser' },
      body: 'x',
      headRefName: AUTOFILL_BRANCH,
    }),
    eligible: false,
  },
  {
    name: 'autofill bot already labelled needs-human (the failed-attempt stop)',
    pr: pr(7, { body: 'x', headRefName: AUTOFILL_BRANCH, labels: [{ name: 'needs-human' }] }),
    eligible: false,
  },
  {
    name: 'autofill bot pinned out with no-auto-resolve',
    pr: pr(8, { body: 'x', headRefName: AUTOFILL_BRANCH, labels: [{ name: 'no-auto-resolve' }] }),
    eligible: false,
  },
];

test(
  'SECURITY: the discover filter selects exactly the three trusted author arms and nothing else',
  { skip },
  () => {
    const selected = JSON.parse(
      runJq(
        `${DISCOVER_JQ} | map(.number)`,
        CASES.map((c) => c.pr),
        ['-c'],
      ),
    ) as number[];
    const expected = CASES.filter((c) => c.eligible).map((c) => c.pr.number);
    assert.deepEqual(
      selected,
      expected,
      `discover selected the wrong set.\n` +
        CASES.map(
          (c) => `  #${c.pr.number} ${c.eligible ? 'MUST include' : 'MUST EXCLUDE'} — ${c.name}`,
        ).join('\n'),
    );
  },
);

test(
  'SECURITY: the resolve re-verification agrees with discover on every case — the two copies must not drift',
  { skip },
  () => {
    // Compared against DISCOVER'S OWN OUTPUT, not against the expected table:
    // the table already pins each copy's absolute verdict (test 1 for
    // discover, and every case here transitively), so what is left to catch
    // is the two rules diverging from EACH OTHER — the failure this
    // duplication invites, and the one a table-vs-table check would miss if
    // both copies happened to drift the same way.
    const selected = new Set(
      JSON.parse(
        runJq(
          `${DISCOVER_JQ} | map(.number)`,
          CASES.map((c) => c.pr),
          ['-c'],
        ),
      ) as number[],
    );
    for (const c of CASES) {
      const verdict = runJq(RESOLVE_JQ, c.pr, ['-r']);
      assert.equal(
        verdict,
        String(selected.has(c.pr.number)),
        `resolve and discover disagree on #${c.pr.number} (${c.name}) — discover ` +
          `${selected.has(c.pr.number) ? 'selects' : 'skips'} it but resolve says ${verdict}`,
      );
    }
  },
);

test(
  'SECURITY: resolve additionally refuses a PR that is closed or no longer conflicting, which discover does not check',
  { skip },
  () => {
    // discover reads mergeability separately (a bounded poll below the filter);
    // resolve folds state/mergeable INTO the same expression, and that is what
    // makes a superseded duplicate dispatch a no-op instead of a mislabel.
    const merged = pr(9, { state: 'MERGED' });
    const resolved = pr(10, { mergeable: 'MERGEABLE' });
    assert.equal(runJq(RESOLVE_JQ, merged, ['-r']), 'false', 'a non-OPEN PR must never be resolved');
    assert.equal(
      runJq(RESOLVE_JQ, resolved, ['-r']),
      'false',
      'an already-unconflicted PR must never be resolved',
    );
  },
);
