import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// create_thread's defensive self-refuse guard (issue #229 adversarial review:
// a bot-created thread must never open a space moderation wouldn't scan)
// reads config.moderation.enabled + config.discord.allowedChannelIds, both
// parsed once at config.ts import time — needs its own file/process, same
// reason tests/discordThreadArchive.test.ts lives separately.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= 'guild-thread-guard';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.DISCORD_MODERATION_ENABLED = 'true';
process.env.DISCORD_ALLOWED_CHANNEL_IDS = 'parent-allowed';

// isKnownConversation is a real DB query with no fallback (src/storage/
// repository.ts), so any test that reaches it (target !== caller's own
// conversation) needs a real Postgres — skip cleanly without one, matching
// CLAUDE.md's DB-integration convention (tests/tools.test.ts's `skip`).
const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { buildToolServer } = await import('../src/agent/tools.js');

function stubAdapter(
  performAdminAction: PlatformAdapter['performAdminAction'],
  canPostTo?: PlatformAdapter['canPostTo'],
): PlatformAdapter {
  return {
    platform: 'discord',
    start: async () => {},
    stop: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    sendMessage: async () => {},
    sendDirectMessage: async () => {},
    conversationsForUser: async () => ['parent-allowed', 'parent-not-allowed'],
    adminCapabilities: new Set(['create_thread']),
    performAdminAction,
    ...(canPostTo ? { canPostTo } : {}),
  };
}

function createThreadHandler(adapter: PlatformAdapter, conversationId: string) {
  const server = buildToolServer(
    {
      platform: 'discord',
      userId: 'admin-1',
      userName: 'Admin',
      role: 'admin',
      conversationId,
    },
    adapter,
  );
  return (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (args: {
            name: string;
            channelId?: string;
            seedMessageId?: string;
          }) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
        }
      >;
    }
  )._registeredTools['create_thread'];
}

test('SECURITY: create_thread self-refuses under a moderation allowlist that excludes the target parent channel (issue #229 — a bot-created thread must never open an unmoderated space)', async () => {
  const adapter = stubAdapter(async () => {
    throw new Error('performAdminAction must never be reached when the guard refuses');
  });
  const handler = createThreadHandler(adapter, 'parent-not-allowed');
  const result = await handler.handler({ name: 'Off-topic' });
  assert.match(result.content[0]?.text ?? '', /would not be moderation-scanned/);
  assert.equal(result.isError, true);
});

test('create_thread proceeds when the target parent channel IS on the moderation allowlist (issue #229)', async () => {
  const calls: Array<string | undefined> = [];
  const adapter = stubAdapter(async (action) => {
    calls.push(action.conversationId);
    return 'Created thread "General chat" (thread-99).';
  });
  const handler = createThreadHandler(adapter, 'parent-allowed');
  const result = await handler.handler({ name: 'General chat' });
  assert.equal(result.isError, false);
  assert.deepEqual(calls, ['parent-allowed']);
});

test(
  "SECURITY: create_thread's moderation-allowlist self-refuse still fires for an off-allowlist parent " +
    'even when the canPostTo fallback (issue #270) would otherwise let the target through — the guard ' +
    'runs after, and independently of, the isKnownConversation/canPostTo check',
  { skip },
  async () => {
    const targetChannel = 'parent-not-allowed-canposto-fallback';
    const adapter: PlatformAdapter = {
      ...stubAdapter(async () => {
        throw new Error('performAdminAction must never be reached when the guard refuses');
      }),
      conversationsForUser: async () => [targetChannel],
      canPostTo: async () => true,
    };
    const handler = createThreadHandler(adapter, 'convo-mine-canposto-guard');
    const result = await handler.handler({ name: 'Off-topic', channelId: targetChannel });
    assert.match(result.content[0]?.text ?? '', /would not be moderation-scanned/);
    assert.equal(result.isError, true);
  },
);
