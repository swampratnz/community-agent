import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';
import type { Platform } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// repeatMaxTurnsShortcutRouter.test.ts. This file is the ONLY place
// ESCALATION_TO_ADMIN_ENABLED is set to 'true' — router.test.ts leaves it
// unset so the default-off path stays covered untouched (also re-pinned
// explicitly by a test below). ACCESS_MODE_DISCORD='open' (mirroring
// confirmCancelMi.router.test.ts) so a non-super-admin caller — unresolvable
// in `community_users` with the DB unreachable, so it resolves to 'guest' —
// still reaches the escalation intercept instead of being short-circuited by
// the gated-guest branch, which only fires in gated mode. Also the ONLY place
// that sets BOTH ESCALATION_TO_ADMIN_ENABLED and
// REPEAT_MAX_TURNS_SHORTCUT_ENABLED together, so the repeat-shortcut's own
// `offerEscalation` call site (issue #479's "dead offer / orphaned entry"
// hazard on the replay path) is actually exercised — neither flag alone
// (as set by this file vs. repeatMaxTurnsShortcutRouter.test.ts, isolated
// per Node test-runner file process) reaches that branch.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1,super-2';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS ??= 'super-1';
process.env.ACCESS_MODE_DISCORD = 'open';
process.env.ESCALATION_TO_ADMIN_ENABLED = 'true';
process.env.REPEAT_MAX_TURNS_SHORTCUT_ENABLED = 'true';

const { config } = await import('../src/config.js');
const { Router, ESCALATION_RATE_LIMIT_PER_HOUR } = await import('../src/router.js');
const { embed } = await import('../src/storage/embeddings.js');
const { MAX_TURNS_REPLY, MAX_TURNS_REPLY_MI } = await import('../src/agent/core.js');

await embed('warmup').catch(() => {});

// Fixed internal constants (mirrored, not imported/exported — matching how
// repeatMaxTurnsShortcutRouter.test.ts asserts against REPEAT_SHORTCUT_WINDOW_MS).
const ESCALATION_OFFER_SUFFIX =
  '\n\nWant me to flag this for a community admin? Reply yes within 10 minutes.';
const ESCALATION_CONFIRMED_TEXT = '👍 Flagged for a community admin — someone will follow up soon.';
const ESCALATION_RATE_LIMITED_TEXT =
  'Already flagged the max I can this hour, sorry — please try again later or contact an admin directly.';
const ESCALATION_WINDOW_MS = 600_000;
const REPEAT_MAX_TURNS_SHORTCUT_NOTICE =
  '↩️ Same request as a moment ago — it still needs breaking down:\n\n';

const RUN = `escalation-router-${Date.now()}`;

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

/**
 * Builds a Router with a stub notifyAdminsFn (14th constructor arg — after
 * the recordAccessRequestFn/notifyAccessRequestFn pair issue #480 inserted
 * ahead of it) that records every call, and a stub runTurn. `getLangPref`
 * defaults to undefined (the real DB-backed lookup, which fails safe to
 * 'auto' against the unreachable dummy DB) — pass an override for a 'mi'
 * scenario, since the escalation-confirm intercept's own language lookup is
 * independent of whatever `reply.languagePreference` the stub `runTurn`
 * returns.
 */
function makeRouterWithNotifySpy(
  runTurn: Parameters<typeof Router>[0],
  getLangPref?: Parameters<typeof Router>[6],
) {
  const notifyCalls: { message: string; excludeUserId: string }[] = [];
  const router = new Router(
    runTurn,
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    getLangPref,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (
      _adapterFor: (platform: Platform) => PlatformAdapter | undefined,
      message: string,
      excludeUserId: string,
    ) => {
      notifyCalls.push({ message, excludeUserId });
    },
  );
  return { router, notifyCalls };
}

test('config: ESCALATION_TO_ADMIN_ENABLED=true is reflected in config.behaviour.escalationToAdminEnabled', () => {
  assert.equal(config.behaviour.escalationToAdminEnabled, true);
});

test('config: REPEAT_MAX_TURNS_SHORTCUT_ENABLED=true is reflected in config.behaviour.repeatMaxTurnsShortcutEnabled', () => {
  assert.equal(config.behaviour.repeatMaxTurnsShortcutEnabled, true);
});

test('router (escalation offer, flag off): a max-turns failure produces byte-identical MAX_TURNS_REPLY, no offer, no pending entry, and a later "yes" never calls notifyAdmins (acceptance criterion 1)', async () => {
  const originalFlag = config.behaviour.escalationToAdminEnabled;
  (config.behaviour as { escalationToAdminEnabled: boolean }).escalationToAdminEnabled = false;
  try {
    let calls = 0;
    const { router, notifyCalls } = makeRouterWithNotifySpy(async () => {
      calls++;
      return { text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true };
    });
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);
    const conversationId = `${RUN}-flag-off`;

    await trigger(makeMessage({ text: `${RUN} a long ask`, conversationId }));
    assert.equal(sent[0].text, MAX_TURNS_REPLY, 'no offer line appended when the flag is off');

    const internals = router as unknown as { pendingEscalations: Map<string, unknown> };
    assert.equal(internals.pendingEscalations.size, 0, 'no pending entry recorded when the flag is off');

    await trigger(makeMessage({ text: 'yes', conversationId }));
    assert.equal(calls, 2, 'the "yes" was routed to a fresh model turn, never intercepted');
    assert.equal(notifyCalls.length, 0, 'notifyAdmins must never fire when the flag is off');
  } finally {
    (config.behaviour as { escalationToAdminEnabled: boolean }).escalationToAdminEnabled = originalFlag;
  }
});

test('router (escalation offer, flag on): a max-turns failure appends the offer and atomically records a live pending entry (acceptance criterion 2)', async () => {
  const { router } = makeRouterWithNotifySpy(async () => ({
    text: MAX_TURNS_REPLY,
    ok: false,
    maxTurnsExceeded: true,
  }));
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-offer`;

  await trigger(makeMessage({ text: `${RUN} a long ask`, conversationId, userId: 'super-1' }));

  assert.equal(sent[0].text, `${MAX_TURNS_REPLY}${ESCALATION_OFFER_SUFFIX}`);

  const internals = router as unknown as {
    pendingEscalations: Map<string, { query: string; at: number }>;
  };
  const key = `discord:${conversationId}:super-1`;
  const entry = internals.pendingEscalations.get(key);
  assert.ok(entry, 'a live pending entry must exist behind the offer');
  assert.equal(entry?.query, `${RUN} a long ask`);
});

test('SECURITY: router (escalation offer via repeat-max-turns shortcut): with both flags on, a repeated identical message that hits sendRepeatMaxTurnsShortcut re-offers escalation with its own live pending entry, and a subsequent "yes" confirms it exactly like the non-shortcut path (issue #479 dead-offer/orphaned-entry hazard, repeat-shortcut replay case)', async () => {
  let calls = 0;
  const { router, notifyCalls } = makeRouterWithNotifySpy(async () => {
    calls++;
    return { text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true };
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-repeat-shortcut-offer`;
  const text = `${RUN} a very long repeat-shortcut ask`;

  // First send: a genuine model turn hits max-turns and gets the offer.
  await trigger(makeMessage({ text, conversationId, userId: 'super-1' }));
  assert.equal(calls, 1);
  assert.equal(sent[0].text, `${MAX_TURNS_REPLY}${ESCALATION_OFFER_SUFFIX}`);

  // Second, identical send: short-circuited by sendRepeatMaxTurnsShortcut —
  // must NOT spawn a second model turn, but must still carry the repeat
  // notice + a freshly re-offered escalation (its own live pending entry,
  // not a dead leftover from the first offer).
  await trigger(makeMessage({ text, conversationId, userId: 'super-1' }));
  assert.equal(calls, 1, 'the repeat-shortcut must short-circuit — no second model turn');
  assert.equal(
    sent[1].text,
    `${REPEAT_MAX_TURNS_SHORTCUT_NOTICE}${MAX_TURNS_REPLY}${ESCALATION_OFFER_SUFFIX}`,
    'the shortcut reply must carry the repeat notice AND the re-offered escalation suffix',
  );

  const internals = router as unknown as {
    pendingEscalations: Map<string, { query: string; at: number }>;
  };
  const key = `discord:${conversationId}:super-1`;
  const entry = internals.pendingEscalations.get(key);
  assert.ok(entry, 'the repeat-shortcut offer must record its own live pending entry');
  assert.equal(entry?.query, text);

  // A subsequent "yes" must confirm exactly like the non-shortcut path:
  // single notifyAdmins call, fixed confirmation text, entry consumed.
  await trigger(makeMessage({ text: 'yes', conversationId, userId: 'super-1' }));
  assert.equal(calls, 1, 'the confirmation must never spawn a model turn');
  assert.equal(notifyCalls.length, 1, 'exactly one notifyAdmins call from the shortcut-path offer');
  assert.equal(sent[2].text, ESCALATION_CONFIRMED_TEXT);
  assert.equal(
    internals.pendingEscalations.has(key),
    false,
    'the shortcut-path pending entry must be consumed (deleted) once confirmed',
  );
});

test('router (escalation offer): a reply with maxTurnsExceeded !== true never gets the offer appended or a pending entry recorded', async () => {
  const { router } = makeRouterWithNotifySpy(async () => ({
    text: `${RUN} a genuine answer`,
    ok: true,
  }));
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-non-failure`;

  await trigger(makeMessage({ text: `${RUN} a normal question`, conversationId }));

  assert.equal(sent[0].text, `${RUN} a genuine answer`);
  const internals = router as unknown as { pendingEscalations: Map<string, unknown> };
  assert.equal(internals.pendingEscalations.size, 0);
});

test('SECURITY: router (escalation confirm): a confirmed "yes" short-circuits entirely in the router — calls notifyAdmins exactly once (echoing the truncated original question), replies with the fixed confirmation, and never spawns a second model turn (acceptance criterion 3)', async () => {
  let calls = 0;
  const { router, notifyCalls } = makeRouterWithNotifySpy(async () => {
    calls++;
    return { text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true };
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-confirm`;

  await trigger(makeMessage({ text: `${RUN} help me please`, conversationId, userId: 'super-1' }));
  assert.equal(calls, 1);

  await trigger(makeMessage({ text: 'Yes', conversationId, userId: 'super-1' }));

  assert.equal(calls, 1, 'the confirmation must never spawn a second model turn');
  assert.equal(notifyCalls.length, 1, 'exactly one notifyAdmins call');
  assert.match(
    notifyCalls[0].message,
    /help me please/,
    'the notification must echo the original (truncated) failing question',
  );
  assert.equal(notifyCalls[0].excludeUserId, 'super-1');
  assert.equal(sent[1].text, ESCALATION_CONFIRMED_TEXT);

  const internals = router as unknown as { pendingEscalations: Map<string, unknown> };
  assert.equal(
    internals.pendingEscalations.size,
    0,
    'the pending entry must be consumed (deleted) the moment it is confirmed',
  );
});

test('SECURITY: router (escalation confirm): "y" and the te reo "āe" variant (case-insensitive, trimmed) also confirm a pending escalation', async () => {
  for (const [affirmative, tag] of [
    ['y', 'y'],
    ['ĀE', 'ae-upper'],
    ['  āe  ', 'ae-padded'],
  ] as const) {
    const { router, notifyCalls } = makeRouterWithNotifySpy(async () => ({
      text: MAX_TURNS_REPLY,
      ok: false,
      maxTurnsExceeded: true,
    }));
    const { adapter, trigger } = makeAdapter();
    router.register(adapter);
    const conversationId = `${RUN}-affirmative-${tag}`;

    await trigger(makeMessage({ text: `${RUN} stuck on ${tag}`, conversationId, userId: 'super-1' }));
    await trigger(makeMessage({ text: affirmative, conversationId, userId: 'super-1' }));

    assert.equal(notifyCalls.length, 1, `"${affirmative}" must confirm the pending escalation`);
  }
});

test('SECURITY: router (escalation confirm): single-shot consumption — replaying the identical confirmed "yes" a second time produces zero further notifyAdmins calls (acceptance criterion 4)', async () => {
  const { router, notifyCalls } = makeRouterWithNotifySpy(async () => ({
    text: MAX_TURNS_REPLY,
    ok: false,
    maxTurnsExceeded: true,
  }));
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-single-shot`;

  await trigger(makeMessage({ text: `${RUN} first failing ask`, conversationId, userId: 'super-1' }));
  await trigger(makeMessage({ text: 'yes', conversationId, userId: 'super-1' }));
  assert.equal(notifyCalls.length, 1);

  await trigger(makeMessage({ text: 'yes', conversationId, userId: 'super-1' }));
  assert.equal(notifyCalls.length, 1, 'a replayed "yes" must never produce a second notification');
  // The second "yes" has no live pending entry, so it must fall through to a
  // fresh model turn rather than being silently dropped.
  assert.notEqual(sent[2].text, ESCALATION_CONFIRMED_TEXT);
});

test('SECURITY: router (escalation confirm): a "yes" with no live pending entry is routed to the model as an ordinary message and never calls notifyAdmins (acceptance criterion 5)', async () => {
  let calls = 0;
  const { router, notifyCalls } = makeRouterWithNotifySpy(async () => {
    calls++;
    return { text: `${RUN} a genuine answer to yes`, ok: true };
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-no-pending`;

  await trigger(makeMessage({ text: 'yes', conversationId, userId: 'super-1' }));

  assert.equal(calls, 1, 'a "yes" with no pending escalation must run a fresh turn');
  assert.equal(notifyCalls.length, 0);
  assert.equal(sent[0].text, `${RUN} a genuine answer to yes`);
});

test('SECURITY: router (escalation confirm): a "yes" whose pending entry is past the 10-minute TTL is routed to the model, not treated as a confirmation', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let calls = 0;
  const { router, notifyCalls } = makeRouterWithNotifySpy(async () => {
    calls++;
    return calls === 1
      ? { text: MAX_TURNS_REPLY, ok: false, maxTurnsExceeded: true }
      : { text: `${RUN} fresh turn after ttl`, ok: true };
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-ttl`;

  await trigger(makeMessage({ text: `${RUN} a ttl-bound ask`, conversationId, userId: 'super-1' }));
  assert.equal(calls, 1);

  t.mock.timers.tick(ESCALATION_WINDOW_MS + 1_000);
  await trigger(makeMessage({ text: 'yes', conversationId, userId: 'super-1' }));

  assert.equal(calls, 2, 'the expired pending entry must not intercept — a fresh turn must run');
  assert.equal(notifyCalls.length, 0);
  assert.equal(sent[1].text, `${RUN} fresh turn after ttl`);
});

test('SECURITY: router (escalation confirm): the rate cap holds regardless of caller tier, including an open-mode guest — once ESCALATION_RATE_LIMIT_PER_HOUR confirmed escalations have fired within the trailing hour, a further confirmed "yes" does not call notifyAdmins and gets the rate-limited reply (acceptance criterion 6)', async () => {
  const { router, notifyCalls } = makeRouterWithNotifySpy(async () => ({
    text: MAX_TURNS_REPLY,
    ok: false,
    maxTurnsExceeded: true,
  }));
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  // Exhaust the guild-wide cap using ordinary (super-admin) callers, each in
  // its own conversation so no single caller's pending entry is reused.
  for (let i = 0; i < ESCALATION_RATE_LIMIT_PER_HOUR; i++) {
    const conversationId = `${RUN}-cap-${i}`;
    await trigger(makeMessage({ text: `${RUN} capped ask ${i}`, conversationId, userId: 'super-1' }));
    await trigger(makeMessage({ text: 'yes', conversationId, userId: 'super-1' }));
  }
  assert.equal(notifyCalls.length, ESCALATION_RATE_LIMIT_PER_HOUR, 'the cap must allow exactly the limit');

  // The cap-exhausting caller here is an UNREGISTERED, non-super-admin
  // identity under ACCESS_MODE_DISCORD='open' — unresolvable in
  // community_users with the DB unreachable, so it resolves to 'guest'. The
  // cap must still hold for this caller tier exactly as it did for the
  // super-admin callers above (no tier-based bypass).
  const guestConversationId = `${RUN}-cap-guest`;
  await trigger(
    makeMessage({
      text: `${RUN} guest capped ask`,
      conversationId: guestConversationId,
      userId: 'guest-1',
      userName: 'Guest',
    }),
  );
  await trigger(makeMessage({ text: 'yes', conversationId: guestConversationId, userId: 'guest-1' }));

  assert.equal(
    notifyCalls.length,
    ESCALATION_RATE_LIMIT_PER_HOUR,
    'once the cap is hit, no further notifyAdmins call fires for ANY caller tier',
  );
  assert.equal(sent[sent.length - 1].text, ESCALATION_RATE_LIMITED_TEXT);
});

test("router (escalation offer): a caller with a standing 'mi' language preference gets ESCALATION_OFFER_SUFFIX_MI appended to MAX_TURNS_REPLY_MI, and a confirmed 'āe' gets the MI confirmation text", async () => {
  const { router, notifyCalls } = makeRouterWithNotifySpy(
    // Real `runAgentTurn` already substitutes MAX_TURNS_REPLY_MI into `text`
    // whenever `languagePreference` resolves to 'mi' (agent/core.ts's
    // FALLBACK_REPLY_MI lookup) — mirror that pairing here rather than the
    // (never-occurring) English text + 'mi' preference combination.
    async () => ({
      text: MAX_TURNS_REPLY_MI,
      ok: false,
      maxTurnsExceeded: true,
      languagePreference: 'mi' as const,
    }),
    async () => 'mi',
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);
  const conversationId = `${RUN}-mi`;

  await trigger(makeMessage({ text: `${RUN} he pātai mi`, conversationId, userId: 'super-1' }));
  assert.equal(
    sent[0].text,
    `${MAX_TURNS_REPLY_MI}\n\nMe tohu tēnei mō tētahi kaiwhakahaere hapori? Whakahokia mai "āe" i roto i te 10 meneti.`,
  );

  await trigger(makeMessage({ text: 'āe', conversationId, userId: 'super-1' }));
  assert.equal(notifyCalls.length, 1);
  assert.equal(
    sent[1].text,
    '👍 Kua tohu mō tētahi kaiwhakahaere hapori — ka whai kōrero mai tētahi i muri tata nei.',
  );
});
