import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
// The adapters take their community text pack as a required constructor
// parameter now (agent-base plan item 6) — production hands it over in
// src/platforms/factories.ts, so these constructions pass the same pack.
import { BAILEYS_TEXT_PACK } from '../src/platforms/textPacks.js';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/strings/notices.js';
import type { IncomingMessage } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// tests/baileysAdapter.test.ts's convention. WHATSAPP_IMAGE_INPUT_ENABLED is
// deliberately left unset here (default false) — the flag-on systemPrompt
// clause has its own test process (tests/whatsappImageInputSystemPromptEnabled.test.ts)
// since config is read once per process and can't be toggled mid-run.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { BaileysAdapter } = await import('../src/platforms/whatsapp/baileysAdapter.js');
const { config } = await import('../src/config.js');
const { pool } = await import('../src/storage/db.js');

type Adapter = InstanceType<typeof BaileysAdapter>;

type ImageAdapter = Adapter & {
  onWhatsappMessage: (m: unknown) => Promise<void>;
  fetchImageAttachment: (
    msg: unknown,
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
  ) => Promise<IncomingMessage['image']>;
};

/**
 * A DM carrying a single WhatsApp `imageMessage`, mirroring
 * tests/baileysAdapter.test.ts's `voiceDm` fixture but reporting
 * `mimetype`/`fileLength` (an image message's own metadata, read pre-fetch)
 * instead of `audioMessage`'s `seconds`. A DM keeps `isDirect`/addressed
 * true and never touches the moderation-scan branch (real Postgres), same
 * convention as the voice tests.
 */
function imageDm(
  fromNumber: string,
  opts: { caption?: string; mimetype?: string; fileLength?: number } = {},
): unknown {
  return {
    key: { remoteJid: `${fromNumber}@s.whatsapp.net`, fromMe: false, id: 'IMAGEMSG1' },
    pushName: 'Tester',
    messageTimestamp: 1_700_000_000,
    message: {
      imageMessage: {
        mimetype: opts.mimetype ?? 'image/png',
        caption: opts.caption ?? "what's this error?",
        fileLength: opts.fileLength ?? 1_000,
      },
    },
  };
}

type WhatsappImageConfig = {
  enabled: boolean;
  minRole: 'super_admin' | 'admin' | 'member' | 'guest';
  maxBytes: number;
  dailyLimitPerUser: number;
};

/** Overrides config.whatsapp.image + the super-admin allowlist for `fn`, then restores. */
async function withImage(
  opts: {
    enabled?: boolean;
    minRole?: WhatsappImageConfig['minRole'];
    maxBytes?: number;
    dailyLimitPerUser?: number;
    superAdmins?: string[];
  },
  fn: () => Promise<void>,
): Promise<void> {
  const image = config.whatsapp.image as WhatsappImageConfig;
  const rbac = config.rbac as { superAdminWhatsappNumbers: readonly string[] };
  const prevImage = { ...image };
  const prevAdmins = rbac.superAdminWhatsappNumbers;
  if (opts.enabled !== undefined) image.enabled = opts.enabled;
  if (opts.minRole !== undefined) image.minRole = opts.minRole;
  if (opts.maxBytes !== undefined) image.maxBytes = opts.maxBytes;
  if (opts.dailyLimitPerUser !== undefined) image.dailyLimitPerUser = opts.dailyLimitPerUser;
  if (opts.superAdmins) rbac.superAdminWhatsappNumbers = opts.superAdmins;
  try {
    await fn();
  } finally {
    Object.assign(image, prevImage);
    rbac.superAdminWhatsappNumbers = prevAdmins;
  }
}

/** Mocks pool.query so resolveRole('whatsapp', userId) resolves `role` (null => 'guest'). */
function mockWhatsappMemberRole(t: TestContext, userId: string, role: 'admin' | 'member' | null) {
  return t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM community_users') && role && params[1] === userId) {
      return { rows: [{ role }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

test('precondition: WHATSAPP_IMAGE_INPUT_MIN_ROLE defaults to super_admin (acceptance criterion 7)', () => {
  assert.equal(config.whatsapp.image.minRole, 'super_admin');
});

test('WhatsApp image input: an enabled super-admin image attachment is fetched, base64-encoded, and attached to the IncomingMessage (acceptance criterion 1)', async () => {
  const adapter = new BaileysAdapter(BAILEYS_TEXT_PACK) as unknown as ImageAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  adapter.fetchImageAttachment = async (_msg, mimeType) => ({ data: 'ZmFrZS1wbmctYnl0ZXM=', mimeType });
  await withImage({ enabled: true, superAdmins: ['64211230001'] }, () =>
    adapter.onWhatsappMessage(imageDm('64211230001', { caption: "what's this error?" })),
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

test('SECURITY: with WHATSAPP_IMAGE_INPUT_ENABLED unset/false, WhatsApp message handling — including any image attachment — is byte-identical to today for every role (acceptance criterion 2)', async () => {
  assert.equal(config.whatsapp.image.enabled, false, 'precondition: default env has image input off');
  for (const opts of [{ mimetype: 'image/png' }, { mimetype: 'application/pdf' }]) {
    const adapter = new BaileysAdapter(BAILEYS_TEXT_PACK) as unknown as ImageAdapter;
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
    await withImage({ superAdmins: ['64211230002'] }, () =>
      adapter.onWhatsappMessage(imageDm('64211230002', opts)),
    );
    assert.equal(seamCalls, 0, 'no download must ever occur with the flag off');
    assert.equal(
      (seen as unknown as IncomingMessage).image,
      undefined,
      'no `image` field must ever be set on the IncomingMessage with the flag off',
    );
  }
});

test('SECURITY: a below-WHATSAPP_IMAGE_INPUT_MIN_ROLE sender at the default (super_admin) is refused with zero download and zero DB calls (acceptance criterion 3)', async (t) => {
  const dbCalls: string[] = [];
  t.mock.method(pool, 'query', async (sql: string) => {
    dbCalls.push(sql);
    return { rows: [], rowCount: 0 };
  });
  const adapter = new BaileysAdapter(BAILEYS_TEXT_PACK) as unknown as ImageAdapter;
  let seamCalls = 0;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  adapter.fetchImageAttachment = async () => {
    seamCalls += 1;
    return { data: 'must never run', mimeType: 'image/png' };
  };
  await withImage({ enabled: true, superAdmins: ['64299990000'] }, () =>
    adapter.onWhatsappMessage(imageDm('64211230003')),
  );
  assert.equal(
    seamCalls,
    0,
    'a non-super-admin must never have their attachment downloaded at the default minRole',
  );
  assert.equal(
    dbCalls.length,
    0,
    'the default super_admin minRole must stay a pure env check with no DB call',
  );
  assert.equal((seen as unknown as IncomingMessage).image, undefined);
});

test('SECURITY: a below-WHATSAPP_IMAGE_INPUT_MIN_ROLE sender (role resolved via platform identity -> DB, never message content) is refused with zero download (acceptance criterion 3)', async (t) => {
  mockWhatsappMemberRole(t, '64211230004', null); // no stored row => resolves to 'guest'
  const adapter = new BaileysAdapter(BAILEYS_TEXT_PACK) as unknown as ImageAdapter;
  let seamCalls = 0;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  adapter.fetchImageAttachment = async () => {
    seamCalls += 1;
    return { data: 'must never run', mimeType: 'image/png' };
  };
  await withImage({ enabled: true, minRole: 'member' }, () =>
    adapter.onWhatsappMessage(imageDm('64211230004')),
  );
  assert.equal(seamCalls, 0, 'a below-tier sender must never have their attachment downloaded');
  assert.equal((seen as unknown as IncomingMessage).image, undefined);
});

test('SECURITY: an attachment over WHATSAPP_IMAGE_INPUT_MAX_BYTES is refused with zero download calls (acceptance criterion 5)', async () => {
  const adapter = new BaileysAdapter(BAILEYS_TEXT_PACK) as unknown as ImageAdapter;
  let seamCalls = 0;
  adapter.onMessage(async () => {});
  adapter.fetchImageAttachment = async () => {
    seamCalls += 1;
    return { data: 'must never run', mimeType: 'image/png' };
  };
  await withImage({ enabled: true, maxBytes: 1_000, superAdmins: ['64211230005'] }, () =>
    adapter.onWhatsappMessage(imageDm('64211230005', { fileLength: 5_000 })),
  );
  assert.equal(seamCalls, 0, 'an over-cap attachment must be refused before any download');
});

test('SECURITY: an attachment outside the MIME allowlist is refused with zero download calls (acceptance criterion 5)', async () => {
  const adapter = new BaileysAdapter(BAILEYS_TEXT_PACK) as unknown as ImageAdapter;
  let seamCalls = 0;
  adapter.onMessage(async () => {});
  adapter.fetchImageAttachment = async () => {
    seamCalls += 1;
    return { data: 'must never run', mimeType: 'image/png' };
  };
  await withImage({ enabled: true, superAdmins: ['64211230006'] }, () =>
    adapter.onWhatsappMessage(imageDm('64211230006', { mimetype: 'application/pdf' })),
  );
  assert.equal(seamCalls, 0, 'a non-allowlisted MIME type must be refused before any download');
});

test('SECURITY: WHATSAPP_IMAGE_INPUT_DAILY_LIMIT_PER_USER bounds a single sender — the (N+1)th image within the day is refused before any download (acceptance criterion 5)', async () => {
  const adapter = new BaileysAdapter(BAILEYS_TEXT_PACK) as unknown as ImageAdapter;
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
  await withImage({ enabled: true, dailyLimitPerUser: limit, superAdmins: ['64211230007'] }, async () => {
    for (let i = 0; i < limit; i++) {
      await adapter.onWhatsappMessage(imageDm('64211230007'));
    }
    assert.equal(seamCalls, limit, 'every attachment within the cap must be downloaded');

    await adapter.onWhatsappMessage(imageDm('64211230007'));
    assert.equal(seamCalls, limit, 'the (N+1)th attachment must be refused BEFORE any download');
    assert.equal(
      seen[seen.length - 1]?.image,
      undefined,
      'an at-cap sender is left with no `image` field, exactly like a below-tier one',
    );
  });
});

test('SECURITY: enabling Discord IMAGE_INPUT_ENABLED does not enable WhatsApp image input — the flags are fully independent (acceptance criterion 7)', async (t) => {
  const discordImage = config.discord.image as { enabled: boolean };
  const prevDiscord = discordImage.enabled;
  discordImage.enabled = true;
  t.after(() => {
    discordImage.enabled = prevDiscord;
  });
  const adapter = new BaileysAdapter(BAILEYS_TEXT_PACK) as unknown as ImageAdapter;
  let seamCalls = 0;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  adapter.fetchImageAttachment = async () => {
    seamCalls += 1;
    return { data: 'must never run', mimeType: 'image/png' };
  };
  await withImage({ superAdmins: ['64211230008'] }, () => adapter.onWhatsappMessage(imageDm('64211230008')));
  assert.equal(seamCalls, 0, "Discord's flag being on must not enable WhatsApp image downloading");
  assert.equal((seen as unknown as IncomingMessage).image, undefined);
});
