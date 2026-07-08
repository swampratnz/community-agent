import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, GuildScheduledEventEntityType } from 'discord.js';
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
// Fixed allowlist for the assign/remove_community_role tests below (issue #232).
process.env.DISCORD_ASSIGNABLE_ROLES ??= 'role-cosmetic-1,role-cosmetic-2';

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

interface FakeScheduledEventGuild {
  id: string;
  scheduledEvents: {
    create: (options: Record<string, unknown>) => Promise<{ name: string; scheduledStartAt: Date }>;
  };
}

/**
 * Stubs client.guilds.fetch + client.channels.fetch for
 * performAdminAction('create_event') (issue #230): `channelFetch` lets each
 * test control whether `location` resolves to a visible voice/stage channel
 * in this guild (channel-hosted path) or not (external/physical location
 * path) — mirrors the real DiscordAdapter's own fallback logic.
 */
function stubClientForEvent(
  adapter: InstanceType<typeof DiscordAdapter>,
  channelFetch: (id: string) => Promise<unknown> = async () => {
    throw new Error('channel not found');
  },
) {
  const created: Array<Record<string, unknown>> = [];
  const guild: FakeScheduledEventGuild = {
    id: config.discord.guildId,
    scheduledEvents: {
      create: async (options: Record<string, unknown>) => {
        created.push(options);
        return {
          name: options.name as string,
          scheduledStartAt: new Date(options.scheduledStartTime as string),
        };
      },
    },
  };
  const client = (
    adapter as unknown as {
      client: {
        guilds: { fetch: (id: string) => Promise<FakeScheduledEventGuild> };
        channels: { fetch: (id: string) => Promise<unknown> };
      };
    }
  ).client;
  client.guilds.fetch = async () => guild;
  client.channels.fetch = channelFetch;
  return created;
}

/** A minimal channel stand-in for create_event's location-resolution check. */
function fakeLocationChannel(opts: { id: string; type: ChannelType; guildId?: string }) {
  return {
    id: opts.id,
    type: opts.type,
    guild: { id: opts.guildId ?? config.discord.guildId },
    isDMBased: () => false,
  };
}

const EVENT_FUTURE_START = '2099-06-01T19:00:00+12:00';
const EVENT_FUTURE_END = '2099-06-01T21:00:00+12:00';

test(
  'SECURITY: performAdminAction("create_event") routes name/description through filterOutbound — a ' +
    'secret cannot reach a Discord event unredacted (issue #230)',
  async () => {
    const adapter = new DiscordAdapter();
    const created = stubClientForEvent(adapter);
    const secret = 'sk-ant-' + 'y'.repeat(30);
    await adapter.performAdminAction({
      kind: 'create_event',
      params: {
        name: `secret is ${secret} end`,
        description: `also ${secret}`,
        startTime: EVENT_FUTURE_START,
        endTime: EVENT_FUTURE_END,
        location: 'Wellington Central Library',
      },
    });
    assert.equal(created.length, 1);
    const opts = created[0];
    assert.ok(!(opts.name as string).includes('sk-ant-'), 'no raw secret fragment may reach the event name');
    assert.ok((opts.name as string).includes('[redacted]'), 'the name secret must be redacted, not dropped');
    assert.ok(
      !(opts.description as string).includes('sk-ant-'),
      'no raw secret fragment may reach the description',
    );
    assert.ok(
      (opts.description as string).includes('[redacted]'),
      'the description secret must be redacted, not dropped',
    );
  },
);

test('performAdminAction("create_event") treats an external/physical location as an EXTERNAL event with the location text filtered (issue #230)', async () => {
  const adapter = new DiscordAdapter();
  const created = stubClientForEvent(adapter);
  await adapter.performAdminAction({
    kind: 'create_event',
    params: {
      name: 'Auckland Meetup',
      startTime: EVENT_FUTURE_START,
      endTime: EVENT_FUTURE_END,
      location: 'Wellington Central Library',
    },
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].entityType, GuildScheduledEventEntityType.External);
  assert.deepEqual(created[0].entityMetadata, { location: 'Wellington Central Library' });
  assert.equal(created[0].channel, undefined);
});

test('SECURITY: performAdminAction("create_event") refuses an external location with no endTime — Discord requires one for non-channel events (issue #230)', async () => {
  const adapter = new DiscordAdapter();
  stubClientForEvent(adapter);
  await assert.rejects(
    () =>
      adapter.performAdminAction({
        kind: 'create_event',
        params: {
          name: 'Auckland Meetup',
          startTime: EVENT_FUTURE_START,
          location: 'Wellington Central Library',
        },
      }),
    /requires an endTime/,
  );
});

test('performAdminAction("create_event") resolves a visible voice channel location to a channel-hosted VOICE event, endTime optional (issue #230)', async () => {
  const adapter = new DiscordAdapter();
  const voiceChannel = fakeLocationChannel({ id: 'chan-voice-1', type: ChannelType.GuildVoice });
  const created = stubClientForEvent(adapter, async () => voiceChannel);
  await adapter.performAdminAction({
    kind: 'create_event',
    params: { name: 'Voice hangout', startTime: EVENT_FUTURE_START, location: 'chan-voice-1' },
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].entityType, GuildScheduledEventEntityType.Voice);
  assert.equal(created[0].channel, 'chan-voice-1');
  assert.equal(created[0].entityMetadata, undefined);
  assert.equal(created[0].scheduledEndTime, undefined);
});

test('performAdminAction("create_event") resolves a visible stage channel location to a channel-hosted STAGE_INSTANCE event (issue #230)', async () => {
  const adapter = new DiscordAdapter();
  const stageChannel = fakeLocationChannel({ id: 'chan-stage-1', type: ChannelType.GuildStageVoice });
  const created = stubClientForEvent(adapter, async () => stageChannel);
  await adapter.performAdminAction({
    kind: 'create_event',
    params: { name: 'Stage AMA', startTime: EVENT_FUTURE_START, location: 'chan-stage-1' },
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].entityType, GuildScheduledEventEntityType.StageInstance);
  assert.equal(created[0].channel, 'chan-stage-1');
});

test('SECURITY: performAdminAction("create_event") falls back to an external location for a visible TEXT channel — only voice/stage channels are channel-hosted (issue #230)', async () => {
  const adapter = new DiscordAdapter();
  const textChannel = fakeLocationChannel({ id: 'chan-text-1', type: ChannelType.GuildText });
  const created = stubClientForEvent(adapter, async () => textChannel);
  await adapter.performAdminAction({
    kind: 'create_event',
    params: {
      name: 'Text-channel-labelled meetup',
      startTime: EVENT_FUTURE_START,
      endTime: EVENT_FUTURE_END,
      location: 'chan-text-1',
    },
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].entityType, GuildScheduledEventEntityType.External);
  assert.deepEqual(created[0].entityMetadata, { location: 'chan-text-1' });
});

test('SECURITY: performAdminAction("create_event") falls back to an external location for a voice channel in a DIFFERENT guild — a validated channel must be in THIS guild (issue #230)', async () => {
  const adapter = new DiscordAdapter();
  const otherGuildVoiceChannel = fakeLocationChannel({
    id: 'chan-voice-other-guild',
    type: ChannelType.GuildVoice,
    guildId: 'some-other-guild',
  });
  const created = stubClientForEvent(adapter, async () => otherGuildVoiceChannel);
  await adapter.performAdminAction({
    kind: 'create_event',
    params: {
      name: 'Cross-guild location attempt',
      startTime: EVENT_FUTURE_START,
      endTime: EVENT_FUTURE_END,
      location: 'chan-voice-other-guild',
    },
  });
  assert.equal(created.length, 1);
  assert.equal(
    created[0].entityType,
    GuildScheduledEventEntityType.External,
    'a channel from another guild must never be treated as a channel-hosted location',
  );
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

// --- reactToMessage: emoji acknowledgement (issue #231) --------------------

interface FakeReactable {
  isTextBased: () => boolean;
  messages: { fetch: (id: string) => Promise<{ react: (emoji: string) => Promise<void> }> };
}

function stubClientForReact(adapter: InstanceType<typeof DiscordAdapter>) {
  const reacted: Array<{ messageId: string; emoji: string }> = [];
  const fetchCalls: string[] = [];
  const client = (
    adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<FakeReactable> } } }
  ).client;
  client.channels.fetch = async () => ({
    isTextBased: () => true,
    messages: {
      fetch: async (messageId: string) => {
        fetchCalls.push(messageId);
        return {
          react: async (emoji: string) => {
            reacted.push({ messageId, emoji });
          },
        };
      },
    },
  });
  return { reacted, fetchCalls };
}

test('reactToMessage fetches the target message in the given channel and reacts with the given emoji', async () => {
  const adapter = new DiscordAdapter();
  const { reacted, fetchCalls } = stubClientForReact(adapter);
  await adapter.reactToMessage('chan-1', 'msg-1', '👀');
  assert.deepEqual(fetchCalls, ['msg-1']);
  assert.deepEqual(reacted, [{ messageId: 'msg-1', emoji: '👀' }]);
});

test('reactToMessage throws when the channel is not accessible/text-based, rather than reacting blind', async () => {
  const adapter = new DiscordAdapter();
  const client = (adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } })
    .client;
  client.channels.fetch = async () => null;
  await assert.rejects(() => adapter.reactToMessage('chan-missing', 'msg-1', '👀'));
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

/**
 * Mocks pool.query so a `community_guidelines` policy read returns `value`
 * (or nothing, if omitted). `opts.welcomeMessage` similarly stubs the
 * `welcome_message` key (issue #253); `opts.welcomeMessageMi` stubs the
 * `welcome_message_mi` key and `opts.languagePreference` stubs the
 * `language_prefs` lookup (issue #282); `opts.throwFor` simulates a policy
 * read failure for the named key.
 */
function stubPoliciesQuery(
  value?: string,
  opts?: {
    welcomeMessage?: string;
    welcomeMessageMi?: string;
    languagePreference?: 'en' | 'mi';
    throwFor?: 'community_guidelines' | 'welcome_message' | 'welcome_message_mi';
  },
) {
  return async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM language_prefs')) {
      return opts?.languagePreference === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ language: opts.languagePreference }], rowCount: 1 };
    }
    if (!sql.includes('FROM policies')) return { rows: [], rowCount: 0 };
    const key = params?.[0];
    if (opts?.throwFor === key) throw new Error('simulated policy read failure');
    if (key === 'community_guidelines') {
      return value === undefined ? { rows: [], rowCount: 0 } : { rows: [{ value }], rowCount: 1 };
    }
    if (key === 'welcome_message') {
      return opts?.welcomeMessage === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ value: opts.welcomeMessage }], rowCount: 1 };
    }
    if (key === 'welcome_message_mi') {
      return opts?.welcomeMessageMi === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ value: opts.welcomeMessageMi }], rowCount: 1 };
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

// --- onGuildMemberAdd: admin-configurable welcome message (issue #253) -----

test('onGuildMemberAdd: uses the configured welcome message in place of the hardcoded default, guidelines still appended (issue #253)', async (t) => {
  resetPolicyCacheForTests();
  const wasWelcome = config.discord.welcome.enabled;
  config.discord.welcome.enabled = true;
  const welcomeMessage = 'Welcome to our community!';
  const guidelines = 'Be respectful. No spam.';
  t.mock.method(pool, 'query', stubPoliciesQuery(guidelines, { welcomeMessage }));
  try {
    const adapter = new DiscordAdapter();
    const sent: string[] = [];
    const member = fakeGuildMember({
      id: 'user-configured-welcome',
      guildId: config.discord.guildId,
      send: async (payload) => {
        sent.push(payload.content);
      },
    });
    await fireGuildMemberAdd(adapter, member);
    assert.deepEqual(sent, [`${welcomeMessage}\n\nCommunity guidelines:\n${guidelines}`]);
    assert.ok(
      !sent[0].includes(WELCOME_MESSAGE),
      'the hardcoded default must not appear once a value is configured',
    );
  } finally {
    config.discord.welcome.enabled = wasWelcome;
    resetPolicyCacheForTests();
  }
});

test('SECURITY: onGuildMemberAdd falls back to the hardcoded default welcome when the welcome_message policy read fails (issue #253)', async (t) => {
  resetPolicyCacheForTests();
  const wasWelcome = config.discord.welcome.enabled;
  config.discord.welcome.enabled = true;
  t.mock.method(pool, 'query', stubPoliciesQuery(undefined, { throwFor: 'welcome_message' }));
  try {
    const adapter = new DiscordAdapter();
    const sent: string[] = [];
    const member = fakeGuildMember({
      id: 'user-welcome-read-failure',
      guildId: config.discord.guildId,
      send: async (payload) => {
        sent.push(payload.content);
      },
    });
    await fireGuildMemberAdd(adapter, member);
    assert.deepEqual(
      sent,
      [WELCOME_MESSAGE],
      'a policy-read failure must fall back to the hardcoded default, never an empty or broken welcome',
    );
  } finally {
    config.discord.welcome.enabled = wasWelcome;
    resetPolicyCacheForTests();
  }
});

// --- onGuildMemberAdd: rejoin honours a standing mi language preference (issue #282) -----------------

test('onGuildMemberAdd: a rejoining member with a standing mi preference and a welcome_message_mi variant gets the mi welcome (issue #282)', async (t) => {
  resetPolicyCacheForTests();
  const wasWelcome = config.discord.welcome.enabled;
  config.discord.welcome.enabled = true;
  const guidelines = 'Be respectful. No spam.';
  const welcomeMessageMi = 'Kia ora and welcome back to our community!';
  t.mock.method(pool, 'query', stubPoliciesQuery(guidelines, { welcomeMessageMi, languagePreference: 'mi' }));
  try {
    const adapter = new DiscordAdapter();
    const sent: string[] = [];
    const member = fakeGuildMember({
      id: 'user-mi-rejoin',
      guildId: config.discord.guildId,
      send: async (payload) => {
        sent.push(payload.content);
      },
    });
    await fireGuildMemberAdd(adapter, member);
    assert.deepEqual(sent, [`${welcomeMessageMi}\n\nCommunity guidelines:\n${guidelines}`]);
    assert.ok(
      !sent[0].includes(WELCOME_MESSAGE),
      'the default-language welcome must not appear once an mi variant is configured for an mi member',
    );
  } finally {
    config.discord.welcome.enabled = wasWelcome;
    resetPolicyCacheForTests();
  }
});

test('onGuildMemberAdd: a member with a standing mi preference but no welcome_message_mi variant gets the existing default-language welcome (issue #282)', async (t) => {
  resetPolicyCacheForTests();
  const wasWelcome = config.discord.welcome.enabled;
  config.discord.welcome.enabled = true;
  const welcomeMessage = 'Welcome to our community!';
  t.mock.method(pool, 'query', stubPoliciesQuery(undefined, { welcomeMessage, languagePreference: 'mi' }));
  try {
    const adapter = new DiscordAdapter();
    const sent: string[] = [];
    const member = fakeGuildMember({
      id: 'user-mi-no-variant',
      guildId: config.discord.guildId,
      send: async (payload) => {
        sent.push(payload.content);
      },
    });
    await fireGuildMemberAdd(adapter, member);
    assert.deepEqual(
      sent,
      [welcomeMessage],
      'an mi member with no mi variant set must fall back to the default-language welcome, never blank or an error',
    );
  } finally {
    config.discord.welcome.enabled = wasWelcome;
    resetPolicyCacheForTests();
  }
});

test('onGuildMemberAdd: a member with no standing language preference gets the default-language welcome even when a welcome_message_mi variant exists (issue #282)', async (t) => {
  resetPolicyCacheForTests();
  const wasWelcome = config.discord.welcome.enabled;
  config.discord.welcome.enabled = true;
  const welcomeMessageMi = 'Kia ora and welcome back!';
  t.mock.method(pool, 'query', stubPoliciesQuery(undefined, { welcomeMessageMi }));
  try {
    const adapter = new DiscordAdapter();
    const sent: string[] = [];
    const member = fakeGuildMember({
      id: 'user-no-preference',
      guildId: config.discord.guildId,
      send: async (payload) => {
        sent.push(payload.content);
      },
    });
    await fireGuildMemberAdd(adapter, member);
    assert.deepEqual(
      sent,
      [WELCOME_MESSAGE],
      'a member with no stored language preference must see byte-identical behaviour to today regardless of an mi variant existing',
    );
  } finally {
    config.discord.welcome.enabled = wasWelcome;
    resetPolicyCacheForTests();
  }
});

test('onGuildMemberAdd: the channel fallback also uses the mi welcome variant identically to the DM (issue #282)', async (t) => {
  resetPolicyCacheForTests();
  const wasWelcome = config.discord.welcome.enabled;
  const wasChannelId = config.discord.welcome.channelId;
  config.discord.welcome.enabled = true;
  config.discord.welcome.channelId = 'chan-welcome';
  const welcomeMessageMi = 'Kia ora and welcome back!';
  t.mock.method(pool, 'query', stubPoliciesQuery(undefined, { welcomeMessageMi, languagePreference: 'mi' }));
  try {
    const adapter = new DiscordAdapter();
    const sent = stubClient(adapter);
    const member = fakeGuildMember({
      id: 'user-mi-dm-closed',
      guildId: config.discord.guildId,
      send: async () => {
        throw new Error('Cannot send messages to this user');
      },
    });
    await fireGuildMemberAdd(adapter, member);
    assert.equal(sent.length, 1);
    assert.ok(
      sent[0].includes(welcomeMessageMi),
      'the channel-fallback welcome must use the same resolved mi variant as the DM path',
    );
  } finally {
    config.discord.welcome.enabled = wasWelcome;
    config.discord.welcome.channelId = wasChannelId;
    resetPolicyCacheForTests();
  }
});

// --- Cosmetic community roles (issue #232) ----------------------------------

/** A minimal discord.js Role stand-in — only what resolveAssignableRole/the tools read. */
function fakeRole(opts: { id: string; name: string; bitfield?: bigint }) {
  return { id: opts.id, name: opts.name, permissions: { bitfield: opts.bitfield ?? 0n } };
}

/**
 * Stubs client.guilds.fetch for performAdminAction's role-management cases:
 * `roles` is a fetch-by-id registry (missing id resolves to null, matching
 * discord.js), and member.roles.add/remove record what would have been
 * granted/revoked without ever calling a real Discord API.
 */
function stubRoleGuild(adapter: Adapter, roles: Record<string, ReturnType<typeof fakeRole>>) {
  const recorded = {
    added: [] as Array<{ userId: string; roleId: string }>,
    removed: [] as Array<{ userId: string; roleId: string }>,
  };
  const fakeGuild = {
    id: config.discord.guildId,
    roles: {
      fetch: async (id: string) => roles[id] ?? null,
    },
    members: {
      fetch: async (userId: string) => ({
        user: { tag: `${userId}#0000` },
        roles: {
          add: async (role: ReturnType<typeof fakeRole>) => {
            recorded.added.push({ userId, roleId: role.id });
          },
          remove: async (role: ReturnType<typeof fakeRole>) => {
            recorded.removed.push({ userId, roleId: role.id });
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

test(
  'SECURITY: assign_community_role refuses an allowlisted role that currently carries a Discord ' +
    'permission — the assign-time re-check is the load-bearing control, not the curation-time ' +
    'allowlist alone (issue #232)',
  async () => {
    const adapter = new DiscordAdapter();
    // Bit 3 (0x8) is Administrator — any nonzero bitfield must be refused, not just this one.
    const role = fakeRole({ id: 'role-cosmetic-1', name: 'Verified Builder', bitfield: 8n });
    const recorded = stubRoleGuild(adapter, { 'role-cosmetic-1': role });

    await assert.rejects(
      () =>
        adapter.performAdminAction({
          kind: 'assign_community_role',
          targetUserId: 'user-1',
          params: { roleId: 'role-cosmetic-1' },
        }),
      /carries Discord permissions/,
    );
    assert.equal(recorded.added.length, 0, 'must never call roles.add when the live permission check fails');
  },
);

test('SECURITY: assign_community_role refuses a role id not on DISCORD_ASSIGNABLE_ROLES, even with zero permissions (issue #232)', async () => {
  const adapter = new DiscordAdapter();
  const role = fakeRole({ id: 'role-not-allowed', name: 'Random Role', bitfield: 0n });
  const recorded = stubRoleGuild(adapter, { 'role-not-allowed': role });

  await assert.rejects(
    () =>
      adapter.performAdminAction({
        kind: 'assign_community_role',
        targetUserId: 'user-1',
        params: { roleId: 'role-not-allowed' },
      }),
    /not on the assignable-role allowlist/,
  );
  assert.equal(recorded.added.length, 0);
});

test('assign_community_role assigns an allowlisted, currently permission-less role (issue #232)', async () => {
  const adapter = new DiscordAdapter();
  const role = fakeRole({ id: 'role-cosmetic-1', name: 'Auckland', bitfield: 0n });
  const recorded = stubRoleGuild(adapter, { 'role-cosmetic-1': role });

  const result = await adapter.performAdminAction({
    kind: 'assign_community_role',
    targetUserId: 'user-1',
    params: { roleId: 'role-cosmetic-1' },
  });

  assert.match(result, /Assigned "Auckland"/);
  assert.deepEqual(recorded.added, [{ userId: 'user-1', roleId: 'role-cosmetic-1' }]);
});

test('remove_community_role removes an allowlisted role regardless of its current permissions (removal cannot escalate) (issue #232)', async () => {
  const adapter = new DiscordAdapter();
  const role = fakeRole({ id: 'role-cosmetic-1', name: 'Auckland', bitfield: 0n });
  const recorded = stubRoleGuild(adapter, { 'role-cosmetic-1': role });

  const result = await adapter.performAdminAction({
    kind: 'remove_community_role',
    targetUserId: 'user-1',
    params: { roleId: 'role-cosmetic-1' },
  });

  assert.match(result, /Removed "Auckland"/);
  assert.deepEqual(recorded.removed, [{ userId: 'user-1', roleId: 'role-cosmetic-1' }]);
});

test('SECURITY: remove_community_role refuses a role id not on DISCORD_ASSIGNABLE_ROLES (issue #232)', async () => {
  const adapter = new DiscordAdapter();
  const role = fakeRole({ id: 'role-not-allowed', name: 'Random Role', bitfield: 0n });
  const recorded = stubRoleGuild(adapter, { 'role-not-allowed': role });

  await assert.rejects(
    () =>
      adapter.performAdminAction({
        kind: 'remove_community_role',
        targetUserId: 'user-1',
        params: { roleId: 'role-not-allowed' },
      }),
    /not on the assignable-role allowlist/,
  );
  assert.equal(recorded.removed.length, 0);
});

test('assign_community_role throws when an allowlisted role id no longer resolves in the guild (issue #232)', async () => {
  const adapter = new DiscordAdapter();
  stubRoleGuild(adapter, {});

  await assert.rejects(
    () =>
      adapter.performAdminAction({
        kind: 'assign_community_role',
        targetUserId: 'user-1',
        params: { roleId: 'role-cosmetic-1' },
      }),
    /was not found in this guild/,
  );
});

test('list_assignable_roles flags a configured role that currently carries permissions, and reports one missing from the guild (issue #232)', async () => {
  const adapter = new DiscordAdapter();
  stubRoleGuild(adapter, {
    'role-cosmetic-1': fakeRole({ id: 'role-cosmetic-1', name: 'Auckland', bitfield: 0n }),
    // role-cosmetic-2 is on the allowlist (see the env setup above) but deliberately absent here.
  });
  // Re-point roles.fetch to also carry a permission-bearing second entry.
  const client = (adapter as unknown as { client: { guilds: { fetch: () => Promise<unknown> } } }).client;
  const guild = await client.guilds.fetch();
  (guild as { roles: { fetch: (id: string) => Promise<unknown> } }).roles.fetch = async (id: string) =>
    id === 'role-cosmetic-1'
      ? fakeRole({ id: 'role-cosmetic-1', name: 'Auckland', bitfield: 0n })
      : id === 'role-cosmetic-2'
        ? fakeRole({ id: 'role-cosmetic-2', name: 'Verified Builder', bitfield: 8n })
        : null;

  const result = await adapter.performAdminAction({ kind: 'list_assignable_roles' });
  const lines = result.split('\n');

  assert.ok(lines.some((l) => l.includes('Auckland (role-cosmetic-1)') && !l.includes('⚠️')));
  assert.ok(
    lines.some((l) => l.includes('Verified Builder (role-cosmetic-2)') && l.includes('⚠️')),
    'a role that currently carries permissions must be flagged',
  );
});

test(
  'SECURITY: assign_community_role never touches the database — a cosmetic role grant leaves ' +
    'community_users/resolveRole untouched (secondary guard; the primary guard is the assign-time ' +
    'permission re-check above) (issue #232)',
  async (t) => {
    const adapter = new DiscordAdapter();
    const role = fakeRole({ id: 'role-cosmetic-1', name: 'Auckland', bitfield: 0n });
    stubRoleGuild(adapter, { 'role-cosmetic-1': role });
    const querySpy = t.mock.method(pool, 'query', async () => {
      throw new Error('must not query the database');
    });

    await adapter.performAdminAction({
      kind: 'assign_community_role',
      targetUserId: 'user-1',
      params: { roleId: 'role-cosmetic-1' },
    });

    assert.equal(
      querySpy.mock.calls.length,
      0,
      'assigning/removing a cosmetic role must never touch any DB table, including community_users',
    );
  },
);

interface FakeThreadParentChannel {
  type: ChannelType;
  threads: { create: (opts: { name: string; startMessage?: string }) => Promise<{ id: string }> };
}

/** Stubs the client's channel fetch to capture the `threads.create` call performAdminAction('create_thread') makes. */
function stubClientForThreadCreate(
  adapter: InstanceType<typeof DiscordAdapter>,
  channelType: ChannelType = ChannelType.GuildText,
) {
  const calls: Array<{ name: string; startMessage?: string }> = [];
  const channel: FakeThreadParentChannel = {
    type: channelType,
    threads: {
      create: async (opts) => {
        calls.push(opts);
        return { id: 'thread-new-1' };
      },
    },
  };
  const client = (
    adapter as unknown as {
      client: { channels: { fetch: (id: string) => Promise<FakeThreadParentChannel | null> } };
    }
  ).client;
  client.channels.fetch = async () => channel;
  return calls;
}

test('SECURITY: performAdminAction("create_thread") routes the thread name through filterOutbound — a secret cannot reach a Discord thread title unredacted (issue #229)', async () => {
  const adapter = new DiscordAdapter();
  const calls = stubClientForThreadCreate(adapter);
  const secret = 'sk-ant-' + 'y'.repeat(30);
  const result = await adapter.performAdminAction({
    kind: 'create_thread',
    conversationId: 'chan-1',
    params: { name: `secret is ${secret} end` },
  });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].name.includes('sk-ant-'), 'no raw secret fragment may reach the thread title');
  assert.ok(calls[0].name.includes('[redacted]'), 'the name secret must be redacted, not dropped');
  assert.match(result, /Created thread/);
});

test('performAdminAction("create_thread") passes seedMessageId through as the native startMessage option (issue #229)', async () => {
  const adapter = new DiscordAdapter();
  const calls = stubClientForThreadCreate(adapter);
  await adapter.performAdminAction({
    kind: 'create_thread',
    conversationId: 'chan-1',
    params: { name: 'Discussion', seedMessageId: 'msg-42' },
  });
  assert.equal(calls[0]?.startMessage, 'msg-42');
});

test('performAdminAction("create_thread") throws on a channel type that does not support threads, e.g. a voice channel (issue #229)', async () => {
  const adapter = new DiscordAdapter();
  stubClientForThreadCreate(adapter, ChannelType.GuildVoice);
  await assert.rejects(
    () =>
      adapter.performAdminAction({
        kind: 'create_thread',
        conversationId: 'chan-1',
        params: { name: 'Discussion' },
      }),
    /does not support threads/,
  );
});

interface FakeThreadChannel {
  isThread: () => boolean;
  setArchived: (archived: boolean, reason?: string) => Promise<unknown>;
}

/** Stubs the client's channel fetch to capture the `setArchived` call performAdminAction('archive_thread') makes. */
function stubClientForThreadArchive(adapter: InstanceType<typeof DiscordAdapter>, isThread = true) {
  const calls: Array<{ archived: boolean; reason?: string }> = [];
  const channel: FakeThreadChannel = {
    isThread: () => isThread,
    setArchived: async (archived, reason) => {
      calls.push({ archived, reason });
    },
  };
  const client = (
    adapter as unknown as {
      client: { channels: { fetch: (id: string) => Promise<FakeThreadChannel | null> } };
    }
  ).client;
  client.channels.fetch = async () => channel;
  return calls;
}

test('performAdminAction("archive_thread") archives the thread with the given reason (issue #229)', async () => {
  const adapter = new DiscordAdapter();
  const calls = stubClientForThreadArchive(adapter);
  const result = await adapter.performAdminAction({
    kind: 'archive_thread',
    conversationId: 'thread-1',
    params: { reason: 'discussion wrapped up' },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { archived: true, reason: 'discussion wrapped up' });
  assert.match(result, /Archived thread thread-1/);
});

test('performAdminAction("archive_thread") throws when the target channel is not a thread (issue #229)', async () => {
  const adapter = new DiscordAdapter();
  stubClientForThreadArchive(adapter, false);
  await assert.rejects(
    () => adapter.performAdminAction({ kind: 'archive_thread', conversationId: 'chan-1', params: {} }),
    /is not a thread/,
  );
});

// canPostTo (issue #270): a fallback reachability check used by announce/
// create_poll/create_thread only when isKnownConversation already said no
// (a brand-new or quiet channel with no recorded interactions). Unlike those
// tools' existing "has the bot seen it" gate, this checks real, current
// reachability — text-based, sendable, non-DM, and in the one configured
// guild — so it must never widen reachability to another guild or a DM.
interface FakeReachableChannel {
  isTextBased: () => boolean;
  isDMBased: () => boolean;
  guildId?: string;
  send?: (opts: { content: string }) => Promise<void>;
}

/** A minimal channel stand-in for canPostTo's reachability check. */
function fakeReachableChannel(opts: {
  guildId?: string;
  isTextBased?: boolean;
  isDMBased?: boolean;
  sendable?: boolean;
}): FakeReachableChannel {
  const channel: FakeReachableChannel = {
    isTextBased: () => opts.isTextBased ?? true,
    isDMBased: () => opts.isDMBased ?? false,
    guildId: opts.guildId ?? config.discord.guildId,
  };
  if (opts.sendable ?? true) channel.send = async () => {};
  return channel;
}

function stubClientForCanPostTo(
  adapter: InstanceType<typeof DiscordAdapter>,
  channelFetch: (id: string) => Promise<unknown>,
) {
  const client = (adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } })
    .client;
  client.channels.fetch = channelFetch;
}

test('canPostTo returns true for a real, sendable, in-guild text channel (issue #270)', async () => {
  const adapter = new DiscordAdapter();
  stubClientForCanPostTo(adapter, async () => fakeReachableChannel({}));
  assert.equal(await adapter.canPostTo('chan-new'), true);
});

test('SECURITY: canPostTo returns false for a channel in a different guild — must not widen reachability past the configured guild (issue #270)', async () => {
  const adapter = new DiscordAdapter();
  stubClientForCanPostTo(adapter, async () => fakeReachableChannel({ guildId: 'some-other-guild' }));
  assert.equal(await adapter.canPostTo('chan-other-guild'), false);
});

test('SECURITY: canPostTo returns false, never throws, for a nonexistent channel id (issue #270)', async () => {
  const adapter = new DiscordAdapter();
  stubClientForCanPostTo(adapter, async () => {
    throw new Error('Unknown Channel');
  });
  assert.equal(await adapter.canPostTo('chan-missing'), false);
});

test('SECURITY: canPostTo returns false for a DM channel (issue #270)', async () => {
  const adapter = new DiscordAdapter();
  stubClientForCanPostTo(adapter, async () => fakeReachableChannel({ isDMBased: true, guildId: undefined }));
  assert.equal(await adapter.canPostTo('dm-1'), false);
});

test('SECURITY: canPostTo returns false for a non-text-based channel, e.g. a voice channel (issue #270)', async () => {
  const adapter = new DiscordAdapter();
  stubClientForCanPostTo(adapter, async () => fakeReachableChannel({ isTextBased: false }));
  assert.equal(await adapter.canPostTo('chan-voice'), false);
});

test('SECURITY: canPostTo returns false for a channel with no send method (issue #270)', async () => {
  const adapter = new DiscordAdapter();
  stubClientForCanPostTo(adapter, async () => fakeReachableChannel({ sendable: false }));
  assert.equal(await adapter.canPostTo('chan-nosend'), false);
});
