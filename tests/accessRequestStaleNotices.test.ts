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
const { recordAccessRequestStaleNotice, pruneAccessRequestStaleNotices } =
  await import('../src/module/storage/accessRequestStaleNotices.js');

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function hasNoticeRow(platform: 'discord' | 'whatsapp', userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM access_request_stale_notices WHERE platform = $1 AND platform_user_id = $2',
    [platform, userId],
  );
  return rows.length > 0;
}

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM access_request_stale_notices WHERE platform_user_id LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

test(
  'SECURITY: recordAccessRequestStaleNotice returns true only the first time for a given (platform, userId) — a second tick for the same still-stale guest is a no-op (issue #1421 acceptance criterion)',
  { skip },
  async () => {
    const userId = `${RUN}-idempotent`;

    const firstInsert = await recordAccessRequestStaleNotice('discord', userId);
    assert.equal(firstInsert, true, 'the first call must report a fresh insert');

    const secondInsert = await recordAccessRequestStaleNotice('discord', userId);
    assert.equal(secondInsert, false, 'ON CONFLICT DO NOTHING must make the second call a no-op');

    assert.ok(await hasNoticeRow('discord', userId), 'exactly one row must exist after both calls');
  },
);

test(
  'recordAccessRequestStaleNotice keys on the full (platform, userId) pair — the same userId on a different platform is a distinct row',
  { skip },
  async () => {
    const userId = `${RUN}-cross-platform`;

    const discordInsert = await recordAccessRequestStaleNotice('discord', userId);
    const whatsappInsert = await recordAccessRequestStaleNotice('whatsapp', userId);

    assert.equal(discordInsert, true);
    assert.equal(
      whatsappInsert,
      true,
      'the same userId on a different platform must be its own row, not a conflict',
    );
  },
);

test(
  'SECURITY: pruneAccessRequestStaleNotices deletes a notice row whose key is absent from activeKeys, and leaves a present-key row untouched (issue #1421 acceptance criterion)',
  { skip },
  async () => {
    const staleUserId = `${RUN}-prune-orphan`;
    const activeUserId = `${RUN}-prune-active`;
    await recordAccessRequestStaleNotice('discord', staleUserId);
    await recordAccessRequestStaleNotice('discord', activeUserId);

    await pruneAccessRequestStaleNotices([{ platform: 'discord', userId: activeUserId }]);

    assert.equal(
      await hasNoticeRow('discord', staleUserId),
      false,
      'a notice row absent from activeKeys must be deleted',
    );
    assert.equal(
      await hasNoticeRow('discord', activeUserId),
      true,
      'a notice row present in activeKeys must survive the prune',
    );
  },
);

test(
  'pruneAccessRequestStaleNotices with an empty activeKeys deletes every existing row — nothing pending means every notice is an orphan',
  { skip },
  async () => {
    const userId = `${RUN}-prune-empty`;
    await recordAccessRequestStaleNotice('discord', userId);

    await pruneAccessRequestStaleNotices([]);

    assert.equal(await hasNoticeRow('discord', userId), false);
  },
);

test(
  "SECURITY: forget_me/purge_user_data erases a caller's own access_request_stale_notices row via the registered purge contributor, independent of the next tick's prune (issue #1421 acceptance criterion)",
  { skip },
  async () => {
    const userId = `${RUN}-purge`;
    await recordAccessRequestStaleNotice('discord', userId);
    assert.ok(await hasNoticeRow('discord', userId), 'precondition: the row exists before purging');

    await purgeUserData('discord', userId);

    assert.equal(
      await hasNoticeRow('discord', userId),
      false,
      "forget_me/purge_user_data must erase the caller's access_request_stale_notices row",
    );
  },
);
