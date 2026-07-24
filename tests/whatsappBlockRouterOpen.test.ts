import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// pauseNotice.router.test.ts's convention of being the ONE place a given
// ACCESS_MODE_* is flipped to 'open' (config is parsed once per process, and
// the Node test runner isolates env per file). This file is the ONLY place
// ACCESS_MODE_WHATSAPP is set to 'open' — whatsappBlockRouter.test.ts leaves
// it at the default 'gated' so that half of issue #572 acceptance criterion
// #1 stays covered there.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.ACCESS_MODE_WHATSAPP = 'open';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const RUN = `whatsapp-block-router-open-${Date.now()}`;

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
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

test('config: ACCESS_MODE_WHATSAPP is parsed as open in this file', () => {
  assert.equal(config.rbac.accessMode.whatsapp, 'open');
});

test(
  "control: in OPEN access mode, an unblocked guest's message DOES reach the agent and get a reply — the " +
    'default-allow behaviour that remove_member could never override (issue #572 problem statement)',
  { skip },
  async () => {
    const userId = `${RUN}-unblocked-guest`;
    let calls = 0;
    const router = new Router(async () => {
      calls += 1;
      return makeReply('hi there');
    }, 20);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ userId }));

    assert.equal(calls, 1, 'open mode default-allows a guest with no community_users row');
    assert.equal(sent.length, 1);
  },
);

test(
  'SECURITY: a blocked WhatsApp sender never reaches the agent and gets no reply in OPEN access mode — the ' +
    "block overrides open mode's default-allow, which is exactly the gap remove_member cannot reach (issue " +
    '#572 acceptance criterion #1)',
  { skip },
  async () => {
    const userId = `${RUN}-blocked-open`;
    await blockUser('whatsapp', userId, 'test-admin', 'persistent abuse');

    const router = new Router(async () => {
      throw new Error('runTurn must never be called for a blocked sender, even in open access mode');
    }, 20);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ userId }));

    assert.equal(sent.length, 0, 'a blocked sender must get no reply at all, even under open-mode default-allow');

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM interactions WHERE platform = 'whatsapp' AND user_id = $1`,
      [userId],
    );
    assert.equal(rows[0].n, 0, 'a blocked sender must leave zero footprint — no interaction row stored');
  },
);
