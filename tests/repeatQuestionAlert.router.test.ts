import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/module/strings/notices.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/base/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it, matching
// knowledgeGapAlert.router.test.ts. This is the ONLY place
// REPEAT_QUESTION_ALERT_ENABLED is set to 'true' — router.test.ts leaves it
// unset (default off) so that byte-identical-by-default path stays covered
// untouched, and the node test runner isolates env per test file (issue
// #887, same convention as issue #650's own router test).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.REPEAT_QUESTION_ALERT_ENABLED = 'true';
// Small cap so the rate-cap test below doesn't need to fire dozens of calls.
process.env.REPEAT_QUESTION_ALERT_RATE_LIMIT_PER_HOUR = '3';
// Generous cooldown so every test (bar the cooldown test itself) that
// deliberately uses a fresh conversationId per turn never accidentally
// collides with a prior turn's stamp.
process.env.REPEAT_QUESTION_ALERT_COOLDOWN_MINUTES = '15';

const { config } = await import('../src/base/config.js');
const { Router } = await import('../src/base/router.js');
const { makeRouterDeps } = await import('../src/module/routerWiring.js');
const { FRESHNESS_DAYS, CLUSTER_LIMIT } = await import('../src/module/adminDigest.js');

type QuestionCluster = { representative: string; count: number };

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
 * Builds a Router with a stub `runTurn` (1st arg) that always returns `ok:
 * true`, plus spy `notifyAdminsFn` (14th arg) and `recentQuestionClustersFn`
 * (24th, last, arg) — the router-level exercise of the repeat-question-
 * cluster alert (issue #887) never needs a real DB or agent turn, mirroring
 * `knowledgeGapAlert.router.test.ts`'s `makeRouterWithSpies` shape.
 */
function makeRouterWithSpies(
  clustersFn: (
    conversationIds: readonly string[] | null,
    days?: number,
    limit?: number,
  ) => Promise<QuestionCluster[]>,
) {
  const notifyCalls: { message: string; excludeUserId: string }[] = [];
  const clusterCalls: (readonly string[] | null)[] = [];
  const clusterCallArgs: { conversationIds: readonly string[] | null; days?: number; limit?: number }[] = [];
  const router = new Router(
    makeRouterDeps({
      runTurn: async () => ({ text: 'Here is what I found.', ok: true }),
      typingRefireMs: 20,
      notifyAdminsFn: async (
        _adapterFor: (platform: string) => PlatformAdapter | undefined,
        message: string,
        excludeUserId: string,
      ) => {
        notifyCalls.push({ message, excludeUserId });
      },
      recentQuestionClustersFn: async (
        conversationIds: readonly string[] | null,
        days?: number,
        limit?: number,
      ) => {
        clusterCalls.push(conversationIds);
        clusterCallArgs.push({ conversationIds, days, limit });
        return clustersFn(conversationIds, days, limit);
      },
    }),
  );
  return { router, notifyCalls, clusterCalls, clusterCallArgs };
}

test('config: REPEAT_QUESTION_ALERT_ENABLED reads true and REPEAT_QUESTION_ALERT_RATE_LIMIT_PER_HOUR reads the overridden value', () => {
  assert.equal(config.repeatQuestionAlert.enabled, true);
  assert.equal(config.repeatQuestionAlert.rateLimitPerHour, 3);
  assert.equal(config.repeatQuestionAlert.threshold, 3);
  assert.equal(config.repeatQuestionAlert.cooldownMinutes, 15);
});

test('router (repeat-question cluster alert): a crossed cluster fires exactly one notifyAdmins call naming the representative text and count, scoped to the triggering conversation only (issue #887 acceptance criterion 1)', async () => {
  const { router, notifyCalls, clusterCalls } = makeRouterWithSpies(async () => [
    { representative: 'what time does the ferry to Waiheke leave on Saturdays', count: 3 },
  ]);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId: 'chan-crossed' }));

  assert.equal(sent[0].text, 'Here is what I found.', 'the member-facing reply is untouched');
  assert.equal(clusterCalls.length, 1, 'exactly one recentQuestionClusters call');
  assert.deepEqual(
    clusterCalls[0],
    ['chan-crossed'],
    'scoped to the single triggering conversation only, matching FRESHNESS_DAYS/CLUSTER_LIMIT window args below',
  );
  assert.equal(notifyCalls.length, 1, 'exactly one notifyAdmins call');
  assert.match(notifyCalls[0].message, /3 times/);
  assert.match(notifyCalls[0].message, /what time does the ferry to Waiheke leave on Saturdays/);
  assert.equal(notifyCalls[0].excludeUserId, 'super-1');
});

test('router (repeat-question cluster alert): recentQuestionClusters is called with the shared FRESHNESS_DAYS/CLUSTER_LIMIT window admin digest and question_digest already use', async () => {
  const { router, clusterCallArgs } = makeRouterWithSpies(async () => []);
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId: 'chan-window-check' }));

  assert.equal(clusterCallArgs.length, 1);
  assert.equal(clusterCallArgs[0].days, FRESHNESS_DAYS);
  assert.equal(clusterCallArgs[0].limit, CLUSTER_LIMIT);
});

test('router (repeat-question cluster alert): no crossing this turn (every cluster under threshold) never calls notifyAdmins', async () => {
  const { router, notifyCalls, clusterCalls } = makeRouterWithSpies(async () => [
    { representative: 'a question asked only twice', count: 2 },
  ]);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId: 'chan-no-cross' }));

  assert.equal(sent[0].text, 'Here is what I found.');
  assert.equal(
    clusterCalls.length,
    1,
    'the cluster check still runs — only the DM is gated on the threshold',
  );
  assert.equal(notifyCalls.length, 0);
});

test('router (repeat-question cluster alert): a reply that did not end in genuine success (ok !== true) never calls recentQuestionClusters or notifyAdmins', async () => {
  const notifyCalls: { message: string; excludeUserId: string }[] = [];
  const clusterCalls: unknown[] = [];
  const router = new Router(
    makeRouterDeps({
      runTurn: async () => ({ text: 'Sorry, something went wrong.', ok: false }),
      typingRefireMs: 20,
      notifyAdminsFn: async (
        _adapterFor: (platform: string) => PlatformAdapter | undefined,
        message: string,
        excludeUserId: string,
      ) => {
        notifyCalls.push({ message, excludeUserId });
      },
      recentQuestionClustersFn: async (conversationIds: readonly string[] | null) => {
        clusterCalls.push(conversationIds);
        return [{ representative: 'would have crossed', count: 99 }];
      },
    }),
  );
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId: 'chan-not-ok' }));

  assert.equal(clusterCalls.length, 0, 'a non-genuine-success reply must never trigger the cluster check');
  assert.equal(notifyCalls.length, 0);
});

test('SECURITY: router (repeat-question cluster alert): the check is scoped to the single triggering conversation only — a qualifying cluster seeded for a different conversation can never surface here (issue #887 acceptance criterion 5)', async () => {
  const { router, notifyCalls, clusterCalls } = makeRouterWithSpies(async (conversationIds) => {
    if (conversationIds?.[0] === 'chan-b-secret') {
      return [{ representative: 'a secret question only asked in chan-b', count: 50 }];
    }
    return [];
  });
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId: 'chan-a-trigger' }));

  assert.equal(clusterCalls.length, 1);
  assert.deepEqual(
    clusterCalls[0],
    ['chan-a-trigger'],
    'the check is scoped to [msg.conversationId] only — it can never be passed a different or broader scope',
  );
  assert.equal(notifyCalls.length, 0, 'chan-b-secret cluster must never surface for a chan-a-trigger turn');
});

test('SECURITY: router (repeat-question cluster alert): the alert DM body is a strict subset of what question_digest returns — representative (truncated) + count only, no conversation id or other new field (issue #887 acceptance criterion 6)', async () => {
  const longQuery = 'x'.repeat(500);
  const { router, notifyCalls } = makeRouterWithSpies(async () => [{ representative: longQuery, count: 7 }]);
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  // userId stays 'super-1' (the convention every other test in this file
  // uses) — overriding it to an arbitrary id would make role resolution hit
  // the real DB and fall into the gated-guest path before respond() is ever
  // reached, never exercising the alert at all. The "no identity leaks"
  // property doesn't need an exotic id to prove: notifyAdminsFn's `message`
  // arg is asserted below to carry only representative + count, and
  // `excludeUserId` (the caller's own id, never echoed into the DM body) is
  // a separate parameter entirely.
  await trigger(makeMessage({ conversationId: 'secret-channel-id-should-not-leak' }));

  assert.equal(notifyCalls.length, 1);
  const message = notifyCalls[0].message;
  assert.doesNotMatch(
    message,
    /secret-channel-id-should-not-leak/,
    'the conversation id must never appear in the alert body',
  );
  assert.doesNotMatch(message, /super-1/, 'no member/user identity must appear in the alert body');
  assert.match(message, /7 times/);
  assert.ok(
    message.length < longQuery.length,
    'an over-long representative must be truncated (truncateForEcho), never echoed in full',
  );
  assert.match(message, /x+\.\.\./, 'truncated text ends with the standard truncateForEcho ellipsis');
});

test('router (repeat-question cluster alert): a second addressed-to-bot turn in the same conversation within the cooldown performs no further recentQuestionClusters call (issue #887 acceptance criterion 2)', async () => {
  const { router, clusterCalls } = makeRouterWithSpies(async () => [
    { representative: 'asked again and again', count: 5 },
  ]);
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId: 'chan-cooldown', text: 'first turn' }));
  await trigger(makeMessage({ conversationId: 'chan-cooldown', text: 'second turn, same conversation' }));

  assert.equal(
    clusterCalls.length,
    1,
    'the cooldown gates the recentQuestionClusters call itself, not just the resulting DM',
  );
});

test("router (repeat-question cluster alert): a turn in a DIFFERENT conversation is unaffected by another conversation's cooldown", async () => {
  const { router, clusterCalls } = makeRouterWithSpies(async () => []);
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId: 'chan-x', text: 'first' }));
  await trigger(makeMessage({ conversationId: 'chan-y', text: 'second, different conversation' }));

  assert.equal(clusterCalls.length, 2, 'each conversation has its own independent cooldown');
});

test('SECURITY: router (repeat-question cluster alert): once REPEAT_QUESTION_ALERT_RATE_LIMIT_PER_HOUR is exhausted within the hour, a further crossed cluster queues no DM (issue #887 acceptance criterion 4)', async () => {
  const { router, notifyCalls, clusterCalls } = makeRouterWithSpies(async () => [
    { representative: 'a recurring question', count: 4 },
  ]);
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  const limit = config.repeatQuestionAlert.rateLimitPerHour;
  for (let i = 0; i < limit; i += 1) {
    await trigger(makeMessage({ text: `capped cluster ${i}`, conversationId: `chan-cap-${i}` }));
  }
  assert.equal(notifyCalls.length, limit, 'every crossing within the cap must notify');

  // One more crossing, past the cap, in a fresh conversation so the cooldown
  // is not what's suppressing it — the rate cap is.
  await trigger(makeMessage({ text: 'over-cap cluster', conversationId: 'chan-over-cap' }));

  assert.equal(
    clusterCalls.length,
    limit + 1,
    'the cluster check itself still runs — only the DM is rate-capped',
  );
  assert.equal(notifyCalls.length, limit, 'the over-cap crossing must not notify — the cap is not exceeded');
});
