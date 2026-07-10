import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Router-level counterpart to gatedNotice.test.ts's pure-function/cache unit
// tests (issue #360) — this file drives the actual gated-guest send path
// through Router.handle(), mirroring rateLimitNotice.router.test.ts's
// harness and env-setup rationale exactly (config.ts validates env at
// import time). DATABASE_URL stays an unreachable dummy: the DI'd
// `getGatedNotice` param stands in for the real DB-backed builder so these
// tests never depend on a live Postgres.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';

const { pool, closeDb } = await import('../src/storage/db.js');
const { Router } = await import('../src/router.js');
const { GATED_NOTICE } = await import('../src/gatedNotice.js');
const { embed } = await import('../src/storage/embeddings.js');

await embed('warmup').catch(() => {});

const RUN = `gatednotice-router-${Date.now()}`;

after(async () => {
  await pool.query(`DELETE FROM interactions WHERE content LIKE $1`, [`${RUN}%`]).catch(() => {});
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
    // Not in SUPER_ADMIN_DISCORD_IDS and unresolvable in `community_users`
    // (DB unreachable in this file) — resolves to 'guest'. Default
    // ACCESS_MODE_DISCORD is 'gated' (see config.ts), so this hits the
    // gated-guest branch.
    userId: `${RUN}-guest`,
    userName: 'A Guest',
    text: `${RUN} hello bot`,
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeReply(text: string): AgentReply {
  return { text };
}

test('router (gated guest): when the injected gated-notice builder resolves admin names, the reply is exactly that text — not the static fallback', async () => {
  const notice =
    'Kia ora! This assistant is member-only. Ask a community admin — Alice or Bob — to add you as a member and I can help.';
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a gated guest');
    },
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => notice,
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, notice);
  assert.notEqual(sent[0].text, GATED_NOTICE);
});

test('router (gated guest): the gated-notice builder is called with the message platform', async () => {
  const seenPlatforms: string[] = [];
  const router = new Router(
    async () => makeReply('unused'),
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (platform: string) => {
      seenPlatforms.push(platform);
      return GATED_NOTICE;
    },
  );
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.deepEqual(seenPlatforms, ['discord']);
});

test('router (gated guest): the default (real, DB-backed) gated-notice builder degrades to the static GATED_NOTICE when the DB is unreachable', async () => {
  const router = new Router(async () => {
    throw new Error('runTurn must not be called for a gated guest');
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, GATED_NOTICE);
});

test('SECURITY: router (gated guest): a gated-notice builder failure is caught — the guest still gets the static fallback notice, never silence or a thrown error', async () => {
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a gated guest');
    },
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      throw new Error('gated-notice builder boom');
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await assert.doesNotReject(trigger(makeMessage()));
  assert.equal(sent.length, 1, 'the guest must still get a reply, not silence');
  assert.equal(
    sent[0].text,
    GATED_NOTICE,
    'a builder failure degrades to the static fallback, never a thrown error',
  );
});
