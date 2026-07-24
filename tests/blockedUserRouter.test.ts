import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// router.test.ts. DATABASE_URL points at an unreachable Postgres, but every
// test here overrides `checkBlocked` (the last Router constructor param, see
// makeBlockedRouter below) rather than relying on a live DB, so that never
// matters.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
// This user bypasses the paused/daily-budget DB reads entirely (see
// src/router.ts), so the "unblocked" happy-path tests below never depend on
// `community_users` state — only the (unreachable, harmlessly-caught) DB.
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';

const { config } = await import('../src/config.js');
const { Router } = await import('../src/router.js');

function makeAdapter(): {
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
    userId: 'blocked-1',
    userName: 'Blocked User',
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

/**
 * Builds a Router with every intermediate constructor slot defaulted and
 * `checkBlocked` (the last positional param, issue #572) set to a test
 * double — mirroring accessRequestAlert.router.test.ts's makeGatedRouter —
 * so these tests exercise the router's blocked-sender gate without a live DB
 * or adapter DM.
 */
function makeBlockedRouter(
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

test('SECURITY: router: a blocked sender never reaches the agent and gets no reply, in gated access mode (the default) — no gated notice either, proving the check runs before the gated-guest branch (issue #572 acceptance criterion #1)', async () => {
  const router = makeBlockedRouter(
    async () => {
      throw new Error('runTurn must not be called for a blocked sender');
    },
    async () => true,
  );
  const { adapter, sent, typingCalls, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 0, 'a blocked sender must get zero replies — not even the gated notice');
  assert.equal(typingCalls.length, 0, 'a blocked sender must never trigger the typing indicator');
});

test('SECURITY: router: a blocked sender never reaches the agent and gets no reply, in open access mode — the block overrides open mode\'s default-allow (issue #572 acceptance criterion #1, the exact gap remove_member cannot reach)', async () => {
  const wasAccessMode = config.rbac.accessMode.discord;
  config.rbac.accessMode.discord = 'open';
  try {
    const router = makeBlockedRouter(
      async () => {
        throw new Error('runTurn must not be called for a blocked sender, even in open mode');
      },
      async () => true,
    );
    const { adapter, sent, typingCalls, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage());

    assert.equal(sent.length, 0, 'a blocked sender must get zero replies in open mode too');
    assert.equal(typingCalls.length, 0);
  } finally {
    config.rbac.accessMode.discord = wasAccessMode;
  }
});

test('SECURITY: router: the blocked-sender check runs before resolveRole — a blocked configured super admin still gets zero reply (issue #572 acceptance criterion #1)', async () => {
  const router = makeBlockedRouter(
    async () => {
      throw new Error('runTurn must not be called for a blocked sender, even a super admin');
    },
    async () => true,
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  // 'super-1' is a configured super admin (SUPER_ADMIN_DISCORD_IDS above) —
  // if the block check ran after resolveRole, this message would sail
  // through untouched, same as every other super-admin test in this repo.
  await trigger(makeMessage({ userId: 'super-1', isDirect: true }));

  assert.equal(sent.length, 0, 'even a super admin gets zero reply once blocked');
});

test('router: an unblocked sender is unaffected — checkBlocked returning false changes nothing about the normal reply path', async () => {
  const router = makeBlockedRouter(async () => makeReply('a perfectly good reply'), async () => false);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  // Direct message from a super admin bypasses the paused/daily-budget DB
  // reads entirely (see router.test.ts's identical convention), so this
  // reaches respond() deterministically without a live DB.
  await trigger(makeMessage({ userId: 'super-1', isDirect: true }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'a perfectly good reply');
});

test('router: blocking then unblocking the same (platform, userId) restores normal replies (issue #572 acceptance criterion #3)', async () => {
  const blocked = new Set<string>(['blocked-1']);
  const router = makeBlockedRouter(
    async () => makeReply('welcome back'),
    async (_platform, userId) => blocked.has(userId),
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ isDirect: true }));
  assert.equal(sent.length, 0, 'still blocked — no reply yet');

  blocked.delete('blocked-1'); // simulates the unblock_user moderate action
  await trigger(makeMessage({ isDirect: true }));
  assert.equal(sent.length, 1, 'unblocked — normal replies resume');
  assert.equal(sent[0].text, 'welcome back');
});

test('router: a blocked-check failure (e.g. a DB hiccup) fails toward "not blocked" rather than dropping every message — same posture as resolveRole\'s own catch', async () => {
  const router = makeBlockedRouter(
    async () => makeReply('still works'),
    async () => {
      throw new Error('simulated DB failure');
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId: 'super-1', isDirect: true }));

  assert.equal(sent.length, 1, 'a checkBlocked error must not take the whole bot down for every sender');
  assert.equal(sent[0].text, 'still works');
});
