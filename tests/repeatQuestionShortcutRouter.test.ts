import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// knowledgeShortcutRouter.test.ts. This file is the ONLY place
// REPEAT_QUESTION_SHORTCUT_ENABLED is set to 'true' — router.test.ts leaves
// it unset so the default-off path stays covered untouched, and the node
// test runner isolates env per test file.
//
// Capture whether a REAL Postgres was provided BEFORE applying the dummy
// default below — the default only exists to satisfy config.ts's import-time
// validation, it is not a reachable DB (see pauseNotice.router.test.ts for
// the same pattern and rationale).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
// Two Discord super admins + one shared cross-platform super admin, so the
// per-caller isolation tests below can exercise a "different userId" and a
// "different platform" caller without ever touching the (unreachable in
// these tests) community_users DB lookup non-super-admins would fall through
// to (which resolves to 'guest' and hits the gated-guest branch instead).
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1,super-2';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS ??= 'super-1';
process.env.REPEAT_QUESTION_SHORTCUT_ENABLED = 'true';

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const { Router } = await import('../src/router.js');
const { embed } = await import('../src/storage/embeddings.js');
const { registerPendingAction, cancelPendingAction } = await import('../src/agent/pendingActions.js');
const { countRepliesToUser } = await import('../src/storage/repository.js');

await embed('warmup').catch(() => {});

// Fixed internal constant per issue #259 (not exported — mirrors how
// ACK_REPLY_TEXT/KNOWLEDGE_SHORTCUT_SUFFIX are asserted against as literals
// in the sibling shortcut test files rather than imported).
const REPEAT_SHORTCUT_WINDOW_MS = 120_000;
const REPEAT_SHORTCUT_NOTICE = "↩️ You asked this a moment ago — here's my answer again:\n\n";

// Unique-per-run marker so this file's DB writes never collide with another
// test file's traffic (same rationale as pauseNotice.router.test.ts) and can
// be cleaned up afterward.
const RUN = `repeatq-router-${Date.now()}`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM interactions WHERE content LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): {
  adapter: PlatformAdapter;
  sent: OutgoingMessage[];
  typingCalls: IncomingMessage[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const typingCalls: IncomingMessage[] = [];
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
    async sendTypingIndicator(msg) {
      typingCalls.push(msg);
    },
    ...overrides,
  };
  return {
    adapter,
    sent,
    typingCalls,
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
    text: `${RUN} hello bot`,
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('config: REPEAT_QUESTION_SHORTCUT_ENABLED=true is reflected in config.behaviour.repeatQuestionShortcutEnabled', () => {
  assert.equal(config.behaviour.repeatQuestionShortcutEnabled, true);
});

test('router (repeat-question shortcut): the same caller resending the same whitespace-normalized text within the window results in exactly one runTurn call, and the second reply is the cached answer prefixed with the repeat notice', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls++;
    return { text: `${RUN} the meetup is at 6pm`, ok: true };
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-happy`;

  await trigger(makeMessage({ text: `${RUN}  what   time is the meetup?  `, conversationId }));
  // Different whitespace, same normalized text — whitespace-only
  // normalization (trim + collapse), no case-folding, no fuzzy matching.
  await trigger(makeMessage({ text: `${RUN} what time is the meetup? `, conversationId }));

  assert.equal(calls, 1, 'the second (whitespace-normalized) resend must not spawn a second turn');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, `${RUN} the meetup is at 6pm`);
  assert.equal(
    sent[1].text,
    `${REPEAT_SHORTCUT_NOTICE}${RUN} the meetup is at 6pm`,
    'the repeat reply must equal the cached replyText prefixed with the fixed repeat-notice string',
  );
});

test('router (repeat-question shortcut): a hit records a shortcut_hits row of kind "repeat_question" (issue #440)', async () => {
  const calls: string[] = [];
  const router = new Router(
    async () => ({ text: `${RUN} the meetup is at 6pm`, ok: true }),
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (kind) => {
      calls.push(kind);
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-shortcut-hit`;

  await trigger(makeMessage({ text: `${RUN} what time is the meetup?`, conversationId }));
  await trigger(makeMessage({ text: `${RUN} what time is the meetup?`, conversationId }));

  assert.equal(sent.length, 2);
  assert.deepEqual(
    calls,
    ['repeat_question'],
    'only the second (shortcut) hit records a row, not the first real turn',
  );
});

test('router (repeat-question shortcut): the same normalized text from a different userId in the same conversation is NOT short-circuited', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls++;
    return { text: `${RUN} answer #${calls}`, ok: true };
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-per-user`;
  const text = `${RUN} what is the wifi password`;

  await trigger(makeMessage({ text, conversationId, userId: 'super-1' }));
  await trigger(makeMessage({ text, conversationId, userId: 'super-2' }));

  assert.equal(
    calls,
    2,
    'a different userId must run a fresh turn — proves the key includes userId, not just conversationId',
  );
  assert.equal(
    sent[1].text,
    `${RUN} answer #2`,
    "must get a fresh answer, never the first caller's cached reply",
  );
});

test("SECURITY: router (repeat-question shortcut): the cache never replays one caller's reply to a different userId, conversationId, or platform — isolation is structural (part of the key), never a text-only match (guards the #106 scope-leak class for a reply cache)", async () => {
  let calls = 0;
  const router = new Router(async (caller) => {
    calls++;
    return {
      text: `${RUN} answer #${calls} for ${caller.platform}:${caller.conversationId}:${caller.userId}`,
      ok: true,
    };
  }, 20);
  const {
    adapter: discordAdapter,
    sent: discordSent,
    trigger: discordTrigger,
  } = makeAdapter({
    platform: 'discord',
  });
  const {
    adapter: whatsappAdapter,
    sent: whatsappSent,
    trigger: whatsappTrigger,
  } = makeAdapter({
    platform: 'whatsapp',
  });
  router.register(discordAdapter);
  router.register(whatsappAdapter);

  const convoA = `${RUN}-iso-a`;
  const convoB = `${RUN}-iso-b`;
  const text = `${RUN} same question everywhere`;

  await discordTrigger(makeMessage({ text, conversationId: convoA, userId: 'super-1', platform: 'discord' }));
  assert.equal(calls, 1);

  // Different userId, same conversation + platform.
  await discordTrigger(makeMessage({ text, conversationId: convoA, userId: 'super-2', platform: 'discord' }));
  assert.equal(calls, 2, "a different userId must never be served another caller's cached reply");
  assert.doesNotMatch(discordSent[1].text, /^↩️/, 'must be a fresh turn, not a replayed cache hit');

  // Same userId, different conversation, same platform.
  await discordTrigger(makeMessage({ text, conversationId: convoB, userId: 'super-1', platform: 'discord' }));
  assert.equal(
    calls,
    3,
    "a different conversationId must never be short-circuited by another conversation's cache",
  );
  assert.doesNotMatch(discordSent[2].text, /^↩️/);

  // Same userId, identical conversationId STRING, different platform.
  await whatsappTrigger(
    makeMessage({ text, conversationId: convoA, userId: 'super-1', platform: 'whatsapp' }),
  );
  assert.equal(
    calls,
    4,
    "a different platform must never be short-circuited by another platform's cache, even with an identical conversationId string",
  );
  assert.doesNotMatch(whatsappSent[0].text, /^↩️/);

  // Sanity: the ORIGINAL caller repeating their own question still gets the cache hit.
  await discordTrigger(makeMessage({ text, conversationId: convoA, userId: 'super-1', platform: 'discord' }));
  assert.equal(calls, 4, 'the original caller must still be short-circuited by their own cache entry');
  assert.match(discordSent[3].text, /^↩️/);
});

test('router (repeat-question shortcut): a reply with ok !== true is never cached — a resend after a failed/fallback reply always runs a fresh turn', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls++;
    return { text: `${RUN} sorry, internal error`, ok: false };
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-notok`;
  const text = `${RUN} will this fail`;

  await trigger(makeMessage({ text, conversationId }));
  await trigger(makeMessage({ text, conversationId }));

  assert.equal(calls, 2, 'a reply with ok !== true must never be stored, so the resend gets a fresh turn');
  assert.equal(
    sent[1].text,
    `${RUN} sorry, internal error`,
    'no repeat-notice prefix — this was a fresh turn, not a cache hit',
  );
});

test('router (repeat-question shortcut): a resend after REPEAT_SHORTCUT_WINDOW_MS has elapsed (advanced via an injectable clock, never a real sleep) runs a fresh turn, and the stale entry is pruned by sweep()', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let calls = 0;
  const router = new Router(async () => {
    calls++;
    return { text: `${RUN} timely answer`, ok: true };
  }, 20);
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-expiry`;
  const text = `${RUN} what is the wifi password`;

  await trigger(makeMessage({ text, conversationId }));
  assert.equal(calls, 1);

  // Still inside the window: short-circuited, no second call.
  t.mock.timers.tick(REPEAT_SHORTCUT_WINDOW_MS - 1000);
  await trigger(makeMessage({ text, conversationId }));
  assert.equal(calls, 1, 'still within the window — must be short-circuited');

  // Cross the window boundary (measured from the ORIGINAL store time).
  t.mock.timers.tick(2000);
  await trigger(makeMessage({ text, conversationId }));
  assert.equal(calls, 2, 'window expired — a fresh turn must run');

  const internals = router as unknown as { lastReply: Map<string, { at: number }>; sweep(): void };
  const key = `discord:${conversationId}:super-1`;
  assert.ok(internals.lastReply.has(key), 'the fresh (2nd) turn must have re-populated the cache');

  t.mock.timers.tick(REPEAT_SHORTCUT_WINDOW_MS + 1000);
  internals.sweep();
  assert.equal(
    internals.lastReply.has(key),
    false,
    'sweep() must prune an entry once REPEAT_SHORTCUT_WINDOW_MS has elapsed',
  );
});

test('SECURITY: router (repeat-question shortcut): a turn that registers a NEW pending CONFIRM action is never cached — a repeat of that message always runs a fresh turn, never replaying stale "reply CONFIRM" text with no live pending action behind it', async () => {
  let calls = 0;
  const conversationId = `${RUN}-confirm`;
  const router = new Router(async (caller) => {
    calls++;
    registerPendingAction(caller.platform, caller.conversationId, caller.userId, {
      description: 'GRANT ADMIN to attacker-123',
      minTier: 'super_admin',
      execute: async () => 'granted',
    });
    return { text: `${RUN} All set — reply CONFIRM to apply.`, ok: true };
  }, 20);
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);
  const text = `${RUN} please refresh your cache`;

  try {
    await trigger(makeMessage({ text, conversationId }));
    await trigger(makeMessage({ text, conversationId }));

    assert.equal(
      calls,
      2,
      'a turn that registers a new pending CONFIRM action must never be cached — the repeat must run a fresh turn',
    );
  } finally {
    cancelPendingAction('discord', conversationId, 'super-1');
  }
});

test(
  'router (repeat-question shortcut): a served repeat-shortcut reply is recorded exactly like a real answer — meta.repeatShortcut + replyToUserId — and counts toward the daily reply budget',
  { skip: !hasDb },
  async () => {
    const conversationId = `${RUN}-recorded`;
    const userId = 'super-1';
    const text = `${RUN} recorded question`;
    const answer = `${RUN} genuine recorded answer`;

    const before = await countRepliesToUser('discord', userId);

    const router = new Router(async () => ({ text: answer, ok: true }), 20);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ text, conversationId, userId }));
    await trigger(makeMessage({ text: ` ${text} `, conversationId, userId }));

    assert.equal(sent.length, 2);

    const after = await countRepliesToUser('discord', userId);
    assert.equal(
      after - before,
      2,
      'both the real answer and the repeat-shortcut reply must be recorded and counted toward the daily budget',
    );

    const { rows } = await pool.query(
      `SELECT meta FROM interactions WHERE direction = 'outbound' AND content LIKE $1`,
      [`%${answer}%`],
    );
    const repeatRow = rows.find(
      (r: { meta: { repeatShortcut?: boolean } }) => r.meta?.repeatShortcut === true,
    );
    assert.ok(repeatRow, 'the repeat-shortcut reply must be recorded with meta.repeatShortcut: true');
    assert.equal(repeatRow.meta.replyToUserId, userId);
  },
);

test('ordering: a repeat-question shortcut reply is enqueued behind an in-flight turn in the same conversation, never overtaking it', async () => {
  const conversationId = `${RUN}-ordering`;
  const cachedText = `${RUN} slow question`;
  let resolveSecond!: (r: AgentReply) => void;
  const secondTurn = new Promise<AgentReply>((resolve) => {
    resolveSecond = resolve;
  });
  // Resolved the instant the SECOND turn's handler is entered — a deterministic
  // "this turn now holds the conversation's enqueue chain" signal (its `enqueue`
  // registered before the task ran), so the repeat fired next is guaranteed to
  // queue BEHIND it. Previously the test gated on a typing-indicator proxy plus
  // a fixed `sleep`, which raced on loaded CI runners and flaked the ordering
  // assertion (the #304/#314 build failures).
  let secondEntered!: () => void;
  const secondEnteredP = new Promise<void>((resolve) => {
    secondEntered = resolve;
  });
  let calls = 0;
  const router = new Router(async () => {
    calls++;
    if (calls === 1) return { text: `${RUN} first answer`, ok: true };
    secondEntered();
    return secondTurn;
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  // Prime the cache with a first successful turn.
  await trigger(makeMessage({ text: cachedText, conversationId }));
  assert.equal(sent.length, 1);

  // Fire a second, DIFFERENT question that hangs (in flight)...
  const secondDone = trigger(makeMessage({ text: `${RUN} different slow question`, conversationId }));
  // Deterministically wait until that turn is executing and holds the enqueue
  // chain before firing the repeat — no wall-clock guess.
  await secondEnteredP;

  // ...then, without waiting, resend the FIRST (now-cached) text.
  const repeatDone = trigger(makeMessage({ text: cachedText, conversationId }));

  await sleep(30);
  assert.equal(sent.length, 1, 'the repeat reply must not land while the earlier real turn is still pending');

  resolveSecond({ text: `${RUN} second answer`, ok: true });
  await Promise.all([secondDone, repeatDone]);

  assert.equal(sent.length, 3);
  assert.equal(
    sent[1].text,
    `${RUN} second answer`,
    'the in-flight turn must be delivered before the queued repeat reply',
  );
  assert.equal(
    sent[2].text,
    `${REPEAT_SHORTCUT_NOTICE}${RUN} first answer`,
    'the repeat reply must be delivered after, not before',
  );
});

// The flag-disabled path ("Default off: unset/false → zero behaviour change,
// the cache is never read or written") is covered in router.test.ts, which
// leaves REPEAT_QUESTION_SHORTCUT_ENABLED unset — this file is the ONLY
// place it's set to 'true', mirroring ackShortcutRouter.test.ts's and
// knowledgeShortcutRouter.test.ts's convention.
