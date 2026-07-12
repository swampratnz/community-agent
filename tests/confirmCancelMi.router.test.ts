import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Router-level counterpart to pauseNotice.router.test.ts/rateLimitNotice.router.test.ts,
// covering the CONFIRM/CANCEL intercept's own three fixed strings (issue #405,
// the one deterministic send path #300/#363's own sweep of router.ts missed).
// ACCESS_MODE_DISCORD='open' (mirroring those files) so a non-super-admin
// actor — unresolvable in `community_users` with the DB unreachable, so they
// resolve to 'guest' — still reaches the CONFIRM/CANCEL intercept instead of
// being short-circuited by the gated-guest branch, which runs earlier in
// `handle()` and only fires in gated mode.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.ACCESS_MODE_DISCORD = 'open';

const { pool, closeDb } = await import('../src/storage/db.js');
const {
  Router,
  CANCEL_TEXT,
  CANCEL_TEXT_MI,
  PERMISSIONS_CHANGED_TEXT,
  PERMISSIONS_CHANGED_TEXT_MI,
  PENDING_NOTICE,
  PENDING_NOTICE_MI,
} = await import('../src/router.js');
const { registerPendingAction, classifyConfirmReply, hasPendingAction } =
  await import('../src/agent/pendingActions.js');
const { embed } = await import('../src/storage/embeddings.js');

await embed('warmup').catch(() => {});

const RUN = `confirmcancelmi-router-${Date.now()}`;

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
    text: `${RUN} CONFIRM`,
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeReply(text: string): AgentReply {
  return { text };
}

let counter = 0;
function nextConvo(): string {
  counter += 1;
  return `chan-${RUN}-${counter}`;
}

// --- CANCEL (acceptance criterion 1) ----------------------------------------

test("router (CANCEL): a caller with a standing 'mi' preference receives CANCEL_TEXT_MI", async () => {
  const conversationId = nextConvo();
  registerPendingAction('discord', conversationId, 'super-1', {
    description: `${RUN} delete something`,
    minTier: 'guest',
    execute: async () => 'done',
  });
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a CANCEL reply');
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

  await trigger(makeMessage({ conversationId, text: 'CANCEL' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, CANCEL_TEXT_MI);
  assert.equal(sent[0].text, 'Kua whakakorea.');
  assert.equal(
    hasPendingAction('discord', conversationId, 'super-1'),
    false,
    'CANCEL must still remove the pending action regardless of language',
  );
});

test("router (CANCEL): a caller with no (or any other) preference receives CANCEL_TEXT, byte-identical to today's 'Cancelled.'", async () => {
  const conversationId = nextConvo();
  registerPendingAction('discord', conversationId, 'super-1', {
    description: `${RUN} delete something`,
    minTier: 'guest',
    execute: async () => 'done',
  });
  // No getLangPref stub: the real getLanguagePreference hits the unreachable
  // DB and rejects, so the router's own `.catch(() => 'auto')` picks the
  // English default — same fail-safe path exercised explicitly below.
  const router = new Router(async () => {
    throw new Error('runTurn must not be called for a CANCEL reply');
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId, text: 'CANCEL' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, CANCEL_TEXT);
  assert.equal(sent[0].text, 'Cancelled.');
});

// --- Permissions-changed (acceptance criterion 2) ---------------------------

test("router (permissions changed): a tier-revoked-mid-TTL CONFIRM for an 'mi' caller receives PERMISSIONS_CHANGED_TEXT_MI", async () => {
  const conversationId = nextConvo();
  // Actor 'guest-1' is not a configured super admin and is unresolvable in
  // community_users (DB unreachable) — resolves to 'guest'. A pending action
  // requiring 'member' means the current-tier re-check at confirm time fails.
  registerPendingAction('discord', conversationId, 'guest-1', {
    description: `${RUN} grant admin`,
    minTier: 'member',
    execute: async () => {
      throw new Error('execute must never run once the tier re-check fails');
    },
  });
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a CONFIRM reply');
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

  await trigger(makeMessage({ conversationId, userId: 'guest-1', text: 'CONFIRM' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, PERMISSIONS_CHANGED_TEXT_MI);
});

test('router (permissions changed): the same caller with no mi preference gets PERMISSIONS_CHANGED_TEXT, byte-identical to today', async () => {
  const conversationId = nextConvo();
  registerPendingAction('discord', conversationId, 'guest-1', {
    description: `${RUN} grant admin`,
    minTier: 'member',
    execute: async () => {
      throw new Error('execute must never run once the tier re-check fails');
    },
  });
  const router = new Router(async () => {
    throw new Error('runTurn must not be called for a CONFIRM reply');
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId, userId: 'guest-1', text: 'CONFIRM' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, PERMISSIONS_CHANGED_TEXT);
  assert.equal(sent[0].text, 'Not executed: your permissions changed since this action was requested.');
});

// --- Pending notice wrapper (acceptance criterion 3) ------------------------

test("router (pending notice): a newly-registered pending action for an 'mi' caller is served in PENDING_NOTICE_MI, with pending.description embedded unchanged", async () => {
  const conversationId = nextConvo();
  const description = `${RUN} delete knowledge entry #5`;
  const router = new Router(
    async (caller) => {
      registerPendingAction(caller.platform, caller.conversationId, caller.userId, {
        description,
        minTier: 'guest',
        execute: async () => 'done',
      });
      return makeReply('sure, reply CONFIRM to apply');
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

  await trigger(makeMessage({ conversationId, text: `${RUN} please delete entry 5` }));

  assert.equal(sent.length, 2, 'the model reply PLUS the deterministic pending notice both send');
  const notice = sent.find((s) => s.text.includes(description));
  assert.ok(notice, 'pending.description must appear unchanged in the mi notice');
  assert.equal(notice.text, PENDING_NOTICE_MI(description));
  assert.notEqual(notice.text, PENDING_NOTICE(description));
});

test('router (pending notice): the same scenario with no mi preference is served in the English PENDING_NOTICE wrapper', async () => {
  const conversationId = nextConvo();
  const description = `${RUN} delete knowledge entry #6`;
  const router = new Router(async (caller) => {
    registerPendingAction(caller.platform, caller.conversationId, caller.userId, {
      description,
      minTier: 'guest',
      execute: async () => 'done',
    });
    return makeReply('sure, reply CONFIRM to apply');
  }, 20);
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ conversationId, text: `${RUN} please delete entry 6` }));

  assert.equal(sent.length, 2);
  const notice = sent.find((s) => s.text.includes(description));
  assert.ok(notice);
  assert.equal(notice.text, PENDING_NOTICE(description));
});

// --- Confirm-protocol preservation (acceptance criterion 4) -----------------

test('SECURITY: PENDING_NOTICE_MI keeps the CONFIRM/CANCEL reply tokens literal and untranslated, and a subsequent reply from an mi caller still classifies correctly', () => {
  const notice = PENDING_NOTICE_MI(`${RUN} some action`);
  assert.match(notice, /\bCONFIRM\b/, 'the literal token CONFIRM must survive translation');
  assert.match(notice, /\bCANCEL\b/, 'the literal token CANCEL must survive translation');

  // The confirm protocol itself doesn't care what language the notice was
  // rendered in — the caller still replies with the bare English token, and
  // classifyConfirmReply must still recognise it.
  assert.equal(classifyConfirmReply('CONFIRM'), 'confirm');
  assert.equal(classifyConfirmReply('CANCEL'), 'cancel');
});

// --- Fail-safe (acceptance criterion 5) -------------------------------------

test('SECURITY: a getLanguagePreference failure at each of the three CONFIRM/CANCEL send sites still sends the English default, never throws or drops the reply', async () => {
  const throwingLangPref = async () => {
    throw new Error('language_prefs read boom');
  };

  // Site 1: CANCEL.
  const cancelConvo = nextConvo();
  registerPendingAction('discord', cancelConvo, 'super-1', {
    description: `${RUN} cancel-failsafe`,
    minTier: 'guest',
    execute: async () => 'done',
  });
  const cancelRouter = new Router(
    async () => {
      throw new Error('runTurn must not be called for a CANCEL reply');
    },
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    throwingLangPref,
  );
  const { adapter: cancelAdapter, sent: cancelSent, trigger: cancelTrigger } = makeAdapter();
  cancelRouter.register(cancelAdapter);
  await assert.doesNotReject(cancelTrigger(makeMessage({ conversationId: cancelConvo, text: 'CANCEL' })));
  assert.equal(cancelSent.length, 1);
  assert.equal(cancelSent[0].text, CANCEL_TEXT);

  // Site 2: permissions-changed.
  const permConvo = nextConvo();
  registerPendingAction('discord', permConvo, 'guest-1', {
    description: `${RUN} perm-failsafe`,
    minTier: 'member',
    execute: async () => {
      throw new Error('execute must never run once the tier re-check fails');
    },
  });
  const permRouter = new Router(
    async () => {
      throw new Error('runTurn must not be called for a CONFIRM reply');
    },
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    throwingLangPref,
  );
  const { adapter: permAdapter, sent: permSent, trigger: permTrigger } = makeAdapter();
  permRouter.register(permAdapter);
  await assert.doesNotReject(
    permTrigger(makeMessage({ conversationId: permConvo, userId: 'guest-1', text: 'CONFIRM' })),
  );
  assert.equal(permSent.length, 1);
  assert.equal(permSent[0].text, PERMISSIONS_CHANGED_TEXT);

  // Site 3: pending notice.
  const pendingConvo = nextConvo();
  const description = `${RUN} pending-failsafe`;
  const pendingRouter = new Router(
    async (caller) => {
      registerPendingAction(caller.platform, caller.conversationId, caller.userId, {
        description,
        minTier: 'guest',
        execute: async () => 'done',
      });
      return makeReply('sure, reply CONFIRM to apply');
    },
    20,
    undefined,
    undefined,
    undefined,
    undefined,
    throwingLangPref,
  );
  const { adapter: pendingAdapter, sent: pendingSent, trigger: pendingTrigger } = makeAdapter();
  pendingRouter.register(pendingAdapter);
  await assert.doesNotReject(
    pendingTrigger(makeMessage({ conversationId: pendingConvo, text: `${RUN} please do the thing` })),
  );
  assert.equal(pendingSent.length, 2);
  const notice = pendingSent.find((s) => s.text.includes(description));
  assert.ok(notice);
  assert.equal(notice.text, PENDING_NOTICE(description));
});

// --- Scope-boundary regression (acceptance criterion 6) ---------------------

test("router (CONFIRM): pending.execute()'s own outcome string stays byte-identical regardless of language preference — this PR does not translate per-tool outcomes", async () => {
  const conversationId = nextConvo();
  registerPendingAction('discord', conversationId, 'super-1', {
    description: `${RUN} outcome-scope`,
    minTier: 'guest',
    execute: async () => 'Updated knowledge entry #5.',
  });
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a CONFIRM reply');
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

  await trigger(makeMessage({ conversationId, text: 'CONFIRM' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'Updated knowledge entry #5.');
});

test("router (CONFIRM): a thrown execute()'s Failed: ... message stays byte-identical regardless of language preference", async () => {
  const conversationId = nextConvo();
  registerPendingAction('discord', conversationId, 'super-1', {
    description: `${RUN} failure-scope`,
    minTier: 'guest',
    execute: async () => {
      throw new Error('boom');
    },
  });
  const router = new Router(
    async () => {
      throw new Error('runTurn must not be called for a CONFIRM reply');
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

  await trigger(makeMessage({ conversationId, text: 'CONFIRM' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'Failed: boom');
});

// --- SECURITY: fixed, non-interpolated _MI constants (acceptance criterion 7) ----

test('SECURITY: CANCEL_TEXT_MI and PERMISSIONS_CHANGED_TEXT_MI are fixed, non-interpolated strings — pinned so a future edit cannot silently make them depend on caller-controlled input', () => {
  assert.equal(typeof CANCEL_TEXT_MI, 'string');
  assert.equal(CANCEL_TEXT_MI, 'Kua whakakorea.');
  assert.equal(typeof PERMISSIONS_CHANGED_TEXT_MI, 'string');
  assert.equal(
    PERMISSIONS_CHANGED_TEXT_MI,
    'Kāore i whakahaerehia: kua rerekē ō mana whakaaetanga mai i te wā i tonoa ai tēnei mahi.',
  );
});

test('SECURITY: PENDING_NOTICE_MI interpolates ONLY the pending.description placeholder — every other part of the template is fixed regardless of input', () => {
  const outA = PENDING_NOTICE_MI('description A');
  const outB = PENDING_NOTICE_MI('description B');
  // Replacing each call's own description with a shared placeholder must
  // yield byte-identical templates — proving no other part of the string
  // varies with the input, i.e. no hidden extra interpolation surface.
  assert.equal(outA.replace('description A', ' '), outB.replace('description B', ' '));
});
