import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import type { IncomingMessage } from '../src/platforms/types.js';

// Issue #575's auto-retraction feature, flag OFF (AUTO_RETRACT_REPLY_ENABLED
// deliberately left unset — config.ts's default `false`). Lives in its own
// file/process (config.ts parses env once at import) so the flag-on
// behaviour in tests/replyRetractionRouter.test.ts can't leak into this
// file's "byte-identical" assertions, mirroring the split already used for
// tests/ambientArchiving.test.ts / tests/ambientArchivingOff.test.ts.
//
// DISCORD_ARCHIVE_ALL_MESSAGES is turned ON here (issue #595): it makes the
// MessageDelete/MessageBulkDelete listeners actually get registered (the
// registration gate is `archiveAllMessages || autoRetractReplyEnabled`) even
// though retraction itself is off, so the "regardless of archiveAllMessages"
// half of acceptance criterion 1/5 is exercised for real instead of trivially
// passing because the listener was never wired up.
process.env.DISCORD_ARCHIVE_ALL_MESSAGES = 'true';
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'baileys';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-575-off-discord';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS ??= '64277000001';

const { config } = await import('../src/config.js');
const { Router } = await import('../src/router.js');
const { DiscordAdapter } = await import('../src/platforms/discord/adapter.js');
const { BaileysAdapter } = await import('../src/platforms/whatsapp/baileysAdapter.js');
const { pool, closeDb } = await import('../src/storage/db.js');

const RUN = `retract-off-${Date.now()}`;

after(async () => {
  await pool.query(`DELETE FROM interactions WHERE conversation_id LIKE $1`, [`${RUN}%`]).catch(() => {});
  await closeDb();
});

// Sanity: this whole file's premise depends on the flag actually being off
// (and, for the bulk-delete SECURITY test below, archiving actually being on).
assert.equal(
  config.behaviour.autoRetractReplyEnabled,
  false,
  'AUTO_RETRACT_REPLY_ENABLED must be unset for this file',
);
assert.equal(
  config.discord.archiveAllMessages,
  true,
  'DISCORD_ARCHIVE_ALL_MESSAGES must be on for this file (issue #595)',
);

type DiscordAdapterInstance = InstanceType<typeof DiscordAdapter>;
type BaileysAdapterInstance = InstanceType<typeof BaileysAdapter>;

/** Stubs client.channels.fetch with a fake channel that records sends and deletes, mirroring tests/discordAdapter.test.ts's monkey-patch style. */
function stubDiscordChannel(adapter: DiscordAdapterInstance) {
  const sentMessages = new Map<string, { deleted: boolean }>();
  let counter = 0;
  const channel = {
    isTextBased: () => true,
    async send() {
      counter += 1;
      const id = `${RUN}-discord-reply-${counter}`;
      sentMessages.set(id, { deleted: false });
      return { id };
    },
    messages: {
      async fetch(id: string) {
        const rec = sentMessages.get(id);
        if (!rec) throw new Error(`unknown message ${id}`);
        return {
          async delete() {
            rec.deleted = true;
          },
        };
      },
    },
  };
  (adapter as unknown as { client: { channels: { fetch: () => Promise<unknown> } } }).client.channels.fetch =
    async () => channel;
  return { sentMessages };
}

function getHandler(adapter: { handler?: (m: IncomingMessage) => Promise<void> | void }) {
  const handler = (adapter as unknown as { handler: (m: IncomingMessage) => Promise<void> | void }).handler;
  if (!handler) throw new Error('router.register() was never called');
  return handler;
}

function fireDiscordDelete(adapter: DiscordAdapterInstance, conversationId: string, messageId: string) {
  return (
    adapter as unknown as { retractReplyIfMapped: (c: string, m: string) => Promise<void> }
  ).retractReplyIfMapped(conversationId, messageId);
}

/** Fake Baileys sock — sendMessage distinguishes a normal send from a `{ delete }` revoke call. */
function stubBaileysSocket(adapter: BaileysAdapterInstance) {
  const deleteCalls: Array<{ jid: string; id: string }> = [];
  let counter = 0;
  const sock = {
    async sendMessage(jid: string, content: { text?: string; delete?: { id: string } }) {
      if (content.delete) {
        deleteCalls.push({ jid, id: content.delete.id });
        return undefined;
      }
      counter += 1;
      const id = `${RUN}-wa-reply-${counter}`;
      return { key: { id, remoteJid: jid, fromMe: true }, message: { conversation: content.text } };
    },
    async sendPresenceUpdate() {},
    async groupMetadata() {
      return { participants: [] };
    },
  };
  (adapter as unknown as { sock: unknown }).sock = sock;
  return { deleteCalls };
}

function fireWhatsappRevoke(
  adapter: BaileysAdapterInstance,
  remoteJid: string,
  revokerNumber: string,
  targetId: string,
) {
  return (adapter as unknown as { onWhatsappMessage: (m: unknown) => Promise<void> }).onWhatsappMessage({
    key: {
      remoteJid,
      fromMe: false,
      id: `${RUN}-revoke-${targetId}`,
      participant: `${revokerNumber}@s.whatsapp.net`,
    },
    message: { protocolMessage: { key: { id: targetId }, type: 0 } },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
}

test('SECURITY: with AUTO_RETRACT_REPLY_ENABLED unset, deleting/revoking a message the bot replied to leaves the reply untouched and invokes deleteOwnMessage on NEITHER Discord NOR WhatsApp Baileys (acceptance criteria 1 + 5)', async (t) => {
  // --- Discord ---
  const discordRouter = new Router(async () => ({ text: 'here is your answer', ok: true }), 1_000_000);
  const discordAdapter = new DiscordAdapter();
  const { sentMessages } = stubDiscordChannel(discordAdapter);
  discordRouter.register(discordAdapter);
  const discordHandler = getHandler(discordAdapter);
  const discordDeleteSpy = t.mock.method(discordAdapter, 'deleteOwnMessage');

  const conversationId = `${RUN}-chan`;
  const messageId = `${RUN}-origin`;
  await discordHandler({
    platform: 'discord',
    conversationId,
    userId: 'super-575-off-discord',
    userName: 'Admin',
    text: `${RUN} question`,
    isDirect: false,
    addressedToBot: true,
    messageId,
    timestamp: Date.now(),
  });

  assert.equal(sentMessages.size, 1, 'the reply is still sent normally — byte-identical happy path');
  const [replyId] = [...sentMessages.keys()];
  assert.equal(sentMessages.get(replyId)?.deleted, false);

  // Simulate the platform reporting the addressed message was deleted —
  // even probing the retraction primitive directly (bypassing whether the
  // MessageDelete listener itself is registered) finds nothing to retract,
  // because the router never wrote a mapping while the flag was off.
  await fireDiscordDelete(discordAdapter, conversationId, messageId);
  assert.equal(
    discordDeleteSpy.mock.calls.length,
    0,
    'SECURITY: Discord deleteOwnMessage must never be called when the flag is off',
  );
  assert.equal(sentMessages.get(replyId)?.deleted, false, "the bot's reply remains untouched");

  // --- WhatsApp Baileys ---
  const waRouter = new Router(async () => ({ text: 'here is your answer', ok: true }), 1_000_000);
  const waAdapter = new BaileysAdapter();
  const { deleteCalls } = stubBaileysSocket(waAdapter);
  waRouter.register(waAdapter);
  const waHandler = getHandler(waAdapter);
  const waDeleteSpy = t.mock.method(waAdapter, 'deleteOwnMessage');

  const groupJid = `${RUN}-group@g.us`;
  const senderA = '64277000001'; // the SAME super-admin number that will "revoke" — the true, genuine author
  const waMessageId = `${RUN}-wa-origin`;
  await waHandler({
    platform: 'whatsapp',
    conversationId: groupJid,
    userId: senderA,
    userName: 'Member A',
    text: `${RUN} question`,
    isDirect: false,
    addressedToBot: true,
    messageId: waMessageId,
    timestamp: Date.now(),
  });

  // Even a revoke from the TRUE original sender must do nothing — proving
  // the flag gates the feature at its source (the router never records a
  // mapping), not merely at the WhatsApp authorship check.
  await fireWhatsappRevoke(waAdapter, groupJid, senderA, waMessageId);
  assert.equal(
    waDeleteSpy.mock.calls.length,
    0,
    'SECURITY: WhatsApp deleteOwnMessage must never be called when the flag is off, even for a genuine-author revoke',
  );
  assert.equal(deleteCalls.length, 0);
});

test(
  'SECURITY: firing the REAL client MessageBulkDelete gateway listener with AUTO_RETRACT_REPLY_ENABLED unset ' +
    'never calls deleteOwnMessage, even though DISCORD_ARCHIVE_ALL_MESSAGES is on for this file (so the ' +
    'listener IS registered and its archive-scoped branch DOES fire) — acceptance criteria 1 + 5 (issue #595)',
  async (t) => {
    const router = new Router(async () => ({ text: 'here is your answer', ok: true }), 1_000_000);
    const adapter = new DiscordAdapter();
    const { sentMessages } = stubDiscordChannel(adapter);
    router.register(adapter);
    const handler = getHandler(adapter);
    const deleteSpy = t.mock.method(adapter, 'deleteOwnMessage');

    const client = (
      adapter as unknown as {
        client: {
          emit: (event: string, ...args: unknown[]) => void;
          login: (token: string) => Promise<void>;
        };
      }
    ).client;
    // start() wires the real gateway listeners under test but also logs in
    // for real — stub the login call, mirroring the enabled-flag file's
    // wiring test.
    client.login = async () => {};
    await adapter.start();

    const conversationId = `${RUN}-chan-bulk`;
    const messageId = `${RUN}-origin-bulk`;
    await handler({
      platform: 'discord',
      conversationId,
      userId: 'super-575-off-discord',
      userName: 'Admin',
      text: `${RUN} question`,
      isDirect: false,
      addressedToBot: true,
      messageId,
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.size, 1, 'the reply is still sent normally — byte-identical happy path');
    const [replyId] = [...sentMessages.keys()];

    // guildId '1' matches DISCORD_GUILD_ID above, so the archive branch's
    // `inArchiveScope` check passes and it genuinely runs (attempting —
    // and failing harmlessly against the unreachable test DATABASE_URL —
    // a `deleteInteractionByMessageId` call), proving retraction staying
    // off is independent of the archive branch firing, not just untested.
    const messages = new Map([[messageId, { channelId: conversationId, id: messageId, guildId: '1' }]]);
    client.emit(Events.MessageBulkDelete, messages, { id: conversationId });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      deleteSpy.mock.calls.length,
      0,
      'SECURITY: the real MessageBulkDelete listener must never call deleteOwnMessage when the flag is off',
    );
    assert.equal(sentMessages.get(replyId)?.deleted, false, "the bot's reply remains untouched");
  },
);
