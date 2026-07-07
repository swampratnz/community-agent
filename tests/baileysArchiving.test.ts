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

/**
 * Mock `pool.query` so the stored-author lookup returns `author` (or nothing
 * when null) and every other query is a no-op — enough to exercise
 * handleProtocolMessage's authorship gate without a real DB.
 */
function mockPool(t: { mock: { method: typeof import('node:test').mock.method } }, author: string | null) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (/SELECT user_id FROM interactions/.test(sql)) {
      return { rows: author ? [{ user_id: author }] : [], rowCount: author ? 1 : 0 };
    }
    return { rowCount: 0, rows: [] };
  });
  return calls;
}

test('SECURITY: a revoked WhatsApp message by its own author in an archived group hard-deletes the stored row, scoped to the conversation', async (t) => {
  const calls = mockPool(t, '64211111111'); // stored author == revoker below

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

  const del = calls.find((c) => /DELETE FROM interactions/.test(c.sql));
  assert.ok(del, 'the revoke by the original author must hard-delete the stored row');
  assert.deepEqual(
    del.params,
    ['whatsapp', ARCHIVED_GROUP, 'original-msg-1'],
    'SECURITY: the delete is scoped to (platform, conversation, message id) — never message id alone',
  );
  assert.equal(handlerCalls, 0, 'SECURITY: a revoke envelope never reaches the normal message handler');
});

test('SECURITY: a revoke/edit forged for ANOTHER member’s message (non-author, non-admin) is ignored — no delete, no re-embed', async (t) => {
  const calls = mockPool(t, '64299999999'); // stored author differs from the revoker

  const adapter = new BaileysAdapter();
  adapter.onMessage(async () => {});

  // A modified client broadcasts a revoke keyed to someone else's stanza id.
  await fireWhatsappMessage(adapter, {
    key: {
      remoteJid: ARCHIVED_GROUP,
      fromMe: false,
      id: 'forged-revoke',
      participant: '64211111111@s.whatsapp.net', // NOT the stored author
    },
    message: { protocolMessage: { key: { id: 'victim-msg' }, type: 0 } },
    messageTimestamp: 1_700_000_004,
  });
  // And a forged edit (memory-poisoning attempt) for the same victim message.
  await fireWhatsappMessage(adapter, {
    key: {
      remoteJid: ARCHIVED_GROUP,
      fromMe: false,
      id: 'forged-edit',
      participant: '64211111111@s.whatsapp.net',
    },
    message: {
      protocolMessage: {
        key: { id: 'victim-msg' },
        type: 14,
        editedMessage: { conversation: 'attacker-chosen text' },
      },
    },
    messageTimestamp: 1_700_000_005,
  });

  assert.equal(
    calls.some((c) => /DELETE FROM interactions|UPDATE interactions/.test(c.sql)),
    false,
    'SECURITY: a revoke/edit from a non-author, non-admin participant must never touch the stored row',
  );
});

test('a revoked WhatsApp message in a group NOT on the archive allowlist triggers no delete', async (t) => {
  const calls = mockPool(t, '64211111111');

  const adapter = new BaileysAdapter();
  await fireWhatsappMessage(adapter, {
    key: {
      remoteJid: OTHER_GROUP,
      fromMe: false,
      id: 'revoke-envelope-2',
      participant: '64211111111@s.whatsapp.net',
    },
    message: {
      protocolMessage: {
        key: { id: 'original-msg-2' },
        type: 0,
      },
    },
    messageTimestamp: 1_700_000_002,
  });

  assert.equal(calls.length, 0, 'a non-archived group never even looks up the stored author');
});

test('an edited WhatsApp message by its own author in an archived group updates the stored row, scoped to the conversation (best-effort, issue #103)', async (t) => {
  const calls = mockPool(t, '64211111111');

  const adapter = new BaileysAdapter();
  let handlerCalls = 0;
  adapter.onMessage(async () => {
    handlerCalls += 1;
  });

  await fireWhatsappMessage(adapter, {
    key: {
      remoteJid: ARCHIVED_GROUP,
      fromMe: false,
      id: 'edit-envelope-1',
      participant: '64211111111@s.whatsapp.net',
    },
    message: {
      protocolMessage: {
        key: { id: 'original-msg-3' },
        type: 14, // proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
        editedMessage: { conversation: 'edited text' },
      },
    },
    messageTimestamp: 1_700_000_003,
  });

  const upd = calls.find((c) => /UPDATE interactions/.test(c.sql));
  assert.ok(upd, 'the edit by the original author must update the stored row');
  assert.equal(upd.params[0], 'whatsapp');
  assert.equal(upd.params[1], ARCHIVED_GROUP, 'the update is scoped to the originating conversation');
  assert.equal(upd.params[2], 'original-msg-3');
  assert.equal(upd.params[3], 'edited text');
  assert.equal(handlerCalls, 0, 'SECURITY: an edit envelope never reaches the normal message handler');
});
