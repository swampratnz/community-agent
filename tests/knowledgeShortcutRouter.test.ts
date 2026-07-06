import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';
import type { searchKnowledge } from '../src/storage/repository.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// ackShortcutRouter.test.ts. This file is the ONLY place
// KNOWLEDGE_SHORTCUT_ENABLED is set to 'true' — router.test.ts and
// ackShortcutRouter.test.ts leave it unset so the default-off path stays
// covered untouched, and the node test runner isolates env per test file.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.KNOWLEDGE_SHORTCUT_ENABLED = 'true';

const { config } = await import('../src/config.js');
const { Router } = await import('../src/router.js');
const { embed } = await import('../src/storage/embeddings.js');

await embed('warmup').catch(() => {});

type SearchKnowledgeFn = typeof searchKnowledge;

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
    text: 'what are the server rules?',
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

/** A fake `searchKnowledge` returning one fixed hit, regardless of query text. */
function fixedHitSearch(similarity: number): SearchKnowledgeFn {
  return async () => [
    {
      id: 1,
      title: 'Rules',
      content: 'Be kind and follow the code of conduct.',
      similarity,
      updatedAt: new Date(),
    },
  ];
}

test('config: KNOWLEDGE_SHORTCUT_ENABLED=true is reflected in config.behaviour.knowledgeShortcutEnabled', () => {
  assert.equal(config.behaviour.knowledgeShortcutEnabled, true);
});

test('config: KNOWLEDGE_SHORTCUT_THRESHOLD defaults to a strict 0.9', () => {
  assert.equal(config.behaviour.knowledgeShortcutThreshold, 0.9);
});

test('router (knowledge shortcut): a near-exact match (>= threshold) skips runTurn and returns the KB content', async () => {
  const recorded: number[][] = [];
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a near-exact knowledge-shortcut match');
    },
    20,
    undefined,
    fixedHitSearch(0.95),
    async (ids) => {
      recorded.push(ids);
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Be kind and follow the code of conduct\./);
  assert.match(sent[0].text, /From our knowledge base/i);
  assert.deepEqual(recorded, [[1]], 'retrieval_count/last_retrieved_at must be bumped for the served entry');
});

test('router (knowledge shortcut): a middling match below threshold falls through to a normal agent turn', async () => {
  const router = new Router(
    async () => ({ text: 'real answer' }),
    20,
    undefined,
    fixedHitSearch(0.5), // above knowledge_search's 0.35 floor, below the 0.9 shortcut floor
    async () => {},
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'real answer', 'must get the real agent reply, not a shortcut reply');
});

test('router (knowledge shortcut): no knowledge hits falls through to a normal agent turn', async () => {
  const router = new Router(
    async () => ({ text: 'real answer' }),
    20,
    undefined,
    async () => [],
    async () => {},
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'real answer');
});

test('router (knowledge shortcut): a lookup failure falls through to a normal agent turn rather than dropping the message', async () => {
  const router = new Router(
    async () => ({ text: 'real answer' }),
    20,
    undefined,
    async () => {
      throw new Error('DB unreachable');
    },
    async () => {},
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'real answer');
});

// The flag-disabled path (including "flag off falls through regardless of
// similarity") is covered in router.test.ts, which leaves
// KNOWLEDGE_SHORTCUT_ENABLED unset — this file is the ONLY place it's set to
// 'true', mirroring ackShortcutRouter.test.ts's convention.

test('router (knowledge shortcut): the shortcut path still respects the gated-guest gate ahead of it', async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called');
    },
    20,
    undefined,
    fixedHitSearch(0.99),
    async () => {
      throw new Error('retrieval must not be recorded for a gated-out guest');
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  // Default ACCESS_MODE_DISCORD is 'gated'; this user is not a super admin
  // and unresolvable in community_users (DB unreachable in this test), so it
  // resolves to 'guest' and must hit the gated-guest branch, never the
  // knowledge shortcut.
  await trigger(makeMessage({ userId: 'unknown-guest-1' }));

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /member-only/i);
});
