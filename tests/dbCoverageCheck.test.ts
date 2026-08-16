import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * scripts/check-db-coverage.mjs — the `pretest` notice that a run without
 * `DATABASE_URL` will SKIP roughly a fifth of the suite rather than pass it.
 *
 * Pinned here for the same reason every other gate script in this repo is
 * (`check-import-direction`, `check-context-pack`, `check-security-test-count`):
 * a script whose behaviour is only ever confirmed by someone running it once,
 * by hand, is a script whose behaviour silently changes.
 *
 * The exit codes matter more than the wording. This deliberately does NOT fail
 * a local run — CLAUDE.md is explicit that a contributor without Postgres must
 * still be able to run what they can — so an accidental `process.exit(1)` on
 * the no-DB path would break every such contributor's `npm test`. Conversely
 * `REQUIRE_DATABASE_URL=1` must genuinely fail, because that is what a CI job
 * would rely on to catch itself having quietly stopped running the DB half.
 *
 * `env` is replaced wholesale rather than spread from `process.env`, so a
 * DATABASE_URL in the ambient environment (this file runs in both
 * configurations) cannot leak in and invert the case under test.
 */
const SCRIPT = fileURLToPath(new URL('../scripts/check-db-coverage.mjs', import.meta.url));

function run(env: Record<string, string>) {
  return spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
}

test('check-db-coverage: without DATABASE_URL it warns but does NOT fail the run', () => {
  const res = run({ PATH: process.env.PATH ?? '' });
  assert.equal(res.status, 0, 'a contributor without Postgres must still be able to run npm test');
  assert.match(res.stdout, /DATABASE_URL is not set/);
  assert.match(res.stdout, /SKIP, not pass/, 'it must name the consequence, not just the condition');
  assert.match(res.stdout, /recipes\.md/, 'and point at the fix');
});

test('check-db-coverage: with DATABASE_URL it confirms in one line and exits 0', () => {
  const res = run({ PATH: process.env.PATH ?? '', DATABASE_URL: 'postgres://x@localhost/y' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /DB-gated tests will run/);
  assert.doesNotMatch(res.stdout, /DATABASE_URL is not set/, 'the warning banner must not fire');
});

test('SECURITY: check-db-coverage never echoes the DATABASE_URL value — a connection string carries credentials', () => {
  // It only ever reports presence/absence, so a CI log (or a pasted terminal
  // scrollback) cannot leak the password embedded in a Postgres URL.
  const secret = 'postgres://user:sup3r-s3cret@db.internal:5432/prod';
  const res = run({ PATH: process.env.PATH ?? '', DATABASE_URL: secret });
  const all = `${res.stdout}${res.stderr}`;
  assert.doesNotMatch(all, /sup3r-s3cret/, 'SECURITY: the password must never be printed');
  assert.doesNotMatch(all, /db\.internal/, 'SECURITY: nor the host');
});

test('check-db-coverage: REQUIRE_DATABASE_URL=1 turns the notice into a hard failure', () => {
  const res = run({ PATH: process.env.PATH ?? '', REQUIRE_DATABASE_URL: '1' });
  assert.equal(res.status, 1, 'CI relies on this to catch itself running a partial suite');
  assert.match(res.stderr, /refusing to run a partial suite/);
});

test('check-db-coverage: REQUIRE_DATABASE_URL=1 is satisfied when DATABASE_URL is present', () => {
  const res = run({
    PATH: process.env.PATH ?? '',
    REQUIRE_DATABASE_URL: '1',
    DATABASE_URL: 'postgres://x@localhost/y',
  });
  assert.equal(res.status, 0, 'the strict mode must pass when the requirement is actually met');
});
