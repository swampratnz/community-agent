import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// knowledgeEntryIdRouter.test.ts. This file pins the PRIMARY outbound-record
// write (router.ts's normal, non-shortcut reply path) so
// `interactions.meta.cacheReadTokens`/`cacheCreationTokens` get stamped
// there (issue #522).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';

const { pool, closeDb } = await import('../src/storage/db.js');
const { Router } = await import('../src/router.js');
const { embed } = await import('../src/storage/embeddings.js');

await embed('warmup').catch(() => {});

// Unique-per-run marker so this file's DB writes never collide with another
// test file's traffic and can be cleaned up afterward.
const RUN = `cache-usage-router-${Date.now()}`;

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
  'router: a reply carrying non-zero AgentReply.cacheReadTokens/cacheCreationTokens stamps both onto meta (issue #522, acceptance criterion 1)',
  { skip: !hasDb },
  async () => {
    const conversationId = `${RUN}-hit`;
    const router = new Router(
      async () => ({ text: 'the answer', ok: true, cacheReadTokens: 1234, cacheCreationTokens: 56 }),
      20,
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId }));

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.equal(meta.cacheReadTokens, 1234);
    assert.equal(meta.cacheCreationTokens, 56);
  },
);

test(
  'router: a reply with no cache-usage fields at all records meta with NEITHER key present (issue #522, acceptance criterion 2)',
  { skip: !hasDb },
  async () => {
    const conversationId = `${RUN}-absent`;
    const router = new Router(async () => ({ text: 'a normal answer', ok: true }), 20);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId }));

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.equal('cacheReadTokens' in meta, false);
    assert.equal('cacheCreationTokens' in meta, false);
  },
);

test(
  'router: a reply with all-zero cache-usage fields records meta with NEITHER key present — byte-identical to "no usage" (issue #522, acceptance criterion 2)',
  { skip: !hasDb },
  async () => {
    const conversationId = `${RUN}-zero`;
    const router = new Router(
      async () => ({ text: 'a normal answer', ok: true, cacheReadTokens: 0, cacheCreationTokens: 0 }),
      20,
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId }));

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.equal('cacheReadTokens' in meta, false);
    assert.equal('cacheCreationTokens' in meta, false);
  },
);
