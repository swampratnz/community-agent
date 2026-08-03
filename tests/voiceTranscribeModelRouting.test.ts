import { test } from 'node:test';
import assert from 'node:assert/strict';
// The default bad-word list is community content registered at its own module
// scope (src/index.ts imports it in production); the moderation wordlist fails
// closed until then, and constructing a Discord adapter builds a Moderator.
import '../src/moderation/badWords.js';
// The adapters take their community text pack as a required constructor
// parameter now (agent-base plan item 6) — production hands it over in
// src/platforms/factories.ts, so these constructions pass the same pack.
import { BAILEYS_TEXT_PACK, DISCORD_TEXT_PACK } from '../src/platforms/textPacks.js';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/strings/notices.js';
import { EventEmitter } from 'node:events';

// config.ts validates env at import time.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

// PR #735 review: `config.discord.voice.model` was read from env but never
// threaded into the transcription pipeline — `getTranscriber()` hardcoded
// `config.whatsapp.voice.model` for every caller, so setting
// DISCORD_VOICE_MODEL to something other than WHATSAPP_VOICE_MODEL silently
// kept using the WhatsApp model. This file mocks out the actual model/network
// seams (transcribeVoiceNote, the baileys media downloader) so the REAL,
// un-stubbed `transcribeAttachment` / `transcribeAudioMessage` methods run and
// prove each platform threads its OWN `*_VOICE_MODEL` through — no ffmpeg or
// model download needed since transcribeVoiceNote itself is mocked.
const modelCalls: string[] = [];

// transcribeVoiceNote and downloadMediaMessage are static imports inside
// adapter.ts/baileysAdapter.ts, so once those modules have been dynamically
// imported anywhere in this process the bindings are fixed — a later
// t.mock.module call can't retarget them (same trap as
// tests/agentCoreMaxTurns.test.ts). Install both mocks once, before the first
// import, and reuse the cached modules across tests.
let modulesPromise: Promise<{
  DiscordAdapter: typeof import('../src/platforms/discord/adapter.js').DiscordAdapter;
  BaileysAdapter: typeof import('../src/platforms/whatsapp/baileysAdapter.js').BaileysAdapter;
  config: typeof import('../src/config.js').config;
}> | null = null;

async function modules(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!modulesPromise) {
    t.mock.module('../src/media/voiceTranscribe.js', {
      namedExports: {
        transcribeVoiceNote: async (_audio: Buffer, model: string) => {
          modelCalls.push(model);
          return 'transcribed';
        },
      },
    });
    t.mock.module('@whiskeysockets/baileys', {
      defaultExport: () => ({
        ev: new EventEmitter(),
        user: { id: '110000000000000@s.whatsapp.net' },
        end() {},
        groupFetchAllParticipating: async () => ({}),
      }),
      namedExports: {
        DisconnectReason: { loggedOut: 401 },
        fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
        useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
        downloadMediaMessage: async () => Buffer.from([0, 0, 0, 0]),
        proto: {},
      },
    });
    modulesPromise = (async () => {
      const { DiscordAdapter } = await import('../src/platforms/discord/adapter.js');
      const { BaileysAdapter } = await import('../src/platforms/whatsapp/baileysAdapter.js');
      const { config } = await import('../src/config.js');
      return { DiscordAdapter, BaileysAdapter, config };
    })();
  }
  return modulesPromise;
}

test('SECURITY: Discord voice transcription passes DISCORD_VOICE_MODEL, not the WhatsApp model, to the transcriber', async (t) => {
  const { DiscordAdapter, config } = await modules(t);
  const voice = config.discord.voice as { model: string };
  const prevModel = voice.model;
  const prevFetch = globalThis.fetch;
  voice.model = 'test/discord-only-model';
  globalThis.fetch = (async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(4),
  })) as unknown as typeof fetch;
  modelCalls.length = 0;
  try {
    const adapter = new DiscordAdapter(DISCORD_TEXT_PACK) as unknown as {
      transcribeAttachment: (url: string, seconds: number) => Promise<string>;
    };
    const transcript = await adapter.transcribeAttachment('https://cdn.discordapp.com/voice.ogg', 5);
    assert.equal(transcript, 'transcribed');
    assert.deepEqual(modelCalls, ['test/discord-only-model']);
  } finally {
    voice.model = prevModel;
    globalThis.fetch = prevFetch;
  }
});

test('SECURITY: WhatsApp voice transcription passes WHATSAPP_VOICE_MODEL, distinct from a differently-configured Discord model', async (t) => {
  const { BaileysAdapter, config } = await modules(t);
  const discordVoice = config.discord.voice as { model: string };
  const whatsappVoice = config.whatsapp.voice as { model: string };
  const prevDiscordModel = discordVoice.model;
  const prevWhatsappModel = whatsappVoice.model;
  discordVoice.model = 'test/discord-only-model';
  whatsappVoice.model = 'test/whatsapp-only-model';
  modelCalls.length = 0;
  try {
    const adapter = new BaileysAdapter(BAILEYS_TEXT_PACK) as unknown as {
      sock: unknown;
      transcribeAudioMessage: (msg: unknown, seconds: number) => Promise<string>;
    };
    adapter.sock = { updateMediaMessage: async () => {} };
    const transcript = await adapter.transcribeAudioMessage({}, 5);
    assert.equal(transcript, 'transcribed');
    assert.deepEqual(modelCalls, ['test/whatsapp-only-model']);
    assert.notEqual(
      modelCalls[0],
      discordVoice.model,
      'WhatsApp transcription must never fall back to the Discord model',
    );
  } finally {
    discordVoice.model = prevDiscordModel;
    whatsappVoice.model = prevWhatsappModel;
  }
});
