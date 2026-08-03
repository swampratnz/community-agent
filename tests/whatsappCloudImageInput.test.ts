import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
// The adapters take their community text pack as a required constructor
// parameter now (agent-base plan item 6) — production hands it over in
// src/platforms/factories.ts, so these constructions pass the same pack.
import { WHATSAPP_CLOUD_TEXT_PACK } from '../src/platforms/textPacks.js';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/strings/notices.js';
import type { IncomingMessage } from '../src/platforms/types.js';
import type { CloudInboundMessage } from '../src/platforms/whatsapp/cloudWire.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// tests/whatsappCloudAdapter.test.ts's convention. WHATSAPP_CLOUD_IMAGE_INPUT_ENABLED
// is deliberately left unset here (default false) — the flag-on systemPrompt
// clause has its own test process (tests/whatsappCloudImageInputSystemPromptEnabled.test.ts)
// since config is read once per process and can't be toggled mid-run.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER = 'cloud';
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID ??= 'test-phone-id';
process.env.WHATSAPP_CLOUD_ACCESS_TOKEN ??= 'test-access-token';
process.env.WHATSAPP_CLOUD_VERIFY_TOKEN ??= 'test-verify-token';
process.env.WHATSAPP_CLOUD_APP_SECRET ??= 'test-app-secret';

const { WhatsAppCloudAdapter } = await import('../src/platforms/whatsapp/cloudAdapter.js');
const { config } = await import('../src/config.js');
const { pool } = await import('../src/storage/db.js');
// The tier lists are registered by the tool registry at ITS module scope
// (rbac.ts fails closed until then), so import the registry first.
await import('../src/agent/tools/index.js');
const { toolsForRole, MEMBER_TOOLS, ADMIN_TOOLS, SUPER_ADMIN_TOOLS } = await import('../src/auth/rbac.js');

type Adapter = InstanceType<typeof WhatsAppCloudAdapter>;

type ImageAdapter = Adapter & {
  onCloudMessage: (m: CloudInboundMessage) => Promise<void>;
  resolveMediaUrl: (mediaId: string, accessToken: string) => Promise<{ url: string; fileSize: number }>;
  downloadMediaBytes: (url: string, accessToken: string) => Promise<Buffer>;
};

/** A Cloud webhook-normalised image message, mirroring tests/whatsappCloudAdapter.test.ts's `cloudMessage` fixture. */
function cloudImageMessage(
  from: string,
  opts: { caption?: string; mimeType?: string; id?: string } = {},
): CloudInboundMessage {
  return {
    from,
    id: opts.id ?? 'wamid.IMAGEMSG1',
    timestampMs: Date.now(),
    text: '',
    name: 'Tester',
    image: {
      mediaId: 'media-abc',
      mimeType: opts.mimeType ?? 'image/png',
      caption: opts.caption,
    },
  };
}

type WhatsappCloudImageConfig = {
  enabled: boolean;
  minRole: 'super_admin' | 'admin' | 'member' | 'guest';
  maxBytes: number;
  dailyLimitPerUser: number;
};

/** Overrides config.whatsapp.cloud.image + the super-admin allowlist for `fn`, then restores. */
async function withCloudImage(
  opts: {
    enabled?: boolean;
    minRole?: WhatsappCloudImageConfig['minRole'];
    maxBytes?: number;
    dailyLimitPerUser?: number;
    superAdmins?: string[];
  },
  fn: () => Promise<void>,
): Promise<void> {
  const image = config.whatsapp.cloud.image as WhatsappCloudImageConfig;
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

/** Stubs the two Graph media-fetch seams so gate tests never touch the network. */
function stubMediaFetch(
  adapter: ImageAdapter,
  opts: { fileSize?: number; bytes?: string } = {},
): { resolveCalls: number; downloadCalls: number } {
  const calls = { resolveCalls: 0, downloadCalls: 0 };
  adapter.resolveMediaUrl = async () => {
    calls.resolveCalls += 1;
    return { url: 'https://mmg.whatsapp.net/fake', fileSize: opts.fileSize ?? 1_000 };
  };
  adapter.downloadMediaBytes = async () => {
    calls.downloadCalls += 1;
    return Buffer.from(opts.bytes ?? 'fake-png-bytes');
  };
  return calls;
}

test('precondition: WHATSAPP_CLOUD_IMAGE_INPUT_MIN_ROLE defaults to super_admin (acceptance criterion 7/scope guardrail parity with #879)', () => {
  assert.equal(config.whatsapp.cloud.image.minRole, 'super_admin');
});

test('happy path: an enabled, in-cap, in-byte, allowlisted image from an at-or-above-MIN_ROLE sender resolves + downloads exactly once and grounds the turn (acceptance criterion 5)', async () => {
  const adapter = new WhatsAppCloudAdapter(WHATSAPP_CLOUD_TEXT_PACK) as unknown as ImageAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  const calls = stubMediaFetch(adapter);
  await withCloudImage({ enabled: true, superAdmins: ['64211230001'] }, () =>
    adapter.onCloudMessage(cloudImageMessage('64211230001', { caption: "what's this error?" })),
  );
  assert.equal(calls.resolveCalls, 1, 'exactly one media-URL resolve call');
  assert.equal(calls.downloadCalls, 1, 'exactly one byte-download call');
  assert.ok(seen, 'the message must reach the handler');
  assert.equal((seen as unknown as IncomingMessage).text, "what's this error?");
  assert.deepEqual((seen as unknown as IncomingMessage).image, {
    data: Buffer.from('fake-png-bytes').toString('base64'),
    mimeType: 'image/png',
  });
});

test('SECURITY: with WHATSAPP_CLOUD_IMAGE_INPUT_ENABLED unset/false, an inbound image produces no IncomingMessage.image and no reply at all — the same total silence as before #891 (acceptance criterion 1)', async () => {
  assert.equal(config.whatsapp.cloud.image.enabled, false, 'precondition: default env has image input off');
  for (const opts of [{ caption: 'help!' }, {}]) {
    const adapter = new WhatsAppCloudAdapter(WHATSAPP_CLOUD_TEXT_PACK) as unknown as ImageAdapter;
    let seen: IncomingMessage | null = null;
    adapter.onMessage(async (m) => {
      seen = m;
    });
    // Sender IS a super admin and well under every cap — proving it's the
    // flag, not the tier or the caps, that blocks.
    const calls = stubMediaFetch(adapter);
    await withCloudImage({ superAdmins: ['64211230002'] }, () =>
      adapter.onCloudMessage(cloudImageMessage('64211230002', opts)),
    );
    assert.equal(calls.resolveCalls, 0, 'no media-URL resolve may ever occur with the flag off');
    assert.equal(calls.downloadCalls, 0, 'no byte download may ever occur with the flag off');
    assert.equal(seen, null, 'no reply/handler call at all — matches the pre-#891 total silence');
  }
});

test('SECURITY: caption survives extractMessages onto the new image field and is promoted to `text` only once the image is accepted — never discarded, never silently swapped (acceptance criterion 2)', async () => {
  const { extractMessages } = await import('../src/platforms/whatsapp/cloudWire.js');
  const wirePayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: '64211230003',
                  id: 'wamid.CAPTION1',
                  timestamp: '1700000000',
                  type: 'image',
                  image: { id: 'media-cap', mime_type: 'image/png', caption: 'billing page screenshot' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const extracted = extractMessages(wirePayload);
  assert.equal(extracted.length, 1);
  assert.equal(
    extracted[0].image?.caption,
    'billing page screenshot',
    'the caption must survive onto the wire-level image field',
  );
  assert.equal(extracted[0].text, '', 'text stays empty at the wire level — only promoted once accepted');

  const adapter = new WhatsAppCloudAdapter(WHATSAPP_CLOUD_TEXT_PACK) as unknown as ImageAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  stubMediaFetch(adapter);
  await withCloudImage({ enabled: true, superAdmins: ['64211230003'] }, () =>
    adapter.onCloudMessage(extracted[0]),
  );
  assert.equal(
    (seen as unknown as IncomingMessage).text,
    'billing page screenshot',
    'the caption must reach the accepted turn as `text`, never dropped or swapped for empty text',
  );
});

test('SECURITY: (gate order a1) a below-WHATSAPP_CLOUD_IMAGE_INPUT_MIN_ROLE sender at the default (super_admin) is refused with zero Graph calls and zero DB calls (acceptance criterion 3)', async (t) => {
  const dbCalls: string[] = [];
  t.mock.method(pool, 'query', async (sql: string) => {
    dbCalls.push(sql);
    return { rows: [], rowCount: 0 };
  });
  const adapter = new WhatsAppCloudAdapter(WHATSAPP_CLOUD_TEXT_PACK) as unknown as ImageAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  const calls = stubMediaFetch(adapter);
  await withCloudImage({ enabled: true, superAdmins: ['64299990000'] }, () =>
    adapter.onCloudMessage(cloudImageMessage('64211230004')),
  );
  assert.equal(calls.resolveCalls, 0);
  assert.equal(calls.downloadCalls, 0);
  assert.equal(
    dbCalls.length,
    0,
    'the default super_admin minRole must stay a pure env check with no DB call',
  );
  assert.equal(seen, null);
});

test('SECURITY: (gate order a2) a below-WHATSAPP_CLOUD_IMAGE_INPUT_MIN_ROLE sender (role resolved via platform identity -> DB) is refused with zero Graph calls (acceptance criterion 3)', async (t) => {
  mockWhatsappMemberRole(t, '64211230005', null); // no stored row => resolves to 'guest'
  const adapter = new WhatsAppCloudAdapter(WHATSAPP_CLOUD_TEXT_PACK) as unknown as ImageAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  const calls = stubMediaFetch(adapter);
  await withCloudImage({ enabled: true, minRole: 'member' }, () =>
    adapter.onCloudMessage(cloudImageMessage('64211230005')),
  );
  assert.equal(calls.resolveCalls, 0);
  assert.equal(calls.downloadCalls, 0);
  assert.equal(seen, null);
});

test('SECURITY: (gate order b) WHATSAPP_CLOUD_IMAGE_INPUT_DAILY_LIMIT_PER_USER bounds a sender — the (N+1)th image is refused with zero Graph calls (acceptance criterion 3)', async () => {
  const adapter = new WhatsAppCloudAdapter(WHATSAPP_CLOUD_TEXT_PACK) as unknown as ImageAdapter;
  const seen: IncomingMessage[] = [];
  adapter.onMessage(async (m) => {
    seen.push(m);
  });
  const calls = stubMediaFetch(adapter);
  const limit = 2;
  await withCloudImage(
    { enabled: true, dailyLimitPerUser: limit, superAdmins: ['64211230006'] },
    async () => {
      for (let i = 0; i < limit; i++) {
        await adapter.onCloudMessage(
          cloudImageMessage('64211230006', { caption: `img ${i}`, id: `wamid.D${i}` }),
        );
      }
      assert.equal(calls.resolveCalls, limit);
      assert.equal(calls.downloadCalls, limit);

      await adapter.onCloudMessage(
        cloudImageMessage('64211230006', { caption: 'over cap', id: 'wamid.OVER' }),
      );
      assert.equal(calls.resolveCalls, limit, 'the (N+1)th attempt must be refused BEFORE any resolve call');
      assert.equal(calls.downloadCalls, limit);
      assert.equal(seen.length, limit, 'the over-cap sender gets no turn at all — no image, no text');
    },
  );
});

test('SECURITY: (gate order c) a non-allowlisted MIME (per Meta webhook metadata) is refused with zero Graph calls (acceptance criterion 3)', async () => {
  const adapter = new WhatsAppCloudAdapter(WHATSAPP_CLOUD_TEXT_PACK) as unknown as ImageAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  const calls = stubMediaFetch(adapter);
  await withCloudImage({ enabled: true, superAdmins: ['64211230007'] }, () =>
    adapter.onCloudMessage(cloudImageMessage('64211230007', { mimeType: 'application/pdf', caption: 'x' })),
  );
  assert.equal(calls.resolveCalls, 0);
  assert.equal(calls.downloadCalls, 0);
  assert.equal(seen, null);
});

test('SECURITY: (gate order d) an attachment over WHATSAPP_CLOUD_IMAGE_INPUT_MAX_BYTES is refused after the metadata resolve but with zero byte-download calls (acceptance criterion 3)', async () => {
  const adapter = new WhatsAppCloudAdapter(WHATSAPP_CLOUD_TEXT_PACK) as unknown as ImageAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  const calls = stubMediaFetch(adapter, { fileSize: 5_000 });
  await withCloudImage({ enabled: true, maxBytes: 1_000, superAdmins: ['64211230008'] }, () =>
    adapter.onCloudMessage(cloudImageMessage('64211230008', { caption: 'too big' })),
  );
  assert.equal(
    calls.resolveCalls,
    1,
    "Meta's webhook carries no byte size, so exactly one lightweight metadata call is unavoidable",
  );
  assert.equal(calls.downloadCalls, 0, 'the actual byte-download call must never fire for an over-cap image');
  assert.equal(seen, null);
});

test("SECURITY: a resolve/download failure is logged and swallowed — the attachment is dropped, not a crash (mirrors #879's failure posture)", async () => {
  const adapter = new WhatsAppCloudAdapter(WHATSAPP_CLOUD_TEXT_PACK) as unknown as ImageAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  adapter.resolveMediaUrl = async () => {
    throw new Error('simulated Graph API failure');
  };
  adapter.downloadMediaBytes = async () => Buffer.from('');
  await withCloudImage({ enabled: true, superAdmins: ['64211230009'] }, () =>
    adapter.onCloudMessage(cloudImageMessage('64211230009', { caption: 'will fail' })),
  );
  assert.equal(seen, null, 'a fetch failure drops the message rather than throwing out of onCloudMessage');
});

test('SECURITY: enabling Baileys WHATSAPP_IMAGE_INPUT_ENABLED (or Discord IMAGE_INPUT_ENABLED) does not enable Cloud image input — the three flags are fully independent (acceptance criterion 7 parity)', async (t) => {
  const baileysImage = config.whatsapp.image as { enabled: boolean };
  const discordImage = config.discord.image as { enabled: boolean };
  const prevBaileys = baileysImage.enabled;
  const prevDiscord = discordImage.enabled;
  baileysImage.enabled = true;
  discordImage.enabled = true;
  t.after(() => {
    baileysImage.enabled = prevBaileys;
    discordImage.enabled = prevDiscord;
  });
  const adapter = new WhatsAppCloudAdapter(WHATSAPP_CLOUD_TEXT_PACK) as unknown as ImageAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  const calls = stubMediaFetch(adapter);
  await withCloudImage({ superAdmins: ['64211230010'] }, () =>
    adapter.onCloudMessage(cloudImageMessage('64211230010', { caption: 'x' })),
  );
  assert.equal(
    calls.resolveCalls,
    0,
    "another platform's flag being on must not enable Cloud image fetching",
  );
  assert.equal(seen, null);
});

test("SECURITY: WHATSAPP_CLOUD_IMAGE_INPUT_ENABLED adds no tool and does not elevate any caller's resolved tier (acceptance criterion 4)", async () => {
  const image = config.whatsapp.cloud.image as { enabled: boolean };
  const prev = image.enabled;
  const before = {
    guest: toolsForRole('guest'),
    member: toolsForRole('member'),
    admin: toolsForRole('admin'),
    super_admin: toolsForRole('super_admin'),
  };
  image.enabled = true;
  try {
    assert.deepEqual(toolsForRole('guest'), before.guest);
    assert.deepEqual(toolsForRole('member'), before.member);
    assert.deepEqual(toolsForRole('admin'), before.admin);
    assert.deepEqual(toolsForRole('super_admin'), before.super_admin);
    // toolsForRole is a pure role -> tool-list mapping (src/auth/rbac.ts) with
    // no config import at all, so this also pins the tool-surface SHAPE for
    // every tier, not just that it's unchanged by the flag.
    assert.deepEqual(toolsForRole('guest'), [...MEMBER_TOOLS]);
    assert.deepEqual(toolsForRole('member'), [...MEMBER_TOOLS]);
    assert.deepEqual(toolsForRole('admin'), [...MEMBER_TOOLS, ...ADMIN_TOOLS]);
    assert.deepEqual(toolsForRole('super_admin'), [...MEMBER_TOOLS, ...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]);
  } finally {
    image.enabled = prev;
  }
});
