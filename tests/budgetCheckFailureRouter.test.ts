import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// router.test.ts. ACCESS_MODE_DISCORD is left unset elsewhere (default
// 'gated'); this file needs 'open' so a non-super-admin (unresolvable role,
// DATABASE_URL unreachable) still reaches the daily-budget check below
// instead of being intercepted by the gated-guest branch, matching
// pauseNotice.router.test.ts's rationale for the same setting.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.ACCESS_MODE_DISCORD = 'open';

const { pool, closeDb } = await import('../src/storage/db.js');
const { Router } = await import('../src/router.js');
const { DAILY_BUDGET_NOTICE_TEXT, DAILY_BUDGET_NOTICE_TEXT_MI, DAILY_BUDGET_NOTICE_TEXT_PLAIN } =
  await import('../src/dailyBudgetNotice.js');
const { embed } = await import('../src/storage/embeddings.js');
const { getPendingAlertsForTests, resetPendingAlertsForTests, queuePendingAlert, PENDING_ALERT_QUEUE_CAP } =
  await import('../src/pendingAlertQueue.js');

await embed('warmup').catch(() => {});

// Open mode means every trigger() below reaches recordInteraction and is
// persisted for real. The context builder (src/context/builder.ts) clusters
// inbound interactions by embedding similarity across the WHOLE table,
// unscoped by conversation or test file — an identical message text from
// >=3 distinct users forms a real cluster (this bit contextBuilder.test.ts
// once already, via this file's earlier plain "hello bot" fixture). A
// unique-per-run marker keeps this file's traffic from ever exact-matching
// another test file's fixed message text, and the cleanup below removes it
// afterward, matching pauseNotice.router.test.ts's approach.
const RUN = `budgetcheckfailure-router-${Date.now()}`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM interactions WHERE content LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): {
  adapter: PlatformAdapter;
  sent: OutgoingMessage[];
  dms: { id: string; text: string }[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const dms: { id: string; text: string }[] = [];
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
    async sendDirectMessage(id, text) {
      dms.push({ id, text });
    },
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
    dms,
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
    userId: 'member-1',
    userName: 'Test Member',
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

function failingCountReplies(): Promise<number> {
  return Promise.reject(new Error('countRepliesToUser boom'));
}

test('router (budget check failure): a countRepliesToUser rejection still lets the member reply through (fail-open unchanged, issue #52)', async () => {
  const router = new Router(
    async () => makeReply('reply despite budget-check failure'),
    20,
    async () => false, // not paused
    undefined,
    undefined,
    failingCountReplies,
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'reply despite budget-check failure');
});

test('router (budget check failure): exactly one super-admin DM fires on failure; a second failure inside the debounce window fires no more', async () => {
  const router = new Router(
    async () => makeReply('ok'),
    20,
    async () => false,
    undefined,
    undefined,
    failingCountReplies,
  );
  const { adapter, dms, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId: 'member-1' }));
  await trigger(makeMessage({ userId: 'member-2' })); // a distinct user hitting the same failure must NOT produce a second DM — debounce is process-wide, not per-user

  assert.equal(dms.length, 1, 'exactly one DM across both failures inside the debounce window');
  assert.equal(dms[0].id, 'super-1');
  assert.match(dms[0].text, /daily reply-budget check failed/i);
  assert.doesNotMatch(
    dms[0].text,
    new RegExp(`member-1|member-2|${RUN}`, 'i'),
    'no per-user identifiers or message content in the alert',
  );
});

test('router (budget check failure): no DM at all when countRepliesToUser succeeds (regression: only a real failure alerts)', async () => {
  const router = new Router(
    async () => makeReply('ok'),
    20,
    async () => false,
    undefined,
    undefined,
    async () => 0,
  );
  const { adapter, dms, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(dms.length, 0, 'a successful budget check must never alert');
});

// --- Shared pending-alert queue extension (issue #593) ---

test('router (budget check failure): with the only registered adapter disconnected, the alert is queued exactly once instead of dropped (issue #593)', async () => {
  resetPendingAlertsForTests();
  const router = new Router(
    async () => makeReply('reply despite budget-check failure'),
    20,
    async () => false,
    undefined,
    undefined,
    failingCountReplies,
  );
  const { adapter, dms, trigger } = makeAdapter({ isConnected: () => false });
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(dms.length, 0, 'no send is attempted through the disconnected adapter');
  assert.equal(
    getPendingAlertsForTests().length,
    1,
    'the budget-check-failure alert is queued exactly once, not dropped',
  );
  assert.match(getPendingAlertsForTests()[0] ?? '', /daily reply-budget check failed/i);
  resetPendingAlertsForTests();
});

test('SECURITY: the budget-check-failure alert queues the message byte-identical to its live-send text, at "system" priority, surviving a low-priority flood (issue #593)', async () => {
  resetPendingAlertsForTests();

  const liveRouter = new Router(
    async () => makeReply('ok'),
    20,
    async () => false,
    undefined,
    undefined,
    failingCountReplies,
  );
  const { adapter: liveAdapter, dms: liveDms, trigger: liveTrigger } = makeAdapter();
  liveRouter.register(liveAdapter);
  await liveTrigger(makeMessage());
  const liveText = liveDms[0]?.text;
  assert.ok(liveText, 'a live send happened to capture the exact text');
  resetPendingAlertsForTests();

  const downRouter = new Router(
    async () => makeReply('ok'),
    20,
    async () => false,
    undefined,
    undefined,
    failingCountReplies,
  );
  const { adapter: downAdapter, trigger: downTrigger } = makeAdapter({ isConnected: () => false });
  downRouter.register(downAdapter);
  await downTrigger(makeMessage());

  assert.deepEqual(getPendingAlertsForTests(), [liveText], 'queued text is byte-identical to the live text');

  // Simulate tools.ts's notifySuperAdmins (member-reachable, 'low' priority)
  // flooding the shared queue past its cap — this system-priority alert must
  // never be evicted (issue #545's fix).
  for (let i = 0; i < PENDING_ALERT_QUEUE_CAP * 2; i++) queuePendingAlert(`low-flood-${i}`, 'low');
  assert.ok(
    getPendingAlertsForTests().includes(liveText),
    'the system-priority budget-check-failure alert survives a low-priority flood',
  );
  resetPendingAlertsForTests();
});

test('router (budget check failure): does not cross-talk with the unrelated budget-exceeded notice', async () => {
  // A user already over the daily limit gets the member-facing budget notice
  // via a SUCCESSFUL countReplies call; a later, unrelated countReplies
  // FAILURE for a different user must still alert supers independently, and
  // the earlier over-limit notice must not have been suppressed or altered.
  let calls = 0;
  const router = new Router(
    async () => makeReply('should not be reached while over budget'),
    20,
    async () => false,
    undefined,
    undefined,
    async () => {
      calls += 1;
      if (calls === 1) return 999; // first user: over budget, real success
      return Promise.reject(new Error('boom')); // second user: real failure
    },
  );
  const { adapter, dms, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId: 'member-over-budget' }));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /reached today's usage limit/i);

  await trigger(makeMessage({ userId: 'member-2' }));
  assert.equal(dms.length, 1, 'the unrelated failure for a different user still produces its own alert');
});

// --- Standing 'mi' language preference on the daily-budget notice (issue #300) ---

test("router (budget exceeded): a caller with a standing 'mi' language preference gets DAILY_BUDGET_NOTICE_TEXT_MI, not the English default", async () => {
  const router = new Router(
    async () => makeReply('should not be reached while over budget'),
    20,
    async () => false,
    undefined,
    undefined,
    async () => 999, // over the daily limit
    async () => 'mi',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, DAILY_BUDGET_NOTICE_TEXT_MI);
});

test("router (budget exceeded): a caller with 'auto' (the default) still gets the English DAILY_BUDGET_NOTICE_TEXT", async () => {
  const router = new Router(
    async () => makeReply('should not be reached while over budget'),
    20,
    async () => false,
    undefined,
    undefined,
    async () => 999,
    async () => 'auto',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, DAILY_BUDGET_NOTICE_TEXT);
});

test('SECURITY: a getLanguagePreference failure on the daily-budget notice still sends the English default, never throws or drops the notice', async () => {
  const router = new Router(
    async () => makeReply('should not be reached while over budget'),
    20,
    async () => false,
    undefined,
    undefined,
    async () => 999,
    async () => {
      throw new Error('language_prefs read boom');
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await assert.doesNotReject(trigger(makeMessage()));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, DAILY_BUDGET_NOTICE_TEXT);
});

test('router (budget exceeded): the language-preference lookup runs at most once per debounce window, never once per shed message', async () => {
  let calls = 0;
  const router = new Router(
    async () => makeReply('should not be reached while over budget'),
    20,
    async () => false,
    undefined,
    undefined,
    async () => 999,
    async () => {
      calls += 1;
      return 'auto';
    },
  );
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());
  await trigger(makeMessage());
  await trigger(makeMessage());

  assert.equal(
    calls,
    1,
    'only the first (notifying) message in the window should read the language preference',
  );
});

// --- Standing 'plain' response-style preference on the daily-budget notice (issue #430) ---

test("router (budget exceeded): a caller with a standing 'plain' response style (and 'auto' language) gets DAILY_BUDGET_NOTICE_TEXT_PLAIN", async () => {
  const router = new Router(
    async () => makeReply('should not be reached while over budget'),
    20,
    async () => false,
    undefined,
    undefined,
    async () => 999, // over the daily limit
    async () => 'auto',
    undefined,
    undefined,
    async () => 'plain',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, DAILY_BUDGET_NOTICE_TEXT_PLAIN);
});

test("router (budget exceeded): a caller with 'standard' response style still gets the English DAILY_BUDGET_NOTICE_TEXT (byte-identical regression)", async () => {
  const router = new Router(
    async () => makeReply('should not be reached while over budget'),
    20,
    async () => false,
    undefined,
    undefined,
    async () => 999,
    async () => 'auto',
    undefined,
    undefined,
    async () => 'standard',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, DAILY_BUDGET_NOTICE_TEXT);
});

test("router (budget exceeded): 'mi' takes precedence over 'plain' when both are set", async () => {
  const router = new Router(
    async () => makeReply('should not be reached while over budget'),
    20,
    async () => false,
    undefined,
    undefined,
    async () => 999,
    async () => 'mi',
    undefined,
    undefined,
    async () => 'plain',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, DAILY_BUDGET_NOTICE_TEXT_MI);
  assert.notEqual(sent[0].text, DAILY_BUDGET_NOTICE_TEXT_PLAIN);
});

test('SECURITY: a getResponseStyle failure on the daily-budget notice still sends the English default, never throws or drops the notice', async () => {
  const router = new Router(
    async () => makeReply('should not be reached while over budget'),
    20,
    async () => false,
    undefined,
    undefined,
    async () => 999,
    async () => 'auto',
    undefined,
    undefined,
    async () => {
      throw new Error('response_style_prefs read boom');
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await assert.doesNotReject(trigger(makeMessage()));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, DAILY_BUDGET_NOTICE_TEXT);
});
