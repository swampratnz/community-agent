import { test, after } from 'node:test';
import assert from 'node:assert/strict';

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
const { purgeUserData } = await import('@swampratnz/agent-base/storage/repository.js');
const { recordFindHelperRequest, listOwnFindHelperRequests } =
  await import('../src/module/storage/findHelperRequests.js');

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM find_helper_requests WHERE requester_user_id LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

test(
  'recordFindHelperRequest + listOwnFindHelperRequests round-trip: topic and matched survive, newest-first, scoped to the caller (issue #1313 acceptance criterion 2)',
  { skip },
  async () => {
    const userId = `${RUN}-roundtrip`;
    const otherUserId = `${RUN}-roundtrip-other`;
    await recordFindHelperRequest('discord', userId, 'first topic', false);
    await recordFindHelperRequest('discord', userId, 'second topic', true);
    await recordFindHelperRequest('discord', otherUserId, "someone else's topic", true);

    const rows = await listOwnFindHelperRequests('discord', userId, 10);
    assert.equal(rows.length, 2, "only the caller's own two rows are returned");
    assert.equal(rows[0]?.topic, 'second topic', 'newest-first ordering');
    assert.equal(rows[0]?.matched, true);
    assert.equal(rows[1]?.topic, 'first topic');
    assert.equal(rows[1]?.matched, false);
    assert.ok(
      !rows.some((r) => r.topic === "someone else's topic"),
      "SECURITY: another caller's row must never be returned",
    );

    await pool.query(`DELETE FROM find_helper_requests WHERE requester_user_id = $1`, [otherUserId]);
  },
);

test(
  'listOwnFindHelperRequests clamps an out-of-range limit into [1, 50], matching listOwnProjectConnectionRequests (issue #1313 acceptance criterion 2)',
  { skip },
  async () => {
    const userId = `${RUN}-limit-clamp`;
    for (let i = 0; i < 3; i++) {
      await recordFindHelperRequest('discord', userId, `topic ${i}`, false);
    }

    const zeroClamped = await listOwnFindHelperRequests('discord', userId, 0);
    assert.ok(zeroClamped.length > 0, 'a zero/invalid limit clamps up to at least 1, never to zero rows');

    const hugeClamped = await listOwnFindHelperRequests('discord', userId, 10_000);
    assert.ok(hugeClamped.length <= 50, 'a huge limit clamps down to at most 50');
  },
);

test(
  "SECURITY: purgeUserData erases a caller's own find_helper_requests rows — the purge contributor findHelperRequests.ts registers (issue #1313 acceptance criterion 6)",
  { skip },
  async () => {
    const userId = `${RUN}-purge`;
    await recordFindHelperRequest('discord', userId, 'a topic to be purged', true);

    const beforePurge = await listOwnFindHelperRequests('discord', userId, 10);
    assert.equal(beforePurge.length, 1, 'precondition: the row exists before purging');

    await purgeUserData('discord', userId);

    const afterPurge = await listOwnFindHelperRequests('discord', userId, 10);
    assert.equal(
      afterPurge.length,
      0,
      "forget_me/purge_user_data must erase the caller's find_helper_requests rows",
    );
  },
);
