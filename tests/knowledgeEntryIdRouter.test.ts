import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// maxTurnsFailureRouter.test.ts. This file pins the PRIMARY outbound-record
// write (router.ts's normal, non-shortcut reply path) so
// `interactions.meta.knowledgeEntryId` gets stamped there too (issue #411) —
// the deterministic knowledge-shortcut's own stamp is covered separately by
// knowledgeShortcutRouter.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';

const { pool, closeDb } = await import('../src/storage/db.js');
const { Router } = await import('../src/router.js');
const { embed } = await import('../src/storage/embeddings.js');
const { MAX_TURNS_REPLY, INTERNAL_ERROR_REPLY } = await import('../src/agent/core.js');

await embed('warmup').catch(() => {});

// Unique-per-run marker so this file's DB writes never collide with another
// test file's traffic and can be cleaned up afterward.
const RUN = `knowledge-entry-id-router-${Date.now()}`;

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
  'router: a normal (non-shortcut) reply carrying AgentReply.knowledgeEntryId stamps meta.knowledgeEntryId on the primary outbound-recording call, alongside replyToUserId (issue #411, acceptance criterion 1)',
  { skip: !hasDb },
  async () => {
    const conversationId = `${RUN}-primary`;
    const userId = 'super-1';
    const router = new Router(
      async () => ({ text: 'the answer, from knowledge_search', ok: true, knowledgeEntryId: 4242 }),
      20,
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId, userId }));

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.equal(meta.knowledgeEntryId, 4242, 'the normal path must stamp the same knowledgeEntryId key');
    assert.equal(meta.replyToUserId, userId, 'replyToUserId must still be stamped as before');
  },
);

test(
  'router: a reply with knowledgeEntryId absent records meta with NO knowledgeEntryId key — never null, never a stale value (issue #411, acceptance criterion 2)',
  { skip: !hasDb },
  async () => {
    const conversationId = `${RUN}-no-hit`;
    const router = new Router(
      async () => ({ text: 'a normal answer, no knowledge_search hit', ok: true }),
      20,
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId }));

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.equal(
      'knowledgeEntryId' in meta,
      false,
      'a turn with no qualifying knowledge_search hit must never carry a knowledgeEntryId key',
    );
  },
);

test(
  'SECURITY: router: a max-turns failure that also carries a stray knowledgeEntryId on the AgentReply is still recorded verbatim by the router — the router trusts AgentReply, so core.ts (not the router) is the sole guard against a stale id on a failure path (issue #411, acceptance criterion 5)',
  { skip: !hasDb },
  async () => {
    // This pins the router's half of the invariant: it faithfully passes
    // through whatever core.ts decided, so the "never stale" guarantee lives
    // entirely in execTurn's success-only threading (see
    // tests/agentCoreKnowledgeEntryId.test.ts), not duplicated/re-derived
    // here. A genuine core.ts TurnOutcome never sets knowledgeEntryId on a
    // non-success outcome — this test only proves the router doesn't add a
    // SECOND opportunity for staleness by filtering independently.
    const conversationId = `${RUN}-max-turns`;
    const router = new Router(async () => ({ text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true }), 20);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId }));

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.equal(
      'knowledgeEntryId' in meta,
      false,
      'core.ts never sets knowledgeEntryId on a max-turns failure, so the router records none',
    );
    assert.equal(meta.maxTurnsExceeded, true, 'the existing maxTurnsExceeded stamp is unaffected');
  },
);

test(
  'router: a non-knowledge failure (INTERNAL_ERROR_REPLY, ok: false) records meta with NO knowledgeEntryId key (issue #411)',
  { skip: !hasDb },
  async () => {
    const conversationId = `${RUN}-internal-error`;
    const router = new Router(async () => ({ text: INTERNAL_ERROR_REPLY, ok: false }), 20);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId }));

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.equal('knowledgeEntryId' in meta, false);
  },
);
