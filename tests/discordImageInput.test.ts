import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
// The default bad-word list is community content registered at its own module
// scope (src/index.ts imports it in production); the moderation wordlist fails
// closed until then, and constructing a Discord adapter builds a Moderator.
import '../src/moderation/badWords.js';
// The adapters take their community text pack as a required constructor
// parameter now (agent-base plan item 6) — production hands it over in
// src/platforms/factories.ts, so these constructions pass the same pack.
import { DISCORD_TEXT_PACK } from '../src/platforms/textPacks.js';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/strings/notices.js';
import { ChannelType } from 'discord.js';
import type { IncomingMessage } from '../src/platforms/types.js';
// Community content registrations (prompt sections + persona roster) — the
// composition-root contract: src/index.ts registers these in production, so
// tests that assemble prompts register them explicitly here.
import '../src/agent/communityPromptSections.js';
import '../src/agent/personas.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// tests/discordAdapter.test.ts's convention. IMAGE_INPUT_ENABLED is
// deliberately left unset here (default false) — the flag-on systemPrompt
// clause has its own test process (tests/imageInputSystemPromptEnabled.test.ts)
// since config is read once per process and can't be toggled mid-run.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { DiscordAdapter } = await import('../src/platforms/discord/adapter.js');
const { config } = await import('../src/config.js');
const { pool } = await import('../src/storage/db.js');
const { buildSystemPrompt } = await import('../src/agent/systemPrompt.js');

type Adapter = InstanceType<typeof DiscordAdapter>;

type DiscordImageAdapter = Adapter & {
  onDiscordMessage: (m: unknown) => Promise<void>;
  fetchImageAttachment: (
    url: string,
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
  ) => Promise<IncomingMessage['image']>;
};

/** Reaches the private onDiscordMessage handler directly. */
function fireDiscordMessage(adapter: Adapter, message: unknown): Promise<void> {
  return (adapter as unknown as { onDiscordMessage: (m: unknown) => Promise<void> }).onDiscordMessage(
    message,
  );
}

/**
 * A message from `authorId` carrying zero or one attachment. Mirrors
 * discordAdapter.test.ts's `discordVoiceMessage` fixture but reports
 * `contentType`/`size` (an image attachment's own metadata, read pre-fetch)
 * instead of `duration` (a voice-message bubble's marker) — `duration` stays
 * `null` throughout so these fixtures never collide with the voice-message
 * gate. Defaults to a DM so the moderation-scan branch (real Postgres) is
 * never reached, same convention as the voice tests.
 */
function discordImageMessage(opts: {
  authorId: string;
  content?: string;
  attachment?: { url?: string; contentType?: string | null; size?: number };
}): unknown {
  const attachmentsArr = opts.attachment
    ? [
        {
          id: 'att-0',
          url: opts.attachment.url ?? 'https://cdn.discordapp.com/attachments/1/2/screenshot.png',
          contentType: opts.attachment.contentType ?? 'image/png',
          size: opts.attachment.size ?? 1_000,
          duration: null,
        },
      ]
    : [];
  return {
    author: { id: opts.authorId, bot: false, username: 'Tester' },
    member: null,
    content: opts.content ?? '',
    channelId: `dm-${opts.authorId}`,
    channel: { type: ChannelType.DM, isThread: () => false },
    guildId: null,
    webhookId: null,
    mentions: { users: { has: () => false } },
    reference: null,
    attachments: {
      size: attachmentsArr.length,
      first: () => attachmentsArr[0],
    },
    id: `msg-${opts.authorId}`,
    createdTimestamp: 1_700_000_000_000,
  };
}

type DiscordImageConfig = {
  enabled: boolean;
  minRole: 'super_admin' | 'admin' | 'member' | 'guest';
  maxBytes: number;
  dailyLimitPerUser: number;
};

/** Overrides config.discord.image + the super-admin allowlist for `fn`, then restores. */
async function withDiscordImage(
  opts: {
    enabled?: boolean;
    minRole?: DiscordImageConfig['minRole'];
    maxBytes?: number;
    dailyLimitPerUser?: number;
    superAdmins?: string[];
  },
  fn: () => Promise<void>,
): Promise<void> {
  const image = config.discord.image as DiscordImageConfig;
  const rbac = config.rbac as { superAdminDiscordIds: readonly string[] };
  const prevImage = { ...image };
  const prevAdmins = rbac.superAdminDiscordIds;
  if (opts.enabled !== undefined) image.enabled = opts.enabled;
  if (opts.minRole !== undefined) image.minRole = opts.minRole;
  if (opts.maxBytes !== undefined) image.maxBytes = opts.maxBytes;
  if (opts.dailyLimitPerUser !== undefined) image.dailyLimitPerUser = opts.dailyLimitPerUser;
  if (opts.superAdmins) rbac.superAdminDiscordIds = opts.superAdmins;
  try {
    await fn();
  } finally {
    Object.assign(image, prevImage);
    rbac.superAdminDiscordIds = prevAdmins;
  }
}

/** Mocks pool.query so resolveRole('discord', userId) resolves `role` (null => 'guest'). */
function mockDiscordMemberRole(t: TestContext, userId: string, role: 'admin' | 'member' | null) {
  return t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM community_users') && role && params[1] === userId) {
      return { rows: [{ role }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

test('precondition: IMAGE_INPUT_MIN_ROLE defaults to super_admin (acceptance criterion 4)', () => {
  assert.equal(config.discord.image.minRole, 'super_admin');
});

test('Discord image input: an enabled super-admin image attachment is fetched, base64-encoded, and attached to the IncomingMessage (acceptance criterion 2)', async () => {
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK) as unknown as DiscordImageAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  adapter.fetchImageAttachment = async (_url, mimeType) => ({ data: 'ZmFrZS1wbmctYnl0ZXM=', mimeType });
  await withDiscordImage({ enabled: true, superAdmins: ['user-783-1'] }, () =>
    fireDiscordMessage(
      adapter,
      discordImageMessage({ authorId: 'user-783-1', content: "what's this error?", attachment: {} }),
    ),
  );
  assert.ok(seen, 'the message must reach the handler');
  assert.equal(
    (seen as unknown as IncomingMessage).text,
    "what's this error?",
    'text is unaffected by the image',
  );
  assert.deepEqual((seen as unknown as IncomingMessage).image, {
    data: 'ZmFrZS1wbmctYnl0ZXM=',
    mimeType: 'image/png',
  });
});

test('SECURITY: with IMAGE_INPUT_ENABLED unset/false, Discord message handling — including any attachment — is byte-identical to today for every role (acceptance criterion 1)', async () => {
  assert.equal(config.discord.image.enabled, false, 'precondition: default env has image input off');
  for (const attachment of [
    { contentType: 'image/png', size: 100 },
    { contentType: 'application/pdf', size: 100 },
    undefined,
  ]) {
    const adapter = new DiscordAdapter(DISCORD_TEXT_PACK) as unknown as DiscordImageAdapter;
    let seen: IncomingMessage | null = null;
    let seamCalls = 0;
    adapter.onMessage(async (m) => {
      seen = m;
    });
    adapter.fetchImageAttachment = async () => {
      seamCalls += 1;
      return { data: 'should-never-run', mimeType: 'image/png' };
    };
    // Sender IS a super admin and well under every cap — proving it's the
    // flag, not the tier or the caps, that blocks.
    await withDiscordImage({ superAdmins: ['user-783-2'] }, () =>
      fireDiscordMessage(adapter, discordImageMessage({ authorId: 'user-783-2', attachment })),
    );
    assert.equal(seamCalls, 0, 'no fetch must ever occur with the flag off');
    assert.equal(
      (seen as unknown as IncomingMessage).image,
      undefined,
      'no `image` field must ever be set on the IncomingMessage with the flag off',
    );
  }
});

test('SECURITY: a below-IMAGE_INPUT_MIN_ROLE sender at the default (super_admin) is refused with zero fetch and zero DB calls (acceptance criterion 3)', async (t) => {
  const dbCalls: string[] = [];
  t.mock.method(pool, 'query', async (sql: string) => {
    dbCalls.push(sql);
    return { rows: [], rowCount: 0 };
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK) as unknown as DiscordImageAdapter;
  let seamCalls = 0;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  adapter.fetchImageAttachment = async () => {
    seamCalls += 1;
    return { data: 'must never run', mimeType: 'image/png' };
  };
  await withDiscordImage({ enabled: true, superAdmins: ['some-other-admin'] }, () =>
    fireDiscordMessage(adapter, discordImageMessage({ authorId: 'user-783-3', attachment: {} })),
  );
  assert.equal(
    seamCalls,
    0,
    'a non-super-admin must never have their attachment fetched at the default minRole',
  );
  assert.equal(
    dbCalls.length,
    0,
    'the default super_admin minRole must stay a pure env check with no DB call',
  );
  assert.equal((seen as unknown as IncomingMessage).image, undefined);
});

test('SECURITY: a below-IMAGE_INPUT_MIN_ROLE sender (role resolved via platform identity -> DB, never message content) is refused with zero fetch (acceptance criterion 3)', async (t) => {
  mockDiscordMemberRole(t, 'user-783-4', null); // no stored row => resolves to 'guest'
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK) as unknown as DiscordImageAdapter;
  let seamCalls = 0;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  adapter.fetchImageAttachment = async () => {
    seamCalls += 1;
    return { data: 'must never run', mimeType: 'image/png' };
  };
  await withDiscordImage({ enabled: true, minRole: 'member' }, () =>
    fireDiscordMessage(adapter, discordImageMessage({ authorId: 'user-783-4', attachment: {} })),
  );
  assert.equal(seamCalls, 0, 'a below-tier sender must never have their attachment fetched');
  assert.equal((seen as unknown as IncomingMessage).image, undefined);
});

test('SECURITY: an attachment over IMAGE_INPUT_MAX_BYTES is refused with zero fetch calls (acceptance criterion 3)', async () => {
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK) as unknown as DiscordImageAdapter;
  let seamCalls = 0;
  adapter.onMessage(async () => {});
  adapter.fetchImageAttachment = async () => {
    seamCalls += 1;
    return { data: 'must never run', mimeType: 'image/png' };
  };
  await withDiscordImage({ enabled: true, maxBytes: 1_000, superAdmins: ['user-783-5'] }, () =>
    fireDiscordMessage(adapter, discordImageMessage({ authorId: 'user-783-5', attachment: { size: 5_000 } })),
  );
  assert.equal(seamCalls, 0, 'an over-cap attachment must be refused before any fetch');
});

test('SECURITY: an attachment outside the MIME allowlist is refused with zero fetch calls (acceptance criterion 3)', async () => {
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK) as unknown as DiscordImageAdapter;
  let seamCalls = 0;
  adapter.onMessage(async () => {});
  adapter.fetchImageAttachment = async () => {
    seamCalls += 1;
    return { data: 'must never run', mimeType: 'image/png' };
  };
  await withDiscordImage({ enabled: true, superAdmins: ['user-783-6'] }, () =>
    fireDiscordMessage(
      adapter,
      discordImageMessage({ authorId: 'user-783-6', attachment: { contentType: 'application/pdf' } }),
    ),
  );
  assert.equal(seamCalls, 0, 'a non-allowlisted MIME type must be refused before any fetch');
});

test('SECURITY: IMAGE_INPUT_DAILY_LIMIT_PER_USER bounds a single sender — the (N+1)th image within the day is refused before any fetch (acceptance criterion 3)', async () => {
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK) as unknown as DiscordImageAdapter;
  let seamCalls = 0;
  const seen: IncomingMessage[] = [];
  adapter.onMessage(async (m) => {
    seen.push(m);
  });
  adapter.fetchImageAttachment = async () => {
    seamCalls += 1;
    return { data: `image-${seamCalls}`, mimeType: 'image/png' };
  };
  const limit = 2;
  await withDiscordImage(
    { enabled: true, dailyLimitPerUser: limit, superAdmins: ['user-783-7'] },
    async () => {
      for (let i = 0; i < limit; i++) {
        await fireDiscordMessage(adapter, discordImageMessage({ authorId: 'user-783-7', attachment: {} }));
      }
      assert.equal(seamCalls, limit, 'every attachment within the cap must be fetched');

      await fireDiscordMessage(adapter, discordImageMessage({ authorId: 'user-783-7', attachment: {} }));
      assert.equal(seamCalls, limit, 'the (N+1)th attachment must be refused BEFORE any fetch');
      assert.equal(
        seen[seen.length - 1]?.image,
        undefined,
        'an at-cap sender is left with no `image` field, exactly like a below-tier one',
      );
    },
  );
});

test('SECURITY: the default systemPrompt (IMAGE_INPUT_ENABLED off) never carries the image-untrusted-data clause — it is added only when the flag could apply (acceptance criterion 6; flag-on path in tests/imageInputSystemPromptEnabled.test.ts)', () => {
  assert.equal(config.discord.image.enabled, false, 'precondition: default env has image input off');
  const prompt = buildSystemPrompt(
    {
      platform: 'discord',
      userId: 'u1',
      userName: 'Chris',
      role: 'member',
      conversationId: 'c1',
      isDirect: false,
    },
    { codeAnswers: 'snippets', responseStyle: 'standard', languagePreference: 'auto' },
  );
  assert.doesNotMatch(prompt, /UNTRUSTED DATA to look at and answer from/);
});
