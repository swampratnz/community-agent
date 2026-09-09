import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/accessRequestResolutions.test.ts. DATABASE_URL gates
// the DB-integration tests below (skipped cleanly when unset, per CLAUDE.md).
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');
const { recordHumanHelpRequest, countHumanHelpRequestsSince, mostRecentHumanHelpRequestAt } =
  await import('../src/module/storage/humanHelpRequestLog.js');

after(async () => {
  await closeDb();
});

// SECURITY, DB-independent: parses the schema fragment text directly rather
// than querying a live DB, so it runs even without DATABASE_URL and can never
// be fooled by a stray column added to a DIFFERENT table sharing the name.
// Pins the acceptance criterion this table's whole design turns on: no
// platform/conversation/user/content column, ever (issue #1364 acceptance
// criterion 5).
test('SECURITY: schema/87-human-help-request-log.sql declares only {id, created_at} on human_help_request_log — no platform, conversation, user, or content column (issue #1364 acceptance criterion 5)', () => {
  const sql = readFileSync(
    new URL('../src/module/storage/schema/87-human-help-request-log.sql', import.meta.url),
    'utf8',
  );
  const createMatch = sql.match(/CREATE TABLE IF NOT EXISTS human_help_request_log \(([^;]*)\)/s);
  assert.ok(createMatch, 'expected a CREATE TABLE IF NOT EXISTS human_help_request_log (...) statement');
  const columnNames = createMatch[1]
    .split(',')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/)[0]);
  assert.deepEqual(
    columnNames,
    ['id', 'created_at'],
    'SECURITY: an extra column here would turn a deliberately anonymous frequency signal into an identity store',
  );
});

// Live-DB companion to the structural test above, mirroring
// accessRequestResolutions.test.ts's own column-pin style exactly (issue
// #1364 acceptance criterion 5).
test(
  'SECURITY: human_help_request_log has exactly the columns {id, created_at} in the live schema — no platform, user id, or content column (issue #1364 acceptance criterion 5)',
  { skip },
  async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'human_help_request_log' ORDER BY column_name`,
    );
    const columns = rows.map((r) => r.column_name).sort();
    assert.deepEqual(columns, ['created_at', 'id']);
  },
);

test(
  'recordHumanHelpRequest + countHumanHelpRequestsSince round-trip: one recorded call is counted within a since window that starts just before it (issue #1364 acceptance criterion 1)',
  { skip },
  async () => {
    const since = new Date();
    const before = await countHumanHelpRequestsSince(since);
    await recordHumanHelpRequest();
    const after = await countHumanHelpRequestsSince(since);
    assert.equal(after, before + 1, 'exactly one row must be added by one recordHumanHelpRequest() call');
  },
);

test(
  'countHumanHelpRequestsSince excludes rows created before the given since cutoff (issue #1364)',
  { skip },
  async () => {
    await recordHumanHelpRequest();
    const since = new Date(Date.now() + 60_000);
    assert.equal(
      await countHumanHelpRequestsSince(since),
      0,
      'a since cutoff in the future must exclude every existing row',
    );
  },
);

test('mostRecentHumanHelpRequestAt reflects a just-recorded row (issue #1364)', { skip }, async () => {
  const before = Date.now();
  await recordHumanHelpRequest();
  const after = Date.now();
  const mostRecent = await mostRecentHumanHelpRequestAt();
  assert.ok(mostRecent, 'a row exists, so this must not be null');
  assert.ok(
    mostRecent.getTime() >= before - 1000 && mostRecent.getTime() <= after + 1000,
    'the most recent timestamp must fall within the window this call ran in — true regardless of any ' +
      'concurrently-written row from another test file, since any such row is equally recent',
  );
});

// Structural check mirroring accessRequestResolutions.test.ts's own — this
// table carries no identity column (pinned above), so there is nothing here
// for forget_me/purge_user_data to reach, and this module never registers a
// purge contributor for it (issue #1364 acceptance criterion — no identity
// to purge).
test('SECURITY: src/module/storage/humanHelpRequestLog.ts registers no purge contributor for human_help_request_log — the table carries no identity for forget_me/purge_user_data to erase (issue #1364)', () => {
  const source = readFileSync(
    new URL('../src/module/storage/humanHelpRequestLog.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    !source.includes('registerPurgeContributor'),
    'this table needs no purge hook — it carries no platform/userId to erase by construction',
  );
});
