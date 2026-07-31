import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, Platform, PlatformAdapter } from '../src/platforms/types.js';
import type {
  MemberInterestRow,
  MemberInterestSearchHit,
  SelfInterestMatchResult,
} from '../src/storage/repository/memberDiscovery.js';
import type { MemberProject, MemberProjectSearchHit } from '../src/storage/repository/memberProjects.js';
import type { ShortcutKind } from '../src/storage/repository/shortcutHits.js';

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
// Run-unique identity for the real-DB daily-budget assertion (mirrors
// repeatQuestionShortcutRouter.test.ts's BUDGET_USER_ID rationale exactly:
// countRepliesToUser aggregates outbound replies for an IDENTITY across the
// WHOLE interactions table over a sliding 24h window, so a shared fixture id
// could pick up another parallel test file's concurrent writes).
const BUDGET_USER_ID = `wa-cmd-budget-${process.pid}-${Date.now()}`;
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const { Router } = await import('../src/router.js');
const { countRepliesToUser } = await import('../src/storage/repository.js');

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
  buildMemberDigestContentFn?: () => Promise<string | null>;
  getCommunityGuidelinesFn?: () => Promise<string | null>;
  getCommunityGuidelinesMiFn?: () => Promise<string | null>;
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
    opts.runTurn ?? (async () => ({ text: REAL_TURN_REPLY })), // 1 runTurn
    20, // 2 typingRefireMs
    async () => false, // 3 checkPaused
    undefined, // 4 searchKnowledgeForShortcut
    undefined, // 5 recordShortcutRetrieval
    async () => 0, // 6 countReplies — always under budget, deterministic
    opts.getLangPref, // 7 getLangPref
    undefined, // 8 checkLowRatedKnowledge
    undefined, // 9 getGatedNotice
    undefined, // 10 getRespStyle
    opts.recordShortcutHitFn, // 11 recordShortcutHit
    undefined, // 12 recordAccessRequestFn
    undefined, // 13 notifyAccessRequestFn
    undefined, // 14 notifyAdminsFn
    undefined, // 15 recordEscalatedGapFn
    undefined, // 16 markKnowledgeGapsAlertedFn
    undefined, // 17 markStaleKnowledgeAlertedFn
    opts.getCommunityGuidelinesFn, // 18
    opts.getCommunityGuidelinesMiFn, // 19
    opts.searchMemberInterestsFn, // 20
    opts.searchProjectsFn, // 21
    opts.listRecentProjectsFn, // 22
    opts.buildMemberDigestContentFn, // 23
    undefined, // 24 recentQuestionClustersFn
    opts.searchMemberInterestsForSelfFn, // 25
    undefined, // 26 checkKnowledgeConflict
    opts.listOwnProjectsFn, // 27
    opts.listRecentInterestsFn, // 28
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

test('config: WHATSAPP_TEXT_COMMANDS_ENABLED=true is reflected in config.behaviour.whatsappTextCommandsEnabled', () => {
  assert.equal(config.behaviour.whatsappTextCommandsEnabled, true);
});

// --- Acceptance criterion 5 / regression: flag off is byte-identical --------

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

test('acceptance criterion 4: a bare `new Router()` with no listOwnProjectsFn override still constructs, and an unrelated existing command (!guidelines) behaves unchanged (trailing defaulted field)', async (t) => {
  mockPoolRole(t, null);
  const router = new Router();
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
    getCommunityGuidelinesFn: async () => 'Be kind.',
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
    getCommunityGuidelinesMiFn: async () => 'Kia atawhai.',
    getCommunityGuidelinesFn: async () => {
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
    getCommunityGuidelinesFn: async () => null,
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!guidelines', userId: 'member-1' }));

  assert.match(sent[0].text, /No community guidelines have been set yet/);
});

// --- !digest --------------------------------------------------------------------

test('!digest from a member uses buildMemberDigestContentFn', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({
    runTurn: throwingRunTurn,
    buildMemberDigestContentFn: async () => 'This week: 2 new projects.',
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!digest', userId: 'member-1' }));

  assert.equal(sent[0].text, 'This week: 2 new projects.');
});

test('!digest replies with the fixed "Nothing to report" text when buildMemberDigestContentFn resolves null', async (t) => {
  mockPoolRole(t, 'member');
  const router = makeRouter({ runTurn: throwingRunTurn, buildMemberDigestContentFn: async () => null });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!digest', userId: 'member-1' }));

  assert.equal(sent[0].text, 'Nothing to report right now.');
});

// --- shortcut_hits tracking (issue #874, acceptance criterion 1) ------------

test('acceptance criterion 1: each of !whois/!projects/!guidelines/!digest records exactly one whatsapp_text_command shortcut hit via the shared send path', async (t) => {
  mockPoolRole(t, 'member');
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
    getCommunityGuidelinesFn: async () => 'Be kind.',
    buildMemberDigestContentFn: async () => 'Nothing much.',
  });
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage({ text: '!whois rust', userId: 'member-1' }));
  await trigger(makeMessage({ text: '!projects', userId: 'member-1' }));
  await trigger(makeMessage({ text: '!guidelines', userId: 'member-1' }));
  await trigger(makeMessage({ text: '!digest', userId: 'member-1' }));

  assert.equal(sent.length, 4);
  assert.deepEqual(
    hits,
    ['whatsapp_text_command', 'whatsapp_text_command', 'whatsapp_text_command', 'whatsapp_text_command'],
    'all four commands must record exactly one whatsapp_text_command hit each, via the shared send path',
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
    buildMemberDigestContentFn: async () => {
      throw new Error('buildMemberDigestContentFn must never be invoked for a rejected caller');
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
    getCommunityGuidelinesFn: async () => 'Be kind.',
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
      throwingRunTurn,
      20,
      async () => false,
      undefined,
      undefined,
      countRepliesToUser,
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
      async () => 'Be kind.',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
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
