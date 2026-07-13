import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// router.test.ts. This file is the ONLY place ACK_SHORTCUT_ENABLED is set to
// 'true' — router.test.ts leaves it unset so the default-off path stays
// covered untouched, and the node test runner isolates env per test file.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.ACK_SHORTCUT_ENABLED = 'true';

const { config } = await import('../src/config.js');
const { Router } = await import('../src/router.js');
const { embed } = await import('../src/storage/embeddings.js');

await embed('warmup').catch(() => {});

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
    userId: 'super-1',
    userName: 'Test User',
    text: 'hello bot',
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('config: ACK_SHORTCUT_ENABLED=true is reflected in config.behaviour.ackShortcutEnabled', () => {
  assert.equal(config.behaviour.ackShortcutEnabled, true);
});

test('router (ack shortcut enabled): an exact ack message skips runTurn and sends the canned reply', async () => {
  const router = new Router(async () => {
    throw new Error('runTurn must not be called for a pure acknowledgement');
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: 'thanks' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'No worries!');
});

test('router (ack shortcut enabled): an emoji-only ack message skips runTurn', async () => {
  const router = new Router(async () => {
    throw new Error('runTurn must not be called for a pure acknowledgement');
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '👍' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'No worries!');
});

test('SECURITY/regression: a message that merely starts with an ack word still reaches runTurn', async () => {
  const router = new Router(async () => ({ text: 'real answer' }), 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: "thanks but that didn't work" }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'real answer', 'must get the real agent reply, not the canned ack reply');
});

test('SECURITY/regression: a message that merely ends with an ack word still reaches runTurn', async () => {
  const router = new Router(async () => ({ text: 'real answer' }), 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: "ok here's my question" }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'real answer');
});

test('ordering: an in-flight real turn is still delivered before a subsequent ack reply in the same conversation', async () => {
  let resolveTurn!: (r: AgentReply) => void;
  const turnPromise = new Promise<AgentReply>((resolve) => {
    resolveTurn = resolve;
  });
  const router = new Router(async () => turnPromise, 20);
  const { adapter, sent, typingCalls, trigger } = makeAdapter();
  router.register(adapter);

  // Fire a real question, then (without waiting for the answer) an ack in
  // the same conversation — the ack must not overtake the in-flight answer.
  const realDone = trigger(makeMessage({ text: 'how do I reset my password?' }));

  // respond() only fires the typing indicator once the real turn's task is
  // actually executing inside the chain (after handle()'s pre-turn awaits) —
  // poll for it instead of a fixed sleep so this isn't flaky under CI load
  // (same rationale as router.test.ts's typing-indicator test).
  const deadline = Date.now() + 3000;
  while (typingCalls.length < 1 && Date.now() < deadline) await sleep(5);
  assert.ok(typingCalls.length >= 1, 'the real turn must already be in flight before the ack fires');

  const ackDone = trigger(makeMessage({ text: 'thanks' }));

  await sleep(30);
  assert.equal(sent.length, 0, 'neither reply should land while the real turn is still pending');

  resolveTurn({ text: 'real answer' });
  await Promise.all([realDone, ackDone]);

  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, 'real answer', 'the real answer must be delivered first');
  assert.equal(sent[1].text, 'No worries!', 'the ack reply must be delivered after, not before');
});

test('router (ack shortcut enabled): a hit records a shortcut_hits row of kind "ack" (issue #440)', async () => {
  const calls: string[] = [];
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a pure acknowledgement');
    },
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (kind) => {
      calls.push(kind);
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: 'thanks' }));

  assert.equal(sent.length, 1);
  assert.deepEqual(calls, ['ack']);
});

test('SECURITY: router (ack shortcut enabled): a recordShortcutHit rejection never blocks or delays the ack reply (issue #440)', async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a pure acknowledgement');
    },
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      throw new Error('shortcut_hits insert failed (simulated)');
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: 'thanks' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'No worries!', 'the ack reply still sends despite the failed recording');
});

// --- Standing 'mi' language preference on the ack shortcut (issue #435) ----

test("router (ack shortcut enabled): a caller with a standing 'mi' language preference gets ACK_REPLY_TEXT_MI, not the English default", async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a pure acknowledgement');
    },
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => 'mi',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: 'thanks' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'Kāore he raru!');
});

test("router (ack shortcut enabled): a caller with 'auto' (the default) still gets byte-identical 'No worries!'", async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a pure acknowledgement');
    },
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => 'auto',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: 'thanks' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'No worries!');
});

test('SECURITY: a getLanguagePreference failure on the ack shortcut still sends the English default, never throws or drops the reply', async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a pure acknowledgement');
    },
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      throw new Error('language_prefs read boom');
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await assert.doesNotReject(trigger(makeMessage({ text: 'thanks' })));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'No worries!');
});

test('SECURITY: ACK_REPLY_TEXT_MI is a fixed, non-interpolated string — byte-identical regardless of the caller or message content', async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a pure acknowledgement');
    },
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => 'mi',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: 'thanks', userId: 'super-1' }));
  await trigger(makeMessage({ text: '👍', userId: 'super-1' }));

  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, sent[1].text, 'no hidden interpolation on caller/message-controlled input');
  assert.equal(sent[0].text, 'Kāore he raru!');
});

test('router (ack shortcut enabled): the ack path still respects the gated-guest gate ahead of it', async () => {
  const router = new Router(async () => {
    throw new Error('runTurn must not be called');
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  // Default ACCESS_MODE_DISCORD is 'gated'; this user is not a super admin
  // and unresolvable in community_users (DB unreachable in this test), so
  // it resolves to 'guest' and must hit the gated-guest branch, never the
  // ack shortcut.
  await trigger(makeMessage({ text: 'thanks', userId: 'unknown-guest-1' }));

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /member-only/i);
});
