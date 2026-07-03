import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it. DATABASE_URL
// points nowhere; policy reads fail and fall back to defaults (see
// src/storage/policies.ts), so no real DB is needed for this adapter-level
// test.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { DiscordAdapter } = await import('../src/platforms/discord/adapter.js');

interface FakeSendable {
  isTextBased: () => boolean;
  send: (opts: { content: string }) => Promise<void>;
}

/**
 * Stubs the discord.js client's channel/user fetch so sendMessage /
 * sendDirectMessage can be exercised without a real gateway connection —
 * mirrors the network-mocking style used for the Cloud WhatsApp adapter in
 * whatsappCloudAdapter.test.ts.
 */
function stubClient(adapter: InstanceType<typeof DiscordAdapter>) {
  const sent: string[] = [];
  const record = async (opts: { content: string }) => {
    sent.push(opts.content);
  };
  const client = (
    adapter as unknown as {
      client: {
        channels: { fetch: (id: string) => Promise<FakeSendable> };
        users: { fetch: (id: string) => Promise<FakeSendable> };
      };
    }
  ).client;
  client.channels.fetch = async () => ({ isTextBased: () => true, send: record });
  client.users.fetch = async () => ({ isTextBased: () => true, send: record });
  return sent;
}

test('SECURITY: sendMessage routes through filterOutbound — a secret cannot reach a Discord channel unredacted', async () => {
  const adapter = new DiscordAdapter();
  const sent = stubClient(adapter);
  await adapter.sendMessage({
    conversationId: 'chan-1',
    text: 'secret is sk-ant-' + 'y'.repeat(30) + ' end',
  });
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes('sk-ant-'), 'no raw secret fragment may reach the channel');
  assert.ok(sent[0].includes('[redacted]'), 'the secret must have been redacted, not silently dropped');
});

test('SECURITY: sendDirectMessage routes through filterOutbound — a secret cannot reach a Discord DM unredacted', async () => {
  const adapter = new DiscordAdapter();
  const sent = stubClient(adapter);
  await adapter.sendDirectMessage('user-1', 'secret is sk-ant-' + 'y'.repeat(30) + ' end');
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes('sk-ant-'), 'no raw secret fragment may reach the DM');
  assert.ok(sent[0].includes('[redacted]'), 'the secret must have been redacted, not silently dropped');
});
