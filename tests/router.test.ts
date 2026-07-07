import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it. DATABASE_URL
// points at an unreachable Postgres; every DB write these tests touch
// (recordInteraction, recordAccessRequest, getMemberRole) is best-effort or
// `.catch()`-guarded on the paths exercised here, so a connection refusal is
// swallowed rather than failing the test — matching discordAdapter.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
// This user bypasses the paused/daily-budget DB reads entirely (see
// src/router.ts), so the "happy path" tests below never depend on
// `community_users` state — only the (unreachable, harmlessly-caught) DB.
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';

const { config } = await import('../src/config.js');
const { Router } = await import('../src/router.js');
const { INTERNAL_ERROR_REPLY } = await import('../src/agent/core.js');
const { logger } = await import('../src/logger.js');
const { embed } = await import('../src/storage/embeddings.js');

// recordInteraction embeds every message it stores; the embedding pipeline is
// downloaded/loaded lazily on first use and then memoised. Pre-warm it here
// (outside any timing-sensitive assertion) so later tests aren't thrown off
// by a one-off multi-second load cost hiding inside `respond()`'s first call.
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

function makeReply(text: string): AgentReply {
  return { text };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('respond(): fires the typing indicator immediately and re-fires periodically while the turn is in flight', async () => {
  let resolveTurn!: (r: AgentReply) => void;
  const turnPromise = new Promise<AgentReply>((resolve) => {
    resolveTurn = resolve;
  });
  const router = new Router(async () => turnPromise, 20); // 20ms refire so this doesn't wait real 8s intervals
  const { adapter, sent, typingCalls, trigger } = makeAdapter();
  router.register(adapter);

  const done = trigger(makeMessage());
  // respond() only fires the indicator AFTER handle()'s pre-turn awaits
  // (inbound record + the first DB query, whose pg-pool cold connect on a
  // fresh CI Postgres can exceed 100ms). Racing a fixed sleep against that is
  // flaky — it read 0 fires on CI. Poll for the first fire instead, then let a
  // few 20ms refire windows elapse while the turn is still pending.
  const deadline = Date.now() + 3000;
  while (typingCalls.length < 1 && Date.now() < deadline) await sleep(5);
  assert.ok(typingCalls.length >= 1, 'the typing indicator should fire once the turn starts');
  await sleep(70); // ~3 refire windows at 20ms
  assert.ok(typingCalls.length >= 2, `expected multiple typing-indicator fires, got ${typingCalls.length}`);
  assert.equal(sent.length, 0, 'the reply must not be sent until the turn resolves');

  resolveTurn(makeReply('hi there'));
  await done;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'hi there');
});

test('respond(): a rejecting typing indicator never delays or breaks the reply', async () => {
  const router = new Router(async () => makeReply('reply despite rejecting indicator'), 20);
  const { adapter, sent, trigger } = makeAdapter({
    sendTypingIndicator: async () => {
      throw new Error('indicator boom');
    },
  });
  router.register(adapter);

  await trigger(makeMessage());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'reply despite rejecting indicator');
});

test('respond(): a typing indicator that hangs forever never delays the reply', async () => {
  const router = new Router(async () => makeReply('quick reply'), 1_000_000); // huge refire: only the immediate fire matters here
  const { adapter, sent, trigger } = makeAdapter({
    sendTypingIndicator: () => new Promise<void>(() => {}), // never resolves or rejects
  });
  router.register(adapter);

  const result = await Promise.race([
    trigger(makeMessage()).then(() => 'done'),
    sleep(500).then(() => 'timeout'),
  ]);
  assert.equal(
    result,
    'done',
    'the reply must complete promptly even though the typing indicator hangs forever',
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'quick reply');
});

test('respond(): the re-fire interval is cleared when the turn rejects — no further indicator calls after settlement', async () => {
  const router = new Router(async () => {
    throw new Error('turn failed');
  }, 20);
  const { adapter, typingCalls, trigger } = makeAdapter();
  router.register(adapter);

  // handle() chains respond() through a `.catch(logger.error)`, so a thrown
  // turn does not propagate out of trigger() — it's logged, not re-thrown.
  await trigger(makeMessage());
  const callsAtSettlement = typingCalls.length;
  assert.ok(callsAtSettlement >= 1, 'the indicator should have fired at least once before the turn rejected');

  await sleep(80); // several 20ms refire windows' worth of time
  assert.equal(
    typingCalls.length,
    callsAtSettlement,
    'no further indicator calls after the turn settled (rejected) — the interval must be cleared',
  );
});

test('respond(): a Cloud-style adapter whose 2nd+ indicator call rejects still delivers the reply, no dangling interval', async () => {
  let calls = 0;
  let resolveTurn!: (r: AgentReply) => void;
  const turnPromise = new Promise<AgentReply>((resolve) => {
    resolveTurn = resolve;
  });
  const router = new Router(async () => turnPromise, 20);
  const { adapter, sent, trigger } = makeAdapter({
    sendTypingIndicator: async () => {
      calls += 1;
      // Meta's mark-as-read/typing_indicator is bound to a single wamid and
      // cannot be meaningfully re-fired — simulate the 2nd+ re-fire failing.
      if (calls > 1) throw new Error('cannot re-fire a mark-as-read for an already-read wamid');
    },
  });
  router.register(adapter);

  const done = trigger(makeMessage());
  await sleep(70); // several refire windows — at least one re-fire attempt (and rejection)
  assert.ok(calls >= 2, 'expected a re-fire to have been attempted and rejected');

  resolveTurn(makeReply('cloud reply'));
  await done;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'cloud reply');
});

test('respond(): a thrown turn sends the internal-error fallback instead of silence (issue #52)', async (t) => {
  const errorLog = t.mock.method(logger, 'error');
  const router = new Router(async () => {
    throw new Error('DB blew up mid-turn');
  }, 1_000_000);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1, 'the member gets exactly one reply, never silence');
  assert.equal(sent[0].text, INTERNAL_ERROR_REPLY);
  assert.ok(
    errorLog.mock.calls.some((c) => String(c.arguments[1]).includes('fallback')),
    'the backstop logs at error level — it never swallows silently',
  );
});

test('respond(): a failure during the send itself is never retried — at most one outbound reply (issue #52)', async () => {
  let sendAttempts = 0;
  const router = new Router(async () => makeReply('a perfectly good reply'), 1_000_000);
  const { adapter, trigger } = makeAdapter({
    sendMessage: async () => {
      sendAttempts += 1;
      throw new Error('send failed after the turn succeeded');
    },
  });
  router.register(adapter);

  // handle() chains respond() through `.catch(logger.error)`, so the send
  // failure is logged, not re-thrown — and crucially the backstop wraps only
  // the PRE-send path, so it must not catch this and emit a second reply.
  await trigger(makeMessage());

  assert.equal(sendAttempts, 1, 'no fallback double-send after a send-path failure');
});

test('router: a gated-out guest never reaches respond() — zero typing indicator calls', async () => {
  const router = new Router(async () => {
    throw new Error('runTurn must not be called for a gated-out guest');
  }, 20);
  const { adapter, sent, typingCalls, trigger } = makeAdapter();
  router.register(adapter);

  // Not in SUPER_ADMIN_DISCORD_IDS and unresolvable in `community_users`
  // (DB unreachable in this test) — resolves to 'guest'. Default
  // ACCESS_MODE_DISCORD is 'gated' (see config.ts), so this hits the
  // gated-guest branch, which returns before respond() is ever called.
  await trigger(makeMessage({ userId: 'unknown-guest-1', isDirect: false, addressedToBot: true }));

  assert.equal(typingCalls.length, 0, 'a gated-out guest must never trigger the typing indicator');
  assert.equal(sent.length, 1, 'the guest still gets the gated notice');
  assert.match(sent[0].text, /member-only/i);
});

test('router: a gated-out guest is unaffected by pause — still gets the gated notice, never the pause notice (issue #128)', async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a gated-out guest');
    },
    20,
    async () => true, // paused
  );
  const { adapter, sent, typingCalls, trigger } = makeAdapter();
  router.register(adapter);

  // Gated-mode guest branch returns before the paused check is ever reached
  // (src/router.ts), so pause state must have no effect on this path.
  await trigger(makeMessage({ userId: 'unknown-guest-1', isDirect: false, addressedToBot: true }));

  assert.equal(typingCalls.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /member-only/i, 'must get the gated notice, not the pause notice');
});

test('config: ACK_SHORTCUT_ENABLED defaults to false when unset', () => {
  assert.equal(config.behaviour.ackShortcutEnabled, false);
});

test('router: ACK_SHORTCUT_ENABLED default (off) — an exact ack message still runs the full agent turn, byte-for-byte unchanged', async () => {
  const router = new Router(async () => makeReply('real answer'), 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: 'thanks' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'real answer', 'with the flag off, even an exact ack must reach the agent');
});

test('config: KNOWLEDGE_SHORTCUT_ENABLED defaults to false when unset', () => {
  assert.equal(config.behaviour.knowledgeShortcutEnabled, false);
});

test('router: KNOWLEDGE_SHORTCUT_ENABLED default (off) — a near-exact knowledge match still runs the full agent turn (issue #162)', async () => {
  const router = new Router(
    async () => makeReply('real answer'),
    20,
    undefined,
    async () => {
      throw new Error('knowledge shortcut lookup must never run while the flag is off');
    },
    async () => {
      throw new Error('retrieval must never be recorded while the flag is off');
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: 'what are the server rules?' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'real answer', 'with the flag off, the shortcut lookup must not even run');
});

test('config: SHUTDOWN_DRAIN_TIMEOUT_MS defaults to 20000ms when unset', () => {
  assert.equal(config.behaviour.shutdownDrainTimeoutMs, 20_000);
});

test('drain(): resolves immediately when there are no in-flight chains — no regression to the fast shutdown path (issue #210)', async () => {
  const router = new Router();
  const start = Date.now();
  await router.drain(20_000);
  assert.ok(
    Date.now() - start < 50,
    'drain() must return near-instantly with nothing in flight, nowhere close to the timeout',
  );
});

test('drain(): waits for an in-flight turn to settle — including its send — before resolving (issue #210)', async (t) => {
  const infoLog = t.mock.method(logger, 'info');
  let resolveTurn!: (r: AgentReply) => void;
  const turnPromise = new Promise<AgentReply>((resolve) => {
    resolveTurn = resolve;
  });
  const router = new Router(async () => turnPromise, 1_000_000);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  void trigger(makeMessage());
  await sleep(50); // let handle() run through to enqueue() registering the chain

  const drainPromise = router.drain(5_000);
  assert.equal(
    sent.length,
    0,
    'the reply must not have sent yet — drain() must not resolve before the turn does',
  );

  resolveTurn(makeReply('drained reply'));
  await drainPromise;

  assert.equal(sent.length, 1, 'drain() resolving means the reply already sent on the live connection');
  assert.equal(sent[0].text, 'drained reply');
  assert.ok(
    infoLog.mock.calls.some((c) => String(c.arguments[1]).includes('settled')),
    'drain() should log that all in-flight turns settled, not that the timeout won',
  );
});

test('drain(): resolves at the timeout boundary if a chain never settles — never hangs forever (issue #210)', async (t) => {
  const infoLog = t.mock.method(logger, 'info');
  const router = new Router(async () => new Promise<AgentReply>(() => {}), 1_000_000); // turn hangs forever
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  void trigger(makeMessage());
  await sleep(50); // let the chain register

  const start = Date.now();
  await router.drain(150);
  const elapsed = Date.now() - start;

  assert.ok(
    elapsed >= 140,
    `drain() must wait out the full timeout when a chain never settles, took ${elapsed}ms`,
  );
  assert.ok(elapsed < 1_000, `drain() must not wait meaningfully past the timeout, took ${elapsed}ms`);
  assert.ok(
    infoLog.mock.calls.some((c) => String(c.arguments[1]).includes('timed out')),
    'drain() should log that the timeout won, not that everything settled',
  );
});

test('drain(): a settled chain is cleared from the map — a later drain() call does not wait on it again (issue #210)', async () => {
  const router = new Router(async () => makeReply('quick'), 1_000_000);
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage()); // full turn completes; enqueue()'s .finally already cleared the chain

  const start = Date.now();
  await router.drain(20_000);
  assert.ok(
    Date.now() - start < 50,
    'a settled, already-cleared chain must not be waited on again by a later drain() call',
  );
});

test('drain(): a message arriving mid-drain starts a new chain that drain() does not wait on (issue #210)', async () => {
  let turnCalls = 0;
  let resolveTurn1!: (r: AgentReply) => void;
  const turn1 = new Promise<AgentReply>((resolve) => {
    resolveTurn1 = resolve;
  });
  const router = new Router(async () => {
    turnCalls += 1;
    if (turnCalls === 1) return turn1;
    return new Promise<AgentReply>(() => {}); // message 2's turn hangs forever
  }, 1_000_000);
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  void trigger(makeMessage({ messageId: 'm1' }));
  await sleep(50); // let message 1 register its chain

  const drainPromise = router.drain(2_000);

  // Adapters are still connected during the drain window, so a fresh inbound
  // message can start a new chain for the same conversation. drain() must
  // not be extended to cover it.
  void trigger(makeMessage({ messageId: 'm2', text: 'second message while draining' }));
  await sleep(50); // let message 2 chain behind message 1 in the map

  resolveTurn1(makeReply('answer to message 1'));

  const result = await Promise.race([
    drainPromise.then(() => 'drained'),
    sleep(300).then(() => 'still-draining'),
  ]);
  assert.equal(
    result,
    'drained',
    'drain() must resolve once its original snapshot settles, not wait for a chain started after drain() was called',
  );
});
