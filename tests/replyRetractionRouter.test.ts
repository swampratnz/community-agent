import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import type { IncomingMessage } from '../src/platforms/types.js';

// Issue #575's auto-retraction feature, flag ON. Lives in its own
// file/process (config.ts parses env once at import) so this file's
// AUTO_RETRACT_REPLY_ENABLED=true never leaks into
// tests/replyRetractionDisabled.test.ts's off-by-default assertions.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'baileys';
process.env.AUTO_RETRACT_REPLY_ENABLED = 'true';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-575-discord';
// Both the WhatsApp group sender (senderA) and the admin retraction sender
// (senderC) are pre-registered so their turns get a real reply, not a gated
// notice — senderB (the spoofed revoker) is deliberately NOT listed here.
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS ??= '64211111111,64233333333';
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID ??= 'test-phone-id';
process.env.WHATSAPP_CLOUD_ACCESS_TOKEN ??= 'test-access-token';
process.env.WHATSAPP_CLOUD_VERIFY_TOKEN ??= 'test-verify-token';
process.env.WHATSAPP_CLOUD_APP_SECRET ??= 'test-app-secret';

const { config } = await import('../src/config.js');
const { Router } = await import('../src/router.js');
const { DiscordAdapter } = await import('../src/platforms/discord/adapter.js');
const { BaileysAdapter } = await import('../src/platforms/whatsapp/baileysAdapter.js');
const { WhatsAppCloudAdapter } = await import('../src/platforms/whatsapp/cloudAdapter.js');
const { pool, closeDb } = await import('../src/storage/db.js');

const RUN = `retract-on-${Date.now()}`;

after(async () => {
  await pool.query(`DELETE FROM interactions WHERE conversation_id LIKE $1`, [`${RUN}%`]).catch(() => {});
  await closeDb();
});

assert.equal(
  config.behaviour.autoRetractReplyEnabled,
  true,
  'AUTO_RETRACT_REPLY_ENABLED must be on for this file',
);

type DiscordAdapterInstance = InstanceType<typeof DiscordAdapter>;
type BaileysAdapterInstance = InstanceType<typeof BaileysAdapter>;

function makeReplyRouter() {
  return new Router(async () => ({ text: 'here is your answer', ok: true }), 1_000_000);
}

function getHandler(adapter: { handler?: (m: IncomingMessage) => Promise<void> | void }) {
  const handler = (adapter as unknown as { handler: (m: IncomingMessage) => Promise<void> | void }).handler;
  if (!handler) throw new Error('router.register() was never called');
  return handler;
}

// ---------------------------------------------------------------------------
// Discord (acceptance criteria 2 + 3)
// ---------------------------------------------------------------------------

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

function fireDiscordDelete(adapter: DiscordAdapterInstance, conversationId: string, messageId: string) {
  return (
    adapter as unknown as { retractReplyIfMapped: (c: string, m: string) => Promise<void> }
  ).retractReplyIfMapped(conversationId, messageId);
}

function discordMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'discord',
    conversationId: `${RUN}-chan`,
    userId: 'super-575-discord',
    userName: 'Admin',
    text: `${RUN} question`,
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

test('Discord: a delete of an addressed message that received a bot reply within the TTL window triggers exactly one deleteOwnMessage call for the bot reply id (acceptance criterion 2)', async (t) => {
  const router = makeReplyRouter();
  const adapter = new DiscordAdapter();
  const { sentMessages } = stubDiscordChannel(adapter);
  router.register(adapter);
  const handler = getHandler(adapter);
  const deleteSpy = t.mock.method(adapter, 'deleteOwnMessage');

  const conversationId = `${RUN}-chan-ac2`;
  const messageId = `${RUN}-origin-ac2`;
  await handler(discordMessage({ conversationId, messageId }));

  assert.equal(sentMessages.size, 1, 'exactly one reply was sent');
  const [replyId] = [...sentMessages.keys()];
  assert.equal(sentMessages.get(replyId)?.deleted, false);

  await fireDiscordDelete(adapter, conversationId, messageId);

  assert.equal(deleteSpy.mock.calls.length, 1, 'exactly one deleteOwnMessage call');
  assert.deepEqual(deleteSpy.mock.calls[0].arguments, [conversationId, replyId]);
  assert.equal(sentMessages.get(replyId)?.deleted, true, 'the bot reply was actually retracted');

  // A second delete event for the same origin message (e.g. a duplicate
  // gateway dispatch) must not attempt a second retraction — the mapping is
  // single-use.
  await fireDiscordDelete(adapter, conversationId, messageId);
  assert.equal(
    deleteSpy.mock.calls.length,
    1,
    'single-use: a duplicate delete event calls deleteOwnMessage again = 0 extra times',
  );
});

test('Discord: no false positives — an unaddressed/ambient message with no mapped reply triggers zero deleteOwnMessage calls (acceptance criterion 3)', async (t) => {
  const router = makeReplyRouter();
  const adapter = new DiscordAdapter();
  stubDiscordChannel(adapter);
  router.register(adapter);
  const handler = getHandler(adapter);
  const deleteSpy = t.mock.method(adapter, 'deleteOwnMessage');

  const conversationId = `${RUN}-chan-ac3a`;
  const messageId = `${RUN}-ambient-ac3a`;
  await handler(discordMessage({ conversationId, messageId, addressedToBot: false }));

  await fireDiscordDelete(adapter, conversationId, messageId);
  assert.equal(deleteSpy.mock.calls.length, 0, 'an unaddressed message never produced a mapped reply');
});

test('Discord: no false positives — a delete arriving after the 30-minute TTL window is not retracted (acceptance criterion 3, time-injected)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  try {
    const router = makeReplyRouter();
    const adapter = new DiscordAdapter();
    const { sentMessages } = stubDiscordChannel(adapter);
    router.register(adapter);
    const handler = getHandler(adapter);
    const deleteSpy = t.mock.method(adapter, 'deleteOwnMessage');

    const conversationId = `${RUN}-chan-ac3b`;
    const messageId = `${RUN}-origin-ac3b`;
    await handler(discordMessage({ conversationId, messageId }));
    assert.equal(sentMessages.size, 1);

    t.mock.timers.tick(31 * 60_000); // past REPLY_RETRACTION_TTL_MS (30 min)

    await fireDiscordDelete(adapter, conversationId, messageId);
    assert.equal(deleteSpy.mock.calls.length, 0, 'a delete outside the TTL window must not retract');
  } finally {
    t.mock.timers.reset();
  }
});

test(
  'Discord: firing the REAL client MessageDelete gateway listener registered by start() (not the ' +
    'private retractReplyIfMapped shortcut every other test in this file uses) retracts the mapped reply — ' +
    'pins the actual listener-registration wiring itself, so a regression there (e.g. the listener not ' +
    'being registered when only autoRetractReplyEnabled is set) would be caught (PR #576 review)',
  async (t) => {
    const router = makeReplyRouter();
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
    // for real — stub the login call so this stays a local, network-free
    // test, mirroring tests/discordAdapter.test.ts's existing client.emit
    // pattern for GuildMemberUpdate/GuildRoleUpdate/GuildRoleDelete.
    client.login = async () => {};
    await adapter.start();

    const conversationId = `${RUN}-chan-wiring`;
    const messageId = `${RUN}-origin-wiring`;
    await handler(discordMessage({ conversationId, messageId }));

    assert.equal(sentMessages.size, 1, 'exactly one reply was sent');
    const [replyId] = [...sentMessages.keys()];

    // Dispatch the actual discord.js gateway event — exercising the
    // `Events.MessageDelete` listener body registered in `start()`
    // end-to-end, including the `if (config.discord.archiveAllMessages || ` +
    // `config.behaviour.autoRetractReplyEnabled)` registration gate itself.
    client.emit(Events.MessageDelete, { channelId: conversationId, id: messageId, guildId: null });
    // The listener's body is async but the `on` callback doesn't await it —
    // give the microtask queue a turn so the fire-and-forget retraction settles.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      deleteSpy.mock.calls.length,
      1,
      'the real gateway listener invoked deleteOwnMessage exactly once',
    );
    assert.deepEqual(deleteSpy.mock.calls[0].arguments, [conversationId, replyId]);
    assert.equal(
      sentMessages.get(replyId)?.deleted,
      true,
      'the bot reply was actually retracted via the real listener, not a bypassed private method',
    );
  },
);

test('Discord: a multi-chunk reply (longer than the 2000-char cap) is retracted in its ENTIRETY — every chunk is deleted, not just the last one (PR #576 review)', async (t) => {
  const longText = `${RUN}-chunk-a-`.padEnd(2200, 'a') + '\n' + `${RUN}-chunk-b-`.padEnd(2200, 'b');
  const router = new Router(async () => ({ text: longText, ok: true }), 1_000_000);
  const adapter = new DiscordAdapter();
  const { sentMessages } = stubDiscordChannel(adapter);
  router.register(adapter);
  const handler = getHandler(adapter);
  const deleteSpy = t.mock.method(adapter, 'deleteOwnMessage');

  const conversationId = `${RUN}-chan-multichunk`;
  const messageId = `${RUN}-origin-multichunk`;
  await handler(discordMessage({ conversationId, messageId }));

  const chunkIds = [...sentMessages.keys()];
  assert.ok(chunkIds.length >= 2, 'the long reply was split into multiple Discord messages by chunkText');
  for (const id of chunkIds) assert.equal(sentMessages.get(id)?.deleted, false);

  await fireDiscordDelete(adapter, conversationId, messageId);

  assert.equal(
    deleteSpy.mock.calls.length,
    chunkIds.length,
    'deleteOwnMessage is called once per chunk, not just once for the last chunk',
  );
  for (const id of chunkIds) {
    assert.equal(
      sentMessages.get(id)?.deleted,
      true,
      `chunk ${id} must be retracted — an earlier chunk staying public would defeat the privacy goal`,
    );
  }
});

test("Discord: one chunk failing to delete (e.g. already manually removed) does not stop the other chunks from being retracted, and does not reject/throw (PR #576 review — matches the WhatsApp Baileys equivalent's per-chunk .catch)", async (t) => {
  const longText = `${RUN}-chunk-a-`.padEnd(2200, 'a') + '\n' + `${RUN}-chunk-b-`.padEnd(2200, 'b');
  const router = new Router(async () => ({ text: longText, ok: true }), 1_000_000);
  const adapter = new DiscordAdapter();
  const { sentMessages } = stubDiscordChannel(adapter);
  router.register(adapter);
  const handler = getHandler(adapter);

  const conversationId = `${RUN}-chan-partialfail`;
  const messageId = `${RUN}-origin-partialfail`;
  await handler(discordMessage({ conversationId, messageId }));

  const chunkIds = [...sentMessages.keys()];
  assert.ok(chunkIds.length >= 2, 'the long reply was split into multiple Discord messages by chunkText');
  const [failingId, ...otherIds] = chunkIds;

  const realDelete = adapter.deleteOwnMessage.bind(adapter);
  t.mock.method(adapter, 'deleteOwnMessage', async (convId: string, msgId: string) => {
    if (msgId === failingId) throw new Error('already deleted manually');
    return realDelete(convId, msgId);
  });

  await assert.doesNotReject(
    fireDiscordDelete(adapter, conversationId, messageId),
    'a single chunk delete failure must not reject the overall retraction',
  );

  for (const id of otherIds) {
    assert.equal(
      sentMessages.get(id)?.deleted,
      true,
      `chunk ${id} must still be retracted even though a sibling chunk's delete failed`,
    );
  }
});

test(
  'Discord: firing the REAL client MessageBulkDelete gateway listener retracts a mapped reply within the batch, ' +
    'even with archiveAllMessages off (config default in this file) — pins the actual listener-registration ' +
    "wiring, not just the retraction primitive (acceptance criteria 2 + 3, issue #595's MessageDelete follow-up)",
  async (t) => {
    const router = makeReplyRouter();
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
    client.login = async () => {};
    await adapter.start();

    const conversationId = `${RUN}-chan-bulk`;
    const messageId = `${RUN}-origin-bulk`;
    await handler(discordMessage({ conversationId, messageId }));

    assert.equal(sentMessages.size, 1, 'exactly one reply was sent');
    const [replyId] = [...sentMessages.keys()];

    // Dispatch the actual discord.js `MessageBulkDelete` gateway event — a
    // moderator clearing several messages at once, one of which is the
    // mapped origin message. `archiveAllMessages` is unset (false) in this
    // file, so this also proves retraction fires independently of archiving.
    const messages = new Map([[messageId, { channelId: conversationId, id: messageId, guildId: null }]]);
    client.emit(Events.MessageBulkDelete, messages, { id: conversationId });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(deleteSpy.mock.calls.length, 1, 'exactly one deleteOwnMessage call for the mapped reply');
    assert.deepEqual(deleteSpy.mock.calls[0].arguments, [conversationId, replyId]);
    assert.equal(sentMessages.get(replyId)?.deleted, true, 'the bot reply was actually retracted');
  },
);

test(
  'Discord: a MessageBulkDelete batch mixing one mapped message with several unmapped/ambient messages ' +
    'retracts only the mapped one (acceptance criterion 4, issue #595)',
  async (t) => {
    const router = makeReplyRouter();
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
    client.login = async () => {};
    await adapter.start();

    const conversationId = `${RUN}-chan-bulk-mixed`;
    const messageId = `${RUN}-origin-bulk-mixed`;
    await handler(discordMessage({ conversationId, messageId }));

    assert.equal(sentMessages.size, 1, 'exactly one reply was sent');
    const [replyId] = [...sentMessages.keys()];

    const ambient1 = `${RUN}-ambient-1`;
    const ambient2 = `${RUN}-ambient-2`;
    const messages = new Map([
      [ambient1, { channelId: conversationId, id: ambient1, guildId: null }],
      [messageId, { channelId: conversationId, id: messageId, guildId: null }],
      [ambient2, { channelId: conversationId, id: ambient2, guildId: null }],
    ]);
    client.emit(Events.MessageBulkDelete, messages, { id: conversationId });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(deleteSpy.mock.calls.length, 1, 'only the mapped message triggers a retraction');
    assert.deepEqual(deleteSpy.mock.calls[0].arguments, [conversationId, replyId]);
    assert.equal(sentMessages.get(replyId)?.deleted, true);
  },
);

// ---------------------------------------------------------------------------
// WhatsApp Baileys (SECURITY acceptance criterion 4)
// ---------------------------------------------------------------------------

/** Fake Baileys sock — sendMessage distinguishes a normal send from a `{ delete }` revoke call; groupMetadata reports whichever numbers `admins` currently holds. */
function stubBaileysSocket(adapter: BaileysAdapterInstance, admins: Set<string>) {
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
      return {
        participants: [...admins].map((number) => ({ id: `${number}@s.whatsapp.net`, admin: 'admin' })),
      };
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
      id: `${RUN}-revoke-${targetId}-${revokerNumber}`,
      participant: `${revokerNumber}@s.whatsapp.net`,
    },
    message: { protocolMessage: { key: { id: targetId }, type: 0 } },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
}

const GROUP_JID = `${RUN}-group@g.us`;
const SENDER_A = '64211111111'; // the true original sender/author — pre-registered super admin above
const SENDER_B = '64299999999'; // a random participant — neither the author nor an admin
const SENDER_C = '64233333333'; // a group admin who did NOT author the original message

test('SECURITY: WhatsApp — a revoke from a non-author, non-admin participant does not retract the mapped reply, and does not burn the mapping: the true author (or a group admin) can still retract it afterward (acceptance criterion 4)', async () => {
  const admins = new Set([SENDER_C]);
  const router = makeReplyRouter();
  const adapter = new BaileysAdapter();
  const { deleteCalls } = stubBaileysSocket(adapter, admins);
  router.register(adapter);
  const handler = getHandler(adapter);

  const messageId = `${RUN}-origin-ac4`;
  await handler({
    platform: 'whatsapp',
    conversationId: GROUP_JID,
    userId: SENDER_A,
    userName: 'Member A',
    text: `${RUN} question`,
    isDirect: false,
    addressedToBot: true,
    messageId,
    timestamp: Date.now(),
  });
  assert.equal(deleteCalls.length, 0);

  // A modified client broadcasts a revoke keyed to SENDER_A's message id,
  // but is neither SENDER_A nor a group admin.
  await fireWhatsappRevoke(adapter, GROUP_JID, SENDER_B, messageId);
  assert.equal(
    deleteCalls.length,
    0,
    'SECURITY: a spoofed revoke from a non-author, non-admin participant must not retract the reply',
  );

  // The TRUE original sender revokes their own (now-answered) message —
  // must still succeed, proving the forged attempt above did NOT evict/burn
  // the mapping (the griefing vector src/replyRetraction.ts's
  // peek/evict split closes).
  await fireWhatsappRevoke(adapter, GROUP_JID, SENDER_A, messageId);
  assert.equal(deleteCalls.length, 1, 'the mapped original sender can retract their own answered message');
  assert.equal(deleteCalls[0].jid, GROUP_JID);

  // A separate message, revoked by a group ADMIN who is not its author —
  // also a legitimate "delete for everyone" moderation trigger.
  const messageId2 = `${RUN}-origin-ac4-admin`;
  await handler({
    platform: 'whatsapp',
    conversationId: GROUP_JID,
    userId: SENDER_A,
    userName: 'Member A',
    text: `${RUN} second question`,
    isDirect: false,
    addressedToBot: true,
    messageId: messageId2,
    timestamp: Date.now(),
  });
  await fireWhatsappRevoke(adapter, GROUP_JID, SENDER_C, messageId2);
  assert.equal(deleteCalls.length, 2, 'a group admin can retract someone else’s answered message too');
});

// ---------------------------------------------------------------------------
// WhatsApp Cloud (acceptance criterion 6 — capability gating)
// ---------------------------------------------------------------------------

function mockFetch(response: { ok: boolean; status?: number } = { ok: true }) {
  const calls: string[] = [];
  const fetchMock = async (url: string | URL) => {
    calls.push(String(url));
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      headers: new Headers(),
      text: async () => (response.ok ? '' : 'graph error'),
      json: async () => ({}),
    } as Response;
  };
  return { calls, fetchMock };
}

test('WhatsApp Cloud: has no deleteOwnMessage capability, and enabling the flag has no effect on its normal reply flow — never throws (acceptance criterion 6)', async () => {
  const { calls, fetchMock } = mockFetch();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    const adapter = new WhatsAppCloudAdapter();
    assert.equal(
      typeof adapter.deleteOwnMessage,
      'undefined',
      'WhatsApp Cloud has no deleteOwnMessage — capability-gated by omission, never by throwing',
    );

    const router = makeReplyRouter();
    router.register(adapter);
    const handler = getHandler(adapter);

    const userId = `${RUN}-cloud-user`;
    // sendText enforces the 24h customer-service window via `lastInboundAt`,
    // populated in production by the real webhook intake path; poke it
    // directly here, mirroring tests/whatsappCloudAdapter.test.ts.
    (adapter as unknown as { lastInboundAt: Map<string, number> }).lastInboundAt.set(userId, Date.now());

    await handler({
      platform: 'whatsapp',
      conversationId: userId,
      userId,
      userName: 'Cloud User',
      text: `${RUN} question`,
      isDirect: true,
      addressedToBot: true,
      messageId: `${RUN}-cloud-origin`,
      timestamp: Date.now(),
    });

    assert.ok(
      calls.length >= 1,
      'the reply was still sent normally via the Cloud Graph API — no throw, no behaviour change',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
