import { test, after } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';
import type {
  IncomingMessage,
  OutgoingMessage,
  PlatformAdapter,
} from '@swampratnz/agent-base/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// tests/cacheUsageRouter.test.ts. This file pins the PRIMARY outbound-record
// write (router.ts's normal, non-shortcut reply path) so
// `interactions.meta.modelUsage` gets stamped there (issue #792).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';

const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');
const { Router } = await import('@swampratnz/agent-base/router.js');
const { makeRouterDeps } = await import('../src/module/routerWiring.js');
const { embed } = await import('@swampratnz/agent-base/storage/embeddings.js');

await embed('warmup').catch(() => {});

// Unique-per-run marker so this file's DB writes never collide with another
// test file's traffic and can be cleaned up afterward.
const RUN = `model-usage-router-${Date.now()}`;

after(async () => {
  if (hasDb) {
    // Scoped by conversation_id, not content: the outbound reply rows this
    // file records (the router's normal, non-shortcut path) carry generic
    // reply text that never includes the RUN marker, only the inbound
    // messages that trigger them do — conversation_id is the one column
    // every row this file writes actually shares.
    await pool.query(`DELETE FROM interactions WHERE conversation_id LIKE $1`, [`${RUN}%`]);
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
    userId: 'super-1',
    userName: 'Test User',
    text: `${RUN} hello bot`,
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

async function outboundMeta(conversationId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    `SELECT meta FROM interactions WHERE direction = 'outbound' AND conversation_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [conversationId],
  );
  assert.equal(rows.length, 1, `expected exactly one outbound interaction recorded for ${conversationId}`);
  return rows[0].meta;
}

test(
  'router: a reply carrying a non-empty AgentReply.modelUsage stamps it verbatim onto meta (issue #792, acceptance criterion 3)',
  { skip: !hasDb },
  async () => {
    const conversationId = `${RUN}-hit`;
    const router = new Router(
      makeRouterDeps({
        runTurn: async () => ({
          text: 'the answer',
          ok: true,
          modelUsage: { 'claude-sonnet-5': 1.23, 'claude-haiku-4-5': 0.04 },
        }),
        typingRefireMs: 20,
      }),
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId }));

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.deepEqual(meta.modelUsage, { 'claude-sonnet-5': 1.23, 'claude-haiku-4-5': 0.04 });
  },
);

test(
  'SECURITY: router: a reply with no modelUsage field at all records meta with NO modelUsage key present (issue #792, acceptance criterion 6)',
  { skip: !hasDb },
  async () => {
    const conversationId = `${RUN}-absent`;
    const router = new Router(
      makeRouterDeps({ runTurn: async () => ({ text: 'a normal answer', ok: true }), typingRefireMs: 20 }),
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId }));

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.equal('modelUsage' in meta, false);
  },
);

test(
  'SECURITY: router: a reply with an empty modelUsage object records meta with NO modelUsage key present — byte-identical to "no usage" (issue #792, acceptance criterion 6)',
  { skip: !hasDb },
  async () => {
    const conversationId = `${RUN}-empty`;
    const router = new Router(
      makeRouterDeps({
        runTurn: async () => ({ text: 'a normal answer', ok: true, modelUsage: {} }),
        typingRefireMs: 20,
      }),
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId }));

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.equal('modelUsage' in meta, false);
  },
);
