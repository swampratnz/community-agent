import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Coverage for `check-security-test-count.mjs --write` (`npm run
// test:security:fix`), the helper the autofix / conflict-resolver loops use to
// heal a per-file security-floor.json count mismatch autonomously. The whole
// point of that helper's safety rail is that it can RAISE/ADD counts but must
// never silently LOWER or drop one — which would paper over a deleted SECURITY:
// test, the exact regression the gate exists to catch (issue #42). That
// invariant is security-relevant, so it is pinned here (SECURITY:-prefixed)
// rather than checked by hand.
//
// Each case runs the REAL script (copied into a throwaway repo-shaped tree so
// its `dirname/..` path resolution lands on the temp dir) against fixture test
// files + manifest, exercising the actual code path, not a reimplementation.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realScript = path.join(repoRoot, 'scripts', 'check-security-test-count.mjs');

// Build fixture test-file CONTENT declaring `n` SECURITY: tests. The quote is
// interpolated so THIS file's own source reads `test(${Q}SECURITY:` — `test(`
// followed by `$`, which the gate's own static scanner does NOT match — while
// the WRITTEN fixture file gets a literal SECURITY:-prefixed declaration the
// scanner counts. (Without this trick these fixtures would inflate this file's
// declared SECURITY: count and break the floor.)
const Q = "'";
function fixtureContent(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += `test(${Q}SECURITY: case ${i}${Q}, () => undefined);\n`;
  return out;
}

function setup(files: Record<string, number>, manifest: Record<string, number>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'secfloor-'));
  mkdirSync(path.join(dir, 'scripts'));
  mkdirSync(path.join(dir, 'tests'));
  copyFileSync(realScript, path.join(dir, 'scripts', 'check-security-test-count.mjs'));
  for (const [name, n] of Object.entries(files)) {
    writeFileSync(path.join(dir, 'tests', name), fixtureContent(n));
  }
  writeFileSync(path.join(dir, 'tests', 'security-floor.json'), JSON.stringify(manifest, null, 2) + '\n');
  return dir;
}

function runWrite(dir: string, extraArgs: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync(
    'node',
    [path.join(dir, 'scripts', 'check-security-test-count.mjs'), '--write', ...extraArgs],
    { encoding: 'utf8' },
  );
}

// Check (non-write) mode: static validation only, which exits BEFORE the script
// spawns the tsx runtime runner (so a fixture tree with no package.json / tsx is
// fine as long as the assertion is that a static problem fails it).
function runCheck(dir: string, extraArgs: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync('node', [path.join(dir, 'scripts', 'check-security-test-count.mjs'), ...extraArgs], {
    encoding: 'utf8',
  });
}

function readManifest(dir: string): Record<string, number> {
  return JSON.parse(readFileSync(path.join(dir, 'tests', 'security-floor.json'), 'utf8'));
}

test('SECURITY: test:security:fix raises a lagging per-file count and normalises key order to sorted', () => {
  // Deliberately non-alphabetical manifest order; zeta under-counts reality.
  const dir = setup({ 'zeta.test.ts': 3, 'alpha.test.ts': 2 }, { 'zeta.test.ts': 1, 'alpha.test.ts': 2 });
  try {
    const res = runWrite(dir);
    assert.equal(res.status, 0, res.stderr);
    const m = readManifest(dir);
    assert.deepEqual(
      Object.keys(m),
      ['alpha.test.ts', 'zeta.test.ts'],
      're-sorted to alphabetical order (sorted order keeps concurrent PRs from conflicting here)',
    );
    assert.equal(m['zeta.test.ts'], 3, 'lagging count raised to the true count');
    assert.equal(m['alpha.test.ts'], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: test:security:fix places every entry (existing + newly-covered) in sorted position', () => {
  // 'omega' already in the manifest is NOT alphabetically first, so a correct
  // sort must MOVE it after the newly-covered 'alpha'/'beta' — proving the
  // output is fully sorted, not merely "new files appended at the end".
  const dir = setup({ 'omega.test.ts': 1, 'alpha.test.ts': 2, 'beta.test.ts': 1 }, { 'omega.test.ts': 1 });
  try {
    const res = runWrite(dir);
    assert.equal(res.status, 0, res.stderr);
    const m = readManifest(dir);
    assert.deepEqual(Object.keys(m), ['alpha.test.ts', 'beta.test.ts', 'omega.test.ts']);
    assert.equal(m['alpha.test.ts'], 2);
    assert.equal(m['beta.test.ts'], 1);
    assert.equal(m['omega.test.ts'], 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test:security (check mode) fails on an unsorted manifest and points at the --fix command', () => {
  // Counts MATCH reality, so the ONLY problem is key order — the check must
  // still fail (that is what keeps the anti-conflict sorted invariant honest).
  const dir = setup({ 'alpha.test.ts': 1, 'zeta.test.ts': 1 }, { 'zeta.test.ts': 1, 'alpha.test.ts': 1 });
  try {
    const res = runCheck(dir);
    assert.notEqual(res.status, 0, 'an out-of-order manifest must fail the check');
    assert.match(res.stderr, /not sorted/i);
    assert.match(res.stderr, /test:security:fix/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: test:security:fix refuses to LOWER a count without --allow-lower (cannot mask a deleted security test)', () => {
  const dir = setup({ 'alpha.test.ts': 2 }, { 'alpha.test.ts': 5 });
  try {
    const res = runWrite(dir);
    assert.notEqual(res.status, 0, 'must exit non-zero when a count would drop');
    assert.match(res.stderr, /refusing to LOWER/i);
    assert.equal(readManifest(dir)['alpha.test.ts'], 5, 'manifest left UNCHANGED on refusal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: test:security:fix lowers a count only when --allow-lower is explicitly passed', () => {
  const dir = setup({ 'alpha.test.ts': 2 }, { 'alpha.test.ts': 5 });
  try {
    const res = runWrite(dir, ['--allow-lower']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      readManifest(dir)['alpha.test.ts'],
      2,
      'count lowered to reality only with the explicit flag',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: test:security:fix refuses to DROP a removed file’s entry without --allow-lower', () => {
  // The manifest lists a file that no longer exists under tests/.
  const dir = setup({ 'alpha.test.ts': 1 }, { 'alpha.test.ts': 1, 'removed.test.ts': 3 });
  try {
    const res = runWrite(dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /refusing to LOWER/i);
    assert.ok('removed.test.ts' in readManifest(dir), 'entry for a missing file is NOT silently dropped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: check mode refuses a per-file count LOWERED vs the PR base (a deleted SECURITY test + matching manifest drop) unless the override is set — audit H1', () => {
  // Baseline: alpha declares 3 SECURITY tests, manifest agrees (consistent, green).
  const dir = setup({ 'alpha.test.ts': 3 }, { 'alpha.test.ts': 3 });
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'ci@example.com']);
    git(['config', 'user.name', 'CI']);
    git(['add', '.']);
    git(['commit', '-q', '--no-gpg-sign', '-m', 'baseline']);

    // A PR deletes ONE SECURITY test AND lowers the manifest to match: 2 == 2,
    // so the plain exact-match check alone stays green — this is exactly the
    // silent regression H1 describes.
    writeFileSync(path.join(dir, 'tests', 'alpha.test.ts'), fixtureContent(2));
    writeFileSync(
      path.join(dir, 'tests', 'security-floor.json'),
      JSON.stringify({ 'alpha.test.ts': 2 }, null, 2) + '\n',
    );

    const check = (env: Record<string, string>) =>
      spawnSync('node', [path.join(dir, 'scripts', 'check-security-test-count.mjs')], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });

    const blocked = check({ SECURITY_FLOOR_BASELINE_REF: 'HEAD' });
    assert.notEqual(blocked.status, 0, 'a silent lowering vs the base must fail the check');
    assert.match(blocked.stderr, /LOWERED 3 . 2/, 'names the file and the base→now drop');
    assert.match(blocked.stderr, /allow-security-floor-lower/, 'points at the explicit override');

    const overridden = check({ SECURITY_FLOOR_BASELINE_REF: 'HEAD', ALLOW_SECURITY_FLOOR_LOWER: 'true' });
    assert.doesNotMatch(
      overridden.stderr ?? '',
      /LOWERED/,
      'the explicit allow-security-floor-lower override suppresses the lowering block',
    );

    const noBaseline = check({ SECURITY_FLOOR_BASELINE_REF: '' });
    assert.doesNotMatch(
      noBaseline.stderr ?? '',
      /LOWERED/,
      'with no base ref (local/push/merge_group) the guard is inactive — unchanged behaviour',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
