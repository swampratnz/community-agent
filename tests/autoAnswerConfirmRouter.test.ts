import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Regression cover for the CONFIRM-in-thread hazard the automated review on
// #482 named: an auto-answer reply is contained in a NEW Discord thread, but a
// destructive tool's pending action is registered against the PARENT channel
// (that's where the agent turn's caller.conversationId points). Discord reports
// a reply typed inside the thread with the thread's OWN id as its
// conversationId, so a member replying `CONFIRM`/`CANCEL` exactly where the
// bot's own pending notice appeared would never match the pending action —
// silently swallowing a member's own `forget_me` privacy deletion, for
// example. The router now translates a confirming reply arriving inside a known
// auto-answer thread back to the parent channel for the pending LOOKUP only
// (registration is unchanged). These tests pin that translation.
//
// Same env shape as autoAnswerRouter.test.ts: open mode so a non-super-admin
// caller reaches the auto-answer path at guest tier (which the router degrades
// to when the DB is unreachable), and every id is per-run to avoid real-DB
// accumulation.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.ACCESS_MODE_DISCORD = 'open';

const RUN = `autoanswer-confirm-router-${Date.now()}`;
const AUTO_CHAN = `${RUN}-chan`;
process.env.AUTO_ANSWER_CHANNEL_IDS = AUTO_CHAN;

const { pool, closeDb } = await import('../src/storage/db.js');
const { Router, CANCEL_TEXT } = await import('../src/router.js');
const { registerPendingAction, hasPendingAction } = await import('../src/agent/pendingActions.js');
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
  threadCalls: { threadId: string }[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const threadCalls: { threadId: string }[] = [];
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
    async startAutoAnswerThread() {
      threadCounter += 1;
      const threadId = `${RUN}-thread-${threadCounter}`;
      threadCalls.push({ threadId });
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
    text: `${RUN} please delete my data`,
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

test('SECURITY: a CONFIRM typed inside the auto-answer thread executes the pending action registered against the parent channel (issue #477)', async () => {
  let executed = false;
  const userId = `${RUN}-member-confirm-1`;
  // The agent turn registers a destructive pending action against the PARENT
  // channel (caller.conversationId), exactly as a real `forget_me` would.
  const router = new Router(async (caller) => {
    registerPendingAction(caller.platform, caller.conversationId, caller.userId, {
      description: `${RUN} delete your data`,
      minTier: 'guest',
      execute: async () => {
        executed = true;
        return 'Deleted.';
      },
    });
    return makeReply('Are you sure?');
  }, 20);
  const { adapter, threadCalls, trigger } = makeAdapter();
  router.register(adapter);

  // 1) The auto-answer turn: creates the thread and registers the pending
  //    action against the parent channel.
  await trigger(makeMessage({ userId }));
  assert.equal(threadCalls.length, 1, 'the auto-answer turn must have opened a thread');
  const threadId = threadCalls[0].threadId;
  assert.equal(
    hasPendingAction('discord', AUTO_CHAN, userId),
    true,
    'the pending action is registered against the parent channel, not the thread',
  );

  // 2) The member replies CONFIRM INSIDE the thread — Discord reports the
  //    thread id as the conversationId. This must still resolve.
  await trigger(makeMessage({ userId, conversationId: threadId, text: 'CONFIRM' }));

  assert.equal(executed, true, 'CONFIRM typed inside the thread must execute the parent-scoped action');
  assert.equal(
    hasPendingAction('discord', AUTO_CHAN, userId),
    false,
    'the pending action is consumed once confirmed',
  );
});

test('SECURITY: a CANCEL typed inside the auto-answer thread aborts the parent-scoped pending action without executing it (issue #477)', async () => {
  let executed = false;
  const userId = `${RUN}-member-cancel-1`;
  const router = new Router(async (caller) => {
    registerPendingAction(caller.platform, caller.conversationId, caller.userId, {
      description: `${RUN} delete your data`,
      minTier: 'guest',
      execute: async () => {
        executed = true;
        return 'Deleted.';
      },
    });
    return makeReply('Are you sure?');
  }, 20);
  const { adapter, sent, threadCalls, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId }));
  const threadId = threadCalls[0].threadId;

  await trigger(makeMessage({ userId, conversationId: threadId, text: 'CANCEL' }));

  assert.equal(executed, false, 'CANCEL must never execute the pending action');
  assert.equal(
    hasPendingAction('discord', AUTO_CHAN, userId),
    false,
    'CANCEL typed inside the thread must still remove the parent-scoped pending action',
  );
  assert.equal(
    sent.some((m) => m.text === CANCEL_TEXT),
    true,
    'the member gets the cancellation acknowledgement',
  );
});
