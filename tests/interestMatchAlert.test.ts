import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
// interestMatchAlertMessage is rendered via notice(), unlike
// reportStaleAlert.ts's hardcoded template, so this file needs it where
// tests/reportStaleAlert.test.ts does not.
import './support/registerNotices.js';
import type { OutgoingMessage, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';
import { fakePolicyStore } from './support/fakePolicyStore.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/reportStaleAlert.test.ts. This job is always-on (no
// enable flag), so no *_ENABLED var is needed here.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { makeDefaultInterestMatchAlertRun, startInterestMatchAlert } =
  await import('../src/module/interestMatchAlert.js');
const { WindowClosedError } = await import('@swampratnz/agent-base/platforms/whatsapp/cloudAdapter.js');
const { INTEREST_MATCH_ALERT_POLICY_KEY } = await import('../src/module/storage/policies.js');

type Platform = 'discord' | 'whatsapp';
type SelfInterestMatchResult =
  | { hasProfile: false }
  | {
      hasProfile: true;
      hits: Array<{ platform: Platform; userId: string; interests: string; similarity: number }>;
    };
type OptInKey = { platform: Platform; userId: string };

function optIns(entries: Array<Partial<OptInKey>>): OptInKey[] {
  return entries.map((e, i) => ({ platform: 'discord', userId: `member-${i}`, ...e }));
}

function hits(count: number, secretText = 'secret interest text'): SelfInterestMatchResult {
  if (count === 0) return { hasProfile: true, hits: [] };
  return {
    hasProfile: true,
    hits: Array.from({ length: count }, (_, i) => ({
      platform: 'discord' as const,
      userId: `matched-member-${i}`,
      interests: secretText,
      similarity: 0.9,
    })),
  };
}

function makeAdapter(connected = true): {
  adapter: PlatformAdapter;
  dms: Array<{ userId: string; text: string }>;
} {
  const dms: Array<{ userId: string; text: string }> = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => connected,
    onMessage() {},
    async sendMessage(_out: OutgoingMessage) {},
    async sendDirectMessage(userId: string, text: string) {
      dms.push({ userId, text });
    },
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return { adapter, dms };
}

/** Mirrors tests/reportStaleAlert.test.ts's makeCloudAdapter. */
function makeCloudAdapter(rejections: Record<string, unknown>): {
  adapter: PlatformAdapter;
  dms: Array<{ userId: string; text: string }>;
  queued: Array<{ userId: string; message: string; priority: 'system' | 'low' }>;
} {
  const dms: Array<{ userId: string; text: string }> = [];
  const queued: Array<{ userId: string; message: string; priority: 'system' | 'low' }> = [];
  const adapter: PlatformAdapter = {
    platform: 'whatsapp',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage() {},
    async sendMessage(_out: OutgoingMessage) {},
    async sendDirectMessage(userId: string, text: string) {
      if (userId in rejections) throw rejections[userId];
      dms.push({ userId, text });
    },
    queueForWindowReopen(userId: string, message: string, priority: 'system' | 'low') {
      queued.push({ userId, message, priority });
    },
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return { adapter, dms, queued };
}

const englishSelection = async () => ({ language: 'en', style: undefined });

test("SECURITY: a member absent from the opt-in table is never scanned and never DM'd, even when their self-match count is nonzero", async () => {
  const { adapter, dms } = makeAdapter();
  let searchCalled = false;
  // No opt-ins at all — the scan set is empty, so searchSelfMatches must
  // never even be invoked for a nonzero-would-match identity that never
  // opted in.
  const listOptIns = async () => [];
  const searchSelfMatches = async () => {
    searchCalled = true;
    return hits(3);
  };
  const runOnce = makeDefaultInterestMatchAlertRun(
    [adapter],
    listOptIns,
    searchSelfMatches,
    englishSelection,
    fakePolicyStore(),
  );

  await runOnce();

  assert.equal(dms.length, 0, 'no opt-in row means no scan and no alert');
  assert.equal(searchCalled, false, 'a member absent from the opt-in table is never scanned');
});

test('SECURITY: the rendered DM string contains no interest text, no other member id/handle, and no numeric match count', async () => {
  const { adapter, dms } = makeAdapter();
  const secretInterestText = 'secret-interest-text-4f2a';
  const secretMatchedUserId = 'secret-matched-member-9b1c';
  const listOptIns = async () => optIns([{}]);
  const searchSelfMatches = async () => ({
    hasProfile: true as const,
    hits: [
      {
        platform: 'discord' as Platform,
        userId: secretMatchedUserId,
        interests: secretInterestText,
        similarity: 0.91,
      },
      {
        platform: 'discord' as Platform,
        userId: 'another-secret-id',
        interests: 'more secret text',
        similarity: 0.8,
      },
    ],
  });
  const runOnce = makeDefaultInterestMatchAlertRun(
    [adapter],
    listOptIns,
    searchSelfMatches,
    englishSelection,
    fakePolicyStore(),
  );

  await runOnce();

  assert.equal(dms.length, 1);
  const body = dms[0].text;
  assert.ok(!body.includes(secretInterestText), 'interest text must never appear in the alert DM');
  assert.ok(!body.includes(secretMatchedUserId), "a matched member's id must never appear in the alert DM");
  assert.ok(!body.includes('another-secret-id'), "a matched member's id must never appear in the alert DM");
  assert.ok(!/\d/.test(body), 'no numeric match count may appear in the alert DM');
  assert.equal(body, 'You have new interest matches on the community — run who_is_into to see who.');
});

test(
  'SECURITY: after forget_me/purge_user_data for (platform, userId), the opt-in row is gone and a subsequent job tick produces no alert for that identity',
  { skip },
  async () => {
    const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');
    const { purgeUserData } = await import('@swampratnz/agent-base/storage/repository.js');
    const { setInterestMatchAlertOptIn, listInterestMatchAlertOptIns } =
      await import('../src/module/storage/interestMatchAlertOptIns.js');
    const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const userId = `${RUN}-purge`;

    try {
      await setInterestMatchAlertOptIn('discord', userId, true);
      const before = await listInterestMatchAlertOptIns();
      assert.ok(
        before.some((k) => k.platform === 'discord' && k.userId === userId),
        'precondition: the opt-in row exists before purging',
      );

      await purgeUserData('discord', userId);

      const after1 = await listInterestMatchAlertOptIns();
      assert.ok(
        !after1.some((k) => k.platform === 'discord' && k.userId === userId),
        'forget_me/purge_user_data must erase the opt-in row',
      );

      const { adapter, dms } = makeAdapter();
      const searchSelfMatches = async () => hits(2);
      const runOnce = makeDefaultInterestMatchAlertRun(
        [adapter],
        listInterestMatchAlertOptIns,
        searchSelfMatches,
        englishSelection,
        fakePolicyStore(),
      );
      await runOnce();
      assert.ok(
        !dms.some((d) => d.userId === userId),
        'a subsequent tick after purge must produce no alert for the purged identity',
      );
    } finally {
      await pool.query('DELETE FROM interest_match_alert_optins WHERE user_id = $1', [userId]);
      await closeDb();
    }
  },
);

test('makeDefaultInterestMatchAlertRun: a self-match count of zero never alerts', async () => {
  const { adapter, dms } = makeAdapter();
  const listOptIns = async () => optIns([{}]);
  const searchSelfMatches = async () => hits(0);
  const runOnce = makeDefaultInterestMatchAlertRun(
    [adapter],
    listOptIns,
    searchSelfMatches,
    englishSelection,
    fakePolicyStore(),
  );

  await runOnce();

  assert.equal(dms.length, 0);
});

test('makeDefaultInterestMatchAlertRun: hasProfile: false counts as zero matches — no alert, no throw', async () => {
  const { adapter, dms } = makeAdapter();
  const listOptIns = async () => optIns([{}]);
  const searchSelfMatches = async (): Promise<SelfInterestMatchResult> => ({ hasProfile: false });
  const runOnce = makeDefaultInterestMatchAlertRun(
    [adapter],
    listOptIns,
    searchSelfMatches,
    englishSelection,
    fakePolicyStore(),
  );

  await assert.doesNotReject(runOnce());
  assert.equal(dms.length, 0);
});

test('makeDefaultInterestMatchAlertRun: alerts exactly once on the tick the self-match count first becomes >0, then stays silent while it remains >0 — including a partial decrease that never reaches 0', async () => {
  const { adapter, dms } = makeAdapter();
  let count = 0;
  const listOptIns = async () => optIns([{}]);
  const searchSelfMatches = async () => hits(count);
  const runOnce = makeDefaultInterestMatchAlertRun(
    [adapter],
    listOptIns,
    searchSelfMatches,
    englishSelection,
    fakePolicyStore(),
  );

  await runOnce();
  assert.equal(dms.length, 0);

  count = 1;
  await runOnce();
  assert.equal(dms.length, 1, 'exactly one alert on the tick the self-match count first becomes >0');

  count = 3;
  await runOnce();
  assert.equal(dms.length, 1, 'no repeat alert while the count stays >0 (latch, not a nag)');

  count = 1;
  await runOnce();
  assert.equal(dms.length, 1, 'a partial decrease (3 -> 1) must not re-arm the latch');
});

test('makeDefaultInterestMatchAlertRun: the latch re-arms once the count returns to exactly 0, and a later crossing alerts again', async () => {
  const { adapter, dms } = makeAdapter();
  let count = 2;
  const listOptIns = async () => optIns([{}]);
  const searchSelfMatches = async () => hits(count);
  const runOnce = makeDefaultInterestMatchAlertRun(
    [adapter],
    listOptIns,
    searchSelfMatches,
    englishSelection,
    fakePolicyStore(),
  );

  await runOnce(); // 0 -> 2, crosses
  assert.equal(dms.length, 1);

  count = 0;
  await runOnce(); // drops to exactly 0 — silent re-arm
  assert.equal(dms.length, 1, 'dropping to exactly 0 must not itself alert');

  count = 1;
  await runOnce(); // crosses again
  assert.equal(dms.length, 2, 'a fresh crossing after returning to 0 fires a second, distinct alert');
});

test("makeDefaultInterestMatchAlertRun: restart-safety — seeded from a store already holding a member's own key active, that member's still->=1 first tick does not re-send the DM", async () => {
  const { adapter, dms } = makeAdapter();
  const store = fakePolicyStore({ [INTEREST_MATCH_ALERT_POLICY_KEY]: ['discord:member-0'] });
  const listOptIns = async () => optIns([{}]);
  const searchSelfMatches = async () => hits(2);
  const runOnce = makeDefaultInterestMatchAlertRun(
    [adapter],
    listOptIns,
    searchSelfMatches,
    englishSelection,
    store,
  );

  await runOnce();

  assert.equal(dms.length, 0, 'a fresh process must not re-fire for an already-active, still-nonzero member');
});

test('SECURITY: per-member isolation of persisted state — a two-member run persists only the member(s) whose own count actually crossed, never the other member', async () => {
  const { adapter, dms } = makeAdapter();
  const store = fakePolicyStore();
  const listOptIns = async () => optIns([{ userId: 'member-a' }, { userId: 'member-b' }]);
  const searchSelfMatches = async (_platform: string, userId: string) => hits(userId === 'member-a' ? 2 : 0);
  const runOnce = makeDefaultInterestMatchAlertRun(
    [adapter],
    listOptIns,
    searchSelfMatches,
    englishSelection,
    store,
  );

  await runOnce();

  assert.deepEqual(
    dms.map((d) => d.userId),
    ['member-a'],
  );
  assert.deepEqual(
    await store.readPolicy(INTEREST_MATCH_ALERT_POLICY_KEY),
    ['discord:member-a'],
    "member-b never crossed, so member-b's key must never appear in the persisted active set",
  );
});

test('SECURITY: a WindowClosedError for one member is queued via queueForWindowReopen (not dropped) and does not block delivery to the rest', async () => {
  const { adapter, dms, queued } = makeCloudAdapter({
    'member-closed': new WindowClosedError('member-closed'),
  });
  const listOptIns = async () => [
    { platform: 'whatsapp' as Platform, userId: 'member-open' },
    { platform: 'whatsapp' as Platform, userId: 'member-closed' },
  ];
  const searchSelfMatches = async () => hits(1);
  const runOnce = makeDefaultInterestMatchAlertRun(
    [adapter],
    listOptIns,
    searchSelfMatches,
    englishSelection,
    fakePolicyStore(),
  );

  await runOnce();

  assert.deepEqual(
    dms.map((d) => d.userId),
    ['member-open'],
    'the open-window member is still delivered live',
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0].userId, 'member-closed');
  assert.equal(queued[0].priority, 'low');
});

test('SECURITY: a throwing per-member read (searchSelfMatches) for one member never aborts the tick — every other opted-in member is still scanned and alerted', async () => {
  const { adapter, dms } = makeAdapter();
  const listOptIns = async () => optIns([{ userId: 'member-broken' }, { userId: 'member-fine' }]);
  const searchSelfMatches = async (_platform: string, userId: string) => {
    if (userId === 'member-broken') throw new Error('transient DB blip');
    return hits(1);
  };
  const runOnce = makeDefaultInterestMatchAlertRun(
    [adapter],
    listOptIns,
    searchSelfMatches,
    englishSelection,
    fakePolicyStore(),
  );

  await assert.doesNotReject(runOnce());

  assert.deepEqual(
    dms.map((d) => d.userId),
    ['member-fine'],
    "the broken member's read failure must not suppress the alert to the other, healthy member",
  );
});

test('makeDefaultInterestMatchAlertRun: a member with no adapter matching its platform (or a disconnected one) is silently skipped, never throws', async () => {
  const { adapter } = makeAdapter(false);
  const listOptIns = async () => optIns([{}]);
  const searchSelfMatches = async () => hits(2);
  const runOnce = makeDefaultInterestMatchAlertRun(
    [adapter],
    listOptIns,
    searchSelfMatches,
    englishSelection,
    fakePolicyStore(),
  );

  await assert.doesNotReject(runOnce());
});

test('startInterestMatchAlert: always-on, no enable flag — creates a timer even with no *_ENABLED env set', () => {
  const timer = startInterestMatchAlert([], async () => {});
  assert.notEqual(timer, null, 'this job is unconditionally enabled by design');
  if (timer) clearInterval(timer);
});
