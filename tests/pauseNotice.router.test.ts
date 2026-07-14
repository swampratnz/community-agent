import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// router.test.ts. This file is the ONLY place ACCESS_MODE_DISCORD is set to
// 'open' — router.test.ts leaves it unset (default 'gated') so that path
// stays covered untouched, and the node test runner isolates env per test
// file. Open mode is needed here so a non-super-admin (unresolvable in
// community_users with the DB unreachable, so it resolves to 'guest') still
// reaches the paused check instead of being intercepted by the gated-guest
// branch — exercising the "guest's, in open mode" case from issue #128's
// acceptance criteria.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
// Capture whether a REAL Postgres was provided BEFORE applying the dummy
// default below — the default only exists to satisfy config.ts's import-time
// validation, it is not a reachable DB. Reading hasDb after the `??=` would
// make it always true, so the after() cleanup query would reject against the
// unreachable dummy and throw out of the teardown hook, failing this file in
// the security-invariants CI job (which runs with DATABASE_URL unset).
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.ACCESS_MODE_DISCORD = 'open';
const { pool, closeDb } = await import('../src/storage/db.js');
const { Router } = await import('../src/router.js');
const { PAUSE_NOTICE_TEXT, PAUSE_NOTICE_TEXT_MI, PAUSE_NOTICE_TEXT_PLAIN } =
  await import('../src/pauseNotice.js');
const { RATE_LIMIT_NOTICE_TEXT } = await import('../src/rateLimitNotice.js');
const { embed } = await import('../src/storage/embeddings.js');

await embed('warmup').catch(() => {});

// Non-gated mode means every trigger() below reaches recordInteraction and is
// persisted for real (unlike router.test.ts's default gated mode, where a
// guest's content never lands in `interactions`). The context builder
// (src/context/builder.ts) clusters inbound interactions by embedding
// similarity across the WHOLE table, unscoped by conversation or test file —
// an identical message text from >=3 distinct users forms a real cluster. A
// unique-per-run marker keeps this file's traffic from ever exact-matching
// another test file's fixed message text (e.g. router.test.ts's default
// "hello bot"), and the cleanup below removes it afterward.
const RUN = `pausenotice-router-${Date.now()}`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM interactions WHERE content LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): {
  adapter: PlatformAdapter;
  sent: OutgoingMessage[];
  typingCalls: IncomingMessage[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const typingCalls: IncomingMessage[] = [];
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
    async sendTypingIndicator(msg) {
      typingCalls.push(msg);
    },
    ...overrides,
  };
  return {
    adapter,
    sent,
    typingCalls,
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
    userId: 'guest-1',
    userName: 'Test Guest',
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

test('router (paused): a member/guest addressing the bot gets exactly one pause notice, not the agent turn', async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called while paused');
    },
    20,
    async () => true, // paused
  );
  const { adapter, sent, typingCalls, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(typingCalls.length, 0, 'a paused user must never trigger the typing indicator');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, PAUSE_NOTICE_TEXT);
});

test('router (paused): a second addressed message from the same user inside the debounce window gets no additional notice', async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called while paused');
    },
    20,
    async () => true, // paused
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());
  await trigger(makeMessage());

  assert.equal(sent.length, 1, 'the second message inside the window must not produce another notice');
});

test('router (paused): a different user still gets their own first notice (debounce is per-user)', async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called while paused');
    },
    20,
    async () => true, // paused
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId: 'guest-1' }));
  await trigger(makeMessage({ userId: 'guest-2' }));

  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, PAUSE_NOTICE_TEXT);
  assert.equal(sent[1].text, PAUSE_NOTICE_TEXT);
});

test('router (paused): a super admin is unaffected — still gets the full agent turn, not the pause notice', async () => {
  const router = new Router(
    async () => makeReply('real answer despite pause'),
    20,
    async () => true, // paused
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId: 'super-1' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'real answer despite pause');
});

test('router (paused): a user over the rate limit while paused gets exactly the pause notice, never a rate-limit notice too (no double-notify)', async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called while paused');
    },
    20,
    async () => true, // paused
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  // The paused check runs before the rate-limit check in src/router.ts and
  // returns first, so userHits is never even populated while paused — a
  // burst well past RATE_LIMIT (8) must still yield only the one debounced
  // pause notice.
  for (let i = 0; i < 11; i += 1) {
    await trigger(makeMessage());
  }

  assert.equal(sent.length, 1, 'only one notice across the whole burst');
  assert.equal(sent[0].text, PAUSE_NOTICE_TEXT);
  assert.notEqual(sent[0].text, RATE_LIMIT_NOTICE_TEXT);
});

test('router (not paused): behaviour is unchanged — normal reply, no pause notice', async () => {
  const router = new Router(
    async () => makeReply('normal reply'),
    20,
    async () => false, // not paused
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'normal reply');
});

// --- Standing 'mi' language preference on the pause notice (issue #300) -----

test("router (paused): a caller with a standing 'mi' language preference gets PAUSE_NOTICE_TEXT_MI, not the English default", async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called while paused');
    },
    20,
    async () => true, // paused
    undefined,
    undefined,
    undefined,
    async () => 'mi',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, PAUSE_NOTICE_TEXT_MI);
});

test("router (paused): a caller with 'auto' (the default) still gets the English PAUSE_NOTICE_TEXT", async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called while paused');
    },
    20,
    async () => true, // paused
    undefined,
    undefined,
    undefined,
    async () => 'auto',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, PAUSE_NOTICE_TEXT);
});

test('SECURITY: a getLanguagePreference failure on the pause notice still sends the English default, never throws or drops the notice', async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called while paused');
    },
    20,
    async () => true, // paused
    undefined,
    undefined,
    undefined,
    async () => {
      throw new Error('language_prefs read boom');
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await assert.doesNotReject(trigger(makeMessage()));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, PAUSE_NOTICE_TEXT);
});

test('router (paused): the language-preference lookup runs at most once per debounce window, never once per shed message', async () => {
  let calls = 0;
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called while paused');
    },
    20,
    async () => true, // paused
    undefined,
    undefined,
    undefined,
    async () => {
      calls += 1;
      return 'auto';
    },
  );
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());
  await trigger(makeMessage());
  await trigger(makeMessage());

  assert.equal(
    calls,
    1,
    'only the first (notifying) message in the window should read the language preference',
  );
});

// --- Standing 'plain' response-style preference on the pause notice (issue #430) ---

test("router (paused): a caller with a standing 'plain' response style (and 'auto' language) gets PAUSE_NOTICE_TEXT_PLAIN", async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called while paused');
    },
    20,
    async () => true, // paused
    undefined,
    undefined,
    undefined,
    async () => 'auto',
    undefined,
    undefined,
    async () => 'plain',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, PAUSE_NOTICE_TEXT_PLAIN);
});

test("router (paused): a caller with 'standard' response style still gets the English PAUSE_NOTICE_TEXT (byte-identical regression)", async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called while paused');
    },
    20,
    async () => true, // paused
    undefined,
    undefined,
    undefined,
    async () => 'auto',
    undefined,
    undefined,
    async () => 'standard',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, PAUSE_NOTICE_TEXT);
});

test("router (paused): 'mi' takes precedence over 'plain' when both are set — the caller still gets PAUSE_NOTICE_TEXT_MI", async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called while paused');
    },
    20,
    async () => true, // paused
    undefined,
    undefined,
    undefined,
    async () => 'mi',
    undefined,
    undefined,
    async () => 'plain',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, PAUSE_NOTICE_TEXT_MI);
  assert.notEqual(sent[0].text, PAUSE_NOTICE_TEXT_PLAIN);
});

test('SECURITY: a getResponseStyle failure on the pause notice still sends the English default, never throws or drops the notice', async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called while paused');
    },
    20,
    async () => true, // paused
    undefined,
    undefined,
    undefined,
    async () => 'auto',
    undefined,
    undefined,
    async () => {
      throw new Error('response_style_prefs read boom');
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await assert.doesNotReject(trigger(makeMessage()));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, PAUSE_NOTICE_TEXT);
});
