#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Runs every SECURITY:-prefixed test (see CLAUDE.md) and enforces a count
// floor: `npm run test:security` fails not just on a failing assertion but
// also if fewer SECURITY tests exist than expected. That turns "someone
// deleted or silently disabled a security test" from a still-green CI run
// into a loud failure — see issue #42.
//
// The expected counts live in tests/security-floor.json as a PER-FILE map
// (file → number of SECURITY: tests declared in it), not a single global
// constant. The old `MIN_SECURITY_TESTS = N` constant was the repo's #1
// merge-conflict hotspot: every PR that added a SECURITY test edited the same
// line, so any two in-flight PRs conflicted with each other (9 of the 11
// real PR conflicts in the first week were this one line). Per-file entries
// mean concurrent PRs only conflict when they touch the SAME test file —
// which is a conflict worth having.
//
// Convention (unchanged in spirit from #42): when you add a SECURITY: test,
// bump that file's entry in tests/security-floor.json in the SAME diff (add
// the entry if the file is new). The check is exact, not a floor, so the
// manifest can never silently lag reality in either direction. A diff that
// LOWERS an entry needs an explanation in the PR.
//
// Skipped tests (e.g. the DB-backed cases in repository.test.ts when no
// DATABASE_URL is reachable — see CLAUDE.md) are reported by the Node test
// runner as `ok ... # SKIP ...`, so they still count toward the runtime
// check. That keeps the count stable across runners regardless of DB
// availability, while still catching an outright deletion of a DB-dependent
// security test.
//
// This pins the invariants that already have a SECURITY: test — it is not
// proof of total security coverage.
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(repoRoot, 'tests');
const manifestPath = path.join(testsDir, 'security-floor.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const testFileNames = readdirSync(testsDir).filter((f) => f.endsWith('.test.ts'));

// ---- Static check: per-file declaration counts must match the manifest ----
// Matches `test('SECURITY: …'`, `test("…`, `test(\`…`, and `test.skip(…` /
// `test.only(…` forms, including names wrapped onto the next line by
// prettier. Test names in this repo are static string literals, so a static
// scan and the runtime count agree; if you ever build a SECURITY: test name
// dynamically, don't — the gate (and grep-ability) depend on literal names.
const declPattern = /\btest(?:\.[a-z]+)?\(\s*[`'"]SECURITY:/g;
const staticCounts = {};
for (const f of testFileNames) {
  const n = (readFileSync(path.join(testsDir, f), 'utf8').match(declPattern) ?? []).length;
  if (n > 0) staticCounts[f] = n;
}

const problems = [];
for (const [file, expected] of Object.entries(manifest)) {
  const actual = staticCounts[file] ?? 0;
  if (actual < expected) {
    problems.push(
      `${file}: ${actual} SECURITY: test(s) declared, manifest expects ${expected}. A security test was ` +
        `deleted or renamed out of the SECURITY: namespace. If intentional, lower this file's entry in ` +
        `tests/security-floor.json and explain why in the PR.`,
    );
  } else if (actual > expected) {
    problems.push(
      `${file}: ${actual} SECURITY: test(s) declared, manifest expects ${expected}. You added a SECURITY: ` +
        `test — bump this file's entry in tests/security-floor.json in the same diff.`,
    );
  }
}
for (const [file, actual] of Object.entries(staticCounts)) {
  if (!(file in manifest)) {
    problems.push(
      `${file}: declares ${actual} SECURITY: test(s) but has no entry in tests/security-floor.json — ` +
        `add one in the same diff.`,
    );
  }
}

if (problems.length > 0) {
  console.error('check-security-test-count: manifest mismatch:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const expectedTotal = Object.values(manifest).reduce((a, b) => a + b, 0);

// ---- Runtime check: every SECURITY: test runs (or SKIPs) and passes -------
const testFiles = testFileNames.map((f) => path.join('tests', f));

// Derive the node:test runner flags from package.json's own "test" script
// (e.g. `--experimental-test-module-mocks`) instead of hardcoding a second
// copy here, so this gate can never silently drift onto a different runtime
// config than `npm test` — see #109.
const { scripts } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const [, ...testScriptArgs] = scripts.test.trim().split(/\s+/);
const runnerFlags = testScriptArgs.filter((arg) => !arg.startsWith('tests/'));

const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const result = spawnSync(
  tsxBin,
  [...runnerFlags, '--test-reporter=tap', '--test-name-pattern=^SECURITY:', ...testFiles],
  { cwd: repoRoot, encoding: 'utf8' },
);

process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');

if (result.status !== 0) {
  console.error(`\ncheck-security-test-count: tsx --test exited with status ${result.status}`);
  process.exit(result.status ?? 1);
}

const lines = (result.stdout ?? '').split('\n');
const failed = lines.filter((l) => /^not ok \d+ - SECURITY:/.test(l));
const passed = lines.filter((l) => /^ok \d+ - SECURITY:/.test(l));

if (failed.length > 0) {
  console.error(`\ncheck-security-test-count: ${failed.length} SECURITY test(s) failed:`);
  for (const l of failed) console.error(`  ${l}`);
  process.exit(1);
}

if (passed.length < expectedTotal) {
  console.error(
    `\ncheck-security-test-count: only ${passed.length} SECURITY:-prefixed tests ran, but ` +
      `tests/security-floor.json expects ${expectedTotal}. A declared security test did not run — ` +
      `check for a broken file glob or a runner config drift.`,
  );
  process.exit(1);
}

console.log(
  `\ncheck-security-test-count: ${passed.length} SECURITY:-prefixed tests ran ` +
    `(manifest total: ${expectedTotal} across ${Object.keys(manifest).length} files).`,
);
