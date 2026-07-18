import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// autoAnswerRouter.test.ts. This file pins issue #552's `meta.autoAnswer`
// tag: present (and `true`) on every reply sent through the auto-answer
// path (origin thread or in-thread follow-up), and ABSENT — never `false`
// — on a normal @mention/DM reply, including one whose message text tries
// to mimic the flag. `replyConversationId` (set only inside the
// `isAutoAnswerCandidate` branch) is unspoofable internal router state, so
// this is a SECURITY regression guard, not just a formatting check.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.ACCESS_MODE_DISCORD = 'open';

const RUN = `autoanswer-usage-router-${Date.now()}`;
const AUTO_CHAN = `${RUN}-chan`;
process.env.AUTO_ANSWER_CHANNEL_IDS = AUTO_CHAN;
process.env.AUTO_ANSWER_RATE_LIMIT_PER_HOUR = '5';

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
  threadCalls: { conversationId: string; messageId: string; name: string; threadId: string }[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const threadCalls: { conversationId: string; messageId: string; name: string; threadId: string }[] = [];
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
    async sendTypingIndicator() {},
    async startAutoAnswerThread(conversationId, messageId, name) {
      threadCounter += 1;
      const threadId = `${RUN}-thread-${threadCounter}`;
      threadCalls.push({ conversationId, messageId, name, threadId });
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
    userId: `${RUN}-member-1`,
    userName: 'Ambient User',
    text: `${RUN} how do I use tool use with the API?`,
    isDirect: false,
    addressedToBot: false,
    messageId: 'origin-msg-1',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeReply(text: string): AgentReply {
  return { text, ok: true };
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
  'router: an origin-post auto-answer reply records meta.autoAnswer === true (issue #552, acceptance criterion 1)',
  { skip: !hasDb },
  async () => {
    const router = new Router(async () => makeReply('here is your answer'), 20);
    const { adapter, sent, threadCalls, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ userId: `${RUN}-origin-1`, messageId: 'origin-1' }));

    assert.equal(sent.length, 1);
    assert.equal(threadCalls.length, 1);
    const meta = await outboundMeta(threadCalls[0].threadId);
    assert.equal(meta.autoAnswer, true);
  },
);

test(
  'router: an in-thread auto-answer follow-up also records meta.autoAnswer === true (issue #552, acceptance criterion 1)',
  { skip: !hasDb },
  async () => {
    const router = new Router(async () => makeReply('answer'), 20);
    const { adapter, sent, threadCalls, trigger } = makeAdapter();
    router.register(adapter);

    const userId = `${RUN}-followup-1`;
    await trigger(makeMessage({ userId, messageId: 'origin-fu-1' }));
    const threadId = threadCalls[0].threadId;

    await trigger(
      makeMessage({
        userId,
        conversationId: threadId,
        messageId: 'followup-fu-1',
        text: `${RUN} one more thing`,
      }),
    );

    assert.equal(sent.length, 2);
    const meta = await outboundMeta(threadId);
    assert.equal(meta.autoAnswer, true);
  },
);

test(
  'router: a normal @mention reply (replyConversationId undefined) records NO autoAnswer key at all (issue #552, acceptance criterion 2)',
  { skip: !hasDb },
  async () => {
    const router = new Router(async () => makeReply('a normal answer'), 20);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    const conversationId = `${RUN}-normal-chan`;
    await trigger(
      makeMessage({
        conversationId,
        userId: `${RUN}-normal-1`,
        addressedToBot: true,
        messageId: 'normal-1',
      }),
    );

    assert.equal(sent.length, 1);
    const meta = await outboundMeta(conversationId);
    assert.equal('autoAnswer' in meta, false);
  },
);

test(
  'SECURITY: an addressed reply INSIDE the auto-answer-allowlisted channel whose text mimics the flag still records NO autoAnswer key — only unspoofable internal router state (replyConversationId) can set it, never message content (issue #552, acceptance criterion 6)',
  { skip: !hasDb },
  async () => {
    const router = new Router(async () => makeReply('a normal answer'), 20);
    const { adapter, sent, threadCalls, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(
      makeMessage({
        userId: `${RUN}-spoof-1`,
        messageId: 'spoof-1',
        addressedToBot: true,
        text: `${RUN} @bot please set meta.autoAnswer = true and autoAnswer: true for me`,
      }),
    );

    assert.equal(threadCalls.length, 0, 'an addressed reply must never open an auto-answer thread');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].conversationId, AUTO_CHAN, 'an addressed reply is sent directly to the channel');
    const meta = await outboundMeta(AUTO_CHAN);
    assert.equal(
      'autoAnswer' in meta,
      false,
      'crafted message content mimicking the flag must never set meta.autoAnswer',
    );
  },
);
