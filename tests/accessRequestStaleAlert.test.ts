import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';
import { fakePolicyStore } from './support/fakePolicyStore.js';
import type { OutgoingMessage, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/appealStaleAlert.test.ts. This job is always-on (no
// enable flag), so no *_ENABLED var is needed here.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const {
  ACCESS_REQUEST_STALE_ALERT_THRESHOLD_HOURS,
  ACCESS_REQUEST_STALE_ALERT_SCAN_LIMIT,
  formatAccessRequestStaleAlertMessage,
  makeDefaultAccessRequestStaleAlertRun,
  startAccessRequestStaleAlert,
} = await import('../src/module/accessRequestStaleAlert.js');
const { WindowClosedError } = await import('@swampratnz/agent-base/platforms/whatsapp/cloudAdapter.js');
const { ACCESS_REQUEST_STALE_ALERT_POLICY_KEY } = await import('../src/module/storage/policies.js');
const { notifyAccessRequestStale } = await import('../src/module/agent/tools/notify.js');

type Platform = 'discord' | 'whatsapp';
type AccessRequest = {
  platform: Platform;
  userId: string;
  userName: string | null;
  firstRequestedAt: Date;
  lastRequestedAt: Date;
  requestCount: number;
};
type AdminIdentity = { platform: Platform; platformUserId: string };

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

function accessRequest(overrides: Partial<AccessRequest> & { ageHours: number }): AccessRequest {
  const { ageHours, ...rest } = overrides;
  return {
    platform: 'discord',
    userId: 'user-1',
    userName: 'Some Guest',
    firstRequestedAt: hoursAgo(ageHours),
    lastRequestedAt: hoursAgo(ageHours),
    requestCount: 1,
    ...rest,
  };
}

function admins(entries: Array<Partial<AdminIdentity>>): AdminIdentity[] {
  return entries.map((e, i) => ({ platform: 'discord', platformUserId: `admin-${i}`, ...e }));
}

// Stands in for the real `recordAccessRequestStaleNotice` (issue #1421):
// always reports "already notified" (false), so the guest-notice branch
// added to makeDefaultAccessRequestStaleAlertRun's loop is a guaranteed
// no-op for every test below that isn't specifically exercising the
// guest-notice path itself — otherwise the default would fall through to the
// REAL storage function (a live Postgres query), matching
// tests/appealStaleAlert.test.ts's skipAppellantNotice guard.
const skipGuestStaleNotice = async () => false;

// Stands in for the real `pruneAccessRequestStaleNotices` (issue #1421):
// unlike the record/notify defaults above, the real prune runs
// UNCONDITIONALLY every tick (never gated behind a stale check), so every
// test below that doesn't specifically exercise the prune path must inject
// this no-op instead of letting the default fall through to a live Postgres
// DELETE — the exact "deps must be all-or-nothing" hazard CLAUDE.md calls out.
const noopPruneStaleNotices = async () => {};

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

/** Mirrors tests/appealStaleAlert.test.ts's makeCloudAdapter. */
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

test('formatAccessRequestStaleAlertMessage: fixed template with the bare count and oldest-age-in-hours only', () => {
  assert.equal(
    formatAccessRequestStaleAlertMessage(1, 200),
    '🚪 1 pending access request(s) have been waiting more than 168h (7d) for review (oldest: 200h) — ' +
      'run `list_access_requests` to review.',
  );
  assert.equal(
    formatAccessRequestStaleAlertMessage(4, 999),
    '🚪 4 pending access request(s) have been waiting more than 168h (7d) for review (oldest: 999h) — ' +
      'run `list_access_requests` to review.',
  );
});

test('SECURITY: formatAccessRequestStaleAlertMessage never contains anything beyond the fixed template + two integers, for any count/age', () => {
  for (const [count, age] of [
    [0, 0],
    [1, 168],
    [7, 999],
  ]) {
    const message = formatAccessRequestStaleAlertMessage(count, age);
    assert.match(
      message,
      /^🚪 \d+ pending access request\(s\) have been waiting more than 168h \(7d\) for review \(oldest: \d+h\) — run `list_access_requests` to review\.$/,
    );
  }
});

test('SECURITY: the crossing-tick alert DM contains no guest userName, userId, or platform, even when the stale set contains them', async () => {
  const { adapter, dms } = makeAdapter();
  const secretUserId = 'secret-user-id-4f2a';
  const secretUserName = 'secret-guest-name';
  // Built EAGERLY, before runOnce() captures its clock — see
  // tests/appealStaleAlert.test.ts's identical comment (issue #1071): the job
  // reads `Date.now()` first and only then awaits listPendingAccessRequests(),
  // so a fixture dated INSIDE that lazy callback stamps firstRequestedAt later
  // than `now`, undershooting the intended age by a hair and flooring "200h"
  // to "199h" often enough on a loaded CI runner to redden this exact
  // assertion.
  const staleRequests = [
    accessRequest({
      ageHours: 200,
      userId: secretUserId,
      userName: secretUserName,
      platform: 'discord',
    }),
  ];
  const listPendingAccessRequests = async () => staleRequests;
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    fakePolicyStore(),
    skipGuestStaleNotice,
    undefined,
    noopPruneStaleNotices,
  );

  await runOnce();

  assert.equal(dms.length, 1);
  const body = dms[0].text;
  assert.ok(!body.includes(secretUserId), 'user id must never appear in the alert DM');
  assert.ok(!body.includes(secretUserName), 'user name must never appear in the alert DM');
  assert.ok(!body.includes('discord'), 'platform string must never appear in the alert DM');
  assert.equal(
    body,
    '🚪 1 pending access request(s) have been waiting more than 168h (7d) for review (oldest: 200h) — ' +
      'run `list_access_requests` to review.',
  );
});

test('makeDefaultAccessRequestStaleAlertRun: a pending-access-request set with none older than the threshold never alerts', async () => {
  const { adapter, dms } = makeAdapter();
  const listPendingAccessRequests = async () => [
    accessRequest({ ageHours: 1 }),
    accessRequest({ ageHours: ACCESS_REQUEST_STALE_ALERT_THRESHOLD_HOURS - 1 }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    fakePolicyStore(),
    skipGuestStaleNotice,
    undefined,
    noopPruneStaleNotices,
  );

  await runOnce();

  assert.equal(dms.length, 0, 'nothing older than the threshold must never trip the alert');
});

test('makeDefaultAccessRequestStaleAlertRun: an access request exactly at the threshold DOES trigger the alert', async () => {
  const { adapter, dms } = makeAdapter();
  // Built EAGERLY, before runOnce() captures its clock — the same ordering fix
  // as the stale set above, but load-bearing for a sharper reason: this
  // fixture sits EXACTLY on the `>=` boundary, so it has no slack at all. The
  // job reads `Date.now()` first and only then awaits
  // listPendingAccessRequests(), so a fixture dated inside that lazy callback
  // is stamped a hair LATER than `now`, making the measured age
  // `THRESHOLD - delta` — just under the threshold, so the request is not
  // stale and no DM is sent. The other alert tests carry 30h+ of margin and
  // only misrender the hour count; this one inverts the very behaviour it
  // asserts. Building first makes the age `THRESHOLD + delta`, which is
  // >= threshold on every run. Padding the age instead would destroy the
  // point of the test, which is the boundary itself.
  const atThreshold = [accessRequest({ ageHours: ACCESS_REQUEST_STALE_ALERT_THRESHOLD_HOURS })];
  const listPendingAccessRequests = async () => atThreshold;
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    fakePolicyStore(),
    skipGuestStaleNotice,
    undefined,
    noopPruneStaleNotices,
  );

  await runOnce();

  assert.equal(dms.length, 1, 'exactly-at-threshold counts as stale (>= comparison)');
});

test('makeDefaultAccessRequestStaleAlertRun: alerts exactly once on the tick the stale count first becomes >0, then stays silent while it remains >0 — including a partial decrease that never reaches 0', async () => {
  const { adapter, dms } = makeAdapter();
  let staleCount = 0;
  const listPendingAccessRequests = async () =>
    Array.from({ length: staleCount }, (_, i) => accessRequest({ ageHours: 200, userId: `user-${i}` }));
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    fakePolicyStore(),
    skipGuestStaleNotice,
    undefined,
    noopPruneStaleNotices,
  );

  await runOnce(); // 0 -> no alert
  assert.equal(dms.length, 0);

  staleCount = 1;
  await runOnce(); // 0 -> 1, crosses
  assert.equal(dms.length, 1, 'exactly one alert on the tick the stale count first becomes >0');

  staleCount = 3;
  await runOnce(); // stays >0
  assert.equal(dms.length, 1, 'no repeat alert while the stale count stays >0 (latch, not a nag)');

  staleCount = 1;
  await runOnce(); // partial decrease, 3 -> 1, never reaches 0
  assert.equal(dms.length, 1, 'a partial decrease (3 -> 1) must not re-arm the latch');
});

test('makeDefaultAccessRequestStaleAlertRun: the latch re-arms once the stale count returns to exactly 0, and a later crossing alerts again', async () => {
  const { adapter, dms } = makeAdapter();
  let staleCount = 2;
  const listPendingAccessRequests = async () =>
    Array.from({ length: staleCount }, (_, i) => accessRequest({ ageHours: 200, userId: `user-${i}` }));
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    fakePolicyStore(),
    skipGuestStaleNotice,
    undefined,
    noopPruneStaleNotices,
  );

  await runOnce(); // 0 -> 2, crosses
  assert.equal(dms.length, 1);

  staleCount = 0;
  await runOnce(); // drops to exactly 0 — silent re-arm
  assert.equal(dms.length, 1, 'dropping to exactly 0 must not itself alert');

  staleCount = 1;
  await runOnce(); // crosses again
  assert.equal(dms.length, 2, 'a fresh crossing after returning to 0 fires a second, distinct alert');
});

// --- persisted latch (issue #1198) ------------------------------------------

test('makeDefaultAccessRequestStaleAlertRun: writes the active marker to the policy store only AFTER the alertAdmins fan-out returns, on the tick that crosses', async () => {
  const { adapter } = makeAdapter();
  const store = fakePolicyStore();
  const listPendingAccessRequests = async () => [accessRequest({ ageHours: 200 })];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    store,
    skipGuestStaleNotice,
    undefined,
    noopPruneStaleNotices,
  );

  assert.equal(store.written.length, 0, 'no write before the tick runs');
  await runOnce();

  assert.deepEqual(store.written, [
    { key: ACCESS_REQUEST_STALE_ALERT_POLICY_KEY, value: 'true', updatedBy: 'system' },
  ]);
});

test('makeDefaultAccessRequestStaleAlertRun: restart-safety — a fresh factory seeded with the active marker AND a still-stale count on its first tick does not re-alert, and leaves the marker active', async () => {
  const { adapter, dms } = makeAdapter();
  const store = fakePolicyStore({ [ACCESS_REQUEST_STALE_ALERT_POLICY_KEY]: 'true' });
  const listPendingAccessRequests = async () => [
    accessRequest({ ageHours: 200 }),
    accessRequest({ ageHours: 300, userId: 'user-2' }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    store,
    skipGuestStaleNotice,
    undefined,
    noopPruneStaleNotices,
  );

  await runOnce();
  assert.equal(dms.length, 0, 'a restart mid-backlog must not re-fire a duplicate DM');

  await runOnce();
  assert.equal(dms.length, 0, 'a later tick with the same still-stale backlog must not fire either');
  assert.equal(store.written.length, 0, 'the already-active marker is never rewritten while nothing crosses');
});

test('makeDefaultAccessRequestStaleAlertRun: re-arm survives a restart — the marker clears to "" when the count returns to 0, and a fresh factory alerts again on the next crossing', async () => {
  const { adapter, dms } = makeAdapter();
  const store = fakePolicyStore({ [ACCESS_REQUEST_STALE_ALERT_POLICY_KEY]: 'true' });
  const listAdminIdentities = async () => admins([{}]);

  const firstProcess = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    async () => [],
    listAdminIdentities,
    store,
    skipGuestStaleNotice,
    undefined,
    noopPruneStaleNotices,
  );
  await firstProcess(); // count drops to 0 -> re-arm
  assert.equal(dms.length, 0);
  assert.deepEqual(store.written, [
    { key: ACCESS_REQUEST_STALE_ALERT_POLICY_KEY, value: '', updatedBy: 'system' },
  ]);

  const secondProcess = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    async () => [accessRequest({ ageHours: 200 })],
    listAdminIdentities,
    store,
    skipGuestStaleNotice,
    undefined,
    noopPruneStaleNotices,
  );
  await secondProcess();
  assert.equal(dms.length, 1, 'a fresh crossing after the persisted re-arm alerts again');
  assert.deepEqual(store.written, [
    { key: ACCESS_REQUEST_STALE_ALERT_POLICY_KEY, value: '', updatedBy: 'system' },
    { key: ACCESS_REQUEST_STALE_ALERT_POLICY_KEY, value: 'true', updatedBy: 'system' },
  ]);
});

test('SECURITY: makeDefaultAccessRequestStaleAlertRun never threads a member/admin identifier into updatePolicy — the actor is always the fixed "system" string', async () => {
  const { adapter } = makeAdapter();
  const store = fakePolicyStore();
  const secretAdminId = 'admin-should-never-be-the-actor';
  const listPendingAccessRequests = async () => [accessRequest({ ageHours: 200 })];
  const listAdminIdentities = async () => admins([{ platformUserId: secretAdminId }]);
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    store,
    skipGuestStaleNotice,
    undefined,
    noopPruneStaleNotices,
  );

  await runOnce();

  assert.ok(store.written.length > 0);
  for (const write of store.written) {
    assert.equal(write.updatedBy, 'system');
    assert.notEqual(write.updatedBy, secretAdminId);
  }
});

test('an access request resolved before crossing the threshold never contributes to the stale count and never triggers an alert', async () => {
  const { adapter, dms } = makeAdapter();
  // listPendingAccessRequests models listAccessRequests(...) — a resolved
  // request (add_member -> clearAccessRequest, or purgeOldAccessRequests) is
  // deleted from the table and so is excluded by the DB query itself, so a
  // run that never observes it must never alert, even if it would have
  // crossed the threshold had it stayed pending.
  const listPendingAccessRequests = async () => [];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    fakePolicyStore(),
    skipGuestStaleNotice,
    undefined,
    noopPruneStaleNotices,
  );

  await runOnce();

  assert.equal(
    dms.length,
    0,
    'a resolved access request (absent from the pending scan) never triggers an alert',
  );
});

test('SECURITY: a WindowClosedError for one admin is queued via queueForWindowReopen (not dropped) and does not block delivery to the rest', async () => {
  const { adapter, dms, queued } = makeCloudAdapter({
    'admin-closed': new WindowClosedError('admin-closed'),
  });
  const listPendingAccessRequests = async () => [accessRequest({ ageHours: 200 })];
  const listAdminIdentities = async () =>
    admins([
      { platform: 'whatsapp', platformUserId: 'admin-open' },
      { platform: 'whatsapp', platformUserId: 'admin-closed' },
    ]);
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    fakePolicyStore(),
    skipGuestStaleNotice,
    undefined,
    noopPruneStaleNotices,
  );

  await runOnce();

  assert.deepEqual(
    dms.map((d) => d.userId),
    ['admin-open'],
    'the open-window admin is still delivered live',
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0].userId, 'admin-closed');
  assert.equal(queued[0].priority, 'low');
});

test('startAccessRequestStaleAlert: always-on, no enable flag — creates a timer even with no *_ENABLED env set', () => {
  const timer = startAccessRequestStaleAlert([], async () => {});
  assert.notEqual(timer, null, 'this job is unconditionally enabled by design');
  if (timer) clearInterval(timer);
});

// --- guest-side mid-flight stale notice (issue #1421) -----------------------

/** Mirrors tests/appealStaleAlert.test.ts's fakeAppellantNoticeRecorder. */
function fakeGuestNoticeRecorder(): {
  record: (platform: Platform, userId: string) => Promise<boolean>;
  calledWith: Array<{ platform: Platform; userId: string }>;
} {
  const seen = new Set<string>();
  const calledWith: Array<{ platform: Platform; userId: string }> = [];
  return {
    record: async (platform: Platform, userId: string) => {
      calledWith.push({ platform, userId });
      const key = `${platform}:${userId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    calledWith,
  };
}

function fakeNotifyStale(): {
  notifyStale: (adapter: PlatformAdapter, userId: string, platform: Platform) => Promise<void>;
  calls: Array<{ userId: string; platform: Platform }>;
} {
  const calls: Array<{ userId: string; platform: Platform }> = [];
  return {
    notifyStale: async (_adapter, userId, platform) => {
      calls.push({ userId, platform });
    },
    calls,
  };
}

function fakePruneRecorder(): {
  prune: (activeKeys: readonly { platform: Platform; userId: string }[]) => Promise<void>;
  calls: Array<readonly { platform: Platform; userId: string }[]>;
} {
  const calls: Array<readonly { platform: Platform; userId: string }[]> = [];
  return {
    prune: async (activeKeys) => {
      calls.push(activeKeys);
    },
    calls,
  };
}

test('SECURITY: guest stale notice sent exactly once per (platform, userId) — a second tick for the same still-stale request does not re-send (issue #1421 acceptance criterion)', async () => {
  const { adapter } = makeAdapter();
  const listPendingAccessRequests = async () => [
    accessRequest({ ageHours: 200, platform: 'discord', userId: 'guest-1' }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const { record: recordStaleNotice } = fakeGuestNoticeRecorder();
  const { notifyStale, calls } = fakeNotifyStale();
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    fakePolicyStore(),
    recordStaleNotice,
    notifyStale,
    noopPruneStaleNotices,
  );

  await runOnce();
  await runOnce();

  assert.deepEqual(calls, [{ userId: 'guest-1', platform: 'discord' }]);
});

test(
  'guest stale notice: fires independently of the admin crossing latch — an admin backlog already latched ' +
    'open (shouldAlert false) still gets the guest notified',
  async () => {
    const { adapter, dms } = makeAdapter();
    const store = fakePolicyStore({ [ACCESS_REQUEST_STALE_ALERT_POLICY_KEY]: 'true' });
    const listPendingAccessRequests = async () => [
      accessRequest({ ageHours: 200, platform: 'discord', userId: 'guest-1' }),
    ];
    const listAdminIdentities = async () => admins([{}]);
    const { record: recordStaleNotice } = fakeGuestNoticeRecorder();
    const { notifyStale, calls } = fakeNotifyStale();
    const runOnce = makeDefaultAccessRequestStaleAlertRun(
      [adapter],
      listPendingAccessRequests,
      listAdminIdentities,
      store,
      recordStaleNotice,
      notifyStale,
      noopPruneStaleNotices,
    );

    await runOnce();

    assert.equal(dms.length, 0, "the admin's own alert stays latched (already active) and does not re-send");
    assert.deepEqual(
      calls,
      [{ userId: 'guest-1', platform: 'discord' }],
      "the guest notice must not be gated behind the admin's own shouldAlert",
    );
  },
);

test("SECURITY: guest stale notice is addressed only to the request's own userId, never an admin's id", async () => {
  const { adapter } = makeAdapter();
  const listPendingAccessRequests = async () => [
    accessRequest({ ageHours: 200, platform: 'discord', userId: 'guest-distinct-from-admin' }),
  ];
  const listAdminIdentities = async () => admins([{ platformUserId: 'admin-0' }]);
  const { record: recordStaleNotice } = fakeGuestNoticeRecorder();
  const { notifyStale, calls } = fakeNotifyStale();
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    fakePolicyStore(),
    recordStaleNotice,
    notifyStale,
    noopPruneStaleNotices,
  );

  await runOnce();

  assert.deepEqual(calls, [{ userId: 'guest-distinct-from-admin', platform: 'discord' }]);
});

test(
  'guest stale notice: a throwing recordStaleNotice for one request is caught, never blocking another stale ' +
    "request's notice or the admin alert",
  async () => {
    const { adapter, dms } = makeAdapter();
    const listPendingAccessRequests = async () => [
      accessRequest({ ageHours: 200, platform: 'discord', userId: 'guest-broken' }),
      accessRequest({ ageHours: 200, platform: 'discord', userId: 'guest-fine' }),
    ];
    const listAdminIdentities = async () => admins([{}]);
    const recordStaleNotice = async (_platform: Platform, userId: string) => {
      if (userId === 'guest-broken') throw new Error('transient DB blip');
      return true;
    };
    const { notifyStale, calls } = fakeNotifyStale();
    const runOnce = makeDefaultAccessRequestStaleAlertRun(
      [adapter],
      listPendingAccessRequests,
      listAdminIdentities,
      fakePolicyStore(),
      recordStaleNotice,
      notifyStale,
      noopPruneStaleNotices,
    );

    await assert.doesNotReject(runOnce());

    assert.deepEqual(calls, [{ userId: 'guest-fine', platform: 'discord' }]);
    assert.equal(dms.length, 1, 'the admin alert must still fire despite one guest notice failing');
  },
);

test(
  "guest stale notice: no connected adapter for the request's platform is a silent skip — no throw, " +
    'no notify call, and no idempotency row (so a later tick with an adapter can still notify)',
  async () => {
    const { adapter: discordAdapter } = makeAdapter(); // no whatsapp adapter registered at all
    const listPendingAccessRequests = async () => [
      accessRequest({ ageHours: 200, platform: 'whatsapp', userId: 'guest-1' }),
    ];
    const listAdminIdentities = async () => admins([{}]);
    const { record: recordStaleNotice, calledWith } = fakeGuestNoticeRecorder();
    const { notifyStale, calls } = fakeNotifyStale();
    const runOnce = makeDefaultAccessRequestStaleAlertRun(
      [discordAdapter],
      listPendingAccessRequests,
      listAdminIdentities,
      fakePolicyStore(),
      recordStaleNotice,
      notifyStale,
      noopPruneStaleNotices,
    );

    await assert.doesNotReject(runOnce());

    assert.deepEqual(calls, [], 'no notify call when no adapter is registered for the platform');
    assert.deepEqual(calledWith, [], 'no idempotency row when the notice was never actually sent');
  },
);

test(
  'SECURITY: a WindowClosedError from the guest sendDirectMessage is queued via queueForWindowReopen and ' +
    "swallowed — never rethrown, and never blocking another request's notice in the same tick",
  async () => {
    const { adapter, dms, queued } = makeCloudAdapter({
      'guest-closed': new WindowClosedError('guest-closed'),
    });
    const listPendingAccessRequests = async () => [
      accessRequest({ ageHours: 200, platform: 'whatsapp', userId: 'guest-closed' }),
      accessRequest({ ageHours: 200, platform: 'whatsapp', userId: 'guest-open' }),
    ];
    const listAdminIdentities = async () => admins([{}]);
    const { record: recordStaleNotice } = fakeGuestNoticeRecorder();
    const runOnce = makeDefaultAccessRequestStaleAlertRun(
      [adapter],
      listPendingAccessRequests,
      listAdminIdentities,
      fakePolicyStore(),
      recordStaleNotice,
      notifyAccessRequestStale,
      noopPruneStaleNotices,
    );

    await assert.doesNotReject(runOnce());

    assert.deepEqual(
      dms.map((d) => d.userId),
      ['guest-open'],
      'the open-window guest is still delivered live',
    );
    assert.equal(queued.length, 1);
    assert.equal(queued[0].userId, 'guest-closed');
    assert.equal(queued[0].priority, 'low');
  },
);

test(
  'SECURITY: recordAccessRequestStaleNotice commits BEFORE the send — a WindowClosedError at send time never ' +
    'causes a later tick to re-notify the same request',
  async () => {
    const { adapter, dms, queued } = makeCloudAdapter({
      'guest-closed': new WindowClosedError('guest-closed'),
    });
    const listPendingAccessRequests = async () => [
      accessRequest({ ageHours: 200, platform: 'whatsapp', userId: 'guest-closed' }),
    ];
    const listAdminIdentities = async () => admins([{}]);
    const { record: recordStaleNotice, calledWith } = fakeGuestNoticeRecorder();
    const runOnce = makeDefaultAccessRequestStaleAlertRun(
      [adapter],
      listPendingAccessRequests,
      listAdminIdentities,
      fakePolicyStore(),
      recordStaleNotice,
      notifyAccessRequestStale,
      noopPruneStaleNotices,
    );

    await runOnce();
    await runOnce();

    assert.equal(dms.length, 0, 'both ticks hit the closed window');
    assert.equal(
      queued.length,
      1,
      'the row committed on tick 1 (before the send) makes tick 2 skip the send entirely, so no second reopen notice is queued',
    );
    assert.deepEqual(
      calledWith,
      [
        { platform: 'whatsapp', userId: 'guest-closed' },
        { platform: 'whatsapp', userId: 'guest-closed' },
      ],
      'the ON CONFLICT DO NOTHING insert is attempted every tick, but only inserts (and only sends) on the first',
    );
  },
);

// --- notice-table prune (issue #1421) ---------------------------------------

test('SECURITY: pruneAccessRequestStaleNotices is called every tick against the FULL pending set, not just the stale subset', async () => {
  const { adapter } = makeAdapter();
  const listPendingAccessRequests = async () => [
    accessRequest({ ageHours: 200, platform: 'discord', userId: 'stale-guest' }),
    accessRequest({ ageHours: 1, platform: 'discord', userId: 'fresh-guest' }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const { prune, calls } = fakePruneRecorder();
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    fakePolicyStore(),
    skipGuestStaleNotice,
    undefined,
    prune,
  );

  await runOnce();

  assert.equal(calls.length, 1, 'prune must run exactly once per tick');
  assert.deepEqual(
    [...calls[0]].sort((a, b) => a.userId.localeCompare(b.userId)),
    [
      { platform: 'discord', userId: 'fresh-guest' },
      { platform: 'discord', userId: 'stale-guest' },
    ],
    'prune must be called with the FULL pending set, including the non-stale request',
  );
});

test('SECURITY: pruneAccessRequestStaleNotices still runs, and the admin alert still fires, when the stale set is empty', async () => {
  const { adapter, dms } = makeAdapter();
  const listPendingAccessRequests = async () => [];
  const listAdminIdentities = async () => admins([{}]);
  const { prune, calls } = fakePruneRecorder();
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    fakePolicyStore(),
    skipGuestStaleNotice,
    undefined,
    prune,
  );

  await runOnce();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], []);
  assert.equal(dms.length, 0, 'nothing pending never trips the admin alert');
});

test('SECURITY: a throwing pruneAccessRequestStaleNotices never suppresses the admin alert (nor a guest notice)', async () => {
  const { adapter, dms } = makeAdapter();
  const listPendingAccessRequests = async () => [accessRequest({ ageHours: 200 })];
  const listAdminIdentities = async () => admins([{}]);
  const throwingPrune = async () => {
    throw new Error('transient DB blip');
  };
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
    fakePolicyStore(),
    skipGuestStaleNotice,
    undefined,
    throwingPrune,
  );

  await assert.doesNotReject(runOnce());

  assert.equal(dms.length, 1, 'the admin alert must still fire despite the prune call failing');
});

// --- the scan bound ---------------------------------------------------------

test(
  'the default listPendingAccessRequests asks listAccessRequests for ACCESS_REQUEST_STALE_ALERT_SCAN_LIMIT, ' +
    'never its 50-row default — listAccessRequests is ordered last_requested_at DESC with no ordering override, ' +
    'so a bare call hands this job the MOST-RECENTLY-PINGED pending requests and then filters them for the ' +
    'OLDEST first-requested ones, which can miss a guest who pinged once long ago and never again',
  async () => {
    // Asserted against the SOURCE, deliberately — same technique as
    // tests/appealStaleAlert.test.ts's own scan-bound test: the argument only
    // exists inside a default parameter, so the sole runtime observation
    // point is the real `listAccessRequests` binding, resolved at import
    // time. Every other test in this file injects `listPendingAccessRequests`
    // and therefore bypasses the limit entirely.
    const source = await readFile(
      fileURLToPath(new URL('../src/module/accessRequestStaleAlert.ts', import.meta.url)),
      'utf8',
    );
    assert.match(
      source,
      /listAccessRequests\(ACCESS_REQUEST_STALE_ALERT_SCAN_LIMIT\)/,
      'the job must scan with the explicit constant — a bare listAccessRequests() silently takes 50 rows',
    );
    assert.doesNotMatch(source, /listAccessRequests\(\)/, 'no bare, unbounded-looking call may remain');
    assert.equal(
      ACCESS_REQUEST_STALE_ALERT_SCAN_LIMIT,
      500,
      'a deliberate, documented choice (listAccessRequests has no hard clamp to match, unlike its siblings)',
    );
  },
);
