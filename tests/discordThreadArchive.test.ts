import { test } from 'node:test';
import assert from 'node:assert/strict';

// A message posted in a thread reports the THREAD's id as `channelId`, not its
// parent's. This file pins that archive/allowlist scope decisions resolve a
// thread to its parent consistently across BOTH the intake gate
// (onDiscordMessage) and the delete/edit-honouring path (onMessageUpdate /
// MessageDelete) — otherwise a thread message under an allowlisted parent
// gets archived but its later edit/delete is never honoured (a privacy
// regression, issue #48). Needs an allowlist configured, which config.ts
// parses once at import, so it lives in its own file/process.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID = 'guild-thr';
process.env.DISCORD_ALLOWED_CHANNEL_IDS = 'parent-allowed';
process.env.DISCORD_ARCHIVE_ALL_MESSAGES = 'true';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { DiscordAdapter } = await import('../src/platforms/discord/adapter.js');
const { pool } = await import('../src/storage/db.js');

type Adapter = InstanceType<typeof DiscordAdapter>;

/** Reaches the private onMessageUpdate handler directly (the delete listeners are inline arrows in start()). */
function fireMessageUpdate(adapter: Adapter, msg: unknown): Promise<void> {
  return (adapter as unknown as { onMessageUpdate: (m: unknown) => Promise<void> }).onMessageUpdate(msg);
}

function threadEdit(parentId: string) {
  return {
    partial: false,
    guildId: 'guild-thr',
    channelId: 'thread-1', // the thread's own id — this is what the stored row is keyed on
    id: 'msg-1',
    channel: { isThread: () => true, parentId },
    author: { bot: false },
    content: 'edited in a thread',
  };
}

test('SECURITY: a thread message edit/delete is honoured when its PARENT channel is allowlisted, matching the intake gate (issue #48 thread parity)', async (t) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return { rowCount: 0, rows: [] };
  });

  const adapter = new DiscordAdapter();

  // Parent IS allowlisted → scope resolves to the parent → honoured. The DB
  // update is keyed on the THREAD id (where the row was stored), not the parent.
  await fireMessageUpdate(adapter, threadEdit('parent-allowed'));
  const upd = calls.find((c) => /UPDATE interactions/.test(c.sql));
  assert.ok(upd, 'a thread edit under an allowlisted parent must reach the stored-copy update');
  assert.equal(
    upd.params[1],
    'thread-1',
    'the update is keyed on the thread id (the stored conversation_id), not the parent',
  );

  // Parent is NOT allowlisted → out of scope → never honoured.
  calls.length = 0;
  await fireMessageUpdate(adapter, threadEdit('parent-other'));
  assert.equal(
    calls.some((c) => /UPDATE interactions/.test(c.sql)),
    false,
    'a thread whose parent is not allowlisted stays out of archive scope',
  );
});
