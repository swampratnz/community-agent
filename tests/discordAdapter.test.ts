import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import type { IncomingMessage } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it. DATABASE_URL
// points nowhere; policy reads fail and fall back to defaults (see
// src/storage/policies.ts), so no real DB is needed for this adapter-level
// test. Moderation is on so the mute-enforcement tests below (issue #171)
// exercise their real gates instead of a hardcoded early return; the
// DB-touching queries those gates need (member_warnings / community_users /
// server_roster) are mocked on `pool.query` per-test, mirroring
// tests/baileysArchiving.test.ts — no real Postgres required.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.DISCORD_MODERATION_ENABLED ??= 'true';

const { DiscordAdapter, WELCOME_MESSAGE } = await import('../src/platforms/discord/adapter.js');
const { config } = await import('../src/config.js');
const { pool } = await import('../src/storage/db.js');
const { resetPolicyCacheForTests } = await import('../src/storage/policies.js');

type Adapter = InstanceType<typeof DiscordAdapter>;

/** Reaches the private onChannelCreate handler directly. */
function fireChannelCreate(adapter: Adapter, channel: unknown): Promise<void> {
  return (adapter as unknown as { onChannelCreate: (c: unknown) => Promise<void> }).onChannelCreate(channel);
}

/** Reaches the private onGuildMemberAdd handler directly. */
function fireGuildMemberAdd(adapter: Adapter, member: unknown): Promise<void> {
  return (adapter as unknown as { onGuildMemberAdd: (m: unknown) => Promise<void> }).onGuildMemberAdd(member);
}

/** A minimal Guild stand-in carrying only what findMutedRole reads. */
function fakeGuildRef(opts: { id: string; mutedRole?: { id: string; name: string } }) {
  const roles = opts.mutedRole ? [opts.mutedRole] : [];
  return {
    id: opts.id,
    roles: {
      cache: {
        get: (id: string) => roles.find((r) => r.id === id),
        find: (pred: (r: { id: string; name: string }) => boolean) => roles.find(pred),
      },
    },
  };
}

/** A minimal NonThreadGuildBasedChannel stand-in for onChannelCreate. */
function fakeChannel(opts: { id: string; type: ChannelType; guild: ReturnType<typeof fakeGuildRef> }) {
  const overwriteCalls: Array<{ role: unknown; payload: Record<string, unknown> }> = [];
  const channel = {
    id: opts.id,
    type: opts.type,
    guild: opts.guild,
    permissionOverwrites: {
      edit: async (role: unknown, payload: Record<string, unknown>) => {
        overwriteCalls.push({ role, payload });
      },
    },
  };
  return { channel, overwriteCalls };
}

/** A minimal GuildMember stand-in for onGuildMemberAdd. */
function fakeGuildMember(opts: {
  id: string;
  guildId: string;
  displayName?: string;
  bot?: boolean;
  send?: (payload: { content: string }) => Promise<void>;
}) {
  return {
    id: opts.id,
    displayName: opts.displayName ?? 'Member',
    guild: { id: opts.guildId },
    user: { bot: opts.bot ?? false },
    send: opts.send ?? (async () => {}),
  };
}

/**
 * Stubs client.guilds.fetch for the muteUser/postAdminAlert path exercised by
 * remuteOnRejoinIfNeeded: an existing muted role (so ensureMutedRole doesn't
 * need guild.roles.create) and an existing mod-alerts channel (so
 * ensureAdminChannel doesn't need guild.channels.create).
 */
function stubMuteGuild(adapter: Adapter, order: string[] = []) {
  const recorded = { muted: [] as string[], adminAlerts: [] as string[] };
  const mutedRole = { id: 'role-muted', name: config.moderation.mutedRoleName };
  const modAlertsChannel = {
    id: 'chan-mod-alerts',
    type: ChannelType.GuildText,
    name: config.moderation.adminChannelName,
    permissionOverwrites: { edit: async () => {} },
    send: async (o: { content: string }) => {
      recorded.adminAlerts.push(o.content);
    },
  };
  const fakeGuild = {
    id: config.discord.guildId,
    roles: {
      cache: {
        get: (id: string) => (id === mutedRole.id ? mutedRole : undefined),
        find: (pred: (r: typeof mutedRole) => boolean) => [mutedRole].find(pred),
      },
    },
    channels: {
      fetch: async () => ({
        values: () => [modAlertsChannel][Symbol.iterator](),
        find: (pred: (c: typeof modAlertsChannel) => boolean) => [modAlertsChannel].find(pred),
      }),
    },
    members: {
      fetch: async (userId: string) => ({
        roles: {
          add: async () => {
            recorded.muted.push(userId);
            order.push('mute');
          },
        },
      }),
    },
  };
  const client = (
    adapter as unknown as { client: { guilds: { fetch: (id: string) => Promise<typeof fakeGuild> } } }
  ).client;
  client.guilds.fetch = async () => fakeGuild;
  return recorded;
}

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

interface FakePollSendable {
  isTextBased: () => boolean;
  send: (opts: {
    poll: { question: { text: string }; answers: Array<{ text: string }>; duration: number };
  }) => Promise<void>;
}

/** Stubs the client's channel fetch to capture the `poll` payload performAdminAction('create_poll') builds. */
function stubClientForPoll(adapter: InstanceType<typeof DiscordAdapter>) {
  const sent: Array<{
    poll: { question: { text: string }; answers: Array<{ text: string }>; duration: number };
  }> = [];
  const record = async (opts: (typeof sent)[number]) => {
    sent.push(opts);
  };
  const client = (
    adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<FakePollSendable> } } }
  ).client;
  client.channels.fetch = async () => ({ isTextBased: () => true, send: record });
  return sent;
}

test('SECURITY: performAdminAction("create_poll") routes question/answers through filterOutbound — a secret cannot reach a Discord poll unredacted (issue #228)', async () => {
  const adapter = new DiscordAdapter();
  const sent = stubClientForPoll(adapter);
  const secret = 'sk-ant-' + 'y'.repeat(30);
  await adapter.performAdminAction({
    kind: 'create_poll',
    conversationId: 'chan-1',
    params: {
      question: `secret is ${secret} end`,
      options: [`also ${secret}`, 'a clean option'],
      durationHours: 24,
    },
  });
  assert.equal(sent.length, 1);
  const { poll } = sent[0];
  assert.ok(!poll.question.text.includes('sk-ant-'), 'no raw secret fragment may reach the poll question');
  assert.ok(poll.question.text.includes('[redacted]'), 'the question secret must be redacted, not dropped');
  assert.ok(!poll.answers[0].text.includes('sk-ant-'), 'no raw secret fragment may reach a poll answer');
  assert.ok(poll.answers[0].text.includes('[redacted]'), 'the answer secret must be redacted, not dropped');
  assert.equal(poll.answers[1].text, 'a clean option', 'an unaffected answer must pass through unchanged');
  assert.equal(poll.duration, 24);
});

interface FakeImageSendable {
  isTextBased: () => boolean;
  isDMBased: () => boolean;
  send: (opts: {
    content?: string;
    files: Array<{ attachment: Buffer; name: string; description?: string }>;
  }) => Promise<void>;
}

/** Stubs the client's channel fetch to capture the full `send` payload sendImage builds (issue #174). */
function stubClientForImage(adapter: InstanceType<typeof DiscordAdapter>) {
  const sent: Array<{
    content?: string;
    files: Array<{ attachment: Buffer; name: string; description?: string }>;
  }> = [];
  const record = async (opts: (typeof sent)[number]) => {
    sent.push(opts);
  };
  const client = (
    adapter as unknown as {
      client: { channels: { fetch: (id: string) => Promise<FakeImageSendable> } };
    }
  ).client;
  client.channels.fetch = async () => ({ isTextBased: () => true, isDMBased: () => false, send: record });
  return sent;
}

test('sendImage sets the Discord attachment description (screen-reader alt-text) to the same caption used as the message content (issue #174)', async () => {
  const adapter = new DiscordAdapter();
  const sent = stubClientForImage(adapter);
  await adapter.sendImage(
    'chan-1',
    { data: Buffer.from('fake-image'), filename: 'image.jpg', mimeType: 'image/jpeg' },
    'a cat wearing a hat',
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'a cat wearing a hat');
  assert.equal(
    sent[0].files[0].description,
    'a cat wearing a hat',
    'the attachment description (Discord alt-text) must be set, not left bare',
  );
});

test('SECURITY: sendImage filters the caption once and reuses it for both content and attachment description — a secret cannot reach the alt-text unredacted (issue #174)', async () => {
  const adapter = new DiscordAdapter();
  const sent = stubClientForImage(adapter);
  const secretPrompt = 'draw sk-ant-' + 'y'.repeat(30) + ' as a logo';
  await adapter.sendImage(
    'chan-1',
    { data: Buffer.from('fake-image'), filename: 'image.jpg', mimeType: 'image/jpeg' },
    secretPrompt,
  );
  assert.ok(!sent[0].content?.includes('sk-ant-'), 'message content must be redacted');
  assert.ok(
    !sent[0].files[0].description?.includes('sk-ant-'),
    'attachment description must also be redacted — it must not bypass the outbound filter',
  );
  assert.equal(
    sent[0].content,
    sent[0].files[0].description,
    'content and description must be the exact same filtered value, computed once',
  );
});

function fakeMessage(): IncomingMessage {
  return {
    platform: 'discord',
    conversationId: 'chan-1',
    userId: 'u1',
    userName: 'User',
    text: 'hi',
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
  };
}

test("sendTypingIndicator: calls the channel's native sendTyping()", async () => {
  const adapter = new DiscordAdapter();
  let typingCalls = 0;
  const client = (adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } })
    .client;
  client.channels.fetch = async () => ({
    isTextBased: () => true,
    sendTyping: async () => {
      typingCalls += 1;
    },
  });
  await adapter.sendTypingIndicator(fakeMessage());
  assert.equal(typingCalls, 1);
});

test('sendTypingIndicator: a channel that cannot signal typing (no sendTyping) is a silent no-op', async () => {
  const adapter = new DiscordAdapter();
  const client = (adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } })
    .client;
  client.channels.fetch = async () => ({ isTextBased: () => true }); // no sendTyping method
  await assert.doesNotReject(() => adapter.sendTypingIndicator(fakeMessage()));
});

// --- onChannelCreate: new channels/categories inherit the muted role's overwrite immediately (issue #171) ---

test('onChannelCreate: applies the muted-role deny-post overwrite to a new text channel when a muted role already exists', async () => {
  const adapter = new DiscordAdapter();
  const guild = fakeGuildRef({
    id: config.discord.guildId,
    mutedRole: { id: 'role-muted', name: config.moderation.mutedRoleName },
  });
  const { channel, overwriteCalls } = fakeChannel({ id: 'chan-new', type: ChannelType.GuildText, guild });
  await fireChannelCreate(adapter, channel);
  assert.equal(overwriteCalls.length, 1);
  assert.equal((overwriteCalls[0].role as { id: string }).id, 'role-muted');
  assert.equal(overwriteCalls[0].payload.SendMessages, false);
  assert.equal(overwriteCalls[0].payload.SendMessagesInThreads, false);
});

test('onChannelCreate: applies the overwrite to a newly created category too', async () => {
  const adapter = new DiscordAdapter();
  const guild = fakeGuildRef({
    id: config.discord.guildId,
    mutedRole: { id: 'role-muted', name: config.moderation.mutedRoleName },
  });
  const { channel, overwriteCalls } = fakeChannel({ id: 'cat-new', type: ChannelType.GuildCategory, guild });
  await fireChannelCreate(adapter, channel);
  assert.equal(
    overwriteCalls.length,
    1,
    'a new category gets the overwrite directly — no reliance on Discord syncing it to future children',
  );
});

test('SECURITY: onChannelCreate applies the muted-role deny to a new voice channel (its text chat is otherwise postable by a muted member)', async () => {
  const adapter = new DiscordAdapter();
  const guild = fakeGuildRef({
    id: config.discord.guildId,
    mutedRole: { id: 'role-muted', name: config.moderation.mutedRoleName },
  });
  // Voice/Stage/Media channels have a text surface but were excluded from the
  // overwrite set, so a muted member could post freely in them.
  for (const type of [ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildMedia]) {
    const { channel, overwriteCalls } = fakeChannel({ id: `chan-${type}`, type, guild });
    await fireChannelCreate(adapter, channel);
    assert.equal(overwriteCalls.length, 1, `channel type ${type} must receive the deny overwrite`);
    assert.equal(overwriteCalls[0].payload.SendMessages, false);
  }
});

test("onChannelCreate: ignores thread channels — thread posting is blocked via the parent channel's SendMessagesInThreads:false instead", async () => {
  const adapter = new DiscordAdapter();
  const guild = fakeGuildRef({
    id: config.discord.guildId,
    mutedRole: { id: 'role-muted', name: config.moderation.mutedRoleName },
  });
  const { channel, overwriteCalls } = fakeChannel({
    id: 'thread-new',
    type: ChannelType.PublicThread,
    guild,
  });
  await fireChannelCreate(adapter, channel);
  assert.equal(
    overwriteCalls.length,
    0,
    'threads carry no overwrites of their own; no separate thread handling is added',
  );
});

test('onChannelCreate: does nothing when no muted role exists yet (nothing to inherit)', async () => {
  const adapter = new DiscordAdapter();
  const guild = fakeGuildRef({ id: config.discord.guildId });
  const { channel, overwriteCalls } = fakeChannel({ id: 'chan-new', type: ChannelType.GuildText, guild });
  await fireChannelCreate(adapter, channel);
  assert.equal(overwriteCalls.length, 0);
});

test('onChannelCreate: does nothing for a channel outside the configured guild', async () => {
  const adapter = new DiscordAdapter();
  const guild = fakeGuildRef({
    id: 'some-other-guild',
    mutedRole: { id: 'role-muted', name: config.moderation.mutedRoleName },
  });
  const { channel, overwriteCalls } = fakeChannel({ id: 'chan-new', type: ChannelType.GuildText, guild });
  await fireChannelCreate(adapter, channel);
  assert.equal(overwriteCalls.length, 0);
});

test('onChannelCreate: does nothing when moderation is disabled', async () => {
  const wasEnabled = config.moderation.enabled;
  config.moderation.enabled = false;
  try {
    const adapter = new DiscordAdapter();
    const guild = fakeGuildRef({
      id: config.discord.guildId,
      mutedRole: { id: 'role-muted', name: config.moderation.mutedRoleName },
    });
    const { channel, overwriteCalls } = fakeChannel({ id: 'chan-new', type: ChannelType.GuildText, guild });
    await fireChannelCreate(adapter, channel);
    assert.equal(overwriteCalls.length, 0);
  } finally {
    config.moderation.enabled = wasEnabled;
  }
});

// --- onGuildMemberAdd: rejoin re-mute closes the leave/rejoin bypass (issue #171) -------------------

/** Mocks pool.query for the three queries the rejoin path can issue. */
function stubRejoinQueries(opts: { activeWarnings: number; storedRole?: 'admin' | 'member' }) {
  return async (sql: string) => {
    if (sql.includes('INSERT INTO server_roster')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM member_warnings')) return { rows: [{ n: opts.activeWarnings }], rowCount: 1 };
    if (sql.includes('FROM community_users')) {
      return opts.storedRole ? { rows: [{ role: opts.storedRole }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
}

test('SECURITY: a member who leaves and rejoins while still at/above the strike limit is automatically re-muted, and admins are alerted', async (t) => {
  t.mock.method(pool, 'query', stubRejoinQueries({ activeWarnings: config.moderation.strikeLimit }));
  const adapter = new DiscordAdapter();
  const recorded = stubMuteGuild(adapter);
  const member = fakeGuildMember({ id: 'user-rejoin', guildId: config.discord.guildId });
  await fireGuildMemberAdd(adapter, member);
  assert.deepEqual(recorded.muted, ['user-rejoin']);
  assert.equal(
    recorded.adminAlerts.length,
    1,
    'unlike the routine new-channel re-apply, a rejoin re-mute must alert admins',
  );
  assert.match(recorded.adminAlerts[0], /rejoined/i);
});

test('SECURITY: the rejoin re-mute ignores MODERATION_STRIKE_WINDOW_DAYS — leaving and waiting out the window is not an unmute path', async (t) => {
  const wasWindow = config.moderation.strikeWindowDays;
  config.moderation.strikeWindowDays = 7;
  try {
    let windowParam: unknown = 'unqueried';
    const stub = stubRejoinQueries({ activeWarnings: config.moderation.strikeLimit });
    t.mock.method(pool, 'query', async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM member_warnings')) windowParam = params?.[2];
      return stub(sql);
    });
    const adapter = new DiscordAdapter();
    const recorded = stubMuteGuild(adapter);
    const member = fakeGuildMember({ id: 'user-rejoin-window', guildId: config.discord.guildId });
    await fireGuildMemberAdd(adapter, member);
    assert.deepEqual(recorded.muted, ['user-rejoin-window']);
    assert.equal(
      windowParam,
      null,
      'the rejoin check must pass NO window (null bound param) — every uncleared strike counts on rejoin, so the strike window can never reopen the leave/rejoin bypass',
    );
  } finally {
    config.moderation.strikeWindowDays = wasWindow;
  }
});

test('onGuildMemberAdd: does not re-mute a rejoining member below the strike limit', async (t) => {
  t.mock.method(pool, 'query', stubRejoinQueries({ activeWarnings: config.moderation.strikeLimit - 1 }));
  const adapter = new DiscordAdapter();
  const recorded = stubMuteGuild(adapter);
  const member = fakeGuildMember({ id: 'user-clean', guildId: config.discord.guildId });
  await fireGuildMemberAdd(adapter, member);
  assert.equal(recorded.muted.length, 0);
  assert.equal(recorded.adminAlerts.length, 0);
});

test('SECURITY: a member exempt via admin tier is never auto-re-muted on rejoin, even at/above the strike limit', async (t) => {
  t.mock.method(
    pool,
    'query',
    stubRejoinQueries({ activeWarnings: config.moderation.strikeLimit, storedRole: 'admin' }),
  );
  const adapter = new DiscordAdapter();
  const recorded = stubMuteGuild(adapter);
  const member = fakeGuildMember({ id: 'user-admin', guildId: config.discord.guildId });
  await fireGuildMemberAdd(adapter, member);
  assert.equal(
    recorded.muted.length,
    0,
    'an exempt admin must never be auto-muted, mirroring Moderator.scan',
  );
  assert.equal(recorded.adminAlerts.length, 0);
});

test('onGuildMemberAdd: skips the rejoin re-mute check entirely when moderation is disabled', async (t) => {
  const wasEnabled = config.moderation.enabled;
  config.moderation.enabled = false;
  try {
    let moderationQueried = false;
    t.mock.method(pool, 'query', async (sql: string) => {
      if (sql.includes('FROM member_warnings') || sql.includes('FROM community_users'))
        moderationQueried = true;
      if (sql.includes('INSERT INTO server_roster')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const adapter = new DiscordAdapter();
    const recorded = stubMuteGuild(adapter);
    const member = fakeGuildMember({ id: 'user-x', guildId: config.discord.guildId });
    await fireGuildMemberAdd(adapter, member);
    assert.equal(recorded.muted.length, 0);
    assert.equal(moderationQueried, false, 'no warning/role lookup when moderation is off');
  } finally {
    config.moderation.enabled = wasEnabled;
  }
});

test('onGuildMemberAdd: the rejoin re-mute runs before any welcome-message logic', async (t) => {
  const wasWelcome = config.discord.welcome.enabled;
  config.discord.welcome.enabled = true;
  try {
    t.mock.method(pool, 'query', stubRejoinQueries({ activeWarnings: config.moderation.strikeLimit }));
    const adapter = new DiscordAdapter();
    const order: string[] = [];
    stubMuteGuild(adapter, order);
    const member = fakeGuildMember({
      id: 'user-rejoin-welcome',
      guildId: config.discord.guildId,
      send: async () => {
        order.push('welcome-dm');
      },
    });
    await fireGuildMemberAdd(adapter, member);
    assert.deepEqual(order, ['mute', 'welcome-dm']);
  } finally {
    config.discord.welcome.enabled = wasWelcome;
  }
});

// --- onGuildMemberAdd: community guidelines appended to the welcome (issue #212) --------------------

/** Mocks pool.query so a `community_guidelines` policy read returns `value` (or nothing, if omitted). */
function stubPoliciesQuery(value?: string) {
  return async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM policies') && params?.[0] === 'community_guidelines') {
      return value === undefined ? { rows: [], rowCount: 0 } : { rows: [{ value }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
}

test('onGuildMemberAdd: welcome DM stays byte-identical to today when no guidelines are set (issue #212)', async (t) => {
  resetPolicyCacheForTests();
  const wasWelcome = config.discord.welcome.enabled;
  config.discord.welcome.enabled = true;
  t.mock.method(pool, 'query', stubPoliciesQuery());
  try {
    const adapter = new DiscordAdapter();
    const sent: string[] = [];
    const member = fakeGuildMember({
      id: 'user-no-guidelines',
      guildId: config.discord.guildId,
      send: async (payload) => {
        sent.push(payload.content);
      },
    });
    await fireGuildMemberAdd(adapter, member);
    assert.deepEqual(sent, [WELCOME_MESSAGE]);
  } finally {
    config.discord.welcome.enabled = wasWelcome;
    resetPolicyCacheForTests();
  }
});

test('onGuildMemberAdd: welcome DM appends community guidelines verbatim when set (issue #212)', async (t) => {
  resetPolicyCacheForTests();
  const wasWelcome = config.discord.welcome.enabled;
  config.discord.welcome.enabled = true;
  const guidelines = 'Be respectful. No spam. Keep discussion on-topic.';
  t.mock.method(pool, 'query', stubPoliciesQuery(guidelines));
  try {
    const adapter = new DiscordAdapter();
    const sent: string[] = [];
    const member = fakeGuildMember({
      id: 'user-with-guidelines',
      guildId: config.discord.guildId,
      send: async (payload) => {
        sent.push(payload.content);
      },
    });
    await fireGuildMemberAdd(adapter, member);
    assert.deepEqual(sent, [`${WELCOME_MESSAGE}\n\nCommunity guidelines:\n${guidelines}`]);
  } finally {
    config.discord.welcome.enabled = wasWelcome;
    resetPolicyCacheForTests();
  }
});

test('onGuildMemberAdd: the channel fallback also appends community guidelines verbatim when the DM fails (issue #212)', async (t) => {
  resetPolicyCacheForTests();
  const wasWelcome = config.discord.welcome.enabled;
  const wasChannelId = config.discord.welcome.channelId;
  config.discord.welcome.enabled = true;
  config.discord.welcome.channelId = 'chan-welcome';
  const guidelines = 'Be respectful. No spam.';
  t.mock.method(pool, 'query', stubPoliciesQuery(guidelines));
  try {
    const adapter = new DiscordAdapter();
    const sent = stubClient(adapter);
    const member = fakeGuildMember({
      id: 'user-dm-closed',
      guildId: config.discord.guildId,
      send: async () => {
        throw new Error('Cannot send messages to this user');
      },
    });
    await fireGuildMemberAdd(adapter, member);
    assert.equal(sent.length, 1);
    assert.ok(
      sent[0].includes(`Community guidelines:\n${guidelines}`),
      'the channel-fallback welcome must include the guidelines text verbatim too',
    );
  } finally {
    config.discord.welcome.enabled = wasWelcome;
    config.discord.welcome.channelId = wasChannelId;
    resetPolicyCacheForTests();
  }
});
