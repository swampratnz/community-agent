import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it, matching router.test.ts.
// This file is the ONLY place ACCESS_REQUEST_ALERT_ENABLED is set to 'true' —
// router.test.ts leaves it unset (default off) so that byte-identical-by-
// default path stays covered untouched, and the node test runner isolates env
// per test file (issue #480).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.ACCESS_REQUEST_ALERT_ENABLED = 'true';
// Small cap so the rate-cap test below doesn't need to fire dozens of calls.
process.env.ACCESS_REQUEST_ALERT_RATE_LIMIT_PER_HOUR = '3';

const { config } = await import('../src/config.js');
const { Router } = await import('../src/router.js');

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
    userId: 'unknown-guest-1',
    userName: 'Guest',
    text: 'hello bot',
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Builds a Router with every intermediate constructor slot defaulted, and
 * `recordAccessRequestFn`/`notifyAccessRequestFn` (the last two positional
 * params, issue #480) set to test doubles — so these tests exercise the
 * router's gating logic (flag + inserted + rate cap) without a live DB or
 * adapter DM.
 */
function makeGatedRouter(opts: {
  recordAccessRequestFn: () => Promise<{ inserted: boolean; firstRequestedAt: Date }>;
  notifyAccessRequestFn: (...args: unknown[]) => Promise<void>;
}) {
  return new Router(
    async () => {
      throw new Error('runTurn must not be called for a gated-out guest');
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
    undefined,
    opts.recordAccessRequestFn,
    opts.notifyAccessRequestFn,
  );
}

test('config: ACCESS_REQUEST_ALERT_ENABLED reads true and ACCESS_REQUEST_ALERT_RATE_LIMIT_PER_HOUR reads the overridden value', () => {
  assert.equal(config.accessRequestAlert.enabled, true);
  assert.equal(config.accessRequestAlert.rateLimitPerHour, 3);
});

test('router (gated guest): a fresh access request (inserted === true) fires notifyAccessRequest exactly once, with the guest platform/userId/userName', async () => {
  const calls: Array<{ platform: string; userId: string; userName: string }> = [];
  const router = makeGatedRouter({
    recordAccessRequestFn: async () => ({ inserted: true, firstRequestedAt: new Date() }),
    notifyAccessRequestFn: async (_adapterFor, guest) => {
      calls.push(guest as { platform: string; userId: string; userName: string });
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId: 'fresh-guest', userName: 'Fresh Guest' }));

  assert.equal(sent.length, 1, 'the guest still gets the gated notice');
  assert.equal(calls.length, 1, 'notifyAccessRequest must fire exactly once for a fresh insert');
  const guest = calls[0];
  assert.equal(guest.platform, 'discord');
  assert.equal(guest.userId, 'fresh-guest');
  assert.equal(guest.userName, 'Fresh Guest');
});

test(
  'SECURITY: router (gated guest): a repeat ping from the same still-pending guest (inserted === false) never ' +
    'fires an additional notifyAccessRequest call (issue #480)',
  async () => {
    let calls = 0;
    const router = makeGatedRouter({
      recordAccessRequestFn: async () => ({ inserted: false, firstRequestedAt: new Date() }), // repeat upsert of an existing row
      notifyAccessRequestFn: async () => {
        calls += 1;
      },
    });
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage());
    await trigger(makeMessage());

    assert.equal(sent.length, 2, 'the guest still gets the gated notice on every addressed message');
    assert.equal(calls, 0, 'a repeat (non-fresh) request must never notify');
  },
);

test(
  'SECURITY: router (gated guest): once ACCESS_REQUEST_ALERT_RATE_LIMIT_PER_HOUR alerts have fired within the ' +
    'trailing hour, a further first-time request is still recorded but does not notify again (issue #480)',
  async () => {
    let notifyCalls = 0;
    let recordCalls = 0;
    const router = makeGatedRouter({
      recordAccessRequestFn: async () => {
        recordCalls += 1;
        return { inserted: true, firstRequestedAt: new Date() }; // every call here is a "fresh" first-time request
      },
      notifyAccessRequestFn: async () => {
        notifyCalls += 1;
      },
    });
    const { adapter, trigger } = makeAdapter();
    router.register(adapter);

    const limit = config.accessRequestAlert.rateLimitPerHour;
    for (let i = 0; i < limit; i += 1) {
      await trigger(makeMessage({ userId: `guest-${i}` }));
    }
    assert.equal(notifyCalls, limit, 'every call within the cap must notify');

    // One more first-time request, past the cap.
    await trigger(makeMessage({ userId: 'guest-over-cap' }));

    assert.equal(recordCalls, limit + 1, 'the over-cap request is still recorded (never lost)');
    assert.equal(notifyCalls, limit, 'the over-cap request must not notify — the cap is not exceeded');
  },
);

test('router (gated guest): re-request after a fresh insert (e.g. after clearAccessRequest) notifies again — each call is judged solely on its own inserted value', async () => {
  let calls = 0;
  const router = makeGatedRouter({
    recordAccessRequestFn: async () => ({ inserted: true, firstRequestedAt: new Date() }), // every call reports fresh, as it would right after clearAccessRequest
    notifyAccessRequestFn: async () => {
      calls += 1;
    },
  });
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId: 'guest-a' }));
  await trigger(makeMessage({ userId: 'guest-b' }));

  assert.equal(calls, 2, 'each distinct fresh insert notifies its own time, independent of prior calls');
});

test(
  'SECURITY: router (gated guest): a recordAccessRequest failure (e.g. DB unreachable) is treated as "not fresh" ' +
    'and never fires notifyAccessRequest, and never throws or drops the gated reply',
  async () => {
    let notifyCalls = 0;
    const router = makeGatedRouter({
      recordAccessRequestFn: async () => {
        throw new Error('DB unreachable');
      },
      notifyAccessRequestFn: async () => {
        notifyCalls += 1;
      },
    });
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await assert.doesNotReject(trigger(makeMessage()));

    assert.equal(sent.length, 1, 'the guest still gets the gated notice despite the recording failure');
    assert.equal(notifyCalls, 0, 'a failed record must never be treated as a fresh insert');
  },
);
