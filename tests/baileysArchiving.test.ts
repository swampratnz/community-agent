import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from '../src/platforms/types.js';

// Wire-level tests for WhatsApp group ambient archiving (issue #103, extends
// #48): messageId population and delete/edit honouring in the Baileys
// adapter, mirroring the style of tests/baileysAdapter.test.ts and
// tests/dbDegradation.test.ts (mock `pool.query` on the shared pool
// singleton rather than a real Postgres — deleteInteractionByMessageId/
// updateInteractionByMessageId both bottom out in `pool.query`). No
// DATABASE_URL connectivity or module-mocking flag required.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const ARCHIVED_GROUP = 'wire-archived-group@g.us';
const OTHER_GROUP = 'wire-not-archived-group@g.us';
process.env.WHATSAPP_ARCHIVE_GROUP_JIDS = ARCHIVED_GROUP;

const { BaileysAdapter } = await import('../src/platforms/whatsapp/baileysAdapter.js');
const { pool } = await import('../src/storage/db.js');

/** Reaches the private onWhatsappMessage handler directly, mirroring how baileysAdapter.test.ts reaches other private members. */
function fireWhatsappMessage(
  adapter: InstanceType<typeof BaileysAdapter>,
  msg: Record<string, unknown>,
): Promise<void> {
  return (adapter as unknown as { onWhatsappMessage: (m: unknown) => Promise<void> }).onWhatsappMessage(msg);
}

test('onWhatsappMessage: populates IncomingMessage.messageId from the WhatsApp message key (issue #103)', async () => {
  const adapter = new BaileysAdapter();
  let received: IncomingMessage | undefined;
  adapter.onMessage(async (msg) => {
    received = msg;
  });

  await fireWhatsappMessage(adapter, {
    key: { remoteJid: '64211234567@s.whatsapp.net', fromMe: false, id: 'WA-MSG-1' },
    message: { conversation: 'hello there' },
    messageTimestamp: 1_700_000_000,
    pushName: 'Tester',
  });

  assert.equal(received?.messageId, 'WA-MSG-1');
  assert.equal(received?.text, 'hello there');
});

test('SECURITY: a revoked WhatsApp message in an archive-allowlisted group hard-deletes the stored row by message id', async (t) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return { rowCount: 1, rows: [] };
  });

  const adapter = new BaileysAdapter();
  let handlerCalls = 0;
  adapter.onMessage(async () => {
    handlerCalls += 1;
  });

  await fireWhatsappMessage(adapter, {
    key: {
      remoteJid: ARCHIVED_GROUP,
      fromMe: false,
      id: 'revoke-envelope-1',
      participant: '64211111111@s.whatsapp.net',
    },
    message: {
      protocolMessage: {
        key: { id: 'original-msg-1' },
        type: 0, // proto.Message.ProtocolMessage.Type.REVOKE
      },
    },
    messageTimestamp: 1_700_000_001,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /DELETE FROM interactions/);
  assert.deepEqual(calls[0].params, ['whatsapp', 'original-msg-1']);
  assert.equal(handlerCalls, 0, 'SECURITY: a revoke envelope never reaches the normal message handler');
});

test('a revoked WhatsApp message in a group NOT on the archive allowlist triggers no delete', async (t) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return { rowCount: 0, rows: [] };
  });

  const adapter = new BaileysAdapter();
  await fireWhatsappMessage(adapter, {
    key: { remoteJid: OTHER_GROUP, fromMe: false, id: 'revoke-envelope-2' },
    message: {
      protocolMessage: {
        key: { id: 'original-msg-2' },
        type: 0,
      },
    },
    messageTimestamp: 1_700_000_002,
  });

  assert.equal(calls.length, 0);
});

test('an edited WhatsApp message in an archive-allowlisted group updates the stored row by message id (best-effort, issue #103)', async (t) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return { rowCount: 1, rows: [] };
  });

  const adapter = new BaileysAdapter();
  let handlerCalls = 0;
  adapter.onMessage(async () => {
    handlerCalls += 1;
  });

  await fireWhatsappMessage(adapter, {
    key: { remoteJid: ARCHIVED_GROUP, fromMe: false, id: 'edit-envelope-1' },
    message: {
      protocolMessage: {
        key: { id: 'original-msg-3' },
        type: 14, // proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
        editedMessage: { conversation: 'edited text' },
      },
    },
    messageTimestamp: 1_700_000_003,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE interactions/);
  assert.equal(calls[0].params[0], 'whatsapp');
  assert.equal(calls[0].params[1], 'original-msg-3');
  assert.equal(calls[0].params[2], 'edited text');
  assert.equal(handlerCalls, 0, 'SECURITY: an edit envelope never reaches the normal message handler');
});
