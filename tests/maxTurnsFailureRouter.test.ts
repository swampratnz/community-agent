import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// repeatMaxTurnsShortcutRouter.test.ts. REPEAT_MAX_TURNS_SHORTCUT_ENABLED is
// deliberately left unset here — this file pins the PRIMARY outbound-record
// write (router.ts:900-909), which happens on every turn regardless of that
// flag, not the #306 repeat-shortcut path (covered by
// repeatMaxTurnsShortcutRouter.test.ts).
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
const RUN = `maxturns-router-${Date.now()}`;

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
  'router: a genuine error_max_turns failure (reply.maxTurnsExceeded === true) stamps meta.maxTurnsExceeded: true on the primary outbound-recording call, alongside replyToUserId (issue #371)',
  { skip: !hasDb },
  async () => {
    const conversationId = `${RUN}-primary`;
    const userId = 'super-1';
    const router = new Router(async () => ({ text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true }), 20);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId, userId }));

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.equal(
      meta.maxTurnsExceeded,
      true,
      'the primary max-turns failure must stamp maxTurnsExceeded: true',
    );
    assert.equal(meta.replyToUserId, userId, 'replyToUserId must still be stamped as before');
  },
);

test(
  'router: a successful reply (reply.ok === true, maxTurnsExceeded absent) records meta with NO maxTurnsExceeded key (issue #371)',
  { skip: !hasDb },
  async () => {
    const conversationId = `${RUN}-success`;
    const router = new Router(async () => ({ text: 'a normal answer', ok: true }), 20);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId }));

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.equal(
      'maxTurnsExceeded' in meta,
      false,
      'a successful turn must never carry a maxTurnsExceeded key, not even a falsy one',
    );
  },
);

test(
  'router: a non-max-turns failure (reply.ok === false, maxTurnsExceeded undefined) records meta with NO maxTurnsExceeded key (issue #371)',
  { skip: !hasDb },
  async () => {
    const conversationId = `${RUN}-other-failure`;
    const router = new Router(async () => ({ text: INTERNAL_ERROR_REPLY, ok: false }), 20);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ conversationId }));

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.equal(
      'maxTurnsExceeded' in meta,
      false,
      'a non-max-turns failure must never carry a maxTurnsExceeded key — never a truthy-ish absent value',
    );
  },
);
