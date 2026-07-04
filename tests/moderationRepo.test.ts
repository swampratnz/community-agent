import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Capture whether a REAL Postgres was provided BEFORE the dummy default below,
// so the after() cleanup is skipped cleanly (not run against an unreachable
// dummy) when DATABASE_URL is unset — see tests/repository.test.ts.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { addWarning, countActiveWarnings, clearWarnings, purgeUserData } =
  await import('../src/storage/repository.js');
const { pool, closeDb } = await import('../src/storage/db.js');

const RUN = `modwarn-${Date.now()}`;
const USER = `${RUN}-user`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM member_warnings WHERE user_id LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

test('addWarning + countActiveWarnings: active count reflects uncleared rows', { skip }, async () => {
  await addWarning({
    platform: 'discord',
    userId: USER,
    reason: 'bad language ("test")',
    excerpt: 'a rude message',
    source: 'auto',
    issuedBy: null,
  });
  await addWarning({
    platform: 'discord',
    userId: USER,
    reason: 'bad language ("test2")',
    excerpt: 'another rude message',
    source: 'auto',
    issuedBy: null,
  });
  assert.equal(await countActiveWarnings('discord', USER), 2);
});

test(
  'clearWarnings clears active rows, returns the count cleared, and zeroes the active count',
  {
    skip,
  },
  async () => {
    const user = `${RUN}-clear`;
    await addWarning({
      platform: 'discord',
      userId: user,
      reason: 'x',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    await addWarning({
      platform: 'discord',
      userId: user,
      reason: 'y',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    const cleared = await clearWarnings('discord', user, 'admin-1');
    assert.equal(cleared, 2, 'both active warnings were cleared');
    assert.equal(await countActiveWarnings('discord', user), 0, 'no active warnings remain');
    // Clearing again is a no-op (nothing active left).
    assert.equal(await clearWarnings('discord', user, 'admin-1'), 0);
  },
);

test(
  "SECURITY: purge_user_data deletes a member's warning history (purge coherence)",
  {
    skip,
  },
  async () => {
    const user = `${RUN}-purge`;
    await addWarning({
      platform: 'discord',
      userId: user,
      reason: 'z',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    assert.equal(await countActiveWarnings('discord', user), 1);
    await purgeUserData('discord', user);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM member_warnings WHERE platform = 'discord' AND user_id = $1`,
      [user],
    );
    assert.equal(rows[0].n, 0, 'purge_user_data removed all warning rows for the user');
  },
);
