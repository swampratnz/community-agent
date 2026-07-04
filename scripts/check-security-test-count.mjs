#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Runs every SECURITY:-prefixed test (see CLAUDE.md) and enforces a count
// floor: `npm run test:security` fails not just on a failing assertion but
// also if fewer than MIN_SECURITY_TESTS ran at all. That turns "someone
// deleted or silently disabled a security test" from a still-green CI run
// into a loud failure — see issue #42.
//
// Skipped tests (e.g. the DB-backed cases in repository.test.ts when no
// DATABASE_URL is reachable — see CLAUDE.md) are reported by the Node test
// runner as `ok ... # SKIP ...`, so they still count toward the floor. That
// keeps the count stable across runners regardless of DB availability,
// while still catching an outright deletion of a DB-dependent security test.
//
// This is a floor, not proof of total security coverage — it only pins the
// invariants that already have a SECURITY: test.
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(repoRoot, 'tests');

// Count at merge time of #42. Bump this in the same diff that adds a new
// SECURITY: test; a diff that only lowers it needs an explanation.
// Raised to 41 with the cross-platform identity-linking SECURITY tests (#44),
// then to 57 with the approved-issues batch build (#45-#53), then to 59 with
// the PR #91 review round (ambient recall scoping + URL-path token scrub),
// then to 61 with the WhatsApp Cloud app-secret redaction tests (#110), then
// to 62 with the suggestion-resolution cross-platform-notify guard (#116).
const MIN_SECURITY_TESTS = 62;

const testFiles = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join('tests', f));

const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const result = spawnSync(
  tsxBin,
  ['--test', '--test-reporter=tap', '--test-name-pattern=^SECURITY:', ...testFiles],
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

if (passed.length < MIN_SECURITY_TESTS) {
  console.error(
    `\ncheck-security-test-count: only ${passed.length} SECURITY:-prefixed tests ran, expected at least ` +
      `${MIN_SECURITY_TESTS}. A security test may have been deleted or renamed out of the SECURITY: ` +
      `namespace. If this removal is intentional, lower MIN_SECURITY_TESTS in this script and explain why ` +
      `in the PR.`,
  );
  process.exit(1);
}

console.log(
  `\ncheck-security-test-count: ${passed.length} SECURITY:-prefixed tests ran (floor: ${MIN_SECURITY_TESTS}).`,
);
