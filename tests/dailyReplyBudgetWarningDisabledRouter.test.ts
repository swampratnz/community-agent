import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// budgetCheckFailureRouter.test.ts. DAILY_REPLY_BUDGET_WARN_ENABLED is
// deliberately left UNSET here (default off) — this file pins the
// SECURITY invariant that with the flag off, the reply is byte-identical to
// today's for every used/limit combination, complementing
// dailyReplyBudgetWarningRouter.test.ts (the ONLY place the flag is 'true').
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.ACCESS_MODE_DISCORD = 'open';

const { pool, closeDb } = await import('../src/storage/db.js');
const { Router } = await import('../src/router.js');
const { config } = await import('../src/config.js');
const { embed } = await import('../src/storage/embeddings.js');

await embed('warmup').catch(() => {});

const LIMIT = 50;

const RUN = `daily-budget-warn-disabled-router-${Date.now()}`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM interactions WHERE content LIKE $1`, [`${RUN}%`]);
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
    userId: 'member-1',
    userName: 'Test Member',
    text: `${RUN} hello bot`,
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeReply(text: string): AgentReply {
  return { text, ok: true };
}

function countRepliesReturning(used: number): () => Promise<number> {
  return async () => used;
}

test('config: DAILY_REPLY_BUDGET_WARN_ENABLED is off in this file (sanity check for the tests below)', () => {
  assert.equal(config.behaviour.dailyReplyBudgetWarnEnabled, false);
});

test('SECURITY: DAILY_REPLY_BUDGET_WARN_ENABLED off — reply is byte-identical for a caller at exactly used = limit - 1 (deep inside what would be the warning window)', async () => {
  const router = new Router(
    async () => makeReply(`${RUN} unmodified reply`),
    20,
    async () => false,
    undefined,
    undefined,
    countRepliesReturning(LIMIT - 1), // remaining would be 0 — well inside any warning window if the flag were on
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].text,
    `${RUN} unmodified reply`,
    'no warning line for any used/limit combination when the flag is off',
  );
});

test('SECURITY: DAILY_REPLY_BUDGET_WARN_ENABLED off — byte-identical across the full range from just-started to just-under-the-cutoff', async () => {
  for (const used of [0, 1, 25, 44, 45, 46, 47, 48, 49]) {
    const router = new Router(
      async () => makeReply(`${RUN} reply for used=${used}`),
      20,
      async () => false,
      undefined,
      undefined,
      countRepliesReturning(used),
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId: `chan-${used}` }));

    assert.equal(sent.length, 1);
    assert.equal(
      sent[0].text,
      `${RUN} reply for used=${used}`,
      `used=${used} must produce an unmodified reply`,
    );
  }
});

test('router (daily budget warning disabled): the existing used >= limit hard-stop notice is unaffected', async () => {
  const router = new Router(
    async () => makeReply('should not be reached — over budget'),
    20,
    async () => false,
    undefined,
    undefined,
    countRepliesReturning(LIMIT),
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /reached today's usage limit/i);
});
