import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it. These unit tests never
// touch a DB or Discord: the store and enforcer are in-memory fakes and the
// classifier is injected, so they run in the security-invariants job too.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { makeWordlistDetector } = await import('../src/moderation/wordlist.js');
const { Moderator, makeClassifier } = await import('../src/moderation/moderator.js');
const { toolsForRole } = await import('../src/auth/rbac.js');

type ModeratorType = InstanceType<typeof Moderator>;

function makeStore() {
  const counts = new Map<string, number>();
  const added: Array<{ platform: string; userId: string; source: string; reason: string }> = [];
  const key = (p: string, u: string) => `${p}:${u}`;
  return {
    added,
    async addWarning(w: { platform: string; userId: string; reason: string; source: string }) {
      added.push({ platform: w.platform, userId: w.userId, source: w.source, reason: w.reason });
      counts.set(key(w.platform, w.userId), (counts.get(key(w.platform, w.userId)) ?? 0) + 1);
    },
    async countActiveWarnings(platform: string, userId: string) {
      return counts.get(key(platform, userId)) ?? 0;
    },
  };
}

function makeEnforcer(overrides: Record<string, unknown> = {}) {
  const calls = {
    warnUser: [] as Array<[string, string]>,
    muteUser: [] as string[],
    unmuteUser: [] as string[],
    postAdminAlert: [] as string[],
  };
  const base = {
    calls,
    async warnUser(userId: string, text: string) {
      calls.warnUser.push([userId, text]);
    },
    async muteUser(userId: string) {
      calls.muteUser.push(userId);
    },
    async unmuteUser(userId: string) {
      calls.unmuteUser.push(userId);
    },
    async postAdminAlert(text: string) {
      calls.postAdminAlert.push(text);
    },
  };
  return { ...base, ...overrides };
}

function makeModerator(opts: {
  enabled?: boolean;
  strikeLimit?: number;
  isExempt?: (p: string, u: string) => Promise<boolean>;
  classify?: (text: string) => Promise<{ reason: string; excerpt: string } | null>;
  store?: ReturnType<typeof makeStore>;
  enforcer?: ReturnType<typeof makeEnforcer>;
}): {
  moderator: ModeratorType;
  store: ReturnType<typeof makeStore>;
  enforcer: ReturnType<typeof makeEnforcer>;
} {
  const store = opts.store ?? makeStore();
  const enforcer = opts.enforcer ?? makeEnforcer();
  const detect = makeWordlistDetector();
  const moderator = new Moderator({
    enabled: opts.enabled ?? true,
    strikeLimit: opts.strikeLimit ?? 3,
    classify: opts.classify ?? (async (t) => detect(t)),
    isExempt: opts.isExempt ?? (async () => false),
    store,
    enforcer,
  });
  return { moderator, store, enforcer };
}

const msg = (text: string, userId = 'u1') => ({
  platform: 'discord' as const,
  userId,
  userName: 'Someone',
  text,
});

// --- wordlist detector -------------------------------------------------------

test('wordlist detector flags a bad word as a whole word, with an excerpt', () => {
  const detect = makeWordlistDetector();
  const hit = detect('you are a total asshole honestly');
  assert.ok(hit, 'expected a detection');
  assert.match(hit.reason, /bad language/);
  assert.match(hit.excerpt, /asshole/);
});

test('wordlist detector does not trip on innocent substrings (whole-word match)', () => {
  const detect = makeWordlistDetector();
  assert.equal(detect('I sat in the grass in class'), null, '"ass" inside "grass"/"class" must not match');
  assert.equal(detect('the assistant helped me'), null, '"ass" inside "assistant" must not match');
});

test('wordlist detector honours operator-supplied extra terms (case-insensitive)', () => {
  const detect = makeWordlistDetector(['frobnicate']);
  const hit = detect('please stop FROBNICATING... frobnicate elsewhere');
  assert.ok(hit);
});

// --- Moderator orchestration -------------------------------------------------

test('Moderator does nothing when disabled', async () => {
  const { moderator, store, enforcer } = makeModerator({ enabled: false });
  await moderator.scan(msg('you asshole'));
  assert.equal(store.added.length, 0);
  assert.equal(enforcer.calls.warnUser.length, 0);
  assert.equal(enforcer.calls.postAdminAlert.length, 0);
});

test('Moderator ignores a clean message', async () => {
  const { moderator, store, enforcer } = makeModerator({});
  await moderator.scan(msg('hello, how do I use the API?'));
  assert.equal(store.added.length, 0);
  assert.equal(enforcer.calls.warnUser.length, 0);
});

test('Moderator warns (but does not mute) on the first flagged message', async () => {
  const { moderator, store, enforcer } = makeModerator({ strikeLimit: 3 });
  await moderator.scan(msg('you asshole'));
  assert.equal(store.added.length, 1);
  assert.equal(store.added[0].source, 'auto');
  assert.equal(enforcer.calls.warnUser.length, 1, 'the member gets a warning DM');
  assert.equal(enforcer.calls.postAdminAlert.length, 1, 'the admin channel is notified');
  assert.equal(enforcer.calls.muteUser.length, 0, 'not muted below the limit');
});

test('SECURITY: a member is muted only once the active-strike count reaches the limit, never before', async () => {
  const { moderator, enforcer } = makeModerator({ strikeLimit: 3 });
  await moderator.scan(msg('asshole one'));
  await moderator.scan(msg('asshole two'));
  assert.equal(enforcer.calls.muteUser.length, 0, 'still not muted at 2/3');
  await moderator.scan(msg('asshole three'));
  assert.equal(enforcer.calls.muteUser.length, 1, 'muted exactly at 3/3');
  assert.equal(enforcer.calls.muteUser[0], 'u1');
  // The block alert (not just a warning) goes to the admin channel.
  assert.match(enforcer.calls.postAdminAlert.at(-1)!, /muted|blocked/i);
});

test('SECURITY: admins and super admins are never warned or muted, even on a flagged message', async () => {
  const { moderator, store, enforcer } = makeModerator({
    strikeLimit: 1, // would mute on the very first strike if not exempt
    isExempt: async () => true,
  });
  await moderator.scan(msg('you absolute asshole'));
  assert.equal(store.added.length, 0, 'no warning recorded for an exempt user');
  assert.equal(enforcer.calls.warnUser.length, 0);
  assert.equal(enforcer.calls.muteUser.length, 0);
  assert.equal(enforcer.calls.postAdminAlert.length, 0);
});

test('Moderator: a failing enforcement step is swallowed and does not abort the rest or throw', async () => {
  const enforcer = makeEnforcer({
    warnUser: async () => {
      throw new Error('DMs closed');
    },
  });
  const { moderator } = makeModerator({ strikeLimit: 3, enforcer });
  await assert.doesNotReject(moderator.scan(msg('you asshole')));
  // The warn DM threw, but the admin alert still fired.
  assert.equal(enforcer.calls.postAdminAlert.length, 1);
});

// --- two-stage classifier gating --------------------------------------------

test('makeClassifier never calls the LLM when llmAbuseEnabled is off', async () => {
  let llmCalls = 0;
  const classify = makeClassifier({
    badWords: [],
    llmAbuseEnabled: false,
    llm: async () => {
      llmCalls += 1;
      return { reason: 'abuse', excerpt: '' };
    },
  });
  // A message the wordlist won't catch — the only path to a flag is the LLM,
  // which must stay off.
  assert.equal(await classify('you are being unkind and I disagree'), null);
  assert.equal(llmCalls, 0, 'the LLM classifier must not run when disabled');
});

test('makeClassifier escalates a wordlist-clean message to the LLM only when enabled', async () => {
  let llmCalls = 0;
  const classify = makeClassifier({
    badWords: [],
    llmAbuseEnabled: true,
    llm: async () => {
      llmCalls += 1;
      return { reason: 'abuse (targeted harassment)', excerpt: 'x' };
    },
  });
  const hit = await classify('some subtle harassment the wordlist misses');
  assert.equal(llmCalls, 1);
  assert.ok(hit && /abuse/.test(hit.reason));
});

test('makeClassifier short-circuits on a wordlist hit without calling the LLM', async () => {
  let llmCalls = 0;
  const classify = makeClassifier({
    badWords: [],
    llmAbuseEnabled: true,
    llm: async () => {
      llmCalls += 1;
      return null;
    },
  });
  const hit = await classify('you asshole');
  assert.ok(hit, 'wordlist catches it');
  assert.equal(llmCalls, 0, 'no LLM call when the wordlist already flagged it');
});

// --- RBAC surface ------------------------------------------------------------

test('SECURITY: clear_warnings is admin-tier only — absent from the member/guest surface', () => {
  const tool = 'mcp__community__clear_warnings';
  assert.ok(toolsForRole('admin').includes(tool), 'admins have clear_warnings');
  assert.ok(toolsForRole('super_admin').includes(tool), 'super admins have clear_warnings');
  assert.ok(!toolsForRole('member').includes(tool), 'members must not have clear_warnings');
  assert.ok(!toolsForRole('guest').includes(tool), 'guests must not have clear_warnings');
});
