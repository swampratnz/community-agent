import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '@swampratnz/agent-base/agent/core.js';
import type {
  IncomingMessage,
  OutgoingMessage,
  Platform,
  PlatformAdapter,
} from '@swampratnz/agent-base/platforms/types.js';
import type {
  MemberInterestRow,
  MemberInterestSearchHit,
  SelfInterestMatchResult,
} from '@swampratnz/agent-base/storage/repository/memberDiscovery.js';
import type {
  MemberProject,
  MemberProjectSearchHit,
} from '@swampratnz/agent-base/storage/repository/memberProjects.js';
import type { ShortcutKind } from '@swampratnz/agent-base/storage/repository/shortcutHits.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// knowledgeShortcutRouter.test.ts's convention. This file is the ONLY place
// WHATSAPP_TEXT_COMMANDS_ENABLED is set to 'true' — router.test.ts and every
// other router test file leave it unset, so the default-off path stays
// covered untouched elsewhere, and the node test runner isolates env per
// test file.
//
// ACCESS_MODE_WHATSAPP is flipped to 'open' here (mirroring
// whatsappBlockRouterOpen.test.ts's convention of being the ONE place a given
// ACCESS_MODE_* is opened) so a guest caller reaches this file's dispatcher
// instead of being intercepted by the earlier gated-guest branch — the
// SECURITY fallthrough test below needs a guest to actually reach
// tryWhatsAppTextCommand, not the static gated notice.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.ACCESS_MODE_WHATSAPP = 'open';
process.env.WHATSAPP_TEXT_COMMANDS_ENABLED = 'true';
// !status reads the same background-polled cache as check_status (issue
// #995) — pollAnthropicStatus below needs this set to actually populate it.
process.env.STATUS_CHECK_API_URL ??= 'https://status.claude.com/api/v2/summary.json';
// Run-unique identity for the real-DB daily-budget assertion (mirrors
// repeatQuestionShortcutRouter.test.ts's BUDGET_USER_ID rationale exactly:
// countRepliesToUser aggregates outbound replies for an IDENTITY across the
// WHOLE interactions table over a sliding 24h window, so a shared fixture id
// could pick up another parallel test file's concurrent writes).
const BUDGET_USER_ID = `wa-cmd-budget-${process.pid}-${Date.now()}`;
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';

const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');
const { config } = await import('@swampratnz/agent-base/config.js');
// Side-effect import (mechanism/content split): the router's text-command
// dispatcher reads commands/registry.ts's registered list, which only the
// community commands module populates — src/index.ts does this in
// production.
await import('./support/registerCommands.js');
// The community policy keys (guidelines/welcome message) — the manifest's
// `policyKeys` registration in production (src/module/agentModule.ts).
await import('./support/registerPolicyKeys.js');
const { Router } = await import('@swampratnz/agent-base/router.js');
const { makeRouterDeps } = await import('../src/module/routerWiring.js');
const { countRepliesToUser } = await import('@swampratnz/agent-base/storage/repository.js');
const { formatStatusMessage, getStatusCache, pollAnthropicStatus, resetStatusCacheForTests } =
  await import('../src/module/status/anthropicStatus.js');
const { formatMyWarningsText } = await import('../src/module/agent/tools/selfService.js');

const RUN = `wa-cmd-router-${Date.now()}`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM interactions WHERE content LIKE $1`, [`${RUN}%`]);
    await closeDb();
  }
});

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): {
  adapter: PlatformAdapter;
  sent: OutgoingMessage[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const adapter: PlatformAdapter = {
    platform: 'whatsapp',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage(h) {
      handler = h;
    },
    async sendMessage(out) {
      sent.push(out);
      return undefined;
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
    platform: 'whatsapp',
    conversationId: 'wa-conv-1',
    userId: 'member-1',
    userName: 'Test Member',
    text: '!guidelines',
    isDirect: true,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Fixed reply a fallback/full turn produces — never mistaken for a text-command's own output. */
const REAL_TURN_REPLY = 'REAL_AGENT_TURN_REPLY';

async function throwingRunTurn(): Promise<AgentReply> {
  throw new Error('runTurn (and therefore query()) must not be called for a served WhatsApp text command');
}

interface RouterOpts {
  runTurn?: () => Promise<AgentReply>;
  role?: 'admin' | 'member' | null;
  searchMemberInterestsFn?: (query: string) => Promise<MemberInterestSearchHit[]>;
  searchMemberInterestsForSelfFn?: (
    platform: Platform,
    userId: string,
    limit?: number,
  ) => Promise<SelfInterestMatchResult>;
  searchProjectsFn?: (query: string, limit?: number) => Promise<MemberProjectSearchHit[]>;
  listRecentProjectsFn?: (limit?: number) => Promise<MemberProject[]>;
  listOwnProjectsFn?: (platform: Platform, userId: string) => Promise<MemberProject[]>;
  buildDigestContentFn?: () => Promise<string | null>;
  getConductGuidelinesFn?: () => Promise<string | null>;
  getLocalisedConductGuidelinesFn?: () => Promise<string | null>;
  getLangPref?: () => Promise<'auto' | 'en' | 'mi'>;
  recordShortcutHitFn?: (kind: ShortcutKind) => Promise<void>;
  listRecentInterestsFn?: (limit?: number) => Promise<MemberInterestRow[]>;
}

/**
 * Builds a Router with every DB-backed dependency this file's tests care
 * about either stubbed out (countReplies, checkPaused — deterministic,
 * DB-free) or overridable (the four issue #859 search/digest/guidelines
 * functions, plus `searchMemberInterestsForSelfFn` for issue #889's bare
 * `!whois` and `listRecentInterestsFn` for issue #920's no-profile browse
 * fallback), so a `!whois`/`!projects`/`!digest`/`!guidelines` test never
 * needs a live Postgres or the real (slow, model-download-on-first-use)
 * `embed()` pipeline — mirroring `knowledgeShortcutRouter.test.ts`'s
 * `searchKnowledgeForShortcut` injection for the exact same reason.
 *
 * Role resolution (`resolveRole`) is NOT injectable on Router, so a
 * non-guest/non-super-admin role still needs a real `community_users` row —
 * `mockPool` below stubs `pool.query`'s `SELECT role FROM community_users`
 * branch for that, the same technique `discordSlashCommands.test.ts` uses.
 */
function makeRouter(opts: RouterOpts = {}): Router {
  return new Router(
    makeRouterDeps({
      runTurn: opts.runTurn ?? (async () => ({ text: REAL_TURN_REPLY })),
      // 1 runTurn
      typingRefireMs: 20,
      // 2 typingRefireMs
      checkPaused: async () => false,
      // 5 recordShortcutRetrieval
      countReplies: async () => 0,
      // 6 countReplies — always under budget, deterministic
      getLangPref: opts.getLangPref,
      // 10 getRespStyle
      recordShortcutHit: opts.recordShortcutHitFn,
      // 17 markStaleKnowledgeAlertedFn
      getConductGuidelinesFn: opts.getConductGuidelinesFn,
      // 18
      getLocalisedConductGuidelinesFn: opts.getLocalisedConductGuidelinesFn,
      // 19
      searchMemberInterestsFn: opts.searchMemberInterestsFn,
      // 20
      searchProjectsFn: opts.searchProjectsFn,
      // 21
      listRecentProjectsFn: opts.listRecentProjectsFn,
      // 22
      buildDigestContentFn: opts.buildDigestContentFn,
      // 24 recentQuestionClustersFn
      searchMemberInterestsForSelfFn: opts.searchMemberInterestsForSelfFn,
      // 26 checkKnowledgeConflict
      listOwnProjectsFn: opts.listOwnProjectsFn,
      // 27
      listRecentInterestsFn: opts.listRecentInterestsFn,
    }), // 28
  );
}

/** Stubs `pool.query`'s role lookup; every other query defaults to an empty result set. */
function mockPoolRole(
  t: { mock: { method: typeof import('node:test').mock.method } },
  role: 'admin' | 'member' | null,
) {
  t.mock.method(pool, 'query', (async (sql: string) => {
    if (sql.includes('SELECT role FROM community_users')) {
      return { rows: role ? [{ role }] : [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);
}

/**
 * Mocks `pool.query`'s role + `countActiveWarnings` (`FROM member_warnings`)
 * branches exactly ONCE (`t.mock.method` may only be called once per method
 * per test — a second call on the same test's `t` leaves `pool.query`
 * permanently stuck on an intermediate mock instead of restoring the real
 * implementation at teardown, which silently broke acceptance criterion 8's
 * real-DB assertion further down this file when discovered during review).
 * Callers that need to vary the counts across several `trigger()` calls
 * within one test mutate the returned ref object instead of re-mocking.
 */
function mockPoolRoleAndWarnings(
  t: { mock: { method: typeof import('node:test').mock.method } },
  role: 'admin' | 'member' | null,
  activeWarnings = 0,
  windowedWarnings = 0,
): { active: number; windowed: number } {
  const ref = { active: activeWarnings, windowed: windowedWarnings };
  t.mock.method(pool, 'query', (async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT role FROM community_users')) {
      return { rows: role ? [{ role }] : [], rowCount: 0 };
    }
    if (sql.includes('FROM member_warnings')) {
      const windowDays = params[2];
      const n = windowDays == null ? ref.active : ref.windowed;
      return { rows: [{ n }], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);
  return ref;
}

test('config: WHATSAPP_TEXT_COMMANDS_ENABLED=true is reflected in config.behaviour.whatsappTextCommandsEnabled', () => {
  assert.equal(config.behaviour.whatsappTextCommandsEnabled, true);
});

// --- Acceptance criterion 5 / regression: flag off is byte-identical --------

test('SECURITY: acceptance criterion 7 — with the flag off, a !help message is NOT treated as a command — falls through to a normal turn like the other four commands (issue #993)', async (t) => {
  const was = config.behaviour.whatsappTextCommandsEnabled;
  config.behaviour.whatsappTextCommandsEnabled = false;
  t.after(() => {
    config.behaviour.whatsappTextCommandsEnabled = was;
  });
  mockPoolRole(t, 'member');

  const router = makeRouter({ runTurn: async () => ({ text: REAL_TURN_REPLY }) });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!help', userId: 'member-1' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, REAL_TURN_REPLY);
});

test('acceptance criterion 5: with the flag off, a !whois message is NOT treated as a command — falls through to a normal turn', async (t) => {
  const was = config.behaviour.whatsappTextCommandsEnabled;
  config.behaviour.whatsappTextCommandsEnabled = false;
  t.after(() => {
    config.behaviour.whatsappTextCommandsEnabled = was;
  });
  mockPoolRole(t, 'member');

  const router = makeRouter({
    runTurn: async () => ({ text: REAL_TURN_REPLY }),
    searchMemberInterestsFn: async () => {
      throw new Error('searchMemberInterestsFn must never be called when the flag is off');
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!whois rust', userId: 'member-1' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, REAL_TURN_REPLY);
});

// --- Acceptance criterion 4: non-WhatsApp platform is always a no-op -------

test('acceptance criterion 4: on Discord, the dispatcher is a no-op even with the flag on', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({
    searchMemberInterestsFn: async () => {
      throw new Error('searchMemberInterestsFn must never be called on a non-WhatsApp platform');
    },
  });
  const { adapter, sent, trigger } = makeAdapter({ platform: 'discord' });
  router.register(adapter);

  await trigger(makeMessage({ platform: 'discord', text: '!whois rust', userId: 'member-1' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, REAL_TURN_REPLY);
});

// --- !whois -------------------------------------------------------------------

test('!whois <query> from a member is served deterministically: zero query() calls, output matches formatInterestResults', async (t) => {
  mockPoolRole(t, 'member');
  const hits: MemberInterestSearchHit[] = [
    { platform: 'whatsapp', userId: 'target-1', interests: 'rust and distributed systems', similarity: 0.81 },
  ];
  let calledWith: string | undefined;
  const router = makeRouter({
    runTurn: throwingRunTurn,
    searchMemberInterestsFn: async (query) => {
      calledWith = query;
      return hits;
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!whois rust', userId: 'member-1' }));

  assert.equal(sent.length, 1);
  assert.equal(calledWith, 'rust');
  assert.match(sent[0].text, /<member-interests/);
  assert.match(sent[0].text, /rust and distributed systems/);
});

test('!whois replies with the no-match text when searchMemberInterestsFn returns no hits', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({ runTurn: throwingRunTurn, searchMemberInterestsFn: async () => [] });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!whois someone', userId: 'member-1' }));

  assert.equal(sent[0].text, 'No members have published interests matching that yet.');
});

// --- bare !whois self-match (issue #889) ------------------------------------

test('acceptance criterion 2: bare !whois from a member with a published profile searches via searchMemberInterestsForSelfFn, keyed on the caller identity, excluding no re-embed', async (t) => {
  mockPoolRole(t, 'member');
  const hits: MemberInterestSearchHit[] = [
    { platform: 'whatsapp', userId: 'target-1', interests: 'rust and distributed systems', similarity: 0.77 },
  ];
  let callCount = 0;
  let calledWith: [Platform, string] | undefined;
  const router = makeRouter({
    runTurn: throwingRunTurn,
    searchMemberInterestsFn: async () => {
      throw new Error('searchMemberInterestsFn (the query-search path) must never be called for bare !whois');
    },
    searchMemberInterestsForSelfFn: async (platform, userId) => {
      callCount += 1;
      calledWith = [platform, userId];
      return { hasProfile: true, hits };
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!whois', userId: 'member-1' }));

  assert.equal(sent.length, 1);
  assert.equal(callCount, 1, 'searchMemberInterestsForSelfFn must be invoked exactly once');
  assert.deepEqual(calledWith, ['whatsapp', 'member-1']);
  assert.match(sent[0].text, /<member-interests/);
  assert.match(sent[0].text, /rust and distributed systems/);
});

test('acceptance criterion 3: bare !whois from a member with a published profile but zero hits returns the existing no-match string', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({
    runTurn: throwingRunTurn,
    searchMemberInterestsForSelfFn: async () => ({ hasProfile: true, hits: [] }),
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!whois', userId: 'member-1' }));

  assert.equal(sent[0].text, 'No members have published interests matching that yet.');
});

test('acceptance criterion 4: bare !whois from a member with no published profile and nothing to browse returns only the who_is_into first-time-caller guidance', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({
    runTurn: throwingRunTurn,
    searchMemberInterestsForSelfFn: async () => ({ hasProfile: false }),
    listRecentInterestsFn: async () => [],
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!whois', userId: 'member-1' }));

  assert.match(sent[0].text, /haven't published interests yet/);
  assert.match(sent[0].text, /set_my_interests/);
});

// --- bare !whois no-profile browse fallback (issue #920) --------------------

test('issue #920 AC #4/#5: bare !whois from a member with no published profile browses listRecentInterestsFn and still appends the set_my_interests hint', async (t) => {
  mockPoolRole(t, 'member');
  const recent: MemberInterestRow[] = [
    { platform: 'whatsapp', userId: 'browsed-1', interests: 'recently published interests' },
  ];
  let callCount = 0;
  const router = makeRouter({
    runTurn: throwingRunTurn,
    searchMemberInterestsFn: async () => {
      throw new Error('searchMemberInterestsFn (the query-search path) must never be called for bare !whois');
    },
    searchMemberInterestsForSelfFn: async () => ({ hasProfile: false }),
    listRecentInterestsFn: async () => {
      callCount += 1;
      return recent;
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!whois', userId: 'member-1' }));

  assert.equal(callCount, 1, 'listRecentInterestsFn must be invoked exactly once');
  assert.match(sent[0].text, /<member-interests/);
  assert.match(sent[0].text, /recently published interests/);
  assert.match(
    sent[0].text,
    /haven't published interests yet/,
    'the set_my_interests hint still appends after the browsed list',
  );
});

test('issue #920: a member WITH an existing profile never reaches listRecentInterestsFn — the self-match path is unaffected', async (t) => {
  mockPoolRole(t, 'member');
  const hits: MemberInterestSearchHit[] = [
    { platform: 'whatsapp', userId: 'target-1', interests: 'rust and distributed systems', similarity: 0.77 },
  ];
  const router = makeRouter({
    runTurn: throwingRunTurn,
    searchMemberInterestsForSelfFn: async () => ({ hasProfile: true, hits }),
    listRecentInterestsFn: async () => {
      throw new Error('listRecentInterestsFn must never be invoked when the caller already has a profile');
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!whois', userId: 'member-1' }));

  assert.match(sent[0].text, /rust and distributed systems/);
});

test('a bare "!whois" with only trailing whitespace still takes the no-argument self-match branch', async (t) => {
  mockPoolRole(t, 'member');
  let callCount = 0;
  const router = makeRouter({
    runTurn: throwingRunTurn,
    searchMemberInterestsFn: async () => {
      throw new Error('searchMemberInterestsFn must never be called when there is no non-whitespace query');
    },
    searchMemberInterestsForSelfFn: async () => {
      callCount += 1;
      return { hasProfile: false };
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!whois   ', userId: 'member-1' }));

  assert.equal(callCount, 1);
  assert.match(sent[0].text, /haven't published interests yet/);
});

// --- !projects ------------------------------------------------------------------

test('!projects (no query) from a member uses listRecentProjectsFn, never searchProjectsFn', async (t) => {
  mockPoolRole(t, 'member');
  const projects: MemberProject[] = [
    {
      id: 1,
      platform: 'whatsapp',
      userId: 'owner-1',
      name: 'Cool Project',
      description: 'does cool things',
      link: null,
      seekingCollaborators: false,
      createdAt: new Date(),
    },
  ];
  const router = makeRouter({
    runTurn: throwingRunTurn,
    listRecentProjectsFn: async () => projects,
    searchProjectsFn: async () => {
      throw new Error('searchProjectsFn must never be called for the no-query path');
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!projects', userId: 'member-1' }));

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Cool Project/);
});

test('!projects <query> from a member uses searchProjectsFn with the query text', async (t) => {
  mockPoolRole(t, 'member');
  let calledWith: string | undefined;
  const router = makeRouter({
    runTurn: throwingRunTurn,
    searchProjectsFn: async (query) => {
      calledWith = query;
      return [];
    },
    listRecentProjectsFn: async () => {
      throw new Error('listRecentProjectsFn must never be called for the query path');
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!projects rag pipelines', userId: 'member-1' }));

  assert.equal(calledWith, 'rag pipelines');
  assert.equal(sent[0].text, 'No shared projects match that.');
});

test('a bare "!projectsomething" (no space) is not recognised as the /projects command', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({
    listRecentProjectsFn: async () => {
      throw new Error('must never be called for an unrecognised prefix');
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!projectsomething', userId: 'member-1' }));

  assert.equal(sent[0].text, REAL_TURN_REPLY);
});

// --- !projects mine (issue #916) --------------------------------------------

test('acceptance criteria 1-2: "!projects mine" (case-insensitive) from a member uses listOwnProjectsFn(msg.platform, msg.userId), rendered through formatProjectResults, never searchProjectsFn/listRecentProjectsFn', async (t) => {
  mockPoolRole(t, 'member');
  const projects: MemberProject[] = [
    {
      id: 1,
      platform: 'whatsapp',
      userId: 'member-1',
      name: 'My Own Project',
      description: 'built by me',
      link: null,
      seekingCollaborators: false,
      createdAt: new Date(),
    },
  ];
  let calledWith: [Platform, string] | undefined;
  const router = makeRouter({
    runTurn: throwingRunTurn,
    listOwnProjectsFn: async (platform, userId) => {
      calledWith = [platform, userId];
      return projects;
    },
    searchProjectsFn: async () => {
      throw new Error('searchProjectsFn must never be called for "!projects mine"');
    },
    listRecentProjectsFn: async () => {
      throw new Error('listRecentProjectsFn must never be called for "!projects mine"');
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!Projects Mine', userId: 'member-1' }));

  assert.deepEqual(calledWith, ['whatsapp', 'member-1']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /My Own Project/);
});

test('acceptance criterion 3: "!projects mine" from a member with zero shared projects gets the same empty-state string as list_projects({ mine: true }) / /projects mine:true', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({
    runTurn: throwingRunTurn,
    listOwnProjectsFn: async () => [],
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!projects mine', userId: 'member-1' }));

  assert.equal(sent[0].text, "You haven't shared any projects yet.");
});

test('"!projects mine" is checked before the general !projects [query] branch — "mine" as a literal project search term still requires the sub-command shape', async (t) => {
  mockPoolRole(t, 'member');
  let searchCalledWith: string | undefined;
  const router = makeRouter({
    runTurn: throwingRunTurn,
    searchProjectsFn: async (query) => {
      searchCalledWith = query;
      return [];
    },
    listOwnProjectsFn: async () => {
      throw new Error('listOwnProjectsFn must never be called for a query that merely contains "mine"');
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!projects mine field', userId: 'member-1' }));

  assert.equal(searchCalledWith, 'mine field');
  assert.equal(sent[0].text, 'No shared projects match that.');
});

test('acceptance criterion 4: a default `new Router(makeRouterDeps())` with no listOwnProjectsFn override still constructs, and an unrelated existing command (!guidelines) behaves unchanged (trailing defaulted field)', async (t) => {
  mockPoolRole(t, null);
  const router = new Router(makeRouterDeps());
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!guidelines', userId: 'guest-1' }));

  assert.equal(sent[0].text, 'No community guidelines have been set yet — ask an admin.');
});

// --- !guidelines (no tier gate) -----------------------------------------------

test('!guidelines has no tier gate — served even for a guest caller', async (t) => {
  mockPoolRole(t, null); // no community_users row -> guest
  const router = makeRouter({
    runTurn: throwingRunTurn,
    getConductGuidelinesFn: async () => 'Be kind.',
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!guidelines', userId: 'guest-1' }));

  assert.equal(sent[0].text, 'Be kind.');
});

test("!guidelines is language-preference-aware, matching handleGuidelines' 'mi' fallback order", async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({
    runTurn: throwingRunTurn,
    getLangPref: async () => 'mi',
    getLocalisedConductGuidelinesFn: async () => 'Kia atawhai.',
    getConductGuidelinesFn: async () => {
      throw new Error('the English fallback must not be read when the Māori text is present');
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!guidelines', userId: 'member-1' }));

  assert.equal(sent[0].text, 'Kia atawhai.');
});

test('!guidelines replies with the not-set-yet text when no guidelines exist', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({
    runTurn: throwingRunTurn,
    getConductGuidelinesFn: async () => null,
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!guidelines', userId: 'member-1' }));

  assert.match(sent[0].text, /No community guidelines have been set yet/);
});

// --- !digest --------------------------------------------------------------------

test('!digest from a member uses buildDigestContentFn', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({
    runTurn: throwingRunTurn,
    buildDigestContentFn: async () => 'This week: 2 new projects.',
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!digest', userId: 'member-1' }));

  assert.equal(sent[0].text, 'This week: 2 new projects.');
});

test('!digest replies with the fixed "Nothing to report" text when buildDigestContentFn resolves null', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({ runTurn: throwingRunTurn, buildDigestContentFn: async () => null });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!digest', userId: 'member-1' }));

  assert.equal(sent[0].text, 'Nothing to report right now.');
});

// --- !help (issue #993): zero-cost command counterpart to community_info ---

test('!help has no tier gate — served even for a guest caller, mirroring !guidelines', async (t) => {
  mockPoolRole(t, null); // no community_users row -> guest
  const router = makeRouter({ runTurn: throwingRunTurn, recordShortcutHitFn: async () => {} });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!help', userId: 'guest-1' }));

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /don't have access/i);
});

test('!help renders byte-identical text to formatCommunityInfoText(role, "whatsapp") for member/admin/super_admin (issue #993 authoritative criterion 1)', async (t) => {
  const { formatCommunityInfoText } = await import('../src/module/agent/tools.js');
  // A SINGLE t.mock.method call for this whole test, with the role read from
  // a mutable closure variable — calling t.mock.method repeatedly on the same
  // (pool, 'query') target within one test only unwinds one layer on
  // cleanup, permanently leaving pool.query mocked for every later test in
  // the file (reproduced in isolation; not a node:test/mockPoolRole misuse
  // any other test in this file happens to make).
  let currentRole: 'admin' | 'member' | null = null;
  t.mock.method(pool, 'query', (async (sql: string) => {
    if (sql.includes('SELECT role FROM community_users')) {
      return { rows: currentRole ? [{ role: currentRole }] : [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);

  for (const role of ['member', 'admin'] as const) {
    currentRole = role;
    const router = makeRouter({ runTurn: throwingRunTurn, recordShortcutHitFn: async () => {} });
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ text: '!help', userId: `${role}-1` }));

    assert.equal(sent[0].text, formatCommunityInfoText(role, 'whatsapp'));
  }

  // super_admin is resolved from config.rbac.superAdminWhatsappNumbers, never
  // community_users — mutate it directly (config is parsed once at import
  // time, so setting the env var this late would have no effect; this file's
  // top-level env only sets SUPER_ADMIN_DISCORD_IDS, not the WhatsApp one).
  const originalSuperAdmins = [...config.rbac.superAdminWhatsappNumbers];
  config.rbac.superAdminWhatsappNumbers.push('super-1');
  t.after(() => {
    config.rbac.superAdminWhatsappNumbers.length = 0;
    config.rbac.superAdminWhatsappNumbers.push(...originalSuperAdmins);
  });
  currentRole = null;
  const router = makeRouter({ runTurn: throwingRunTurn, recordShortcutHitFn: async () => {} });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!help', userId: 'super-1' }));

  assert.equal(sent[0].text, formatCommunityInfoText('super_admin', 'whatsapp'));
});

test('SECURITY: !help for a member caller never contains ADMIN_CAPABILITIES_TEXT/SUPER_ADMIN_CAPABILITIES_TEXT content, and for an admin caller never contains SUPER_ADMIN_CAPABILITIES_TEXT content (issue #993 authoritative criterion 6)', async (t) => {
  // A SINGLE t.mock.method call for this whole test (mutable role, not a
  // second mockPoolRole call) — re-mocking (pool, 'query') a second time
  // within one test only unwinds one layer on cleanup, permanently leaving
  // pool.query mocked for every later test in the file.
  let currentRole: 'admin' | 'member' | null = 'member';
  t.mock.method(pool, 'query', (async (sql: string) => {
    if (sql.includes('SELECT role FROM community_users')) {
      return { rows: currentRole ? [{ role: currentRole }] : [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);

  const memberRouter = makeRouter({ runTurn: throwingRunTurn, recordShortcutHitFn: async () => {} });
  const member = makeAdapter();
  memberRouter.register(member.adapter);
  await member.trigger(makeMessage({ text: '!help', userId: 'member-1' }));
  assert.doesNotMatch(member.sent[0].text, /warn, mute, kick/i);
  assert.doesNotMatch(member.sent[0].text, /grant or revoke admin status/i);

  currentRole = 'admin';
  const adminRouter = makeRouter({ runTurn: throwingRunTurn, recordShortcutHitFn: async () => {} });
  const admin = makeAdapter();
  adminRouter.register(admin.adapter);
  await admin.trigger(makeMessage({ text: '!help', userId: 'admin-1' }));
  assert.match(admin.sent[0].text, /warn, mute, kick/i);
  assert.doesNotMatch(admin.sent[0].text, /grant or revoke admin status/i);
});

test("a successful !help invocation calls recordShortcutHit('whatsapp_text_command') exactly once (issue #993, mirrors issue #874 acceptance criterion 1)", async (t) => {
  mockPoolRole(t, 'member');
  const hits: string[] = [];
  const router = makeRouter({
    runTurn: throwingRunTurn,
    recordShortcutHitFn: async (kind) => {
      hits.push(kind);
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!help', userId: 'member-1' }));

  assert.equal(sent.length, 1);
  assert.deepEqual(hits, ['whatsapp_text_command']);
});

// --- !status (issue #995, no tier gate) --------------------------------------

test('!status returns the same content check_status returns for the same cache state, and has no tier gate (issue #995 acceptance criteria 1, 2, 3)', async (t) => {
  resetStatusCacheForTests();
  t.after(() => resetStatusCacheForTests());
  await pollAnthropicStatus(async () =>
    JSON.stringify({
      page: { id: 'abc' },
      status: { indicator: 'none', description: 'All Systems Operational' },
      incidents: [],
    }),
  );
  mockPoolRole(t, null); // no community_users row -> guest
  const router = makeRouter({ runTurn: throwingRunTurn });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!status', userId: 'guest-1' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, formatStatusMessage(getStatusCache(), Date.now()));
});

test('a bare "!statusx" (no space, unrecognised) is not matched as the !status command — anchored matcher (issue #995 acceptance criterion 2)', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({});
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!statusx', userId: 'member-1' }));

  assert.equal(sent[0].text, REAL_TURN_REPLY);
});

// --- !warnings (issue #1000) --------------------------------------------------

test(
  '!warnings returns the same content my_warnings returns for the same DB state, across all four count ' +
    'branches (issue #1000 approved acceptance criteria 1, 4)',
  async (t) => {
    const originalLimit = config.moderation.strikeLimit;
    const originalWindow = config.moderation.strikeWindowDays;
    config.moderation.strikeLimit = 3;
    t.after(() => {
      config.moderation.strikeLimit = originalLimit;
      config.moderation.strikeWindowDays = originalWindow;
    });

    config.moderation.strikeWindowDays = undefined;
    const ref = mockPoolRoleAndWarnings(t, 'member', 0);
    let router = makeRouter({ runTurn: throwingRunTurn });
    let { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);
    await trigger(makeMessage({ text: '!warnings', userId: 'member-1' }));
    assert.equal(sent[0].text, formatMyWarningsText(0, 3, null));

    ref.active = 1;
    router = makeRouter({ runTurn: throwingRunTurn });
    ({ adapter, sent, trigger } = makeAdapter());
    router.register(adapter);
    await trigger(makeMessage({ text: '!warnings', userId: 'member-1' }));
    assert.equal(sent[0].text, formatMyWarningsText(1, 3, null));

    config.moderation.strikeWindowDays = 30;
    ref.active = 2;
    ref.windowed = 1;
    router = makeRouter({ runTurn: throwingRunTurn });
    ({ adapter, sent, trigger } = makeAdapter());
    router.register(adapter);
    await trigger(makeMessage({ text: '!warnings', userId: 'member-1' }));
    assert.equal(sent[0].text, formatMyWarningsText(2, 3, 1));

    config.moderation.strikeWindowDays = undefined;
    ref.active = 3;
    router = makeRouter({ runTurn: throwingRunTurn });
    ({ adapter, sent, trigger } = makeAdapter());
    router.register(adapter);
    await trigger(makeMessage({ text: '!warnings', userId: 'member-1' }));
    assert.equal(sent[0].text, formatMyWarningsText(3, 3, null));
  },
);

test('a bare "!warningsx" (no space, unrecognised) is not matched as the !warnings command — anchored matcher (issue #1000 SECURITY criterion 6)', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({});
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!warningsx', userId: 'member-1' }));

  assert.equal(sent[0].text, REAL_TURN_REPLY);
});

test(
  'SECURITY: "!warnings <anything>" is never matched — the anchored matcher rejects any argument, so no ' +
    'message-supplied identifier can ever reach countActiveWarnings (issue #1000 SECURITY criterion 6)',
  async (t) => {
    let warningsQueried = false;
    t.mock.method(pool, 'query', (async (sql: string) => {
      if (sql.includes('SELECT role FROM community_users'))
        return { rows: [{ role: 'member' }], rowCount: 0 };
      if (sql.includes('FROM member_warnings')) {
        warningsQueried = true;
        return { rows: [{ n: 0 }], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }) as typeof pool.query);
    const router = makeRouter({ runTurn: async () => ({ text: REAL_TURN_REPLY }) });
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ text: '!warnings some-other-user-id', userId: 'member-1' }));

    assert.equal(sent[0].text, REAL_TURN_REPLY, 'an argument must fall through to a normal turn');
    assert.equal(warningsQueried, false, 'countActiveWarnings must never run when an argument is present');
  },
);

test(
  'SECURITY: a guest caller\'s "!warnings" falls through to the normal turn — countActiveWarnings is never ' +
    'invoked (issue #1000 approved acceptance criterion 5)',
  async (t) => {
    let warningsQueried = false;
    t.mock.method(pool, 'query', (async (sql: string) => {
      if (sql.includes('SELECT role FROM community_users')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM member_warnings')) {
        warningsQueried = true;
        return { rows: [{ n: 0 }], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }) as typeof pool.query);
    const router = makeRouter({ runTurn: async () => ({ text: REAL_TURN_REPLY }) });
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ text: '!warnings', userId: 'guest-1' }));

    assert.equal(sent.length, 1);
    assert.equal(
      sent[0].text,
      REAL_TURN_REPLY,
      'a guest gets no distinguishing denial reply, per the family norm',
    );
    assert.equal(warningsQueried, false, 'countActiveWarnings must never run for a rejected caller');
  },
);

// --- shortcut_hits tracking (issue #874, acceptance criterion 1) ------------

test('acceptance criterion 1: each of !whois/!projects/!guidelines/!digest/!status/!warnings records exactly one whatsapp_text_command shortcut hit via the shared send path (issue #1000)', async (t) => {
  resetStatusCacheForTests();
  t.after(() => resetStatusCacheForTests());
  mockPoolRoleAndWarnings(t, 'member', 0);
  const hits: string[] = [];
  const router = makeRouter({
    runTurn: throwingRunTurn,
    recordShortcutHitFn: async (kind) => {
      hits.push(kind);
    },
    searchMemberInterestsFn: async () => [
      { platform: 'whatsapp', userId: 'target-1', interests: 'rust', similarity: 0.9 },
    ],
    listRecentProjectsFn: async () => [],
    getConductGuidelinesFn: async () => 'Be kind.',
    buildDigestContentFn: async () => 'Nothing much.',
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!whois rust', userId: 'member-1' }));
  await trigger(makeMessage({ text: '!projects', userId: 'member-1' }));
  await trigger(makeMessage({ text: '!guidelines', userId: 'member-1' }));
  await trigger(makeMessage({ text: '!digest', userId: 'member-1' }));
  await trigger(makeMessage({ text: '!status', userId: 'member-1' }));
  await trigger(makeMessage({ text: '!warnings', userId: 'member-1' }));

  assert.equal(sent.length, 6);
  assert.deepEqual(
    hits,
    [
      'whatsapp_text_command',
      'whatsapp_text_command',
      'whatsapp_text_command',
      'whatsapp_text_command',
      'whatsapp_text_command',
      'whatsapp_text_command',
    ],
    'all six commands must record exactly one whatsapp_text_command hit each, via the shared send path',
  );
});

test('SECURITY: a message that falls through to a normal turn (unrecognised prefix) never records a whatsapp_text_command hit (issue #874)', async (t) => {
  mockPoolRole(t, 'member');
  const hits: string[] = [];
  const router = makeRouter({
    runTurn: async () => ({ text: REAL_TURN_REPLY }),
    recordShortcutHitFn: async (kind) => {
      hits.push(kind);
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: 'just a normal message', userId: 'member-1' }));

  assert.equal(sent[0].text, REAL_TURN_REPLY);
  assert.deepEqual(hits, [], 'a fallthrough turn must never record a shortcut hit');
});

test('SECURITY: the recorded whatsapp_text_command kind is a fixed literal, never derived from the message text — even adversarial content in the !whois query (issue #874)', async (t) => {
  mockPoolRole(t, 'member');
  const hits: string[] = [];
  const router = makeRouter({
    runTurn: throwingRunTurn,
    recordShortcutHitFn: async (kind) => {
      hits.push(kind);
    },
    searchMemberInterestsFn: async () => [],
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  const adversarialQuery = "slash_command'; DROP TABLE shortcut_hits; --";
  await trigger(makeMessage({ text: `!whois ${adversarialQuery}`, userId: 'member-1' }));

  assert.equal(sent.length, 1);
  assert.deepEqual(
    hits,
    ['whatsapp_text_command'],
    'the recorded kind is always the fixed literal, regardless of the message body',
  );
});

// --- SECURITY: tier floors + silent fallthrough (acceptance criteria 3, 6) ---

async function assertGuestFallsThroughSilently(
  t: { mock: { method: typeof import('node:test').mock.method } },
  cmd: string,
) {
  mockPoolRole(t, null); // no community_users row -> guest
  const router = makeRouter({
    runTurn: async () => ({ text: REAL_TURN_REPLY }),
    searchMemberInterestsFn: async () => {
      throw new Error('searchMemberInterestsFn must never be invoked for a rejected caller');
    },
    searchMemberInterestsForSelfFn: async () => {
      throw new Error('searchMemberInterestsForSelfFn must never be invoked for a rejected caller');
    },
    searchProjectsFn: async () => {
      throw new Error('searchProjectsFn must never be invoked for a rejected caller');
    },
    listRecentProjectsFn: async () => {
      throw new Error('listRecentProjectsFn must never be invoked for a rejected caller');
    },
    listOwnProjectsFn: async () => {
      throw new Error('listOwnProjectsFn must never be invoked for a rejected caller');
    },
    listRecentInterestsFn: async () => {
      throw new Error('listRecentInterestsFn must never be invoked for a rejected caller');
    },
    buildDigestContentFn: async () => {
      throw new Error('buildDigestContentFn must never be invoked for a rejected caller');
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: cmd, userId: 'guest-1' }));

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].text,
    REAL_TURN_REPLY,
    'a guest must get the normal turn reply, never a distinguishing "not authorized" text',
  );
  assert.ok(!sent[0].text.toLowerCase().includes("don't have access"));
}

test('SECURITY: a guest caller\'s "!whois rust" falls through to the normal turn — no distinguishing denial reply (acceptance criteria 3, 6)', async (t) => {
  await assertGuestFallsThroughSilently(t, '!whois rust');
});

test('SECURITY: a guest caller\'s bare "!whois" falls through to the normal turn — searchMemberInterestsForSelfFn is never invoked (issue #889 acceptance criterion 5)', async (t) => {
  await assertGuestFallsThroughSilently(t, '!whois');
});

test('SECURITY: a guest caller\'s "!projects" falls through to the normal turn — no distinguishing denial reply (acceptance criteria 3, 6)', async (t) => {
  await assertGuestFallsThroughSilently(t, '!projects');
});

test('SECURITY: a guest caller\'s "!digest" falls through to the normal turn — no distinguishing denial reply (acceptance criteria 3, 6)', async (t) => {
  await assertGuestFallsThroughSilently(t, '!digest');
});

test('SECURITY: a sub-member caller\'s "!projects mine" falls through to the normal turn — listOwnProjectsFn is never invoked (issue #916 binding acceptance criterion 6)', async (t) => {
  await assertGuestFallsThroughSilently(t, '!projects mine');
});

test('SECURITY: "!projects mine" for caller A never returns caller B\'s projects — only the caller\'s own resolved msg.platform/msg.userId is wired into listOwnProjectsFn (issue #916 binding acceptance criterion 7)', async (t) => {
  mockPoolRole(t, 'member');
  let calledArgs: [Platform, string] | undefined;
  const ownProjects: MemberProject[] = [
    {
      id: 2,
      platform: 'whatsapp',
      userId: 'caller-a',
      name: "A's Project",
      description: 'owned by caller A',
      link: null,
      seekingCollaborators: false,
      createdAt: new Date(),
    },
  ];
  const router = makeRouter({
    runTurn: throwingRunTurn,
    listOwnProjectsFn: async (platform, userId) => {
      calledArgs = [platform, userId];
      // Self-scoped stub: only ever returns caller A's own projects,
      // regardless of what identifier the surrounding message carries.
      return userId === 'caller-a' ? ownProjects : [];
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  // userName spoofs caller B's identity — the implicit "mine" scope must
  // come only from msg.platform/msg.userId, never from any other message field.
  await trigger(
    makeMessage({ text: '!projects mine', userId: 'caller-a', userName: 'caller-b-impersonation' }),
  );

  assert.deepEqual(calledArgs, ['whatsapp', 'caller-a']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /A's Project/);
  assert.doesNotMatch(sent[0].text, /caller-b/i);
});

test("SECURITY: bare !whois's implicit query is built only from the caller's platform/userId, never from any other message field (issue #634 AC #4 / #889 acceptance criterion 6)", async (t) => {
  mockPoolRole(t, 'member');
  let calledArgs: unknown[] | undefined;
  const router = makeRouter({
    runTurn: throwingRunTurn,
    searchMemberInterestsFn: async () => {
      throw new Error(
        'searchMemberInterestsFn (the explicit-query path) must never be called for bare !whois',
      );
    },
    searchMemberInterestsForSelfFn: async (...args: unknown[]) => {
      calledArgs = args;
      return { hasProfile: true, hits: [] };
    },
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  // userName carries another member's published interest phrase — the
  // literal !whois token is the only text consulted; the implicit query
  // must come only from platform/userId, never from this or any other
  // surrounding message field.
  await trigger(
    makeMessage({
      text: '!whois',
      userId: 'member-1',
      userName: "Alice's rust and distributed-systems interests",
    }),
  );

  assert.deepEqual(calledArgs?.slice(0, 2), ['whatsapp', 'member-1']);
  assert.equal(sent[0].text, 'No members have published interests matching that yet.');
});

// --- SECURITY: the sole send path is adapter.sendMessage (criterion 7) -----

test('SECURITY: a served text-command reply is sent via adapter.sendMessage exactly once — the same filtered() send path every other router reply uses (acceptance criterion 7)', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({
    runTurn: throwingRunTurn,
    getConductGuidelinesFn: async () => 'Be kind.',
  });
  let directMessageCalls = 0;
  const { adapter, sent, trigger } = makeAdapter({
    async sendDirectMessage() {
      directMessageCalls++;
    },
  });
  router.register(adapter);

  await trigger(makeMessage({ text: '!guidelines', userId: 'member-1' }));

  assert.equal(sent.length, 1, 'sendMessage (the filtered send path) must be called exactly once');
  assert.equal(directMessageCalls, 0, 'no reply may go out via a different, unfiltered send primitive');
});

// --- Acceptance criterion 8: counts toward dailyReplyLimitPerUser -----------

test(
  'acceptance criterion 8: a served WhatsApp text-command reply is recorded exactly like a real answer — meta.replyToUserId — and counts toward the daily reply budget',
  { skip: !hasDb },
  async () => {
    // Deliberately NOT mocking pool.query here — this test exercises the
    // REAL DB-backed recordInteraction/countRepliesToUser path issue #859's
    // acceptance criterion 8 requires. BUDGET_USER_ID has no community_users
    // row, so resolveRole resolves it to 'guest' for real — irrelevant here
    // since !guidelines carries no tier gate.
    const userId = BUDGET_USER_ID;
    const before = await countRepliesToUser('whatsapp', userId);

    const router = new Router(
      makeRouterDeps({
        runTurn: throwingRunTurn,
        typingRefireMs: 20,
        checkPaused: async () => false,
        countReplies: countRepliesToUser,
        getConductGuidelinesFn: async () => 'Be kind.',
      }),
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage({ text: '!guidelines', userId, conversationId: `${RUN}-budget` }));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'Be kind.');

    const after = await countRepliesToUser('whatsapp', userId);
    assert.equal(after - before, 1, 'the served reply must be counted toward the daily reply budget');

    const { rows } = await pool.query(
      `SELECT meta FROM interactions WHERE direction = 'outbound' AND meta->>'replyToUserId' = $1 AND platform = 'whatsapp' ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    assert.equal(rows[0]?.meta?.whatsappTextCommand, true);
  },
);
