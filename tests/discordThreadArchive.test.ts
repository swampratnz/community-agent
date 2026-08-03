import { test } from 'node:test';
import assert from 'node:assert/strict';
// The adapters take their community text pack as a required constructor
// parameter now (agent-base plan item 6) — production hands it over in
// src/platforms/factories.ts, so these constructions pass the same pack.
import { DISCORD_TEXT_PACK } from '../src/platforms/textPacks.js';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/strings/notices.js';

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
function fireMessageUpdate(adapter: Adapter, oldMsg: unknown, newMsg: unknown): Promise<void> {
  return (
    adapter as unknown as { onMessageUpdate: (o: unknown, n: unknown) => Promise<void> }
  ).onMessageUpdate(oldMsg, newMsg);
}

function threadEdit(parentId: string, content = 'edited in a thread') {
  return {
    partial: false,
    guildId: 'guild-thr',
    channelId: 'thread-1', // the thread's own id — this is what the stored row is keyed on
    id: 'msg-1',
    channel: { isThread: () => true, parentId },
    author: { bot: false },
    member: { displayName: 'Tester' },
    content,
  };
}

test('SECURITY: a thread message edit/delete is honoured when its PARENT channel is allowlisted, matching the intake gate (issue #48 thread parity)', async (t) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return { rowCount: 0, rows: [] };
  });

  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);

  // Parent IS allowlisted → scope resolves to the parent → honoured. The DB
  // update is keyed on the THREAD id (where the row was stored), not the parent.
  await fireMessageUpdate(adapter, threadEdit('parent-allowed', 'before'), threadEdit('parent-allowed'));
  const upd = calls.find((c) => /UPDATE interactions/.test(c.sql));
  assert.ok(upd, 'a thread edit under an allowlisted parent must reach the stored-copy update');
  assert.equal(
    upd.params[1],
    'thread-1',
    'the update is keyed on the thread id (the stored conversation_id), not the parent',
  );

  // Parent is NOT allowlisted → out of scope → never honoured.
  calls.length = 0;
  await fireMessageUpdate(adapter, threadEdit('parent-other', 'before'), threadEdit('parent-other'));
  assert.equal(
    calls.some((c) => /UPDATE interactions/.test(c.sql)),
    false,
    'a thread whose parent is not allowlisted stays out of archive scope',
  );
});

test('SECURITY: with DISCORD_MODERATION_ENABLED unset (default), a genuinely content-changed edit never reaches Moderator.scan() — byte-identical to pre-#798 archive-sync-only behaviour (issue #798)', async (t) => {
  t.mock.method(pool, 'query', async () => ({ rowCount: 0, rows: [] }));
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const scanCalls: unknown[] = [];
  t.mock.method(
    (adapter as unknown as { moderator: { scan: (ctx: unknown) => Promise<void> } }).moderator,
    'scan',
    async (ctx: unknown) => {
      scanCalls.push(ctx);
    },
  );

  await fireMessageUpdate(
    adapter,
    threadEdit('parent-allowed', 'clean text'),
    threadEdit('parent-allowed', 'clean text turned abusive'),
  );

  assert.equal(
    scanCalls.length,
    0,
    'Moderator.scan() must never be invoked while DISCORD_MODERATION_ENABLED is off, regardless of a real content change',
  );
});
