import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Regression cover for issue #519: the summon gate that decides whether an
// unaddressed post gets a reply only ever matched the CHANNEL a message was
// posted in (`autoAnswerChannelIds`). A follow-up typed INSIDE the thread
// #477's own auto-answer opened reports the THREAD's id as its
// conversationId — never a member of that channel allowlist — so the very
// next message in a live back-and-forth silently reverted to
// mention-required, defeating #477's own purpose one message in. The router
// now also matches when the conversation id is a live entry in
// `autoAnswerThreadParents` (the same thread -> parent map the CONFIRM/CANCEL
// and escalation intercepts already consult), replies in place rather than
// opening a second thread, and reserves the per-channel rate cap against the
// PARENT channel id so a busy thread can't become an uncapped side-channel
// around AUTO_ANSWER_RATE_LIMIT_PER_HOUR.
//
// Same env/per-run-id conventions as autoAnswerRouter.test.ts (open mode,
// per-run identities to avoid real-DB accumulation across local runs).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.ACCESS_MODE_DISCORD = 'open';

const RUN = `autoanswer-followup-router-${Date.now()}`;
const AUTO_CHAN = `${RUN}-chan`;
process.env.AUTO_ANSWER_CHANNEL_IDS = AUTO_CHAN;
process.env.AUTO_ANSWER_RATE_LIMIT_PER_HOUR = '2';

const { pool, closeDb } = await import('../src/storage/db.js');
const { Router } = await import('../src/router.js');
const { ADMIN_TOOLS, MEMBER_TOOLS, SUPER_ADMIN_TOOLS, toolsForRole } = await import('../src/auth/rbac.js');
type Tier = Parameters<typeof toolsForRole>[0];
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

test('auto-answer: an unaddressed follow-up inside a bot-opened auto-answer thread is answered in-thread, no second thread (issue #519, AC1)', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls += 1;
    return makeReply('here is your answer');
  }, 20);
  const { adapter, sent, threadCalls, trigger } = makeAdapter();
  router.register(adapter);

  const userId = `${RUN}-member-ac1`;
  await trigger(makeMessage({ userId, messageId: 'origin-ac1' }));
  assert.equal(threadCalls.length, 1);
  const threadId = threadCalls[0].threadId;

  await trigger(
    makeMessage({
      userId,
      conversationId: threadId,
      messageId: 'followup-ac1',
      text: `${RUN} what about the streaming variant?`,
    }),
  );

  assert.equal(calls, 2, 'the follow-up must also get an agent turn');
  assert.equal(threadCalls.length, 1, 'no second thread must be created for a follow-up already inside one');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].conversationId, threadId, 'the follow-up reply must land in the SAME thread');
});

test('auto-answer: a follow-up past the TTL (thread mapping swept) reverts to mention-required (issue #519, AC2)', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  try {
    let calls = 0;
    const router = new Router(async () => {
      calls += 1;
      return makeReply('answer');
    }, 20);
    const { adapter, sent, threadCalls, trigger } = makeAdapter();
    router.register(adapter);

    const userId = `${RUN}-member-ac2`;
    await trigger(makeMessage({ userId, messageId: 'origin-ac2' }));
    assert.equal(threadCalls.length, 1);
    const threadId = threadCalls[0].threadId;
    assert.equal(calls, 1);

    // Advance past ESCALATION_WINDOW_MS (10 min) and past a sweep tick
    // (RATE_WINDOW_MS * 5 = 5 min) so the thread -> parent mapping is
    // actually pruned, not merely stale.
    t.mock.timers.tick(15 * 60_000);

    await trigger(
      makeMessage({
        userId,
        conversationId: threadId,
        messageId: 'followup-ac2-late',
        text: `${RUN} still there?`,
      }),
    );

    assert.equal(calls, 1, 'a follow-up after the TTL has been swept must NOT get an agent turn');
    assert.equal(sent.length, 1, 'no reply is sent for the late follow-up — falls back to mention-required');
  } finally {
    t.mock.timers.reset();
  }
});

test('SECURITY: a thread follow-up reserves the per-channel cap against the PARENT channel, not the thread id (issue #519, AC3)', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls += 1;
    return makeReply('answer');
  }, 20);
  const { adapter, sent, threadCalls, trigger } = makeAdapter();
  router.register(adapter);

  // Exhaust the parent channel's cap (2) via two top-level posts from other members.
  await trigger(makeMessage({ userId: `${RUN}-member-a`, messageId: 'm-a', text: `${RUN} question a` }));
  await trigger(makeMessage({ userId: `${RUN}-member-b`, messageId: 'm-b', text: `${RUN} question b` }));
  assert.equal(calls, 2);
  assert.equal(threadCalls.length, 2);

  // A follow-up typed inside one of those threads must be dropped too — the
  // parent cap is exhausted, and the thread id must not be a bypass key.
  const threadId = threadCalls[0].threadId;
  await trigger(
    makeMessage({
      userId: `${RUN}-member-a`,
      conversationId: threadId,
      messageId: 'followup-ac3',
      text: `${RUN} one more thing`,
    }),
  );

  assert.equal(calls, 2, 'the in-thread follow-up must be dropped once the PARENT channel cap is exhausted');
  assert.equal(sent.length, 2, 'no reply sent for the capped follow-up');
});

test('SECURITY: a thread follow-up resolves the exact member/guest tool surface, and a bot-authored follow-up is never auto-answered (issue #519, AC4)', async () => {
  let seenRole: Tier | undefined;
  let calls = 0;
  const router = new Router(async (caller) => {
    calls += 1;
    seenRole = caller.role;
    return makeReply('answer');
  }, 20);
  const { adapter, sent, threadCalls, trigger } = makeAdapter();
  router.register(adapter);

  const userId = `${RUN}-member-ac4`;
  await trigger(makeMessage({ userId, messageId: 'origin-ac4' }));
  const threadId = threadCalls[0].threadId;
  assert.equal(calls, 1);

  await trigger(
    makeMessage({ userId, conversationId: threadId, messageId: 'followup-ac4', text: `${RUN} follow-up` }),
  );
  assert.equal(calls, 2, 'the follow-up turn must have been invoked');
  assert.ok(seenRole, 'runTurn must have been invoked for the follow-up');
  const tools = toolsForRole(seenRole);
  assert.deepEqual(tools, [...MEMBER_TOOLS]);
  for (const t of [...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
    assert.ok(!tools.includes(t), `thread follow-up must never grant privileged tool ${t}`);
  }

  // Loop prevention: a bot/webhook-authored post inside the SAME thread must
  // never trigger an auto-answer, exactly as for a top-level post.
  const callsBeforeBotPost = calls;
  await trigger(
    makeMessage({
      userId: `${RUN}-bot-ac4`,
      conversationId: threadId,
      messageId: 'followup-ac4-bot',
      isBotAuthor: true,
      text: `${RUN} bot echo`,
    }),
  );
  assert.equal(calls, callsBeforeBotPost, 'a bot-authored follow-up inside the thread must not spawn a turn');
  assert.equal(sent.length, 2, 'no additional reply for the bot-authored follow-up');
});
