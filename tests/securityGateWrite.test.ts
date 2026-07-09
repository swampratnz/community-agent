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

function readManifest(dir: string): Record<string, number> {
  return JSON.parse(readFileSync(path.join(dir, 'tests', 'security-floor.json'), 'utf8'));
}

test('SECURITY: test:security:fix raises a lagging per-file count and preserves existing key order', () => {
  // Deliberately non-alphabetical manifest order; zeta under-counts reality.
  const dir = setup({ 'zeta.test.ts': 3, 'alpha.test.ts': 2 }, { 'zeta.test.ts': 1, 'alpha.test.ts': 2 });
  try {
    const res = runWrite(dir);
    assert.equal(res.status, 0, res.stderr);
    const m = readManifest(dir);
    assert.deepEqual(
      Object.keys(m),
      ['zeta.test.ts', 'alpha.test.ts'],
      'existing key order preserved (no re-sort)',
    );
    assert.equal(m['zeta.test.ts'], 3, 'lagging count raised to the true count');
    assert.equal(m['alpha.test.ts'], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: test:security:fix appends a newly-covered file in sorted order after existing entries', () => {
  const dir = setup({ 'alpha.test.ts': 1, 'gamma.test.ts': 2, 'beta.test.ts': 1 }, { 'alpha.test.ts': 1 });
  try {
    const res = runWrite(dir);
    assert.equal(res.status, 0, res.stderr);
    const m = readManifest(dir);
    // Existing 'alpha' stays first; the two new files are appended sorted.
    assert.deepEqual(Object.keys(m), ['alpha.test.ts', 'beta.test.ts', 'gamma.test.ts']);
    assert.equal(m['beta.test.ts'], 1);
    assert.equal(m['gamma.test.ts'], 2);
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
