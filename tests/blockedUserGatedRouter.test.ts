import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Router-level counterpart to blockedUserOpenRouter.test.ts, covering the
// `gated` half of issue #572 acceptance criterion 1 (ACCESS_MODE_WHATSAPP
// defaults to 'gated', so this file needs no override — see
// blockedUserOpenRouter.test.ts's header for why `open` lives in its own
// file). DATABASE_URL stays an unreachable dummy; `checkBlocked` is DI'd so
// this file never depends on a live Postgres, mirroring
// gatedNotice.router.test.ts's harness exactly.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS ??= 'super-1';

const { Router, GATED_NOTICE } = await import('../src/router.js');

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): {
  adapter: PlatformAdapter;
  sent: OutgoingMessage[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const adapter: PlatformAdapter = {
    platform: 'whatsapp',
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
    platform: 'whatsapp',
    conversationId: 'convo-1',
    userId: `gated-guest-${Date.now()}`,
    userName: 'A Guest',
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

// A 16-arg positional constructor call is unavoidable without touching every
// other Router() call site in the suite; `undefined` lets each default
// through except the two args this file actually cares about (runTurn,
// checkBlocked).
function buildRouter(
  runTurn: () => Promise<AgentReply>,
  checkBlocked: (platform: string, userId: string) => Promise<boolean>,
) {
  return new Router(
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
    undefined,
    undefined,
    checkBlocked,
  );
}

test(
  'baseline (no block check tripped): a gated guest still gets the static GATED_NOTICE, byte-identical to ' +
    "today — the block check integrates without regressing the existing gated flow",
  async () => {
    const router = buildRouter(
      async () => {
        throw new Error('runTurn must not be called for a gated guest');
      },
      async () => false, // checkBlocked: not blocked
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage());

    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, GATED_NOTICE);
  },
);

test(
  'SECURITY: a blocked sender on `gated` access mode gets zero footprint — no GATED_NOTICE, no agent ' +
    'invocation (issue #572 acceptance criterion 1)',
  async () => {
    let runTurnCalls = 0;
    const router = buildRouter(
      async () => {
        runTurnCalls += 1;
        throw new Error('runTurn must never be called for a blocked sender');
      },
      async () => true, // checkBlocked: blocked
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await assert.doesNotReject(trigger(makeMessage()));

    assert.equal(runTurnCalls, 0);
    assert.equal(sent.length, 0, 'not even the gated notice is sent to a blocked sender');
  },
);

test(
  'SECURITY: a blocked sender whose identity would otherwise resolve super_admin (bypassing pause/rate/' +
    'budget checks) is STILL dropped — the block check runs unconditionally, before role resolution, not ' +
    'just for guests (issue #572 acceptance criterion 1)',
  async () => {
    let runTurnCalls = 0;
    const router = buildRouter(
      async () => {
        runTurnCalls += 1;
        throw new Error('runTurn must never be called for a blocked sender');
      },
      async () => true, // checkBlocked: blocked
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    // 'super-1' is configured via SUPER_ADMIN_WHATSAPP_NUMBERS above — this
    // identity would normally reach the agent immediately (no DB round trip
    // needed for role resolution, no pause/rate/budget gate). The block
    // check must still win.
    await assert.doesNotReject(trigger(makeMessage({ userId: 'super-1' })));

    assert.equal(runTurnCalls, 0);
    assert.equal(sent.length, 0);
  },
);

test(
  'SECURITY: a block-list lookup failure fails OPEN (treated as not-blocked), matching resolveRole\'s own ' +
    'degrade convention — a transient DB hiccup must never silently drop every sender (issue #572)',
  async () => {
    let runTurnCalls = 0;
    const router = buildRouter(
      async () => {
        runTurnCalls += 1;
        return makeReply('a normal reply');
      },
      async () => {
        throw new Error('blocked_users lookup boom');
      },
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    // super-1 sidesteps the gated-guest branch entirely (bypasses pause/
    // rate/budget too) so this test isolates the block-check failure alone.
    await assert.doesNotReject(trigger(makeMessage({ userId: 'super-1' })));

    assert.equal(runTurnCalls, 1, 'a block-check failure must not block a legitimate sender');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'a normal reply');
  },
);
