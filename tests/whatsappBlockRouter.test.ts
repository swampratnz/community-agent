import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// autoAnswerRouter.test.ts's `hasDb` convention. This file deliberately
// leaves ACCESS_MODE_WHATSAPP unset (default 'gated') — the 'open'-mode half
// of issue #572 acceptance criterion #1 lives in
// whatsappBlockRouterOpen.test.ts, since config is parsed once per process
// and the Node test runner isolates env per file.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS ??= 'super-1';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const RUN = `whatsapp-block-router-${Date.now()}`;

const { pool, closeDb } = await import('../src/storage/db.js');
const { Router } = await import('../src/router.js');
const { blockUser, unblockUser } = await import('../src/storage/repository.js');
const { embed } = await import('../src/storage/embeddings.js');

await embed('warmup').catch(() => {});

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM interactions WHERE conversation_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM blocked_users WHERE platform = 'whatsapp' AND external_id LIKE $1`, [
      `${RUN}%`,
    ]);
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
    platform: 'whatsapp',
    adminCapabilities: new Set(['warn_user', 'block_user', 'unblock_user']),
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
    platform: 'whatsapp',
    conversationId: `${RUN}-convo`,
    userId: `${RUN}-user`,
    userName: 'Test User',
    text: 'hello bot',
    isDirect: true,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeReply(text: string): AgentReply {
  return { text };
}

test(
  'SECURITY: a blocked WhatsApp sender never reaches the agent and gets no reply, in GATED access mode ' +
    '(the default) — zero runTurn invocation, zero adapter send, and no interaction row written, proving ' +
    'the block-check runs before role resolution and before any storage (issue #572 acceptance criterion #1)',
  { skip },
  async () => {
    const userId = `${RUN}-blocked-gated`;
    const convo = `${RUN}-convo-blocked-gated`;
    await blockUser('whatsapp', userId, 'test-admin', 'persistent abuse');

    const router = new Router(async () => {
      throw new Error('runTurn must never be called for a blocked sender');
    }, 20);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ userId, conversationId: convo }));

    assert.equal(sent.length, 0, 'a blocked sender must get no reply at all — not even the gated notice');

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM interactions WHERE platform = 'whatsapp' AND user_id = $1`,
      [userId],
    );
    assert.equal(rows[0].n, 0, 'a blocked sender must leave zero footprint — no interaction row stored');
  },
);

test(
  'Block/unblock round-trip: blocking then unblocking the same (platform, userId) restores normal replies ' +
    '(issue #572 acceptance criterion #3)',
  { skip },
  async () => {
    // 'super-1' (SUPER_ADMIN_WHATSAPP_NUMBERS above) resolves role from env
    // alone, with no community_users row needed — the same sidestep
    // router.test.ts's happy-path tests use — so a successful post-unblock
    // turn is unambiguous proof of a real runTurn invocation, not merely the
    // static gated notice a guest identity would get instead.
    const userId = 'super-1';
    const convo = `${RUN}-convo-roundtrip`;
    let calls = 0;
    const router = new Router(async () => {
      calls += 1;
      return makeReply('hi there');
    }, 20);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await blockUser('whatsapp', userId, 'test-admin', 'persistent abuse');
    try {
      await trigger(
        makeMessage({ userId, conversationId: convo, text: `${RUN} first message while blocked` }),
      );
      assert.equal(calls, 0, 'blocked: no turn');
      assert.equal(sent.length, 0, 'blocked: no reply');

      await unblockUser('whatsapp', userId);
      await trigger(
        makeMessage({ userId, conversationId: convo, text: `${RUN} second message after unblock` }),
      );
      assert.equal(calls, 1, 'unblocked: the turn actually runs again');
      assert.equal(sent.length, 1, 'unblocked: the sender gets a real reply again');
    } finally {
      await unblockUser('whatsapp', userId);
      await pool.query(`DELETE FROM interactions WHERE platform = 'whatsapp' AND conversation_id = $1`, [
        convo,
      ]);
    }
  },
);
