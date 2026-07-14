import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// repeatQuestionShortcutRouter.test.ts / autoAnswerRouter.test.ts. This file
// is the ONLY place BOTH AUTO_ANSWER_CHANNEL_IDS and
// REPEAT_QUESTION_SHORTCUT_ENABLED are set together — pinning the acceptance
// criterion that the repeat-question shortcut (an existing member-tier cost
// lever) still applies on the auto-answer path, with no new bypass, and that
// its replay is threaded exactly like a fresh auto-answer would be.
//
// Every identity/channel/thread id below is derived from a per-run marker
// (`RUN`), same rationale as autoAnswerRouter.test.ts: this exercises a
// non-super-admin caller against a real DATABASE_URL when one is reachable,
// so a fixed id would accumulate real `interactions` rows across repeated
// local runs.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.ACCESS_MODE_DISCORD = 'open';

const RUN = `autoanswer-repeat-router-${Date.now()}`;
const AUTO_CHAN = `${RUN}-chan`;
process.env.AUTO_ANSWER_CHANNEL_IDS = AUTO_CHAN;
process.env.REPEAT_QUESTION_SHORTCUT_ENABLED = 'true';

const { pool, closeDb } = await import('../src/storage/db.js');
const { Router } = await import('../src/router.js');
const { embed } = await import('../src/storage/embeddings.js');

await embed('warmup').catch(() => {});

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM interactions WHERE conversation_id LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

function makeAdapter(): {
  adapter: PlatformAdapter;
  sent: OutgoingMessage[];
  threadCalls: { conversationId: string; messageId: string }[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const threadCalls: { conversationId: string; messageId: string }[] = [];
  let threadCounter = 0;
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
    async startAutoAnswerThread(conversationId, messageId) {
      threadCounter += 1;
      const threadId = `${RUN}-thread-${threadCounter}`;
      threadCalls.push({ conversationId, messageId });
      return threadId;
    },
  };
  return {
    adapter,
    sent,
    threadCalls,
    trigger: async (msg) => {
      if (!handler) throw new Error('adapter.onMessage was never registered — call router.register() first');
      await handler(msg);
    },
  };
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'discord',
    conversationId: AUTO_CHAN,
    userId: `${RUN}-member-repeat-1`,
    userName: 'Repeat Asker',
    text: `${RUN} what is the context window size?`,
    isDirect: false,
    addressedToBot: false,
    messageId: 'origin-msg-repeat-1',
    timestamp: Date.now(),
    ...overrides,
  };
}

test('SECURITY: the repeat-question shortcut still applies on the auto-answer path — the same caller resending the same text gets the cached reply, not a second turn (issue #477)', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls += 1;
    return { text: 'the context window is 200k tokens', ok: true };
  }, 20);
  const { adapter, sent, threadCalls, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ messageId: 'origin-msg-repeat-1a' }));
  assert.equal(calls, 1);
  assert.equal(sent.length, 1);
  assert.equal(threadCalls.length, 1);
  const firstThreadId = sent[0].conversationId;
  assert.notEqual(firstThreadId, AUTO_CHAN, 'the first answer is threaded, not sent bare into the channel');

  await trigger(makeMessage({ messageId: 'origin-msg-repeat-1b' }));
  assert.equal(calls, 1, 'the repeat must not spawn a second agent turn');
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /You asked this a moment ago/);
  assert.match(sent[1].text, /the context window is 200k tokens/);
  assert.equal(threadCalls.length, 2, 'the replayed answer is still threaded on its own origin post');
  assert.notEqual(
    sent[1].conversationId,
    firstThreadId,
    'the repeat reply lands in a fresh thread on the repeated post, not the first thread',
  );
  assert.notEqual(sent[1].conversationId, AUTO_CHAN);
});
