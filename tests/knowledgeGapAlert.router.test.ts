import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it, matching
// accessRequestAlert.router.test.ts. This is the ONLY place
// KNOWLEDGE_GAP_ALERT_ENABLED is set to 'true' — router.test.ts leaves it
// unset (default off) so that byte-identical-by-default path stays covered
// untouched, and the node test runner isolates env per test file (issue #650,
// same convention as issue #480's own router test).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.KNOWLEDGE_GAP_ALERT_ENABLED = 'true';
// Small cap so the rate-cap test below doesn't need to fire dozens of calls.
process.env.KNOWLEDGE_GAP_ALERT_RATE_LIMIT_PER_HOUR = '3';

const { config } = await import('../src/config.js');
const { Router, makeRouterDeps } = await import('../src/router.js');

function makeAdapter(): {
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
    text: 'what time does the ferry leave',
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Builds a Router with a stub `runTurn` (1st arg) that returns a fixed
 * `AgentReply`, plus spy `notifyAdminsFn` (14th arg) and
 * `markKnowledgeGapsAlertedFn` (16th arg) — the router-level exercise of the
 * knowledge-gap-cluster alert (issue #650) never needs a real DB or agent
 * turn, mirroring `unhelpfulAnswerEscalationRouter.test.ts`'s
 * `makeRouterWithNotifySpy` shape.
 */
function makeRouterWithSpies(runTurn: Parameters<typeof Router>[0]) {
  const notifyCalls: { message: string; excludeUserId: string }[] = [];
  const markCalls: number[][] = [];
  const router = new Router(
    makeRouterDeps({
      runTurn: runTurn,
      typingRefireMs: 20,
      notifyAdminsFn: async (
        _adapterFor: (platform: string) => PlatformAdapter | undefined,
        message: string,
        excludeUserId: string,
      ) => {
        notifyCalls.push({ message, excludeUserId });
      },
      markKnowledgeGapsAlertedFn: async (ids: readonly number[]) => {
        markCalls.push([...ids]);
      },
    }),
  );
  return { router, notifyCalls, markCalls };
}

test('config: KNOWLEDGE_GAP_ALERT_ENABLED reads true and KNOWLEDGE_GAP_ALERT_RATE_LIMIT_PER_HOUR reads the overridden value', () => {
  assert.equal(config.knowledgeGapAlert.enabled, true);
  assert.equal(config.knowledgeGapAlert.rateLimitPerHour, 3);
});

test('router (knowledge-gap cluster alert): a crossed cluster fires exactly one notifyAdmins call naming the representative text and count, and marks every row id alerted (issue #650 acceptance criteria 1+2)', async () => {
  const { router, notifyCalls, markCalls } = makeRouterWithSpies(async () => ({
    text: 'Here is what I found.',
    ok: true,
    knowledgeGapCluster: {
      representative: 'what time does the ferry to Waiheke leave on Saturdays',
      count: 3,
      rowIds: [101, 102, 103],
    },
  }));
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId: 'chan-crossed' }));

  assert.equal(sent[0].text, 'Here is what I found.', 'the member-facing reply is untouched');
  assert.equal(notifyCalls.length, 1, 'exactly one notifyAdmins call');
  assert.match(notifyCalls[0].message, /3 times/);
  assert.match(notifyCalls[0].message, /what time does the ferry to Waiheke leave on Saturdays/);
  assert.equal(notifyCalls[0].excludeUserId, 'super-1');
  assert.deepEqual(markCalls, [[101, 102, 103]], 'every row id in the crossed cluster is marked alerted');
});

test('router (knowledge-gap cluster alert): no crossing this turn (knowledgeGapCluster absent) never calls notifyAdmins or marks any row alerted', async () => {
  const { router, notifyCalls, markCalls } = makeRouterWithSpies(async () => ({
    text: 'Sorry, I could not find anything on that.',
    ok: true,
  }));
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId: 'chan-no-cross' }));

  assert.equal(sent[0].text, 'Sorry, I could not find anything on that.');
  assert.equal(notifyCalls.length, 0);
  assert.equal(markCalls.length, 0);
});

test('SECURITY: router (knowledge-gap cluster alert): the alert DM body is a strict subset of what list_knowledge_gaps returns — query text (truncated) + count only, no conversation id or other new field (issue #650 acceptance criterion 5)', async () => {
  const longQuery = 'x'.repeat(500);
  const { router, notifyCalls } = makeRouterWithSpies(async () => ({
    text: 'reply',
    ok: true,
    knowledgeGapCluster: { representative: longQuery, count: 7, rowIds: [1] },
  }));
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId: 'secret-channel-id-should-not-leak' }));

  assert.equal(notifyCalls.length, 1);
  const message = notifyCalls[0].message;
  assert.doesNotMatch(
    message,
    /secret-channel-id-should-not-leak/,
    'the conversation id must never appear in the alert body — list_knowledge_gaps itself never returns one',
  );
  assert.match(message, /7 times/);
  assert.ok(
    message.length < longQuery.length,
    'an over-long representative must be truncated (truncateForEcho), never echoed in full',
  );
  assert.match(message, /x+\.\.\./, 'truncated text ends with the standard truncateForEcho ellipsis');
});

test('SECURITY: router (knowledge-gap cluster alert): once KNOWLEDGE_GAP_ALERT_RATE_LIMIT_PER_HOUR is exhausted within the hour, a further crossing queues no DM and leaves its rows unmarked so a later gap can retry (issue #650 acceptance criterion 6)', async () => {
  const { router, notifyCalls, markCalls } = makeRouterWithSpies(async (_caller, prompt: string) => ({
    text: 'reply',
    ok: true,
    knowledgeGapCluster: { representative: prompt, count: 3, rowIds: [Number(prompt.replace(/\D/g, ''))] },
  }));
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  const limit = config.knowledgeGapAlert.rateLimitPerHour;
  for (let i = 0; i < limit; i += 1) {
    await trigger(makeMessage({ text: `capped cluster ${i}`, conversationId: `chan-cap-${i}` }));
  }
  assert.equal(notifyCalls.length, limit, 'every crossing within the cap must notify');
  assert.equal(markCalls.length, limit, 'every crossing within the cap must mark its rows alerted');

  // One more crossing, past the cap.
  await trigger(makeMessage({ text: 'over-cap cluster 999', conversationId: 'chan-over-cap' }));

  assert.equal(notifyCalls.length, limit, 'the over-cap crossing must not notify — the cap is not exceeded');
  assert.equal(
    markCalls.length,
    limit,
    'the over-cap crossing must not mark its rows alerted either — left unalerted so a later gap in the same cluster can retry once the window frees',
  );
});

test('router (knowledge-gap cluster alert): a fresh crossing after the rate window frees up notifies again — each turn is judged solely on its own reservation, independent of prior calls', async () => {
  const { router, notifyCalls } = makeRouterWithSpies(async (_caller, prompt: string) => ({
    text: 'reply',
    ok: true,
    knowledgeGapCluster: { representative: prompt, count: 3, rowIds: [1] },
  }));
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: 'cluster A', conversationId: 'chan-a' }));
  await trigger(makeMessage({ text: 'cluster B', conversationId: 'chan-b' }));

  assert.equal(
    notifyCalls.length,
    2,
    'each distinct crossing notifies its own time, independent of prior calls',
  );
});
