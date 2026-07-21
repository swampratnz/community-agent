import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Classifier } from '../src/moderation/moderator.js';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it. These unit tests never
// touch a DB or Discord: the store and enforcer are in-memory fakes and the
// classifier is injected, so they run in the security-invariants job too.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { makeWordlistDetector } = await import('../src/moderation/wordlist.js');
const {
  Moderator,
  makeClassifier,
  boundForClassifier,
  warnDmText,
  blockedDmText,
  warnDmTextMi,
  blockedDmTextMi,
  warnDmTextPlain,
  blockedDmTextPlain,
  moderationAlertSummaryText,
} = await import('../src/moderation/moderator.js');
const { toolsForRole } = await import('../src/auth/rbac.js');

test('SECURITY: boundForClassifier keeps the tail so abuse hidden after filler is still classified', () => {
  // A message can run to ~2000 chars; a flat slice(0, 500) never sees a slur
  // placed after 500 chars of padding. boundForClassifier must include both
  // the head and the tail of an over-length message.
  const slur = 'ABUSIVE-TERM-AT-THE-END';
  const padded = `${'benign filler '.repeat(200)}${slur}`;
  assert.ok(padded.length > 500, 'the test input must exceed the flat 500-char cap to be meaningful');
  const bounded = boundForClassifier(padded);
  assert.ok(
    bounded.includes(slur),
    'the tail (where the abuse hides) must survive into the classifier input',
  );
  assert.ok(bounded.length < padded.length, 'the input is still bounded, not passed whole');
  // A short message is passed through unchanged (only angle brackets stripped).
  assert.equal(boundForClassifier('just a normal message'), 'just a normal message');
});

type ModeratorType = InstanceType<typeof Moderator>;

function makeStore() {
  const counts = new Map<string, number>();
  const added: Array<{ platform: string; userId: string; source: string; reason: string }> = [];
  const windowDaysSeen: Array<number | undefined> = [];
  const key = (p: string, u: string) => `${p}:${u}`;
  return {
    added,
    windowDaysSeen,
    async addWarning(w: { platform: string; userId: string; reason: string; source: string }) {
      added.push({ platform: w.platform, userId: w.userId, source: w.source, reason: w.reason });
      counts.set(key(w.platform, w.userId), (counts.get(key(w.platform, w.userId)) ?? 0) + 1);
    },
    async countActiveWarnings(platform: string, userId: string, windowDays?: number) {
      windowDaysSeen.push(windowDays);
      return counts.get(key(platform, userId)) ?? 0;
    },
  };
}

function makeEnforcer(overrides: Record<string, unknown> = {}) {
  const calls = {
    warnUser: [] as Array<[string, string]>,
    warnInChannel: [] as Array<[string, string]>,
    muteUser: [] as string[],
    unmuteUser: [] as string[],
    postAdminAlert: [] as string[],
  };
  const base = {
    calls,
    async warnUser(userId: string, text: string) {
      calls.warnUser.push([userId, text]);
    },
    async warnInChannel(channelId: string, text: string) {
      calls.warnInChannel.push([channelId, text]);
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
  strikeWindowDays?: number;
  alertRateLimitPerHour?: number;
  isExempt?: (p: string, u: string) => Promise<boolean>;
  getLanguagePreference?: (p: string, u: string) => Promise<'auto' | 'en' | 'mi'>;
  getResponseStyle?: (p: string, u: string) => Promise<'standard' | 'plain'>;
  classify?: Classifier;
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
    strikeWindowDays: opts.strikeWindowDays,
    // Matches the production default (config.moderation.alertRateLimitPerHour
    // = 30) so existing tests below the cap stay byte-identical unless a test
    // opts into a smaller cap to exercise the alert-cap behaviour itself.
    alertRateLimitPerHour: opts.alertRateLimitPerHour ?? 30,
    classify: opts.classify ?? (async (t) => detect(t)),
    isExempt: opts.isExempt ?? (async () => false),
    getLanguagePreference: opts.getLanguagePreference ?? (async () => 'auto'),
    getResponseStyle: opts.getResponseStyle ?? (async () => 'standard'),
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
  channelId: 'chan1',
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
  assert.equal(enforcer.calls.warnInChannel.length, 1, 'a public warning is posted in-channel');
  assert.equal(enforcer.calls.postAdminAlert.length, 1, 'the admin channel is notified');
  assert.equal(enforcer.calls.muteUser.length, 0, 'not muted below the limit');
});

test('the public in-channel warning names the member only — no user id, matched word, or excerpt', async () => {
  const { moderator, enforcer } = makeModerator({ strikeLimit: 3 });
  await moderator.scan(msg('you asshole', 'user-12345'));
  assert.equal(enforcer.calls.warnInChannel.length, 1);
  const [channelId, text] = enforcer.calls.warnInChannel[0];
  assert.equal(channelId, 'chan1', 'posted in the channel the message came from');
  assert.match(text, /Someone/, 'names the member');
  assert.doesNotMatch(text, /user-12345/, 'must not leak the user id');
  assert.doesNotMatch(text, /asshole/i, 'must not echo the matched word or excerpt');
  // The detailed record (id + matched word) still goes to the private admin channel.
  assert.match(enforcer.calls.postAdminAlert[0], /user-12345/, 'admin log keeps the id for clear_warnings');
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

test('Moderator: unset strikeWindowDays threads through as undefined (unbounded, unset ⇒ unchanged behaviour)', async () => {
  const { moderator, store } = makeModerator({ strikeLimit: 3 });
  await moderator.scan(msg('you asshole'));
  assert.deepEqual(store.windowDaysSeen, [undefined]);
});

test('Moderator: a configured strikeWindowDays is passed through to countActiveWarnings unchanged', async () => {
  const { moderator, store } = makeModerator({ strikeLimit: 3, strikeWindowDays: 30 });
  await moderator.scan(msg('you asshole'));
  assert.deepEqual(store.windowDaysSeen, [30]);
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

// --- 'mi' language preference on the warn/block DMs (issue #333) ------------

test('Moderator: a member with a standing "mi" preference gets the te reo warn DM, not the English default', async () => {
  const { moderator, enforcer } = makeModerator({
    strikeLimit: 3,
    getLanguagePreference: async () => 'mi',
  });
  await moderator.scan(msg('you asshole'));
  assert.equal(enforcer.calls.warnUser.length, 1);
  assert.equal(enforcer.calls.warnUser[0][1], warnDmTextMi(1, 3));
});

test('Moderator: a member with a standing "mi" preference gets the te reo block DM at the strike limit', async () => {
  const { moderator, enforcer } = makeModerator({
    strikeLimit: 1,
    getLanguagePreference: async () => 'mi',
  });
  await moderator.scan(msg('you asshole'));
  assert.equal(enforcer.calls.warnUser.length, 1);
  assert.equal(enforcer.calls.warnUser[0][1], blockedDmTextMi());
});

test('Moderator: "auto"/"en" preference gets byte-identical English DM text on both warn and block', async () => {
  for (const pref of ['auto', 'en'] as const) {
    const warnCase = makeModerator({ strikeLimit: 3, getLanguagePreference: async () => pref });
    await warnCase.moderator.scan(msg('you asshole'));
    assert.equal(warnCase.enforcer.calls.warnUser[0][1], warnDmText(1, 3));

    const blockCase = makeModerator({ strikeLimit: 1, getLanguagePreference: async () => pref });
    await blockCase.moderator.scan(msg('you asshole'));
    assert.equal(blockCase.enforcer.calls.warnUser[0][1], blockedDmText());
  }
});

test('SECURITY: a language-lookup failure degrades to English and never skips warning/mute enforcement', async () => {
  const failingLangPref = async () => {
    throw new Error('language_prefs lookup failed');
  };

  // Below the strike limit: warning still recorded, DM sent in English, admin alerted.
  const warnCase = makeModerator({ strikeLimit: 3, getLanguagePreference: failingLangPref });
  await assert.doesNotReject(warnCase.moderator.scan(msg('you asshole')));
  assert.equal(warnCase.store.added.length, 1, 'the warning is still recorded');
  assert.equal(warnCase.enforcer.calls.warnUser.length, 1);
  assert.equal(warnCase.enforcer.calls.warnUser[0][1], warnDmText(1, 3), 'degrades to the English default');
  assert.equal(warnCase.enforcer.calls.postAdminAlert.length, 1, 'the admin alert still fires');

  // At the strike limit: mute still applied, block DM sent in English, admin alerted.
  const blockCase = makeModerator({ strikeLimit: 1, getLanguagePreference: failingLangPref });
  await assert.doesNotReject(blockCase.moderator.scan(msg('you asshole')));
  assert.equal(blockCase.enforcer.calls.muteUser.length, 1, 'the mute is still applied');
  assert.equal(blockCase.enforcer.calls.warnUser.length, 1);
  assert.equal(blockCase.enforcer.calls.warnUser[0][1], blockedDmText(), 'degrades to the English default');
  assert.equal(blockCase.enforcer.calls.postAdminAlert.length, 1, 'the admin alert still fires');
});

// --- 'plain' response style on the warn/block DMs (issue #657) -------------

test('Moderator: a member with a standing "plain" response style gets the plain-language warn DM, not the English default', async () => {
  const { moderator, enforcer } = makeModerator({
    strikeLimit: 3,
    getResponseStyle: async () => 'plain',
  });
  await moderator.scan(msg('you asshole'));
  assert.equal(enforcer.calls.warnUser.length, 1);
  assert.equal(enforcer.calls.warnUser[0][1], warnDmTextPlain(1, 3));
});

test('Moderator: a member with a standing "plain" response style gets the plain-language block DM at the strike limit', async () => {
  const { moderator, enforcer } = makeModerator({
    strikeLimit: 1,
    getResponseStyle: async () => 'plain',
  });
  await moderator.scan(msg('you asshole'));
  assert.equal(enforcer.calls.warnUser.length, 1);
  assert.equal(enforcer.calls.warnUser[0][1], blockedDmTextPlain());
});

test('Moderator: "standard" response style gets byte-identical English DM text on both warn and block', async () => {
  const warnCase = makeModerator({ strikeLimit: 3, getResponseStyle: async () => 'standard' });
  await warnCase.moderator.scan(msg('you asshole'));
  assert.equal(warnCase.enforcer.calls.warnUser[0][1], warnDmText(1, 3));

  const blockCase = makeModerator({ strikeLimit: 1, getResponseStyle: async () => 'standard' });
  await blockCase.moderator.scan(msg('you asshole'));
  assert.equal(blockCase.enforcer.calls.warnUser[0][1], blockedDmText());
});

test("Moderator: a standing 'mi' language preference wins over a standing 'plain' response style on both warn and block DMs (precedence: mi > plain > standard)", async () => {
  const warnCase = makeModerator({
    strikeLimit: 3,
    getLanguagePreference: async () => 'mi',
    getResponseStyle: async () => 'plain',
  });
  await warnCase.moderator.scan(msg('you asshole'));
  assert.equal(warnCase.enforcer.calls.warnUser[0][1], warnDmTextMi(1, 3));
  assert.notEqual(warnCase.enforcer.calls.warnUser[0][1], warnDmTextPlain(1, 3));

  const blockCase = makeModerator({
    strikeLimit: 1,
    getLanguagePreference: async () => 'mi',
    getResponseStyle: async () => 'plain',
  });
  await blockCase.moderator.scan(msg('you asshole'));
  assert.equal(blockCase.enforcer.calls.warnUser[0][1], blockedDmTextMi());
  assert.notEqual(blockCase.enforcer.calls.warnUser[0][1], blockedDmTextPlain());
});

test('SECURITY: a response-style lookup failure degrades to English and never skips warning/mute enforcement', async () => {
  const failingRespStyle = async () => {
    throw new Error('response_style_prefs lookup failed');
  };

  // Below the strike limit: warning still recorded, DM sent in English, admin alerted.
  const warnCase = makeModerator({ strikeLimit: 3, getResponseStyle: failingRespStyle });
  await assert.doesNotReject(warnCase.moderator.scan(msg('you asshole')));
  assert.equal(warnCase.store.added.length, 1, 'the warning is still recorded');
  assert.equal(warnCase.enforcer.calls.warnUser.length, 1);
  assert.equal(warnCase.enforcer.calls.warnUser[0][1], warnDmText(1, 3), 'degrades to the English default');
  assert.equal(warnCase.enforcer.calls.postAdminAlert.length, 1, 'the admin alert still fires');

  // At the strike limit: mute still applied, block DM sent in English, admin alerted.
  const blockCase = makeModerator({ strikeLimit: 1, getResponseStyle: failingRespStyle });
  await assert.doesNotReject(blockCase.moderator.scan(msg('you asshole')));
  assert.equal(blockCase.enforcer.calls.muteUser.length, 1, 'the mute is still applied');
  assert.equal(blockCase.enforcer.calls.warnUser.length, 1);
  assert.equal(blockCase.enforcer.calls.warnUser[0][1], blockedDmText(), 'degrades to the English default');
  assert.equal(blockCase.enforcer.calls.postAdminAlert.length, 1, 'the admin alert still fires');
});

test("SECURITY: a standing 'mi' language preference never pays for (or is overridden by) a response-style lookup, even one that would fail", async () => {
  let respStyleCalls = 0;
  const failingRespStyle = async () => {
    respStyleCalls += 1;
    throw new Error('response_style_prefs lookup failed — must never be reached when lang is mi');
  };
  const { moderator, enforcer } = makeModerator({
    strikeLimit: 3,
    getLanguagePreference: async () => 'mi',
    getResponseStyle: failingRespStyle,
  });
  await assert.doesNotReject(moderator.scan(msg('you asshole')));
  assert.equal(enforcer.calls.warnUser[0][1], warnDmTextMi(1, 3));
  assert.equal(respStyleCalls, 0, 'getResponseStyle must never be consulted once lang has resolved to mi');
});

// --- two-stage classifier gating --------------------------------------------

const scope = (channelId = 'chan1', platform: 'discord' | 'whatsapp' = 'discord') => ({
  platform,
  channelId,
});

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
  assert.equal(await classify('you are being unkind and I disagree', scope()), null);
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
  const hit = await classify('some subtle harassment the wordlist misses', scope());
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
  const hit = await classify('you asshole', scope());
  assert.ok(hit, 'wordlist catches it');
  assert.equal(llmCalls, 0, 'no LLM call when the wordlist already flagged it');
});

// --- LLM classifier cache (issue #256) ---------------------------------------
// Dedupes identical-text Stage-2 LLM calls within a short per-scope window, so
// a copy-pasted spam/phishing burst pays for one classification instead of N.

function makeCountingLlm(behavior: (text: string) => Promise<{ reason: string; excerpt: string } | null>) {
  const calls: string[] = [];
  const llm: Classifier = async (text) => {
    calls.push(text);
    return behavior(text);
  };
  return { calls, llm };
}

test('makeClassifier: identical text in the same scope within the TTL is served from cache (one LLM call)', async () => {
  const { calls, llm } = makeCountingLlm(async () => ({ reason: 'abuse (x)', excerpt: 'x' }));
  let now = 0;
  const classify = makeClassifier({ badWords: [], llmAbuseEnabled: true, llm, now: () => now });
  await classify('some subtle harassment the wordlist misses', scope());
  now += 1_000; // well within the 5-minute TTL
  const second = await classify('some subtle harassment the wordlist misses', scope());
  assert.equal(calls.length, 1, 'the second identical call must hit the cache, not the LLM');
  assert.ok(second && /abuse/.test(second.reason), 'the cached verdict is still returned');
});

test('makeClassifier: identical text in a different channelId is a cache miss (no cross-scope hit)', async () => {
  const { calls, llm } = makeCountingLlm(async () => null);
  const classify = makeClassifier({ badWords: [], llmAbuseEnabled: true, llm });
  await classify('some subtle harassment the wordlist misses', scope('chan1'));
  await classify('some subtle harassment the wordlist misses', scope('chan2'));
  assert.equal(calls.length, 2, "a different channelId must not reuse another scope's cached verdict");
});

test('SECURITY: identical text on a different platform is a cache miss (scope key includes platform)', async () => {
  const { calls, llm } = makeCountingLlm(async () => null);
  const classify = makeClassifier({ badWords: [], llmAbuseEnabled: true, llm });
  await classify('some subtle harassment the wordlist misses', scope('chan1', 'discord'));
  await classify('some subtle harassment the wordlist misses', scope('chan1', 'whatsapp'));
  assert.equal(calls.length, 2, 'platform must be part of the cache key, not just channelId');
});

test('makeClassifier: identical text after the TTL elapses triggers a fresh classifier call', async () => {
  const { calls, llm } = makeCountingLlm(async () => null);
  let now = 0;
  const classify = makeClassifier({ badWords: [], llmAbuseEnabled: true, llm, now: () => now });
  await classify('some subtle harassment the wordlist misses', scope());
  now += 300_001; // just past the 5-minute TTL
  await classify('some subtle harassment the wordlist misses', scope());
  assert.equal(calls.length, 2, 'an expired cache entry must not be reused');
});

test('SECURITY: a classifier error is never cached — the next identical message still attempts a fresh classification', async () => {
  let attempt = 0;
  const llm: Classifier = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('transient LLM failure');
    return { reason: 'abuse (x)', excerpt: 'x' };
  };
  const classify = makeClassifier({ badWords: [], llmAbuseEnabled: true, llm });
  await assert.rejects(classify('some subtle harassment the wordlist misses', scope()));
  const second = await classify('some subtle harassment the wordlist misses', scope());
  assert.equal(attempt, 2, 'a failed call must not be cached, so an identical retry hits the LLM again');
  assert.ok(second && /abuse/.test(second.reason));
});

test('makeClassifier: a cache hit drives the same downstream moderation action as a fresh classification', async () => {
  const { llm } = makeCountingLlm(async () => ({ reason: 'abuse (targeted harassment)', excerpt: 'x' }));
  const classify = makeClassifier({ badWords: [], llmAbuseEnabled: true, llm });
  const { moderator, enforcer } = makeModerator({ strikeLimit: 5, classify });
  await moderator.scan(msg('some subtle harassment the wordlist misses'));
  await moderator.scan(msg('some subtle harassment the wordlist misses')); // served from cache
  assert.equal(
    enforcer.calls.warnUser.length,
    2,
    'the cache hit must warn the member just like a fresh call',
  );
  assert.equal(enforcer.calls.postAdminAlert.length, 2);
});

test('makeClassifier: the cache never grows past its bound — inserting past it evicts the oldest entry', async () => {
  const { calls, llm } = makeCountingLlm(async () => null);
  const classify = makeClassifier({ badWords: [], llmAbuseEnabled: true, llm });
  const s = scope();
  // Fill the cache with 200 distinct texts, then a 201st distinct text.
  for (let i = 0; i < 201; i += 1) {
    await classify(`distinct message number ${i}`, s);
  }
  assert.equal(calls.length, 201, 'every distinct text is a fresh miss while filling the cache');
  // The very first entry must have been evicted (LRU) to make room for the 201st.
  await classify('distinct message number 0', s);
  assert.equal(calls.length, 202, 'the oldest entry was evicted, so its text is a fresh miss again');
  // A recently-inserted entry must still be cached.
  await classify('distinct message number 200', s);
  assert.equal(calls.length, 202, 'a recently-inserted entry must still be served from cache');
});

test('SECURITY: with llmAbuseEnabled off, the classifier never touches the LLM/cache path at all', async () => {
  const { calls, llm } = makeCountingLlm(async () => ({ reason: 'abuse', excerpt: 'x' }));
  const classify = makeClassifier({ badWords: [], llmAbuseEnabled: false, llm });
  const s = scope();
  await classify('some subtle harassment the wordlist misses', s);
  await classify('some subtle harassment the wordlist misses', s);
  assert.equal(calls.length, 0, 'disabled means the LLM (and therefore its cache) is never reached');
});

// --- mod-alerts rolling-hour cap (issue #517) --------------------------------
// A raid/flood must never drown the mod-alerts channel: below the cap
// behaviour is unchanged; at/over the cap, overflow collapses into one
// deterministic summary; enforcement is never gated by the cap; and the
// window is shared across identities so a multi-account raid can't buy extra
// slots. Must match the internal, non-exported debounce in moderator.ts.
const ALERT_SUMMARY_DEBOUNCE_MS = 10_000;

// postAlert's summary flush is fire-and-forget (`.catch(...)`, no await) once
// its debounce timer fires — same technique as tests/devTeamWatchAlert.test.ts:
// give the microtask queue a turn after ticking the mocked timer.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('the alert cap: below the cap, behaviour is byte-identical to today — one individual alert per flagged message, no summary', async () => {
  const cap = 5;
  const enforcer = makeEnforcer();
  const { moderator } = makeModerator({ strikeLimit: 1000, alertRateLimitPerHour: cap, enforcer });
  for (let i = 0; i < cap - 1; i++) {
    await moderator.scan(msg(`you asshole ${i}`, `u${i}`));
  }
  assert.equal(enforcer.calls.postAdminAlert.length, cap - 1, 'exactly one alert per flagged message');
  for (const text of enforcer.calls.postAdminAlert) {
    assert.doesNotMatch(text, /further warning|rate cap reached/i, 'no summary text below the cap');
  }
});

test('at/over the cap, overflow collapses into exactly one summary notice reporting the exact suppressed count', async (t) => {
  const cap = 3;
  const K = 4; // suppressed count — must be >= 2 to prove accumulation, not just "first overflow"
  const enforcer = makeEnforcer();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { moderator } = makeModerator({ strikeLimit: 1000, alertRateLimitPerHour: cap, enforcer });

  for (let i = 0; i < cap + K; i++) {
    await moderator.scan(msg(`you asshole ${i}`, `u${i}`));
  }
  assert.equal(
    enforcer.calls.postAdminAlert.length,
    cap,
    'exactly cap individual alerts, nothing posted yet for the overflow',
  );

  t.mock.timers.tick(ALERT_SUMMARY_DEBOUNCE_MS);
  await flush();

  assert.equal(
    enforcer.calls.postAdminAlert.length,
    cap + 1,
    'exactly one additional call — the collapsed summary — no further per-hit alerts',
  );
  assert.equal(
    enforcer.calls.postAdminAlert.at(-1),
    moderationAlertSummaryText(K),
    'the summary reports the exact suppressed count (K)',
  );
});

test('SECURITY: enforcement (addWarning/muteUser/warnUser/warnInChannel) fires on every flagged message even once the alert cap is exhausted', async (t) => {
  const cap = 2;
  const strikeLimit = 3;
  const enforcer = makeEnforcer();
  const store = makeStore();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { moderator } = makeModerator({ strikeLimit, alertRateLimitPerHour: cap, enforcer, store });

  const burstSize = 10; // well past the alert cap
  const userId = 'raider-1';
  for (let i = 0; i < burstSize; i++) {
    await moderator.scan(msg(`you asshole ${i}`, userId));
  }

  assert.equal(store.added.length, burstSize, 'addWarning (the audit trail) fires for every flagged message');
  assert.equal(enforcer.calls.warnUser.length, burstSize, 'warnUser fires for every flagged message');
  assert.equal(
    enforcer.calls.warnInChannel.length,
    burstSize,
    'warnInChannel fires for every flagged message',
  );
  assert.equal(
    enforcer.calls.muteUser.length,
    burstSize - (strikeLimit - 1),
    'muteUser fires on every post once the strike limit is crossed',
  );
  assert.ok(
    enforcer.calls.postAdminAlert.length < burstSize,
    'sanity: the alert cap actually suppressed some postAdminAlert calls',
  );
});

test('SECURITY: the alert cap is one shared guild-wide window — a multi-account raid cannot buy extra alert slots by spreading across identities', async (t) => {
  const cap = 3;
  const enforcer = makeEnforcer();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { moderator } = makeModerator({ strikeLimit: 1000, alertRateLimitPerHour: cap, enforcer });

  const identities = 6; // more distinct users/channels than the cap
  for (let i = 0; i < identities; i++) {
    await moderator.scan({ ...msg(`you asshole ${i}`, `raider-${i}`), channelId: `chan-${i}` });
  }

  assert.equal(
    enforcer.calls.postAdminAlert.length,
    cap,
    'individual alerts capped at the shared limit regardless of how many distinct identities/channels posted',
  );
});

// --- RBAC surface ------------------------------------------------------------

test('SECURITY: clear_warnings is admin-tier only — absent from the member/guest surface', () => {
  const tool = 'mcp__community__clear_warnings';
  assert.ok(toolsForRole('admin').includes(tool), 'admins have clear_warnings');
  assert.ok(toolsForRole('super_admin').includes(tool), 'super admins have clear_warnings');
  assert.ok(!toolsForRole('member').includes(tool), 'members must not have clear_warnings');
  assert.ok(!toolsForRole('guest').includes(tool), 'guests must not have clear_warnings');
});

test('SECURITY: list_member_warnings is admin-tier only — absent from the member/guest surface (issue #410)', () => {
  const tool = 'mcp__community__list_member_warnings';
  assert.ok(toolsForRole('admin').includes(tool), 'admins have list_member_warnings');
  assert.ok(toolsForRole('super_admin').includes(tool), 'super admins have list_member_warnings');
  assert.ok(!toolsForRole('member').includes(tool), 'members must not have list_member_warnings');
  assert.ok(!toolsForRole('guest').includes(tool), 'guests must not have list_member_warnings');
});

test('SECURITY: list_muted_members is admin-tier only — absent from the member/guest surface (issue #487)', () => {
  const tool = 'mcp__community__list_muted_members';
  assert.ok(toolsForRole('admin').includes(tool), 'admins have list_muted_members');
  assert.ok(toolsForRole('super_admin').includes(tool), 'super admins have list_muted_members');
  assert.ok(!toolsForRole('member').includes(tool), 'members must not have list_muted_members');
  assert.ok(!toolsForRole('guest').includes(tool), 'guests must not have list_muted_members');
});
