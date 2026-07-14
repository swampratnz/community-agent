import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Router-level counterpart to rateLimitNotice.test.ts's pure-function unit
// tests (issue #300's acceptance criteria call for either) — this file
// drives the actual over-rate-limit send path through Router.handle(),
// mirroring pauseNotice.router.test.ts's harness and env-setup rationale
// exactly (config.ts validates env at import time).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.ACCESS_MODE_DISCORD = 'open';

const { pool, closeDb } = await import('../src/storage/db.js');
const { Router } = await import('../src/router.js');
const { RATE_LIMIT_NOTICE_TEXT, RATE_LIMIT_NOTICE_TEXT_MI, RATE_LIMIT_NOTICE_TEXT_PLAIN } =
  await import('../src/rateLimitNotice.js');
const { embed } = await import('../src/storage/embeddings.js');

await embed('warmup').catch(() => {});

const RUN = `ratelimitnotice-router-${Date.now()}`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM interactions WHERE content LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): {
  adapter: PlatformAdapter;
  sent: OutgoingMessage[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage(h) {
      handler = h;
    },
    async sendMessage(out) {
      sent.push(out);
    },
    async sendDirectMessage() {},
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
    async sendTypingIndicator() {},
    ...overrides,
  };
  return {
    adapter,
    sent,
    trigger: async (msg) => {
      if (!handler) throw new Error('adapter.onMessage was never registered — call router.register() first');
      await handler(msg);
    },
  };
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'discord',
    conversationId: 'chan-1',
    userId: 'member-1',
    userName: 'Test Member',
    text: `${RUN} hello bot`,
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeReply(text: string): AgentReply {
  return { text };
}

/** RATE_LIMIT is 8 messages/window (src/router.ts) — the 9th trip over-limit. */
const OVER_LIMIT_MESSAGE_COUNT = 9;

test("router (rate-limited): a caller with a standing 'mi' language preference gets RATE_LIMIT_NOTICE_TEXT_MI, not the English default", async () => {
  const router = new Router(
    async () => makeReply('ok'),
    20,
    async () => false, // not paused
    undefined,
    undefined,
    async () => 0, // stub the daily-budget read so it can never trip and interfere with the rate-limit path under test
    async () => 'mi',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  for (let i = 0; i < OVER_LIMIT_MESSAGE_COUNT; i += 1) {
    await trigger(makeMessage());
  }

  const last = sent.at(-1);
  assert.equal(last?.text, RATE_LIMIT_NOTICE_TEXT_MI);
});

test("router (rate-limited): a caller with 'auto' (the default) still gets the English RATE_LIMIT_NOTICE_TEXT", async () => {
  const router = new Router(
    async () => makeReply('ok'),
    20,
    async () => false, // not paused
    undefined,
    undefined,
    async () => 0, // stub the daily-budget read so it can never trip and interfere with the rate-limit path under test
    async () => 'auto',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  for (let i = 0; i < OVER_LIMIT_MESSAGE_COUNT; i += 1) {
    await trigger(makeMessage());
  }

  const last = sent.at(-1);
  assert.equal(last?.text, RATE_LIMIT_NOTICE_TEXT);
});

test('SECURITY: a getLanguagePreference failure on the rate-limit notice still sends the English default, never throws or drops the notice', async () => {
  const router = new Router(
    async () => makeReply('ok'),
    20,
    async () => false, // not paused
    undefined,
    undefined,
    async () => 0, // stub the daily-budget read so it can never trip and interfere with the rate-limit path under test
    async () => {
      throw new Error('language_prefs read boom');
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  for (let i = 0; i < OVER_LIMIT_MESSAGE_COUNT; i += 1) {
    await assert.doesNotReject(trigger(makeMessage()));
  }

  const last = sent.at(-1);
  assert.equal(last?.text, RATE_LIMIT_NOTICE_TEXT);
});

test('router (rate-limited): the language-preference lookup runs at most once per debounce window, never once per shed message', async () => {
  let calls = 0;
  const router = new Router(
    async () => makeReply('ok'),
    20,
    async () => false, // not paused
    undefined,
    undefined,
    async () => 0, // stub the daily-budget read so it can never trip and interfere with the rate-limit path under test
    async () => {
      calls += 1;
      return 'auto';
    },
  );
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  // First OVER_LIMIT_MESSAGE_COUNT messages cross into rate-limited territory
  // and the last of them fires exactly one notice (one lookup); further
  // over-limit messages inside the same window must not read again.
  for (let i = 0; i < OVER_LIMIT_MESSAGE_COUNT + 3; i += 1) {
    await trigger(makeMessage());
  }

  assert.equal(calls, 1, 'only the one notifying message in the window should read the language preference');
});

// --- Standing 'plain' response-style preference on the rate-limit notice (issue #430) ---

test("router (rate-limited): a caller with a standing 'plain' response style (and 'auto' language) gets RATE_LIMIT_NOTICE_TEXT_PLAIN", async () => {
  const router = new Router(
    async () => makeReply('ok'),
    20,
    async () => false, // not paused
    undefined,
    undefined,
    async () => 0,
    async () => 'auto',
    undefined,
    undefined,
    async () => 'plain',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  for (let i = 0; i < OVER_LIMIT_MESSAGE_COUNT; i += 1) {
    await trigger(makeMessage());
  }

  const last = sent.at(-1);
  assert.equal(last?.text, RATE_LIMIT_NOTICE_TEXT_PLAIN);
});

test("router (rate-limited): a caller with 'standard' response style still gets the English RATE_LIMIT_NOTICE_TEXT (byte-identical regression)", async () => {
  const router = new Router(
    async () => makeReply('ok'),
    20,
    async () => false, // not paused
    undefined,
    undefined,
    async () => 0,
    async () => 'auto',
    undefined,
    undefined,
    async () => 'standard',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  for (let i = 0; i < OVER_LIMIT_MESSAGE_COUNT; i += 1) {
    await trigger(makeMessage());
  }

  const last = sent.at(-1);
  assert.equal(last?.text, RATE_LIMIT_NOTICE_TEXT);
});

test("router (rate-limited): 'mi' takes precedence over 'plain' when both are set", async () => {
  const router = new Router(
    async () => makeReply('ok'),
    20,
    async () => false, // not paused
    undefined,
    undefined,
    async () => 0,
    async () => 'mi',
    undefined,
    undefined,
    async () => 'plain',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  for (let i = 0; i < OVER_LIMIT_MESSAGE_COUNT; i += 1) {
    await trigger(makeMessage());
  }

  const last = sent.at(-1);
  assert.equal(last?.text, RATE_LIMIT_NOTICE_TEXT_MI);
  assert.notEqual(last?.text, RATE_LIMIT_NOTICE_TEXT_PLAIN);
});

test('SECURITY: a getResponseStyle failure on the rate-limit notice still sends the English default, never throws or drops the notice', async () => {
  const router = new Router(
    async () => makeReply('ok'),
    20,
    async () => false, // not paused
    undefined,
    undefined,
    async () => 0,
    async () => 'auto',
    undefined,
    undefined,
    async () => {
      throw new Error('response_style_prefs read boom');
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  for (let i = 0; i < OVER_LIMIT_MESSAGE_COUNT; i += 1) {
    await assert.doesNotReject(trigger(makeMessage()));
  }

  const last = sent.at(-1);
  assert.equal(last?.text, RATE_LIMIT_NOTICE_TEXT);
});
