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

const { BaileysAdapter } = await import('../src/platforms/whatsapp/baileysAdapter.js');

/**
 * Stubs the Baileys socket so sendMessage / sendDirectMessage can be
 * exercised without a real WhatsApp connection — mirrors the network-mocking
 * style used for the Cloud WhatsApp adapter in whatsappCloudAdapter.test.ts.
 */
function stubSocket(adapter: InstanceType<typeof BaileysAdapter>) {
  const sent: string[] = [];
  (
    adapter as unknown as { sock: { sendMessage: (jid: string, msg: { text: string }) => Promise<void> } }
  ).sock = {
    sendMessage: async (_jid, msg) => {
      sent.push(msg.text);
    },
  };
  return sent;
}

test('SECURITY: sendMessage routes through filterOutbound — a secret cannot reach a WhatsApp chat unredacted', async () => {
  const adapter = new BaileysAdapter();
  const sent = stubSocket(adapter);
  await adapter.sendMessage({
    conversationId: '64211234567@s.whatsapp.net',
    text: 'secret is sk-ant-' + 'y'.repeat(30) + ' end',
  });
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes('sk-ant-'), 'no raw secret fragment may reach the chat');
  assert.ok(sent[0].includes('[redacted]'), 'the secret must have been redacted, not silently dropped');
});

test('SECURITY: sendDirectMessage routes through filterOutbound — a secret cannot reach a WhatsApp DM unredacted', async () => {
  const adapter = new BaileysAdapter();
  const sent = stubSocket(adapter);
  await adapter.sendDirectMessage('64211234567', 'secret is sk-ant-' + 'y'.repeat(30) + ' end');
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes('sk-ant-'), 'no raw secret fragment may reach the DM');
  assert.ok(sent[0].includes('[redacted]'), 'the secret must have been redacted, not silently dropped');
});
