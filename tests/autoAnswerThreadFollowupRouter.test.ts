import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, Platform, PlatformAdapter } from '../src/platforms/types.js';

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

const { config } = await import('../src/config.js');
const { pool, closeDb } = await import('../src/storage/db.js');
const { Router } = await import('../src/router.js');
const { ADMIN_TOOLS, MEMBER_TOOLS, SUPER_ADMIN_TOOLS, toolsForRole } = await import('../src/auth/rbac.js');
type Tier = Parameters<typeof toolsForRole>[0];
const { embed } = await import('../src/storage/embeddings.js');
const { registerPendingAction, hasPendingAction, CONFIRM_TTL_MS } =
  await import('../src/agent/pendingActions.js');

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

// Issue #542: the TTL is creation-anchored no longer — a follow-up now slides
// the same ESCALATION_WINDOW_MS window forward from ITS OWN arrival time,
// rather than only ever counting down from thread creation.
test('auto-answer: a follow-up refreshes the thread TTL, sliding it past the original creation+10min cutoff (issue #542, AC1+AC2)', async (t) => {
  // This test sends 3 auto-answered messages to the same parent channel
  // within minutes — above the file's AUTO_ANSWER_RATE_LIMIT_PER_HOUR=2, which
  // would otherwise cap the 3rd message before the TTL-slide behaviour under
  // test is even reached. Bump it for this test only; unrelated to AC5's cap
  // coverage below, which deliberately tests AGAINST the file's default cap.
  const originalCap = config.discord.autoAnswerRateLimitPerHour;
  (config.discord as { autoAnswerRateLimitPerHour: number }).autoAnswerRateLimitPerHour = 10;
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  try {
    let calls = 0;
    const router = new Router(async () => {
      calls += 1;
      return makeReply('answer');
    }, 20);
    const { adapter, sent, threadCalls, trigger } = makeAdapter();
    router.register(adapter);

    const userId = `${RUN}-member-542-slide`;
    await trigger(makeMessage({ userId, messageId: 'origin-542-slide' }));
    assert.equal(threadCalls.length, 1);
    const threadId = threadCalls[0].threadId;
    assert.equal(calls, 1);

    // T0+8min: a follow-up well inside the original TTL — answered, and
    // (per this fix) refreshes the entry's `at` to T0+8min.
    t.mock.timers.tick(8 * 60_000);
    await trigger(
      makeMessage({
        userId,
        conversationId: threadId,
        messageId: 'followup-542-a',
        text: `${RUN} first follow-up`,
      }),
    );
    assert.equal(calls, 2, 'the first follow-up must be answered');

    // T0+15min: more than 10 minutes after thread CREATION (would have been
    // swept under the old creation-anchored TTL) but only 7 minutes after the
    // refreshed `at` — must still be answered, proving the window actually
    // slid forward rather than just resetting once.
    t.mock.timers.tick(7 * 60_000);
    await trigger(
      makeMessage({
        userId,
        conversationId: threadId,
        messageId: 'followup-542-b',
        text: `${RUN} second follow-up, past creation+10min`,
      }),
    );

    assert.equal(
      calls,
      3,
      'a follow-up past creation+10min but within 10min of the last refresh must still answer',
    );
    assert.equal(threadCalls.length, 1, 'still no second thread created');
    assert.equal(sent.length, 3);
    assert.equal(sent[2].conversationId, threadId, 'the slid-window reply must land in the SAME thread');
  } finally {
    t.mock.timers.reset();
    (config.discord as { autoAnswerRateLimitPerHour: number }).autoAnswerRateLimitPerHour = originalCap;
  }
});

test('SECURITY: parent is preserved unchanged across refreshes — a CONFIRM typed after follow-ups still resolves the original parent-scoped pending action (issue #542, AC4+AC7)', async () => {
  const userId = `${RUN}-member-542-parent`;
  let executed = false;
  const router = new Router(async (caller) => {
    // Only the origin-post turn registers the pending action, against the
    // PARENT channel — exactly as a real requireConfirm-gated tool would. Keyed
    // on `caller.conversationId === AUTO_CHAN` so the later in-thread follow-up
    // turn does NOT also register a (thread-keyed) action; this test is
    // specifically about the parent action surviving refreshes, which is the
    // origin-post fallback path preserved by the audit-M1 own-id-first fix.
    if (caller.conversationId === AUTO_CHAN && !executed) {
      registerPendingAction(caller.platform, caller.conversationId, caller.userId, {
        description: `${RUN} delete your data`,
        minTier: 'guest',
        execute: async () => {
          executed = true;
          return 'Deleted.';
        },
      });
    }
    return makeReply('Are you sure?');
  }, 20);
  const { adapter, threadCalls, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId, messageId: 'origin-542-parent' }));
  const threadId = threadCalls[0].threadId;
  assert.equal(
    hasPendingAction('discord', AUTO_CHAN, userId),
    true,
    'the pending action is registered against the parent channel',
  );

  // A follow-up refreshes the thread entry's `at` — `parent` must be
  // untouched by this.
  await trigger(
    makeMessage({
      userId,
      conversationId: threadId,
      messageId: 'followup-542-parent',
      text: `${RUN} one more thing`,
    }),
  );

  // CONFIRM typed inside the thread must still resolve against the
  // ORIGINAL parent channel, proving the refresh never redirected it.
  await trigger(
    makeMessage({ userId, conversationId: threadId, messageId: 'confirm-542-parent', text: 'CONFIRM' }),
  );

  assert.equal(
    executed,
    true,
    'CONFIRM must execute the pending action registered against the ORIGINAL parent',
  );
  assert.equal(
    hasPendingAction('discord', AUTO_CHAN, userId),
    false,
    'the pending action (still keyed on the original parent) is consumed once confirmed',
  );
});

test('SECURITY: a CONFIRM typed inside an auto-answer thread resolves a pending action registered UNDER THE THREAD by an in-thread follow-up — never silently dropped by translating to the parent (audit M1)', async () => {
  const userId = `${RUN}-member-m1-thread`;
  let executed = false;
  let registered = false;
  const router = new Router(async (caller) => {
    // Register the confirm-gated action ONLY on the in-thread follow-up turn,
    // where caller.conversationId is the THREAD id — exactly as a
    // requireConfirm-gated tool invoked from a #519 follow-up would key it. The
    // origin-post turn just answers. Before the audit-M1 fix the confirm
    // intercept unconditionally translated thread → parent before lookup, so
    // this thread-keyed action was unconfirmable anywhere (a guaranteed miss).
    if (caller.conversationId !== AUTO_CHAN && !registered) {
      registered = true;
      registerPendingAction(caller.platform, caller.conversationId, caller.userId, {
        description: `${RUN} delete your data`,
        minTier: 'guest',
        execute: async () => {
          executed = true;
          return 'Deleted.';
        },
      });
    }
    return makeReply('Are you sure?');
  }, 20);
  const { adapter, threadCalls, trigger } = makeAdapter();
  router.register(adapter);

  // Origin post opens the thread.
  await trigger(makeMessage({ userId, messageId: 'origin-m1' }));
  const threadId = threadCalls[0].threadId;

  // A follow-up typed INSIDE the thread registers the pending action under the thread id.
  await trigger(
    makeMessage({
      userId,
      conversationId: threadId,
      messageId: 'followup-m1',
      text: `${RUN} please delete my data`,
    }),
  );
  assert.equal(
    hasPendingAction('discord', threadId, userId),
    true,
    'the follow-up registered the pending action against the THREAD id',
  );
  assert.equal(
    hasPendingAction('discord', AUTO_CHAN, userId),
    false,
    'nothing is registered against the parent channel in this scenario',
  );

  // CONFIRM typed inside the thread must resolve the thread-keyed action.
  await trigger(makeMessage({ userId, conversationId: threadId, messageId: 'confirm-m1', text: 'CONFIRM' }));
  assert.equal(
    executed,
    true,
    'CONFIRM in-thread must execute the action registered under the thread id (audit M1 regression)',
  );
  assert.equal(
    hasPendingAction('discord', threadId, userId),
    false,
    'the thread-keyed pending action is consumed once confirmed',
  );
});

test("SECURITY: an escalation 'yes' typed inside an auto-answer thread resolves an offer registered UNDER THE THREAD — the escalation intercept prefers the thread id, not translating to the parent and losing it (audit M1, escalation path)", async () => {
  const wasFlag = config.behaviour.escalationToAdminEnabled;
  (config.behaviour as { escalationToAdminEnabled: boolean }).escalationToAdminEnabled = true;
  const notifyCalls: { message: string; excludeUserId: string }[] = [];
  const router = new Router(
    async () => makeReply('answer'),
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (
      _adapterFor: (p: Platform) => PlatformAdapter | undefined,
      message: string,
      excludeUserId: string,
    ) => {
      notifyCalls.push({ message, excludeUserId });
    },
    async (_platform: Platform, _conversationId: string, _userId: string, _query: string) => ({ id: 1 }),
  );
  const { adapter, threadCalls, trigger } = makeAdapter();
  router.register(adapter);
  const userId = `${RUN}-member-m1-escal`;
  try {
    // Origin auto-answer opens the thread (populates autoAnswerThreadParents).
    await trigger(makeMessage({ userId, messageId: 'origin-m1-escal' }));
    const threadId = threadCalls[0].threadId;

    // A #479 escalation offer made on an in-thread follow-up is keyed under the
    // THREAD id. Inject it directly — the offer-REGISTRATION path is unchanged
    // by M1 and covered elsewhere; this pins the intercept's key RESOLUTION.
    const internals = router as unknown as {
      pendingEscalations: Map<string, { query: string; at: number }>;
    };
    const threadKey = `discord:${threadId}:${userId}`;
    internals.pendingEscalations.set(threadKey, { query: 'how do I do X', at: Date.now() });

    // "yes" typed INSIDE the thread must resolve the thread-keyed offer. Before
    // the M1 fix the intercept translated thread → parent and looked up the
    // parent key — a guaranteed miss, so the offer was silently un-confirmable.
    await trigger(makeMessage({ userId, conversationId: threadId, messageId: 'yes-m1-escal', text: 'yes' }));

    assert.equal(
      notifyCalls.length,
      1,
      "the in-thread 'yes' resolved the thread-keyed escalation offer and notified admins",
    );
    assert.equal(
      internals.pendingEscalations.has(threadKey),
      false,
      'the thread-keyed escalation entry is consumed once confirmed (single-shot)',
    );
  } finally {
    (config.behaviour as { escalationToAdminEnabled: boolean }).escalationToAdminEnabled = wasFlag;
  }
});

test('SECURITY: a refreshed follow-up still consumes the shared per-channel cap keyed on the PARENT — once exhausted, further follow-ups are dropped even with a live, refreshed thread entry (issue #542, AC5)', async () => {
  // AUTO_ANSWER_RATE_LIMIT_PER_HOUR is '2' for this whole file (set at the
  // top); this Router instance's own autoAnswerHits map starts empty.
  let calls = 0;
  const router = new Router(async () => {
    calls += 1;
    return makeReply('answer');
  }, 20);
  const { adapter, sent, threadCalls, trigger } = makeAdapter();
  router.register(adapter);

  const userId = `${RUN}-member-542-cap`;

  // Slot 1/2: origin post opens the thread.
  await trigger(makeMessage({ userId, messageId: 'origin-542-cap' }));
  assert.equal(threadCalls.length, 1);
  const threadId = threadCalls[0].threadId;
  assert.equal(calls, 1);

  // Slot 2/2: a follow-up inside the thread — answered AND refreshes the
  // entry's `at`, exhausting the parent-keyed cap.
  await trigger(
    makeMessage({
      userId,
      conversationId: threadId,
      messageId: 'followup-542-cap-1',
      text: `${RUN} cap follow-up 1`,
    }),
  );
  assert.equal(calls, 2, 'the refreshing follow-up still consumed a cap slot and was answered');

  // A further follow-up, even though the (just-refreshed) thread entry is
  // still live, must be dropped — the cap, not the TTL, is now the limit.
  await trigger(
    makeMessage({
      userId,
      conversationId: threadId,
      messageId: 'followup-542-cap-2',
      text: `${RUN} cap follow-up 2`,
    }),
  );
  assert.equal(calls, 2, 'once the parent-keyed cap is exhausted, a live/refreshed entry must not bypass it');
  assert.equal(sent.length, 2, 'no reply for the capped follow-up');
});

test('SECURITY: a follow-up arriving after sweep has pruned the entry gets no reply and does not recreate/revive the map entry (issue #542, AC6)', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  try {
    let calls = 0;
    const router = new Router(async () => {
      calls += 1;
      return makeReply('answer');
    }, 20);
    const { adapter, sent, threadCalls, trigger } = makeAdapter();
    router.register(adapter);

    const userId = `${RUN}-member-542-revive`;
    await trigger(makeMessage({ userId, messageId: 'origin-542-revive' }));
    const threadId = threadCalls[0].threadId;
    assert.equal(calls, 1);

    // Past the TTL and past a sweep tick — the entry is actually pruned.
    t.mock.timers.tick(15 * 60_000);
    await trigger(
      makeMessage({
        userId,
        conversationId: threadId,
        messageId: 'followup-542-revive-late',
        text: `${RUN} still there?`,
      }),
    );
    assert.equal(calls, 1, 'the swept follow-up must not get an agent turn');
    assert.equal(sent.length, 1, 'no reply for the swept follow-up');

    // If the attempt above had (incorrectly) recreated/revived the map
    // entry, this immediately-following message would be treated as a live
    // in-thread follow-up and answered. It must not be.
    await trigger(
      makeMessage({
        userId,
        conversationId: threadId,
        messageId: 'followup-542-revive-later',
        text: `${RUN} anyone home?`,
      }),
    );
    assert.equal(
      calls,
      1,
      'a failed swept attempt must never have revived the map entry for a later message',
    );
    assert.equal(sent.length, 1, 'still no reply — the thread stays reverted to mention-required');
  } finally {
    t.mock.timers.reset();
  }
});

test('SECURITY: a stale/expired pending CONFIRM action is not made resolvable by a refreshed, still-live auto-answer thread entry (issue #542, AC8)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  try {
    const userId = `${RUN}-member-542-shared-map`;
    let executed = false;
    let registered = false;
    const router = new Router(async (caller) => {
      if (!registered) {
        registered = true;
        registerPendingAction(caller.platform, caller.conversationId, caller.userId, {
          description: `${RUN} delete your data`,
          minTier: 'guest',
          execute: async () => {
            executed = true;
            return 'Deleted.';
          },
        });
      }
      return makeReply('Are you sure?');
    }, 20);
    const { adapter, threadCalls, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ userId, messageId: 'origin-542-shared-map' }));
    const threadId = threadCalls[0].threadId;
    assert.equal(hasPendingAction('discord', AUTO_CHAN, userId), true);

    // A follow-up well past the pending CONFIRM action's own (much shorter)
    // TTL, but well within the auto-answer thread's 10-minute window —
    // refreshes the thread entry, keeping it live.
    t.mock.timers.tick(CONFIRM_TTL_MS + 5_000);
    await trigger(
      makeMessage({
        userId,
        conversationId: threadId,
        messageId: 'followup-542-shared-map',
        text: `${RUN} one more thing`,
      }),
    );
    assert.equal(
      hasPendingAction('discord', AUTO_CHAN, userId),
      false,
      'the pending CONFIRM action must have expired on its own independent TTL',
    );

    // A CONFIRM typed now, with the thread entry alive (refreshed) but the
    // pending action already expired, must NOT execute — the thread's own
    // refreshed liveness must never resurrect a stale pending action.
    await trigger(
      makeMessage({ userId, conversationId: threadId, messageId: 'confirm-542-shared-map', text: 'CONFIRM' }),
    );

    assert.equal(executed, false, 'a stale pending action must never execute via a refreshed thread entry');
  } finally {
    t.mock.timers.reset();
  }
});
