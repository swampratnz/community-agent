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
// which is a conflict worth having. The manifest is additionally kept SORTED
// by file name (enforced below, normalised by --write) so that two PRs adding
// entries for DIFFERENT new files don't collide at a shared append point
// either — see the --write section for the full rationale.
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
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// ---- Optional: regenerate the manifest from the true static counts ---------
// `--write` turns a per-file floor mismatch into a mechanical, one-command fix
// (`npm run test:security:fix`). The pipeline's autofix and conflict-resolver
// loops use it after a merge brings in another in-flight PR's SECURITY: tests
// on the SAME file — the #1 source of "counts lag reality" escalations, which
// are not a real defect and should never reach a human.
//
// Output is fully SORTED by file name, and the non-write check below ENFORCES
// that order. This is deliberately the opposite of the old "preserve insertion
// order, append new files at the end" behaviour, and it is the whole reason
// this manifest stopped being a merge-conflict hotspot: appending each new
// file's entry at the end made every PR that covered a NEW test file edit the
// same final lines, so two such PRs conflicted even though their entries are
// independent. A manifest that is born sorted and kept sorted gives every entry
// a stable alphabetical home, so two PRs adding DIFFERENT files land in
// different hunks and git 3-way-merges them with no conflict for a human (or
// the resolver) to touch. The prior "a re-sort is a noisy diff" objection was a
// ONE-TIME cost (a single re-sorting commit); steady-state diffs stay minimal
// because entries no longer migrate.
//
// Safety rail: it RAISES or ADDS entries freely, but REFUSES to lower or drop
// one (which would silently paper over a deleted/renamed-away security test —
// the exact regression this gate exists to catch) unless `--allow-lower` is
// also passed, which a PR must then explain. So the loops can heal the common
// "tests added, manifest lagging" case autonomously, but a genuine removal
// still stops for a human.
if (process.argv.includes('--write')) {
  const allowLower = process.argv.includes('--allow-lower');
  const lowered = [];
  const next = {};
  // Union of files already in the manifest and files with a live static count,
  // emitted in sorted order (see header): deterministic and conflict-resistant.
  const allFiles = [...new Set([...Object.keys(manifest), ...Object.keys(staticCounts)])].sort();
  for (const file of allFiles) {
    const actual = staticCounts[file] ?? 0;
    const expected = manifest[file]; // undefined for a newly-covered file
    if (expected !== undefined && actual === 0) {
      lowered.push(`${file}: ${expected} → 0 (entry would be removed)`);
      continue; // file deleted or all its SECURITY: tests gone — drop the entry
    }
    if (expected !== undefined && actual < expected) lowered.push(`${file}: ${expected} → ${actual}`);
    next[file] = actual;
  }
  if (lowered.length > 0 && !allowLower) {
    console.error(
      'check-security-test-count --write: refusing to LOWER or remove a per-file count — a SECURITY: ' +
        'test was deleted or renamed out of the namespace:',
    );
    for (const l of lowered) console.error(`  ${l}`);
    console.error('If this is intentional, re-run with --allow-lower and explain the removal in the PR.');
    process.exit(1);
  }
  const changed = JSON.stringify(manifest) !== JSON.stringify(next);
  if (changed) writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n');
  const total = Object.values(next).reduce((a, b) => a + b, 0);
  console.log(
    changed
      ? `check-security-test-count --write: regenerated tests/security-floor.json (${Object.keys(next).length} files, ${total} SECURITY: tests).`
      : 'check-security-test-count --write: manifest already matches the code — no change.',
  );
  process.exit(0);
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
        `test — bump this file's entry in tests/security-floor.json in the same diff ` +
        `(or run \`npm run test:security:fix\` to regenerate the manifest).`,
    );
  }
}
for (const [file, actual] of Object.entries(staticCounts)) {
  if (!(file in manifest)) {
    problems.push(
      `${file}: declares ${actual} SECURITY: test(s) but has no entry in tests/security-floor.json — ` +
        `add one in the same diff (in sorted position — see below).`,
    );
  }
}

// The manifest must stay SORTED by file name. A sorted manifest is exactly what
// lets two PRs that each add an entry for a DIFFERENT test file merge without
// conflicting here (their entries live in different hunks); an out-of-order
// entry silently erodes that property one PR at a time. This is a mechanical,
// --write-fixable ordering nit rather than a security finding, but it is
// cheapest to enforce right where the counts are already validated — see the
// --write header for why sorted order is the anti-conflict invariant.
const manifestKeys = Object.keys(manifest);
const sortedKeys = [...manifestKeys].sort();
if (manifestKeys.some((k, i) => k !== sortedKeys[i])) {
  const firstOff = manifestKeys.findIndex((k, i) => k !== sortedKeys[i]);
  problems.push(
    `tests/security-floor.json is not sorted by file name (first out-of-order entry: ` +
      `${manifestKeys[firstOff]}). A sorted manifest lets PRs that add different test files merge ` +
      `without conflicting on this manifest — run \`npm run test:security:fix\` to normalise the order.`,
  );
}

// Unconditional skip/todo of a SECURITY test evades the gate (issue #221):
// `test.skip(`/`test.todo(` keep the static count (declPattern matches them)
// while removing the assertion, and node reports the skip as `ok … # SKIP`
// which the runtime pass-counter below would otherwise credit. Ban the
// METHOD forms outright — a genuine environment gate (e.g. DB-unavailable)
// uses the OPTION form instead: `test('SECURITY: …', { skip }, fn)`, which is
// not matched here and stays allowed.
const bannedSkipPattern = /\btest\.(?:skip|todo)\(\s*[`'"]SECURITY:/g;
for (const f of testFileNames) {
  const n = (readFileSync(path.join(testsDir, f), 'utf8').match(bannedSkipPattern) ?? []).length;
  if (n > 0) {
    problems.push(
      `${f}: ${n} SECURITY: test(s) use test.skip(/test.todo( — an unconditional skip/todo disables a security ` +
        `test while keeping its count. Restore the assertion, or (only for a real environment gate) use the ` +
        `conditional option form test('SECURITY: …', { skip: <cond> }, fn).`,
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
// A `# TODO` directive makes node report a test as `ok … # TODO` even when it
// doesn't assert anything — another way to neuter a SECURITY test while
// keeping it green (issue #221). Treat any TODO-marked SECURITY line as a
// failure, and never credit it toward the pass count. (`# SKIP` stays credited
// so the DB-conditional { skip } option tests keep the count stable across
// runners regardless of DATABASE_URL — see the header.)
const todo = lines.filter((l) => /^(?:not )?ok \d+ - SECURITY:.*# TODO\b/.test(l));
const passed = lines.filter((l) => /^ok \d+ - SECURITY:/.test(l) && !/# TODO\b/.test(l));

if (failed.length > 0 || todo.length > 0) {
  const bad = [...failed, ...todo];
  console.error(`\ncheck-security-test-count: ${bad.length} SECURITY test(s) failed or were marked TODO:`);
  for (const l of bad) console.error(`  ${l}`);
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
