import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/findHelperRequests.test.ts. DATABASE_URL gates the
// DB-integration tests below (skipped cleanly when unset, per CLAUDE.md).
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
const {
  claimDueConnectionOutcomeFollowups,
  countConnectionOutcomesSince,
  rateConnectionOutcome,
  recordConnectionOutcome,
} = await import('../src/module/storage/connectionOutcomes.js');

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM connection_outcomes WHERE requester_user_id LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

test(
  'recordConnectionOutcome inserts a row with followup_sent_at/outcome/responded_at all NULL (issue #1354 acceptance criterion 1)',
  { skip },
  async () => {
    const userId = `${RUN}-insert`;
    await recordConnectionOutcome('find_helper', 'discord', userId);

    const { rows } = await pool.query(
      `SELECT kind, followup_sent_at, outcome, responded_at FROM connection_outcomes
        WHERE requester_platform = 'discord' AND requester_user_id = $1`,
      [userId],
    );
    assert.equal(rows.length, 1, 'exactly one row is created');
    assert.equal(rows[0].kind, 'find_helper');
    assert.equal(rows[0].followup_sent_at, null);
    assert.equal(rows[0].outcome, null);
    assert.equal(rows[0].responded_at, null);
  },
);

test(
  'claimDueConnectionOutcomeFollowups only claims rows older than cutoff with followup_sent_at IS NULL, and stamps followup_sent_at atomically (issue #1354 acceptance criterion 2)',
  { skip },
  async () => {
    const oldUserId = `${RUN}-claim-old`;
    const freshUserId = `${RUN}-claim-fresh`;
    await recordConnectionOutcome('find_helper', 'discord', oldUserId);
    await recordConnectionOutcome('project_connection', 'discord', freshUserId);
    // Backdate only the "old" row past the cutoff this test uses.
    await pool.query(
      `UPDATE connection_outcomes SET created_at = now() - interval '10 days' WHERE requester_user_id = $1`,
      [oldUserId],
    );

    const cutoff = new Date(Date.now() - 3 * 24 * 3_600_000);
    const claimed = await claimDueConnectionOutcomeFollowups(cutoff, 200);
    const claimedIds = claimed.filter(
      (r) => r.requesterUserId === oldUserId || r.requesterUserId === freshUserId,
    );

    assert.deepEqual(
      claimedIds.map((r) => r.requesterUserId),
      [oldUserId],
      'only the row older than the cutoff is claimed; the fresh row is left alone',
    );

    const { rows } = await pool.query(
      `SELECT requester_user_id, followup_sent_at FROM connection_outcomes WHERE requester_user_id = ANY($1)`,
      [[oldUserId, freshUserId]],
    );
    const old = rows.find((r) => r.requester_user_id === oldUserId);
    const fresh = rows.find((r) => r.requester_user_id === freshUserId);
    assert.ok(old?.followup_sent_at, 'the claimed row is stamped');
    assert.equal(fresh?.followup_sent_at, null, 'the not-yet-due row is left unstamped');

    // A second claim over the same cutoff must not return the already-claimed
    // row again — the idempotency guarantee the follow-up job relies on.
    const secondClaim = await claimDueConnectionOutcomeFollowups(cutoff, 200);
    assert.ok(
      !secondClaim.some((r) => r.requesterUserId === oldUserId),
      'a second run must never re-claim an already-claimed row',
    );
  },
);

test(
  'rateConnectionOutcome writes outcome/responded_at once, then no-ops on a second call for the same row (issue #1354 acceptance criterion 4)',
  { skip },
  async () => {
    const userId = `${RUN}-rate-writeonce`;
    await recordConnectionOutcome('find_helper', 'discord', userId);
    const { rows } = await pool.query(
      `SELECT id FROM connection_outcomes WHERE requester_platform = 'discord' AND requester_user_id = $1`,
      [userId],
    );
    const id = Number(rows[0].id);

    const first = await rateConnectionOutcome(id, 'discord', userId, true);
    assert.equal(first, 'recorded');

    const { rows: after1 } = await pool.query(
      `SELECT outcome, responded_at FROM connection_outcomes WHERE id = $1`,
      [id],
    );
    assert.equal(after1[0].outcome, 'helpful');
    const respondedAt = after1[0].responded_at;
    assert.ok(respondedAt);

    const second = await rateConnectionOutcome(id, 'discord', userId, false);
    assert.equal(second, 'already_recorded', 'a second call is a no-op, not an overwrite');

    const { rows: after2 } = await pool.query(
      `SELECT outcome, responded_at FROM connection_outcomes WHERE id = $1`,
      [id],
    );
    assert.equal(after2[0].outcome, 'helpful', 'outcome is unchanged by the second call');
    assert.deepEqual(after2[0].responded_at, respondedAt, 'responded_at is unchanged by the second call');
  },
);

test(
  'SECURITY: rateConnectionOutcome returns the identical "not_found" result for an unknown id and for an id belonging to a different member (issue #1354 acceptance criterion 4)',
  { skip },
  async () => {
    const ownerId = `${RUN}-rate-owner`;
    const otherId = `${RUN}-rate-other`;
    await recordConnectionOutcome('find_helper', 'discord', ownerId);
    const { rows } = await pool.query(
      `SELECT id FROM connection_outcomes WHERE requester_platform = 'discord' AND requester_user_id = $1`,
      [ownerId],
    );
    const ownedId = Number(rows[0].id);
    const unknownId = ownedId + 1_000_000;

    const forUnknownId = await rateConnectionOutcome(unknownId, 'discord', otherId, true);
    const forSomeoneElsesId = await rateConnectionOutcome(ownedId, 'discord', otherId, true);

    assert.equal(forUnknownId, 'not_found');
    assert.equal(forSomeoneElsesId, 'not_found');
    assert.equal(
      forUnknownId,
      forSomeoneElsesId,
      'an unknown id and a real id owned by someone else must be indistinguishable',
    );

    const { rows: ownerRow } = await pool.query(
      `SELECT outcome, responded_at FROM connection_outcomes WHERE id = $1`,
      [ownedId],
    );
    assert.equal(ownerRow[0].outcome, null, "the owner's row must be unaffected by another caller's attempt");
    assert.equal(ownerRow[0].responded_at, null);
  },
);

test(
  'countConnectionOutcomesSince aggregates total/responded/helpful over the window, excluding rows before it',
  { skip },
  async () => {
    const since = new Date();
    const inWindowHelpful = `${RUN}-agg-helpful`;
    const inWindowNotHelpful = `${RUN}-agg-nothelpful`;
    const inWindowUnresponded = `${RUN}-agg-unresponded`;
    const beforeWindow = `${RUN}-agg-before`;

    await recordConnectionOutcome('find_helper', 'discord', inWindowHelpful);
    await recordConnectionOutcome('project_connection', 'discord', inWindowNotHelpful);
    await recordConnectionOutcome('find_helper', 'discord', inWindowUnresponded);
    await recordConnectionOutcome('find_helper', 'discord', beforeWindow);
    await pool.query(`UPDATE connection_outcomes SET created_at = $2 WHERE requester_user_id = $1`, [
      beforeWindow,
      new Date(since.getTime() - 3_600_000),
    ]);

    for (const [userId, helpful] of [
      [inWindowHelpful, true],
      [inWindowNotHelpful, false],
    ] as const) {
      const { rows } = await pool.query(
        `SELECT id FROM connection_outcomes WHERE requester_platform = 'discord' AND requester_user_id = $1`,
        [userId],
      );
      await rateConnectionOutcome(Number(rows[0].id), 'discord', userId, helpful);
    }

    const stats = await countConnectionOutcomesSince(since);
    assert.equal(stats.total, 3, 'the pre-window row is excluded from the total');
    assert.equal(stats.responded, 2);
    assert.equal(stats.helpful, 1);
  },
);

test(
  "SECURITY: purgeUserData erases a caller's own connection_outcomes rows — the purge contributor connectionOutcomes.ts registers (issue #1354 acceptance criterion 6)",
  { skip },
  async () => {
    const userId = `${RUN}-purge`;
    await recordConnectionOutcome('find_helper', 'discord', userId);

    const { rows: before } = await pool.query(
      `SELECT 1 FROM connection_outcomes WHERE requester_platform = 'discord' AND requester_user_id = $1`,
      [userId],
    );
    assert.equal(before.length, 1, 'precondition: the row exists before purging');

    await purgeUserData('discord', userId);

    const { rows: after } = await pool.query(
      `SELECT 1 FROM connection_outcomes WHERE requester_platform = 'discord' AND requester_user_id = $1`,
      [userId],
    );
    assert.equal(
      after.length,
      0,
      "forget_me/purge_user_data must erase the caller's connection_outcomes rows",
    );
  },
);

test(
  "SECURITY: purgeUserData for one member never erases a different member's connection_outcomes row",
  { skip },
  async () => {
    const victimId = `${RUN}-purge-victim`;
    const otherId = `${RUN}-purge-other`;
    await recordConnectionOutcome('find_helper', 'discord', victimId);
    await recordConnectionOutcome('find_helper', 'discord', otherId);

    await purgeUserData('discord', otherId);

    const { rows } = await pool.query(
      `SELECT 1 FROM connection_outcomes WHERE requester_platform = 'discord' AND requester_user_id = $1`,
      [victimId],
    );
    assert.equal(rows.length, 1, "another member's purge must never remove the victim's own row");
  },
);
