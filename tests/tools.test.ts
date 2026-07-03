import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

// notifyMemberApproved holds all of add_member's new (issue #75) behaviour —
// deciding whether to send the approval DM and swallowing send failures. It's
// exported and tested directly here rather than through the full MCP
// tool-call transport, which the rest of add_member (upsertMember/audited/
// clearAccessRequest, all DB-backed) already exercises via repository.test.ts.
const { notifyMemberApproved } = await import('../src/agent/tools.js');

function stubAdapter(sendDirectMessage: PlatformAdapter['sendDirectMessage']): PlatformAdapter {
  return {
    platform: 'discord',
    start: async () => {},
    stop: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    sendMessage: async () => {},
    sendDirectMessage,
    conversationsForUser: async () => [],
    adminCapabilities: new Set(),
    performAdminAction: async () => {
      throw new Error('not implemented in stub');
    },
  };
}

test('notifyMemberApproved sends exactly one confirmation DM on a fresh grant', async () => {
  const calls: Array<[string, string]> = [];
  const adapter = stubAdapter(async (userId, text) => {
    calls.push([userId, text]);
  });

  await notifyMemberApproved(adapter, 'user-1', false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'user-1');
  assert.match(calls[0][1], /approved/i);
});

test('notifyMemberApproved sends nothing when the user was already a member (re-add is a no-op)', async () => {
  const calls: string[] = [];
  const adapter = stubAdapter(async (userId) => {
    calls.push(userId);
  });

  await notifyMemberApproved(adapter, 'user-1', true);

  assert.equal(calls.length, 0);
});

test('notifyMemberApproved swallows a DM failure rather than throwing (grant stays the source of truth)', async () => {
  const adapter = stubAdapter(async () => {
    throw new Error('DMs closed');
  });

  await assert.doesNotReject(notifyMemberApproved(adapter, 'user-1', false));
});
