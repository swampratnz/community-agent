import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/strings/notices.js';
import type { IncomingMessage } from '../src/platforms/types.js';
import type { CloudInboundMessage } from '../src/platforms/whatsapp/cloudWire.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// tests/whatsappCloudImageInput.test.ts's convention.
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

type Adapter = InstanceType<typeof WhatsAppCloudAdapter>;

type VoiceAdapter = Adapter & {
  onCloudMessage: (m: CloudInboundMessage) => Promise<void>;
  resolveMediaUrl: (mediaId: string, accessToken: string) => Promise<{ url: string; fileSize: number }>;
  downloadMediaBytes: (url: string, accessToken: string) => Promise<Buffer>;
  transcribeAudioBytes: (buffer: Buffer) => Promise<string>;
};

/** A Cloud webhook-normalised voice message, mirroring whatsappCloudImageInput.test.ts's `cloudImageMessage` fixture. */
function cloudVoiceMessage(from: string, opts: { mimeType?: string; id?: string } = {}): CloudInboundMessage {
  return {
    from,
    id: opts.id ?? 'wamid.VOICEMSG1',
    timestampMs: Date.now(),
    text: '',
    name: 'Tester',
    voice: {
      mediaId: 'media-voice-abc',
      mimeType: opts.mimeType ?? 'audio/ogg',
    },
  };
}

type WhatsappCloudVoiceConfig = {
  enabled: boolean;
  minRole: 'super_admin' | 'admin' | 'member' | 'guest';
  maxBytes: number;
  rateLimitPerHour: number;
};

/** Overrides config.whatsapp.cloud.voice + the super-admin allowlist for `fn`, then restores. */
async function withCloudVoice(
  opts: {
    enabled?: boolean;
    minRole?: WhatsappCloudVoiceConfig['minRole'];
    maxBytes?: number;
    rateLimitPerHour?: number;
    superAdmins?: string[];
  },
  fn: () => Promise<void>,
): Promise<void> {
  const voice = config.whatsapp.cloud.voice as WhatsappCloudVoiceConfig;
  const rbac = config.rbac as { superAdminWhatsappNumbers: readonly string[] };
  const prevVoice = { ...voice };
  const prevAdmins = rbac.superAdminWhatsappNumbers;
  if (opts.enabled !== undefined) voice.enabled = opts.enabled;
  if (opts.minRole !== undefined) voice.minRole = opts.minRole;
  if (opts.maxBytes !== undefined) voice.maxBytes = opts.maxBytes;
  if (opts.rateLimitPerHour !== undefined) voice.rateLimitPerHour = opts.rateLimitPerHour;
  if (opts.superAdmins) rbac.superAdminWhatsappNumbers = opts.superAdmins;
  try {
    await fn();
  } finally {
    Object.assign(voice, prevVoice);
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

/** Stubs the three fetch/transcribe seams so gate tests never touch the network, ffmpeg or the model. */
function stubVoiceFetch(
  adapter: VoiceAdapter,
  opts: { fileSize?: number; transcript?: string } = {},
): { resolveCalls: number; downloadCalls: number; transcribeCalls: number } {
  const calls = { resolveCalls: 0, downloadCalls: 0, transcribeCalls: 0 };
  adapter.resolveMediaUrl = async () => {
    calls.resolveCalls += 1;
    return { url: 'https://mmg.whatsapp.net/fake-audio', fileSize: opts.fileSize ?? 1_000 };
  };
  adapter.downloadMediaBytes = async () => {
    calls.downloadCalls += 1;
    return Buffer.from('fake-ogg-bytes');
  };
  adapter.transcribeAudioBytes = async () => {
    calls.transcribeCalls += 1;
    return opts.transcript ?? 'kia ora, this is a test transcript';
  };
  return calls;
}

test('precondition: WHATSAPP_CLOUD_VOICE_MIN_ROLE defaults to super_admin, matching the Baileys/Cloud-image conservative default', () => {
  assert.equal(config.whatsapp.cloud.voice.minRole, 'super_admin');
});

test('happy path: an enabled, in-cap, at-or-above-MIN_ROLE sender resolves + downloads + transcribes exactly once and grounds the turn as ordinary text', async () => {
  const adapter = new WhatsAppCloudAdapter() as unknown as VoiceAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  const calls = stubVoiceFetch(adapter, { transcript: 'what is the member count' });
  await withCloudVoice({ enabled: true, superAdmins: ['64211240001'] }, () =>
    adapter.onCloudMessage(cloudVoiceMessage('64211240001')),
  );
  assert.equal(calls.resolveCalls, 1, 'exactly one media-URL resolve call');
  assert.equal(calls.downloadCalls, 1, 'exactly one byte-download call');
  assert.equal(calls.transcribeCalls, 1, 'exactly one transcription call');
  assert.ok(seen, 'the message must reach the handler');
  assert.equal((seen as unknown as IncomingMessage).text, 'what is the member count');
  assert.equal(
    (seen as unknown as IncomingMessage).image,
    undefined,
    'a voice-driven turn carries no image field',
  );
});

test('SECURITY: with WHATSAPP_CLOUD_VOICE_ENABLED unset/false, an inbound voice note produces zero Graph API calls and no reply at all — total silence (acceptance criterion 2)', async () => {
  assert.equal(config.whatsapp.cloud.voice.enabled, false, 'precondition: default env has voice input off');
  const adapter = new WhatsAppCloudAdapter() as unknown as VoiceAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  // Sender IS a super admin and well under every cap — proving it's the
  // flag, not the tier or the caps, that blocks.
  const calls = stubVoiceFetch(adapter);
  await withCloudVoice({ superAdmins: ['64211240002'] }, () =>
    adapter.onCloudMessage(cloudVoiceMessage('64211240002')),
  );
  assert.equal(calls.resolveCalls, 0, 'no media-URL resolve may ever occur with the flag off');
  assert.equal(calls.downloadCalls, 0, 'no byte download may ever occur with the flag off');
  assert.equal(calls.transcribeCalls, 0, 'no transcription may ever occur with the flag off');
  assert.equal(seen, null, 'no reply/handler call at all — matches the off-by-default image test');
});

test('SECURITY: (gate order a1) a below-WHATSAPP_CLOUD_VOICE_MIN_ROLE sender at the default (super_admin) is refused with zero Graph calls and zero DB calls (acceptance criterion 4)', async (t) => {
  const dbCalls: string[] = [];
  t.mock.method(pool, 'query', async (sql: string) => {
    dbCalls.push(sql);
    return { rows: [], rowCount: 0 };
  });
  const adapter = new WhatsAppCloudAdapter() as unknown as VoiceAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  const calls = stubVoiceFetch(adapter);
  await withCloudVoice({ enabled: true, superAdmins: ['64299991111'] }, () =>
    adapter.onCloudMessage(cloudVoiceMessage('64211240003')),
  );
  assert.equal(calls.resolveCalls, 0);
  assert.equal(calls.downloadCalls, 0);
  assert.equal(calls.transcribeCalls, 0);
  assert.equal(
    dbCalls.length,
    0,
    'the default super_admin minRole must stay a pure env check with no DB call',
  );
  assert.equal(seen, null);
});

test('SECURITY: (gate order a2) a below-WHATSAPP_CLOUD_VOICE_MIN_ROLE sender (role resolved via platform identity -> DB) is refused with zero Graph calls (acceptance criterion 4)', async (t) => {
  mockWhatsappMemberRole(t, '64211240004', null); // no stored row => resolves to 'guest'
  const adapter = new WhatsAppCloudAdapter() as unknown as VoiceAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  const calls = stubVoiceFetch(adapter);
  await withCloudVoice({ enabled: true, minRole: 'member' }, () =>
    adapter.onCloudMessage(cloudVoiceMessage('64211240004')),
  );
  assert.equal(calls.resolveCalls, 0);
  assert.equal(calls.downloadCalls, 0);
  assert.equal(seen, null);
});

test('SECURITY: WHATSAPP_CLOUD_VOICE_RATE_LIMIT_PER_HOUR bounds a sender — the (N+1)th voice note within the hour is refused with zero Graph calls', async () => {
  const adapter = new WhatsAppCloudAdapter() as unknown as VoiceAdapter;
  const seen: IncomingMessage[] = [];
  adapter.onMessage(async (m) => {
    seen.push(m);
  });
  const calls = stubVoiceFetch(adapter);
  const limit = 2;
  await withCloudVoice({ enabled: true, rateLimitPerHour: limit, superAdmins: ['64211240005'] }, async () => {
    for (let i = 0; i < limit; i++) {
      await adapter.onCloudMessage(cloudVoiceMessage('64211240005', { id: `wamid.R${i}` }));
    }
    assert.equal(calls.resolveCalls, limit);
    assert.equal(calls.downloadCalls, limit);

    await adapter.onCloudMessage(cloudVoiceMessage('64211240005', { id: 'wamid.ROVER' }));
    assert.equal(calls.resolveCalls, limit, 'the (N+1)th attempt must be refused BEFORE any resolve call');
    assert.equal(calls.downloadCalls, limit);
    assert.equal(seen.length, limit, 'the over-cap sender gets no turn at all');
  });
});

test('SECURITY: (gate order — size cap) an attachment over WHATSAPP_CLOUD_VOICE_MAX_BYTES is refused after the metadata resolve but with zero byte-download calls (acceptance criterion 6)', async () => {
  const adapter = new WhatsAppCloudAdapter() as unknown as VoiceAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  const calls = stubVoiceFetch(adapter, { fileSize: 20_000_000 });
  await withCloudVoice({ enabled: true, maxBytes: 1_000_000, superAdmins: ['64211240006'] }, () =>
    adapter.onCloudMessage(cloudVoiceMessage('64211240006')),
  );
  assert.equal(
    calls.resolveCalls,
    1,
    "Meta's webhook carries no duration or size, so exactly one lightweight metadata call is unavoidable",
  );
  assert.equal(calls.downloadCalls, 0, 'the actual byte-download call must never fire for an over-cap note');
  assert.equal(calls.transcribeCalls, 0);
  assert.equal(seen, null);
});

test("SECURITY: a resolve/download/transcription failure is logged and swallowed — the note is dropped, not a crash (mirrors #891's image failure posture)", async () => {
  const adapter = new WhatsAppCloudAdapter() as unknown as VoiceAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  adapter.resolveMediaUrl = async () => {
    throw new Error('simulated Graph API failure');
  };
  adapter.downloadMediaBytes = async () => Buffer.from('');
  adapter.transcribeAudioBytes = async () => '';
  await withCloudVoice({ enabled: true, superAdmins: ['64211240007'] }, () =>
    adapter.onCloudMessage(cloudVoiceMessage('64211240007')),
  );
  assert.equal(seen, null, 'a fetch failure drops the message rather than throwing out of onCloudMessage');
});

test('SECURITY: enabling Baileys WHATSAPP_VOICE_ENABLED (or Discord DISCORD_VOICE_ENABLED) does not enable Cloud voice transcription — the three flags are fully independent (acceptance criterion 7)', async (t) => {
  const baileysVoice = config.whatsapp.voice as { enabled: boolean };
  const discordVoice = config.discord.voice as { enabled: boolean };
  const prevBaileys = baileysVoice.enabled;
  const prevDiscord = discordVoice.enabled;
  baileysVoice.enabled = true;
  discordVoice.enabled = true;
  t.after(() => {
    baileysVoice.enabled = prevBaileys;
    discordVoice.enabled = prevDiscord;
  });
  const adapter = new WhatsAppCloudAdapter() as unknown as VoiceAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  const calls = stubVoiceFetch(adapter);
  await withCloudVoice({ superAdmins: ['64211240008'] }, () =>
    adapter.onCloudMessage(cloudVoiceMessage('64211240008')),
  );
  assert.equal(
    calls.resolveCalls,
    0,
    "another platform's flag being on must not enable Cloud voice transcription",
  );
  assert.equal(seen, null);
});

test('SECURITY: enabling WHATSAPP_CLOUD_VOICE_ENABLED does not enable WHATSAPP_CLOUD_IMAGE_INPUT_ENABLED, and vice versa — independent flags within the same adapter', async (t) => {
  const image = config.whatsapp.cloud.image as { enabled: boolean };
  const prevImage = image.enabled;
  t.after(() => {
    image.enabled = prevImage;
  });
  image.enabled = true;
  const adapter = new WhatsAppCloudAdapter() as unknown as VoiceAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  const calls = stubVoiceFetch(adapter);
  await withCloudVoice({ superAdmins: ['64211240009'] }, () =>
    adapter.onCloudMessage(cloudVoiceMessage('64211240009')),
  );
  assert.equal(
    calls.resolveCalls,
    0,
    'the Cloud image flag being on must not enable Cloud voice transcription',
  );
  assert.equal(seen, null);
});

test('SECURITY: no raw audio bytes ever reach the IncomingMessage handed to the router — only the transcript text (acceptance criterion 5)', async () => {
  const adapter = new WhatsAppCloudAdapter() as unknown as VoiceAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  stubVoiceFetch(adapter, { transcript: 'kia ora, this is a test transcript' });
  await withCloudVoice({ enabled: true, superAdmins: ['64211240010'] }, () =>
    adapter.onCloudMessage(cloudVoiceMessage('64211240010')),
  );
  assert.ok(seen, 'the message must reach the handler');
  const message = seen as unknown as IncomingMessage;
  assert.equal(message.text, 'kia ora, this is a test transcript');
  const keys = Object.keys(message);
  assert.ok(!keys.includes('audio'), 'IncomingMessage has no audio field at all — nothing to leak');
  assert.equal(message.image, undefined);
  // `raw` carries the wire-level CloudInboundMessage, which only ever holds
  // the media id/mime type metadata (never bytes) for a voice message — see
  // CloudInboundMessage.voice's doc comment.
  const raw = message.raw as CloudInboundMessage;
  assert.deepEqual(raw.voice, { mediaId: 'media-voice-abc', mimeType: 'audio/ogg' });
});
