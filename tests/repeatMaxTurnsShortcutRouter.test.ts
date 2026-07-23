import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// repeatQuestionShortcutRouter.test.ts. This file is the ONLY place
// REPEAT_MAX_TURNS_SHORTCUT_ENABLED is set to 'true' — router.test.ts leaves
// it unset so the default-off path stays covered untouched, and the node
// test runner isolates env per test file. REPEAT_QUESTION_SHORTCUT_ENABLED is
// deliberately left unset here so the sibling #259 shortcut never interferes
// with these assertions.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1,super-2';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS ??= 'super-1';
process.env.REPEAT_MAX_TURNS_SHORTCUT_ENABLED = 'true';

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const { Router } = await import('../src/router.js');
const { embed } = await import('../src/storage/embeddings.js');
const { countRepliesToUser } = await import('../src/storage/repository.js');
const { MAX_TURNS_REPLY, MAX_TURNS_REPLY_MI } = await import('../src/agent/core.js');

await embed('warmup').catch(() => {});

// Fixed internal constant per issue #306 (reused from #259, not duplicated —
// not exported, mirrors how the sibling shortcut test asserts against a
// literal rather than importing).
const REPEAT_SHORTCUT_WINDOW_MS = 120_000;
const REPEAT_MAX_TURNS_SHORTCUT_NOTICE =
  '↩️ Same request as a moment ago — it still needs breaking down:\n\n';

// Unique-per-run marker so this file's DB writes never collide with another
// test file's traffic and can be cleaned up afterward.
const RUN = `repeatmt-router-${Date.now()}`;

/**
 * Retry an assertion block that reads countRepliesToUser — it aggregates
 * outbound replies for an IDENTITY (platform + userId) across the whole
 * interactions table over a sliding 24h window, by design (that's what a
 * daily reply budget means), so it can't be scoped to this test's own
 * conversation_id. The Node test runner executes test FILES in parallel
 * against one shared DB, so another file's concurrent insert for the same
 * 'super-1' discord identity can land between the before/after reads and
 * shift the exact delta (issue #675: "3 !== 2"). Re-running the whole
 * read-seed-read sequence gets a quiet window with overwhelming
 * probability, while a REAL regression fails deterministically on every
 * attempt — so retrying masks nothing (mirrors
 * tests/repository.test.ts's retryOnSharedTableInterference).
 */
async function retryOnSharedTableInterference(attempts: number, run: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run();
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      console.warn(
        `retryOnSharedTableInterference: attempt ${attempt}/${attempts} hit interference, retrying:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

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
    userId: 'super-1',
    userName: 'Test User',
    text: `${RUN} hello bot`,
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

test('config: REPEAT_MAX_TURNS_SHORTCUT_ENABLED=true is reflected in config.behaviour.repeatMaxTurnsShortcutEnabled', () => {
  assert.equal(config.behaviour.repeatMaxTurnsShortcutEnabled, true);
});

test('router (repeat-max-turns shortcut): the same caller resending the same whitespace-normalized text after a max-turns failure results in exactly one runTurn call, and the second reply is the canned max-turns message prefixed with the repeat notice', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls++;
    return { text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true };
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-happy`;

  await trigger(makeMessage({ text: `${RUN}  a very  long ask  `, conversationId }));
  await trigger(makeMessage({ text: `${RUN} a very long ask `, conversationId }));

  assert.equal(calls, 1, 'the second (whitespace-normalized) resend must not spawn a second turn');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, MAX_TURNS_REPLY);
  assert.equal(
    sent[1].text,
    `${REPEAT_MAX_TURNS_SHORTCUT_NOTICE}${MAX_TURNS_REPLY}`,
    'the repeat reply must equal the fixed canned max-turns message prefixed with the fixed repeat-notice string',
  );
});

test('router (repeat-max-turns shortcut): a hit records a shortcut_hits row of kind "repeat_max_turns" (issue #440)', async () => {
  const calls: string[] = [];
  const router = new Router(
    async () => ({ text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true }),
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

  await trigger(makeMessage({ text: `${RUN} a very long ask`, conversationId }));
  await trigger(makeMessage({ text: `${RUN} a very long ask`, conversationId }));

  assert.equal(sent.length, 2);
  assert.deepEqual(
    calls,
    ['repeat_max_turns'],
    'only the second (shortcut) hit records a row, not the first max-turns failure',
  );
});

test('router (repeat-max-turns shortcut): a DIFFERENT message from the same caller after a max-turns failure is not short-circuited', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls++;
    return { text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true };
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-different`;

  await trigger(makeMessage({ text: `${RUN} first long ask`, conversationId }));
  await trigger(makeMessage({ text: `${RUN} a completely different ask`, conversationId }));

  assert.equal(calls, 2, 'a different normalized message must always run a fresh turn');
  assert.equal(sent[1].text, MAX_TURNS_REPLY, 'no repeat-notice prefix — this was a fresh turn');
});

test('router (repeat-max-turns shortcut): a reply with maxTurnsExceeded !== true is never cached — a resend after a successful or other-failure reply always runs a fresh turn', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls++;
    return { text: `${RUN} answer #${calls}`, ok: true };
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-success-only`;
  const text = `${RUN} a normal question`;

  await trigger(makeMessage({ text, conversationId }));
  await trigger(makeMessage({ text, conversationId }));

  assert.equal(
    calls,
    2,
    'a successful reply must never populate the max-turns shortcut map, so the resend runs a fresh turn',
  );
  assert.equal(sent[1].text, `${RUN} answer #2`, 'no repeat-notice prefix — this was a fresh turn');
});

test('router (repeat-max-turns shortcut): with REPEAT_MAX_TURNS_SHORTCUT_ENABLED unset/false, behaviour is byte-identical to today — two identical sends after a max-turns failure both run a fresh turn', async () => {
  const originalFlag = config.behaviour.repeatMaxTurnsShortcutEnabled;
  (config.behaviour as { repeatMaxTurnsShortcutEnabled: boolean }).repeatMaxTurnsShortcutEnabled = false;
  try {
    let calls = 0;
    const router = new Router(async () => {
      calls++;
      return { text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true };
    }, 20);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);
    const conversationId = `${RUN}-flag-off`;
    const text = `${RUN} same long ask every time`;

    await trigger(makeMessage({ text, conversationId }));
    await trigger(makeMessage({ text, conversationId }));

    assert.equal(calls, 2, 'flag off must never short-circuit — always two fresh turns');
    assert.equal(sent[1].text, MAX_TURNS_REPLY, 'no repeat-notice prefix — the flag never engaged');
  } finally {
    (config.behaviour as { repeatMaxTurnsShortcutEnabled: boolean }).repeatMaxTurnsShortcutEnabled =
      originalFlag;
  }
});

test('router (repeat-max-turns shortcut): a resend after REPEAT_SHORTCUT_WINDOW_MS has elapsed (advanced via an injectable clock, never a real sleep) runs a fresh turn, and the stale entry is pruned by sweep()', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let calls = 0;
  const router = new Router(async () => {
    calls++;
    return { text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true };
  }, 20);
  const { adapter, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-expiry`;
  const text = `${RUN} a long ask that keeps failing`;

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

  const internals = router as unknown as {
    lastMaxTurnsFailure: Map<string, { at: number }>;
    sweep(): void;
  };
  const key = `discord:${conversationId}:super-1`;
  assert.ok(internals.lastMaxTurnsFailure.has(key), 'the fresh (2nd) turn must have re-populated the cache');

  t.mock.timers.tick(REPEAT_SHORTCUT_WINDOW_MS + 1000);
  internals.sweep();
  assert.equal(
    internals.lastMaxTurnsFailure.has(key),
    false,
    'sweep() must prune an entry once REPEAT_SHORTCUT_WINDOW_MS has elapsed',
  );
});

test(
  'router (repeat-max-turns shortcut): a served repeat-max-turns reply is recorded exactly like a real reply — meta.repeatMaxTurnsShortcut + replyToUserId — and counts toward the daily reply budget',
  { skip: !hasDb },
  async () => {
    const userId = 'super-1';
    let attempt = 0;

    await retryOnSharedTableInterference(4, async () => {
      attempt++;
      // Attempt-unique so a prior (interfered) attempt's already-committed
      // rows don't get re-matched by this attempt's conversation-scoped
      // lookup below — the delta assertion itself is safe on retry either
      // way, since before/after are both re-read fresh each attempt.
      const conversationId = `${RUN}-recorded-${attempt}`;
      const text = `${RUN} recorded long ask ${attempt}`;

      const before = await countRepliesToUser('discord', userId);

      const router = new Router(
        async () => ({ text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true }),
        20,
      );
      const { adapter, sent, trigger } = makeAdapter();
      router.register(adapter);

      await trigger(makeMessage({ text, conversationId, userId }));
      await trigger(makeMessage({ text: ` ${text} `, conversationId, userId }));

      assert.equal(sent.length, 2);

      const after = await countRepliesToUser('discord', userId);
      assert.equal(
        after - before,
        2,
        'both the real failure reply and the repeat-shortcut reply must be recorded and counted toward the daily budget',
      );

      // The canned max-turns reply text is fixed and never embeds the user's
      // message, unlike the #259 repeat-question shortcut's replayed genuine
      // answer — so this scopes by conversation_id instead of a content LIKE
      // match on the user's text.
      const { rows } = await pool.query(
        `SELECT meta FROM interactions WHERE direction = 'outbound' AND conversation_id = $1`,
        [conversationId],
      );
      const repeatRow = rows.find(
        (r: { meta: { repeatMaxTurnsShortcut?: boolean } }) => r.meta?.repeatMaxTurnsShortcut === true,
      );
      assert.ok(
        repeatRow,
        'the repeat-max-turns-shortcut reply must be recorded with meta.repeatMaxTurnsShortcut: true',
      );
      assert.equal(repeatRow.meta.replyToUserId, userId);
    });
  },
);

test("SECURITY: router (repeat-max-turns shortcut): a max-turns failure cached for one caller never short-circuits a different caller's identical-text turn when they differ in platform, conversationId, or userId — isolation is structural (part of the key), never a text-only match", async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls++;
    return { text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true };
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
  const text = `${RUN} same failing ask everywhere`;

  await discordTrigger(makeMessage({ text, conversationId: convoA, userId: 'super-1', platform: 'discord' }));
  assert.equal(calls, 1);

  // Different userId, same conversation + platform.
  await discordTrigger(makeMessage({ text, conversationId: convoA, userId: 'super-2', platform: 'discord' }));
  assert.equal(calls, 2, "a different userId must never be served another caller's cached max-turns failure");
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

  // Sanity: the ORIGINAL caller repeating their own failing ask still gets the cache hit.
  await discordTrigger(makeMessage({ text, conversationId: convoA, userId: 'super-1', platform: 'discord' }));
  assert.equal(calls, 4, 'the original caller must still be short-circuited by their own cache entry');
  assert.match(discordSent[3].text, /^↩️/);
});

// --- Standing 'mi' language preference on the repeat-max-turns shortcut (issue #435) ---

test("router (repeat-max-turns shortcut): a caller with a standing 'mi' language preference gets REPEAT_MAX_TURNS_SHORTCUT_NOTICE_MI prefixed onto MAX_TURNS_REPLY_MI, not MAX_TURNS_REPLY", async () => {
  let calls = 0;
  const router = new Router(
    async () => {
      calls++;
      return { text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true };
    },
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => 'mi',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-mi`;

  await trigger(makeMessage({ text: `${RUN} a mi long ask`, conversationId }));
  await trigger(makeMessage({ text: `${RUN} a mi long ask`, conversationId }));

  assert.equal(calls, 1);
  assert.equal(sent.length, 2);
  assert.equal(
    sent[1].text,
    `↩️ He rite tonu ki tō tono o mua tata nei — me wāwāhi tonu:\n\n${MAX_TURNS_REPLY_MI}`,
  );
});

test("router (repeat-max-turns shortcut): a caller with 'auto' (the default) still gets today's English notice + MAX_TURNS_REPLY, byte-identical", async () => {
  let calls = 0;
  const router = new Router(
    async () => {
      calls++;
      return { text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true };
    },
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => 'auto',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-auto`;

  await trigger(makeMessage({ text: `${RUN} an auto long ask`, conversationId }));
  await trigger(makeMessage({ text: `${RUN} an auto long ask`, conversationId }));

  assert.equal(sent.length, 2);
  assert.equal(sent[1].text, `${REPEAT_MAX_TURNS_SHORTCUT_NOTICE}${MAX_TURNS_REPLY}`);
});

test('SECURITY: a getLanguagePreference failure on the repeat-max-turns shortcut still sends the English default, never throws or drops the reply', async () => {
  const router = new Router(
    async () => ({ text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true }),
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      throw new Error('language_prefs read boom');
    },
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-failsafe`;

  await trigger(makeMessage({ text: `${RUN} failsafe long ask`, conversationId }));
  await assert.doesNotReject(trigger(makeMessage({ text: `${RUN} failsafe long ask`, conversationId })));

  assert.equal(sent.length, 2);
  assert.equal(sent[1].text, `${REPEAT_MAX_TURNS_SHORTCUT_NOTICE}${MAX_TURNS_REPLY}`);
});

test('SECURITY: REPEAT_MAX_TURNS_SHORTCUT_NOTICE_MI and MAX_TURNS_REPLY_MI are fixed, non-interpolated strings — byte-identical across distinct conversations/callers', async () => {
  const router = new Router(
    async () => ({ text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true }),
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => 'mi',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-mi-fixed`;

  await trigger(makeMessage({ text: `${RUN} another long ask`, conversationId, userId: 'super-2' }));
  await trigger(makeMessage({ text: `${RUN} another long ask`, conversationId, userId: 'super-2' }));

  assert.equal(sent.length, 2);
  assert.equal(
    sent[1].text,
    `↩️ He rite tonu ki tō tono o mua tata nei — me wāwāhi tonu:\n\n${MAX_TURNS_REPLY_MI}`,
  );
});

// The flag-disabled path is also covered above (flag-off regression test);
// router.test.ts leaves REPEAT_MAX_TURNS_SHORTCUT_ENABLED unset so the
// default-off path stays covered in an untouched process too, mirroring
// repeatQuestionShortcutRouter.test.ts's convention.
