import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// repeatQuestionShortcutRouter.test.ts. This file is the ONLY place
// AUTO_ANSWER_CHANNEL_IDS is set to a non-empty value — router.test.ts
// leaves it unset so the default-off (byte-identical) path stays covered
// there, and the Node test runner isolates env per test file.
//
// ACCESS_MODE_DISCORD is 'open' here (default is 'gated') so a non-super-admin
// userId — whose role can't be resolved without a real DB — reaches the
// auto-answer gate at 'guest' tier instead of being intercepted by the
// gated-guest branch. `toolsForRole('guest')` returns exactly the member tool
// set, matching this feature's "member tier (or guest tier in open mode)"
// acceptance criterion. Gated-mode exclusion of an unregistered guest is
// covered separately in autoAnswerGatedRouter.test.ts (default 'gated' mode).
//
// Unlike router.test.ts (which defaults every test to the 'super-1' super
// admin, sidestepping the daily reply budget and any real-DB accumulation
// entirely — see its own comment), these tests deliberately exercise a
// non-super-admin caller, so every identity/channel/thread id below is
// derived from a per-run marker (`RUN`, mirroring
// repeatQuestionShortcutRouter.test.ts's convention) — a fixed id would
// accumulate real `interactions` rows across repeated local runs against a
// real DATABASE_URL and eventually trip the real daily reply budget or the
// context builder's whole-table embedding clusters, exactly as a bare
// `member-1` did before this fix.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.ACCESS_MODE_DISCORD = 'open';

const RUN = `autoanswer-router-${Date.now()}`;
const AUTO_CHAN = `${RUN}-chan`;
process.env.AUTO_ANSWER_CHANNEL_IDS = AUTO_CHAN;
process.env.AUTO_ANSWER_RATE_LIMIT_PER_HOUR = '2';

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const { Router } = await import('../src/router.js');
const { ADMIN_TOOLS, MEMBER_TOOLS, SUPER_ADMIN_TOOLS, toolsForRole } = await import('../src/auth/rbac.js');
const { resolveRole } = await import('../src/auth/roles.js');
type Tier = Parameters<typeof toolsForRole>[0];
const { DAILY_BUDGET_NOTICE_TEXT } = await import('../src/dailyBudgetNotice.js');
const { embed } = await import('../src/storage/embeddings.js');

await embed('warmup').catch(() => {});

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM interactions WHERE conversation_id LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): {
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
    ...overrides,
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

test('config: AUTO_ANSWER_CHANNEL_IDS / AUTO_ANSWER_RATE_LIMIT_PER_HOUR are parsed into config.discord', () => {
  assert.deepEqual(config.discord.autoAnswerChannelIds, [AUTO_CHAN]);
  assert.equal(config.discord.autoAnswerRateLimitPerHour, 2);
});

test('auto-answer: a top-level non-addressed post in an allowlisted channel triggers exactly one turn and threads the reply on the origin post (issue #477)', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls += 1;
    return makeReply('here is your answer');
  }, 20);
  const { adapter, sent, threadCalls, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(calls, 1);
  assert.equal(threadCalls.length, 1, 'a thread must be created, anchored to the origin post');
  assert.equal(threadCalls[0].conversationId, AUTO_CHAN);
  assert.equal(threadCalls[0].messageId, 'origin-msg-1');
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].conversationId,
    threadCalls[0].threadId,
    'the reply must land in the new thread, not the bare channel',
  );
  assert.equal(sent[0].text, 'here is your answer');
});

test('auto-answer: a channel NOT on the allowlist still requires addressedToBot/isDirect (scoping is per-channel)', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls += 1;
    return makeReply('should never be sent');
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId: `${RUN}-some-other-channel` }));

  assert.equal(calls, 0);
  assert.equal(sent.length, 0);
});

test('auto-answer: falls back to a plain channel reply when thread creation fails, rather than dropping the answer', async () => {
  const router = new Router(async () => makeReply('answer despite thread failure'), 20);
  const { adapter, sent, trigger } = makeAdapter({
    startAutoAnswerThread: async () => {
      throw new Error('discord API boom');
    },
  });
  router.register(adapter);

  await trigger(makeMessage({ userId: `${RUN}-member-fallback-1` }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversationId, AUTO_CHAN, 'falls back to the parent channel, not silence');
  assert.equal(sent[0].text, 'answer despite thread failure');
});

test("SECURITY: an auto-answer turn resolves the caller's true tier and is granted exactly the member/guest tool surface — never elevated (issue #477)", async () => {
  let seenRole: Tier | undefined;
  const router = new Router(async (caller) => {
    seenRole = caller.role;
    return makeReply('answer');
  }, 20);
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  const userId = `${RUN}-member-tier-check-1`;
  await trigger(makeMessage({ userId }));

  assert.ok(seenRole, 'runTurn must have been invoked');
  // The exact-role comparison reads the DB via resolveRole; only assert it
  // when a real DB is reachable (matches this file's `hasDb` convention).
  // The security-relevant ceiling below (exactly MEMBER_TOOLS, never elevated)
  // is asserted unconditionally, since it must hold regardless of the resolved
  // tier — even the no-DB default degrades to the same member/guest floor.
  if (hasDb) {
    const expectedRole = await resolveRole('discord', userId);
    assert.equal(
      seenRole,
      expectedRole,
      'the auto-answer path must resolve role via the exact same mechanism as an addressed turn',
    );
  }
  const tools = toolsForRole(seenRole);
  assert.deepEqual(tools, [...MEMBER_TOOLS]);
  for (const t of [...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
    assert.ok(!tools.includes(t), `auto-answer must never grant privileged tool ${t}`);
  }
});

test('SECURITY: a bot/webhook-authored post in an allowlisted channel never triggers an auto-answer (loop prevention, issue #477)', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls += 1;
    return makeReply('should never be sent');
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId: `${RUN}-bot-1`, isBotAuthor: true }));

  assert.equal(calls, 0, 'a bot/webhook-authored ambient post must never spawn an agent turn');
  assert.equal(sent.length, 0);
});

test('per-channel rolling-hour cap bounds auto-answers; once exhausted, further posts in the window are skipped (issue #477, AUTO_ANSWER_RATE_LIMIT_PER_HOUR=2)', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls += 1;
    return makeReply('answer');
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId: `${RUN}-member-a`, messageId: 'm-a', text: `${RUN} question a` }));
  await trigger(makeMessage({ userId: `${RUN}-member-b`, messageId: 'm-b', text: `${RUN} question b` }));
  assert.equal(calls, 2);
  assert.equal(sent.length, 2);

  await trigger(makeMessage({ userId: `${RUN}-member-c`, messageId: 'm-c', text: `${RUN} question c` }));
  assert.equal(
    calls,
    2,
    'the 3rd auto-answer within the rolling hour must be skipped once the per-channel cap is hit',
  );
  assert.equal(sent.length, 2);
});

test('SECURITY: an auto-answer turn is still subject to the daily reply budget — no bypass (issue #477)', async () => {
  let calls = 0;
  const router = new Router(
    async () => {
      calls += 1;
      return makeReply('answer');
    },
    20,
    undefined,
    undefined,
    undefined,
    async () => 999, // always over budget
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId: `${RUN}-member-over-budget-1` }));

  assert.equal(calls, 0, 'an over-budget caller must not get an agent turn, even via auto-answer');
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].conversationId,
    AUTO_CHAN,
    'the budget notice goes to the channel — no thread was created for a shed turn',
  );
  assert.equal(sent[0].text, DAILY_BUDGET_NOTICE_TEXT);
});

test('SECURITY: an over-budget post never burns a per-channel auto-answer cap slot — a shed turn cannot starve other members (issue #477, AUTO_ANSWER_RATE_LIMIT_PER_HOUR=2)', async () => {
  let calls = 0;
  const spammer = `${RUN}-spammer`;
  // The per-channel cap (2) is reserved only AFTER the pause/rate-limit/daily-
  // budget checks — so an over-budget member hammering the channel must not
  // consume any of the shared allowance and lock everyone else out.
  const router = new Router(
    async () => {
      calls += 1;
      return makeReply('answer');
    },
    20,
    undefined,
    undefined,
    undefined,
    async (_platform, userId) => (userId === spammer ? 999 : 0),
  );
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  // Three over-budget posts — enough to exhaust a cap of 2 if the reservation
  // ran before the budget check. All are shed, none answered.
  for (let i = 0; i < 3; i++) {
    await trigger(makeMessage({ userId: spammer, messageId: `spam-${i}`, text: `${RUN} spam ${i}` }));
  }
  assert.equal(calls, 0, 'over-budget posts are never answered');

  // The full cap must still be available: two other members both get answered.
  await trigger(makeMessage({ userId: `${RUN}-legit-a`, messageId: 'la', text: `${RUN} legit a` }));
  await trigger(makeMessage({ userId: `${RUN}-legit-b`, messageId: 'lb', text: `${RUN} legit b` }));
  assert.equal(
    calls,
    2,
    'the shed over-budget posts must not have consumed the channel cap and starved legitimate members',
  );
});
