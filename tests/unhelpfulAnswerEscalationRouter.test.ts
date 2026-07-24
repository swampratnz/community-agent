import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';
import type { Platform } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// tests/escalationRouter.test.ts, whose direct-fire sibling this file
// exercises (issue #598). This is the ONLY other place
// ESCALATION_TO_ADMIN_ENABLED is set to 'true' alongside that file — each
// Node test-runner file is an isolated process, so setting it here has no
// effect on router.test.ts's default-off coverage.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1,super-2';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS ??= 'super-1';
process.env.ACCESS_MODE_DISCORD = 'open';
process.env.ESCALATION_TO_ADMIN_ENABLED = 'true';

const { config } = await import('../src/config.js');
const { Router, ESCALATION_RATE_LIMIT_PER_HOUR } = await import('../src/router.js');

const RUN = `unhelpful-escalation-router-${Date.now()}`;

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
    userId: 'super-1',
    userName: 'Test User',
    text: `${RUN} that was wrong`,
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Builds a Router with a stub notifyAdminsFn (14th constructor arg, same
 * position tests/escalationRouter.test.ts uses) that records every call,
 * plus a stub runTurn. This file never drives the pendingEscalations
 * confirm flow, so recordEscalatedGapFn (15th arg) is left at its default —
 * the direct-fire producer under test here deliberately does not touch it
 * (scope guard, issue #598 acceptance criterion 7).
 */
function makeRouterWithNotifySpy(runTurn: Parameters<typeof Router>[0]) {
  const notifyCalls: { message: string; excludeUserId: string }[] = [];
  const router = new Router(
    runTurn,
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (
      _adapterFor: (platform: Platform) => PlatformAdapter | undefined,
      message: string,
      excludeUserId: string,
    ) => {
      notifyCalls.push({ message, excludeUserId });
    },
  );
  return { router, notifyCalls };
}

test('config: ESCALATION_TO_ADMIN_ENABLED=true is reflected in config.behaviour.escalationToAdminEnabled', () => {
  assert.equal(config.behaviour.escalationToAdminEnabled, true);
});

test('router (unhelpful-answer escalation, flag off): a genuine thumbs-down reply produces byte-identical text and never calls notifyAdmins (issue #598 acceptance criterion 1)', async () => {
  const originalFlag = config.behaviour.escalationToAdminEnabled;
  (config.behaviour as { escalationToAdminEnabled: boolean }).escalationToAdminEnabled = false;
  try {
    const { router, notifyCalls } = makeRouterWithNotifySpy(async () => ({
      text: 'Thanks for the feedback, noted.',
      ok: true,
      unhelpfulAnswerRated: true,
    }));
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);
    const conversationId = `${RUN}-flag-off`;

    await trigger(makeMessage({ conversationId }));

    assert.equal(sent[0].text, 'Thanks for the feedback, noted.');
    assert.equal(notifyCalls.length, 0, 'notifyAdmins must never fire when the flag is off');
  } finally {
    (config.behaviour as { escalationToAdminEnabled: boolean }).escalationToAdminEnabled = originalFlag;
  }
});

test('router (unhelpful-answer escalation, flag on): a genuine thumbs-down reply triggers exactly one notifyAdmins call, echoing the truncated triggering message, and leaves the member-facing reply untouched (issue #598 acceptance criterion 2)', async () => {
  const { router, notifyCalls } = makeRouterWithNotifySpy(async () => ({
    text: 'Thanks for the feedback, noted.',
    ok: true,
    unhelpfulAnswerRated: true,
  }));
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-fires`;

  await trigger(
    makeMessage({ text: `${RUN} that pricing answer was wrong`, conversationId, userId: 'super-1' }),
  );

  assert.equal(sent[0].text, 'Thanks for the feedback, noted.', 'the member-facing reply must be untouched');
  assert.equal(notifyCalls.length, 1, 'exactly one notifyAdmins call');
  assert.match(notifyCalls[0].message, /that pricing answer was wrong/);
  assert.equal(notifyCalls[0].excludeUserId, 'super-1');
});

test('router (unhelpful-answer escalation): a positive rating (unhelpfulAnswerRated absent) never triggers notifyAdmins, flag on (issue #598 acceptance criterion 3)', async () => {
  const { router, notifyCalls } = makeRouterWithNotifySpy(async () => ({
    text: 'Thanks, glad that helped!',
    ok: true,
  }));
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-positive`;

  await trigger(makeMessage({ text: `${RUN} thanks that helped`, conversationId, userId: 'super-1' }));

  assert.equal(sent[0].text, 'Thanks, glad that helped!');
  assert.equal(notifyCalls.length, 0);
});

test("router (unhelpful-answer escalation): a rate_answer call that recorded nothing (unhelpfulAnswerRated absent, e.g. 'no_recent_answer'/'rate_limited') never triggers notifyAdmins (issue #598 acceptance criterion 4)", async () => {
  const { router, notifyCalls } = makeRouterWithNotifySpy(async () => ({
    text: "I don't have a recent answer of mine to rate in this conversation yet.",
    ok: true,
  }));
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-unrecorded`;

  await trigger(makeMessage({ text: `${RUN} that was wrong`, conversationId, userId: 'super-1' }));

  assert.equal(sent[0].text, "I don't have a recent answer of mine to rate in this conversation yet.");
  assert.equal(notifyCalls.length, 0);
});

test('SECURITY: router (unhelpful-answer escalation): the producer shares — never adds to — ESCALATION_RATE_LIMIT_PER_HOUR; once the shared cap is exhausted by the EXISTING max-turns producer, a subsequent genuine thumbs-down in the same rolling hour is silently suppressed, not queued or retried (issue #598 acceptance criterion 6)', async () => {
  const overCapConversationId = `${RUN}-cap-over`;
  const { router, notifyCalls } = makeRouterWithNotifySpy(async (_caller, prompt: string) => {
    // The final trigger below (a genuine thumbs-down) runs in its own,
    // recognisable conversation-scoped prompt; every earlier trigger in this
    // test is the max-turns producer's own failing ask.
    if (prompt === `${RUN} over-cap thumbs-down`) {
      return { text: 'Thanks for the feedback, noted.', ok: true, unhelpfulAnswerRated: true };
    }
    return {
      text: 'Sorry — that took more steps than I allow per message.',
      ok: false,
      maxTurnsExceeded: true,
    };
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  // Exhaust the guild-wide cap using the EXISTING max-turns producer's
  // confirm flow (offer, then "yes") — same shape as
  // tests/escalationRouter.test.ts's own cap-exhaustion test — to prove the
  // cap is genuinely shared across producers, not per-producer.
  for (let i = 0; i < ESCALATION_RATE_LIMIT_PER_HOUR; i++) {
    const conversationId = `${RUN}-cap-${i}`;
    await trigger(
      makeMessage({ text: `${RUN} capped max-turns ask ${i}`, conversationId, userId: 'super-1' }),
    );
    await trigger(makeMessage({ text: 'yes', conversationId, userId: 'super-1' }));
  }
  assert.equal(
    notifyCalls.length,
    ESCALATION_RATE_LIMIT_PER_HOUR,
    'the max-turns producer must be able to exhaust the cap on its own',
  );

  // One more turn, in a FRESH conversation, whose runTurn stub returns a
  // genuine thumbs-down reply — the cap is guild-wide, not per-conversation,
  // so it must still be exhausted.
  await trigger(
    makeMessage({
      text: `${RUN} over-cap thumbs-down`,
      conversationId: overCapConversationId,
      userId: 'super-1',
    }),
  );

  assert.equal(
    notifyCalls.length,
    ESCALATION_RATE_LIMIT_PER_HOUR,
    'once the shared cap is hit by the max-turns producer, no further notifyAdmins call fires for the thumbs-down producer either',
  );
  assert.equal(
    sent[sent.length - 1].text,
    'Thanks for the feedback, noted.',
    'the member-facing reply is unaffected by the suppressed notification — never queued or retried',
  );
});

test('SECURITY: rate_answer tool handler never calls notifyAdmins directly — the notification fires only from router.ts reading the turn-scoped flag post-turn (issue #598 acceptance criterion 5)', () => {
  const source = readFileSync(new URL('../src/agent/tools.ts', import.meta.url), 'utf8');
  const defStart = source.indexOf("'rate_answer',");
  assert.notEqual(defStart, -1, 'rate_answer tool definition not found');
  // The handler body runs from its `async (args) => {` opener through to the
  // closing `},\n  );` that ends the `tool(...)` call — mirrors the
  // feature_flags handler-body extraction in tests/tools.test.ts.
  const region = source.slice(defStart, defStart + 3000);
  const handlerMatch = region.match(/async \(args\) => \{([\s\S]*?)\n {4}\},\n {2}\);/);
  assert.ok(handlerMatch, 'rate_answer handler body not found');
  const body = handlerMatch[1];
  assert.doesNotMatch(
    body,
    /notifyAdmins\(/,
    'rate_answer handler must never call notifyAdmins directly — only router.ts may, post-turn',
  );
});
