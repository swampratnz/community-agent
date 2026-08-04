import { test, after } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';
import type { AgentReply } from '@swampratnz/agent-base/agent/core.js';
import type {
  IncomingMessage,
  OutgoingMessage,
  PlatformAdapter,
} from '@swampratnz/agent-base/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// budgetCheckFailureRouter.test.ts. This file is the ONLY place
// DAILY_REPLY_BUDGET_WARN_ENABLED is set to 'true' (issue #511) —
// router.test.ts and dailyReplyBudgetWarningDisabledRouter.test.ts leave it
// unset so the default-off, byte-identical path stays covered separately
// (Node's test runner isolates env per file process). ACCESS_MODE_DISCORD is
// 'open' so a non-super-admin caller — unresolvable in `community_users` with
// the DB unreachable — still reaches the daily-budget check below instead of
// being intercepted by the gated-guest branch, matching
// budgetCheckFailureRouter.test.ts's rationale. REPEAT_QUESTION_SHORTCUT_ENABLED
// is also on here so this file can assert the appended warning never leaks
// into the cached replay text (acceptance criterion 4 — the cache must still
// see `reply.text`, not `outboundText`).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.ACCESS_MODE_DISCORD = 'open';
process.env.DAILY_REPLY_BUDGET_WARN_ENABLED = 'true';
process.env.DAILY_REPLY_BUDGET_WARN_REMAINING = '5';
process.env.REPEAT_QUESTION_SHORTCUT_ENABLED = 'true';

const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');
const { Router } = await import('@swampratnz/agent-base/router.js');
const { makeRouterDeps } = await import('../src/module/routerWiring.js');
const { embed } = await import('@swampratnz/agent-base/storage/embeddings.js');

// Notice constants agent-base deleted in the package flip (they named this
// community's axis values in framework code, and rendered at import time). Same
// catalogue entries, same values — see tests/support/legacyNotices.ts.
const {
  DAILY_BUDGET_NOTICE_TEXT,
  DAILY_REPLY_BUDGET_WARNING_TEXT,
  DAILY_REPLY_BUDGET_WARNING_TEXT_MI,
  DAILY_REPLY_BUDGET_WARNING_TEXT_PLAIN,
} = await import('./support/legacyNotices.js');

await embed('warmup').catch(() => {});

// DAILY_REPLY_LIMIT_PER_USER defaults to 50 (unset here, matching every other
// budget-adjacent test file's convention of exercising the real default
// rather than overriding it).
const LIMIT = 50;

const RUN = `daily-budget-warn-router-${Date.now()}`;

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
    userId: 'member-1',
    userName: 'Test Member',
    text: `${RUN} hello bot`,
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeReply(text: string, overrides: Partial<AgentReply> = {}): AgentReply {
  return { text, ok: true, ...overrides };
}

function countRepliesReturning(used: number): () => Promise<number> {
  return async () => used;
}

test('router (daily budget warning): appended inside the window, stating the correct remaining count', async () => {
  const router = new Router(
    makeRouterDeps({
      runTurn: async () => makeReply(`${RUN} the real answer`),
      typingRefireMs: 20,
      checkPaused: async () => false,
      countReplies: countRepliesReturning(46),
    }), // remaining after this reply = 50 - (46 + 1) = 3
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, `${RUN} the real answer${DAILY_REPLY_BUDGET_WARNING_TEXT(3)}`);
});

test('router (daily budget warning): the boundary remaining=DAILY_REPLY_BUDGET_WARN_REMAINING (5) still warns (inclusive upper bound)', async () => {
  const router = new Router(
    makeRouterDeps({
      runTurn: async () => makeReply(`${RUN} boundary answer`),
      typingRefireMs: 20,
      checkPaused: async () => false,
      countReplies: countRepliesReturning(44),
    }), // remaining = 50 - (44 + 1) = 5
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent[0].text, `${RUN} boundary answer${DAILY_REPLY_BUDGET_WARNING_TEXT(5)}`);
});

test('router (daily budget warning): the boundary remaining=0 (last reply before the hard cutoff) still warns (inclusive lower bound)', async () => {
  const router = new Router(
    makeRouterDeps({
      runTurn: async () => makeReply(`${RUN} last reply before cutoff`),
      typingRefireMs: 20,
      checkPaused: async () => false,
      countReplies: countRepliesReturning(49),
    }), // remaining = 50 - (49 + 1) = 0 — the most urgent warning case
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].text,
    `${RUN} last reply before cutoff${DAILY_REPLY_BUDGET_WARNING_TEXT(0)}`,
    'the very last reply before the hard cutoff must still carry the warning',
  );
});

test('router (daily budget warning): no warning outside the window (remaining > 5)', async () => {
  const router = new Router(
    makeRouterDeps({
      runTurn: async () => makeReply(`${RUN} plenty left`),
      typingRefireMs: 20,
      checkPaused: async () => false,
      countReplies: countRepliesReturning(40),
    }), // remaining = 50 - (40 + 1) = 9
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, `${RUN} plenty left`, 'no warning line for a caller well under the threshold');
});

test('router (daily budget warning): the existing used >= limit hard-stop path is completely unchanged', async () => {
  const router = new Router(
    makeRouterDeps({
      runTurn: async () => makeReply('should not be reached — over budget'),
      typingRefireMs: 20,
      checkPaused: async () => false,
      countReplies: countRepliesReturning(LIMIT),
    }), // at the limit — no agent turn at all
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].text,
    DAILY_BUDGET_NOTICE_TEXT,
    'the hard cutoff notice must be byte-identical to today',
  );
});

test('router (daily budget warning): debounced once per rolling 24h — a second in-window message from the same caller gets no repeated warning', async () => {
  const router = new Router(
    makeRouterDeps({
      runTurn: async (caller) => makeReply(`${RUN} answer for ${caller.userId}`),
      typingRefireMs: 20,
      checkPaused: async () => false,
      countReplies: countRepliesReturning(46),
    }), // remaining = 3, in-window every call
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: `${RUN} first message` }));
  await trigger(makeMessage({ text: `${RUN} second message` }));

  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /\(You have 3 replies left today\.\)$/, 'first in-window message is warned');
  assert.equal(
    sent[1].text,
    `${RUN} answer for member-1`,
    'second in-window message inside the same 24h window gets no repeated warning',
  );
});

test('router (daily budget warning): a distinct caller is warned independently of another caller already debounced', async () => {
  const router = new Router(
    makeRouterDeps({
      runTurn: async (caller) => makeReply(`${RUN} answer for ${caller.userId}`),
      typingRefireMs: 20,
      checkPaused: async () => false,
      countReplies: countRepliesReturning(46),
    }),
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId: 'member-a', text: `${RUN} from a` }));
  await trigger(makeMessage({ userId: 'member-b', text: `${RUN} from b` }));

  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /\(You have 3 replies left today\.\)$/);
  assert.match(
    sent[1].text,
    /\(You have 3 replies left today\.\)$/,
    'a distinct caller keys its own debounce entry',
  );
});

test('SECURITY: a super-admin caller never receives the warning even deep inside the window', async () => {
  const router = new Router(
    makeRouterDeps({
      runTurn: async () => makeReply(`${RUN} super admin reply`),
      typingRefireMs: 20,
      checkPaused: async () => false,
      countReplies: countRepliesReturning(49),
    }), // would be remaining=0 for a non-super-admin, but the daily-budget block is never entered for super_admin
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ userId: 'super-1' }));

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].text,
    `${RUN} super admin reply`,
    'super admins are exempt from the daily budget entirely',
  );
});

test('router (daily budget warning): the underlying reply.text cache used by the repeat-question shortcut is unaffected (mirrors offerEscalation)', async () => {
  const router = new Router(
    makeRouterDeps({
      runTurn: async () => makeReply(`${RUN} cached answer`),
      typingRefireMs: 20,
      checkPaused: async () => false,
      countReplies: countRepliesReturning(46),
    }), // in-window on the first turn
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  const text = `${RUN} repeat me please`;
  await trigger(makeMessage({ text }));
  assert.match(sent[0].text, /\(You have 3 replies left today\.\)$/, 'first reply carries the warning');

  // Immediate identical resend hits the repeat-question shortcut, which
  // replays the CACHED reply.text — if the cache had accidentally stored the
  // warned outboundText, this second send would carry a doubled warning.
  await trigger(makeMessage({ text }));
  assert.equal(sent.length, 2);
  assert.doesNotMatch(
    sent[1].text,
    /replies left today/,
    'the repeat-shortcut replay must not carry the warning suffix — the cache stores reply.text, not outboundText',
  );
});

// --- Language/style parity (issue #300/#430 precedent) ---

test("router (daily budget warning): a caller with a standing 'mi' language preference gets the _MI variant", async () => {
  const router = new Router(
    makeRouterDeps({
      runTurn: async () => makeReply(`${RUN} kia ora`, { languagePreference: 'mi' }),
      typingRefireMs: 20,
      checkPaused: async () => false,
      countReplies: countRepliesReturning(46),
    }),
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent[0].text, `${RUN} kia ora${DAILY_REPLY_BUDGET_WARNING_TEXT_MI(3)}`);
});

test("router (daily budget warning): a non-mi caller with a standing 'plain' response style gets the _PLAIN variant", async () => {
  const router = new Router(
    makeRouterDeps({
      runTurn: async () => makeReply(`${RUN} plain reply`, { languagePreference: 'auto' }),
      typingRefireMs: 20,
      checkPaused: async () => false,
      countReplies: countRepliesReturning(46),
      getRespStyle: async () => 'plain',
    }),
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent[0].text, `${RUN} plain reply${DAILY_REPLY_BUDGET_WARNING_TEXT_PLAIN(3)}`);
});

test("router (daily budget warning): 'standard' response style (and no mi preference) still gets the English default variant", async () => {
  const router = new Router(
    makeRouterDeps({
      runTurn: async () => makeReply(`${RUN} standard reply`, { languagePreference: 'auto' }),
      typingRefireMs: 20,
      checkPaused: async () => false,
      countReplies: countRepliesReturning(46),
      getRespStyle: async () => 'standard',
    }),
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent[0].text, `${RUN} standard reply${DAILY_REPLY_BUDGET_WARNING_TEXT(3)}`);
});
