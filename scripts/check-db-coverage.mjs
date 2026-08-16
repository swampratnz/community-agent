#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pre-test notice: say plainly when this run will NOT verify the database half.
//
// Roughly a fifth of this suite is DB-gated. Without `DATABASE_URL` those tests
// `skip` — which node:test reports as `# skipped 538` on a line above
// `# fail 0`, and the eye reads the `fail 0`. A local run therefore *looks*
// green while silently omitting every DB-backed invariant, including the
// security ones, and "I ran the full suite" becomes false without anyone
// choosing to make it false.
//
// That is not hypothetical. It has repeatedly sent people (and agents) into
// diagnosing the wrong thing: trusting a local green that never exercised the
// SQL under review, and — worse — reasoning about "shared-database test
// isolation" from intermittent failures produced by a run in which every
// database test was skipping and therefore could not have been involved.
//
// So this prints a banner rather than failing: a contributor without Postgres
// must still be able to run what they can (CLAUDE.md is explicit about that).
// It only ever makes the omission legible. Set `REQUIRE_DATABASE_URL=1` to turn
// it into a hard failure instead — what CI does, so a misconfigured CI job that
// silently stopped running the DB half is caught rather than passing quietly.
// ---------------------------------------------------------------------------
const hasDb = Boolean(process.env.DATABASE_URL);
const required = process.env.REQUIRE_DATABASE_URL === '1';

if (hasDb) {
  console.log('check-db-coverage: DATABASE_URL set — DB-gated tests will run.');
  process.exit(0);
}

const lines = [
  '',
  '  ┌──────────────────────────────────────────────────────────────────────┐',
  '  │  DATABASE_URL is not set.                                            │',
  '  │                                                                      │',
  '  │  Every DB-gated test in this run will SKIP, not pass. A "fail 0"     │',
  '  │  below does NOT mean the database behaviour was verified — check     │',
  '  │  the "# skipped" count on the line above it.                         │',
  '  │                                                                      │',
  '  │  Do not report this run as a full green gate. CI runs these tests    │',
  '  │  against a real pgvector Postgres; that is the authoritative check.  │',
  '  │                                                                      │',
  '  │  To run them locally, see "Get a local Postgres + pgvector" in       │',
  '  │  docs/agents/recipes.md — it is about two minutes.                   │',
  '  └──────────────────────────────────────────────────────────────────────┘',
  '',
];
console.log(lines.join('\n'));

if (required) {
  console.error(
    'check-db-coverage: REQUIRE_DATABASE_URL=1 is set and DATABASE_URL is not — refusing to run a partial suite.',
  );
  process.exit(1);
}
