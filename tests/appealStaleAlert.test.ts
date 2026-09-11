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
// convention in tests/departedAdminAlert.test.ts. This job is always-on (no
// enable flag), so no *_ENABLED var is needed here.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const {
  APPEAL_STALE_ALERT_THRESHOLD_HOURS,
  APPEAL_STALE_ALERT_SCAN_LIMIT,
  formatAppealStaleAlertMessage,
  makeDefaultAppealStaleAlertRun,
  alertAdmins,
  startAppealStaleAlert,
} = await import('../src/module/appealStaleAlert.js');
const { WindowClosedError } = await import('@swampratnz/agent-base/platforms/whatsapp/cloudAdapter.js');
const { APPEAL_STALE_ALERT_POLICY_KEY } = await import('../src/module/storage/policies.js');
const { notifyAppealStale } = await import('../src/module/agent/tools/notify.js');

type Platform = 'discord' | 'whatsapp';
type ModerationAppeal = {
  id: number;
  platform: Platform;
  userId: string;
  userName: string | null;
  reason: string | null;
  activeWarnings: number;
  strikeLimit: number;
  status: 'open' | 'resolved' | 'dismissed';
  createdAt: Date;
};
type AdminIdentity = { platform: Platform; platformUserId: string };

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

function appeal(overrides: Partial<ModerationAppeal> & { ageHours: number }): ModerationAppeal {
  const { ageHours, ...rest } = overrides;
  return {
    id: 1,
    platform: 'discord',
    userId: 'user-1',
    userName: 'Some Member',
    reason: null,
    activeWarnings: 3,
    strikeLimit: 3,
    status: 'open',
    createdAt: hoursAgo(ageHours),
    ...rest,
  };
}

function admins(entries: Array<Partial<AdminIdentity>>): AdminIdentity[] {
  return entries.map((e, i) => ({ platform: 'discord', platformUserId: `admin-${i}`, ...e }));
}

// Stands in for the real `getWithdrawnAppealIds` (issue #1413): always
// reports "nothing withdrawn", so the appellant-notice loop's withdrawal
// guard added to makeDefaultAppealStaleAlertRun never short-circuits it for
// a test that isn't specifically exercising that guard.
const skipWithdrawnIds = async () => new Set<number>();

// Stands in for the real `recordAppellantStaleNotice` (issue #1413): always
// reports "already notified" (false), so the appellant-notice branch added
// to makeDefaultAppealStaleAlertRun's loop is a guaranteed no-op for every
// test below that isn't specifically exercising the appellant-notice path
// itself — otherwise the default would fall through to the REAL storage
// function (a live Postgres query) and the real notifyAppealStale (a live
// language-preference lookup), same "deps must be all-or-nothing" hazard
// tests/reportStaleAlert.test.ts's skipReporterNotice guards against.
const skipAppellantNotice = async () => false;

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

/** Mirrors tests/departedAdminAlert.test.ts's makeCloudAdapter. */
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

test('formatAppealStaleAlertMessage: fixed template with the bare count and oldest-age-in-hours only', () => {
  assert.equal(
    formatAppealStaleAlertMessage(1, 80),
    '📋 1 open moderation appeal(s) have been waiting more than 72h for review (oldest: 80h) — ' +
      'run `list_appeals` to review.',
  );
  assert.equal(
    formatAppealStaleAlertMessage(4, 200),
    '📋 4 open moderation appeal(s) have been waiting more than 72h for review (oldest: 200h) — ' +
      'run `list_appeals` to review.',
  );
});

test('SECURITY: formatAppealStaleAlertMessage never contains anything beyond the fixed template + two integers, for any count/age', () => {
  for (const [count, age] of [
    [0, 0],
    [1, 72],
    [7, 999],
  ]) {
    const message = formatAppealStaleAlertMessage(count, age);
    assert.match(
      message,
      /^📋 \d+ open moderation appeal\(s\) have been waiting more than 72h for review \(oldest: \d+h\) — run `list_appeals` to review\.$/,
    );
  }
});

test('SECURITY: the crossing-tick alert DM contains no appeal id, user id/name, platform string, or reason text, even when the stale set contains them', async () => {
  const { adapter, dms } = makeAdapter();
  const secretUserId = 'secret-user-id-4f2a';
  const secretUserName = 'secret-display-name';
  const secretReason = 'secret-appeal-reason-text';
  // Built EAGERLY, before runOnce() captures its clock. The job reads
  // `Date.now()` first and only then awaits listOpenAppeals(), so a fixture
  // that dates the appeal inside that callback stamps it LATER than `now` —
  // making the measured age just under 100h, which `Math.floor` renders as
  // "99h". Sub-millisecond on an idle machine, but a loaded CI runner
  // deschedules the process between the two often enough to make this test a
  // coin flip (it reddened PR #1071 twice). Constructing first inverts the
  // ordering: the age is then a hair OVER 100h and floors to 100 every time.
  const staleAppeals = [
    appeal({
      ageHours: 100,
      id: 999,
      userId: secretUserId,
      userName: secretUserName,
      reason: secretReason,
      platform: 'discord',
    }),
  ];
  const listOpenAppeals = async () => staleAppeals;
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAppealStaleAlertRun(
    [adapter],
    listOpenAppeals,
    listAdminIdentities,
    fakePolicyStore(),
    skipWithdrawnIds,
    skipAppellantNotice,
  );

  await runOnce();

  assert.equal(dms.length, 1);
  const body = dms[0].text;
  assert.ok(!body.includes('999'), 'appeal id must never appear in the alert DM');
  assert.ok(!body.includes(secretUserId), 'user id must never appear in the alert DM');
  assert.ok(!body.includes(secretUserName), 'user name must never appear in the alert DM');
  assert.ok(!body.includes(secretReason), 'reason text must never appear in the alert DM');
  assert.ok(!body.includes('discord'), 'platform string must never appear in the alert DM');
  assert.equal(
    body,
    '📋 1 open moderation appeal(s) have been waiting more than 72h for review (oldest: 100h) — ' +
      'run `list_appeals` to review.',
  );
});

test('makeDefaultAppealStaleAlertRun: an open-appeals set with no appeal older than the threshold never alerts', async () => {
  const { adapter, dms } = makeAdapter();
  const listOpenAppeals = async () => [
    appeal({ ageHours: 1 }),
    appeal({ ageHours: APPEAL_STALE_ALERT_THRESHOLD_HOURS - 1 }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAppealStaleAlertRun(
    [adapter],
    listOpenAppeals,
    listAdminIdentities,
    fakePolicyStore(),
    skipWithdrawnIds,
    skipAppellantNotice,
  );

  await runOnce();

  assert.equal(dms.length, 0, 'nothing older than the threshold must never trip the alert');
});

test('makeDefaultAppealStaleAlertRun: alerts exactly once on the tick the stale count first becomes >0, then stays silent while it remains >0 — including a partial decrease that never reaches 0', async () => {
  const { adapter, dms } = makeAdapter();
  let staleCount = 0;
  const listOpenAppeals = async () =>
    Array.from({ length: staleCount }, (_, i) => appeal({ ageHours: 100, id: i }));
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAppealStaleAlertRun(
    [adapter],
    listOpenAppeals,
    listAdminIdentities,
    fakePolicyStore(),
    skipWithdrawnIds,
    skipAppellantNotice,
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

test('makeDefaultAppealStaleAlertRun: the latch re-arms once the stale count returns to exactly 0, and a later crossing alerts again', async () => {
  const { adapter, dms } = makeAdapter();
  let staleCount = 2;
  const listOpenAppeals = async () =>
    Array.from({ length: staleCount }, (_, i) => appeal({ ageHours: 100, id: i }));
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAppealStaleAlertRun(
    [adapter],
    listOpenAppeals,
    listAdminIdentities,
    fakePolicyStore(),
    skipWithdrawnIds,
    skipAppellantNotice,
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

test('makeDefaultAppealStaleAlertRun: writes the active marker to the policy store only AFTER the alertAdmins fan-out returns, on the tick that crosses', async () => {
  const { adapter } = makeAdapter();
  const store = fakePolicyStore();
  const listOpenAppeals = async () => [appeal({ ageHours: 100 })];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAppealStaleAlertRun(
    [adapter],
    listOpenAppeals,
    listAdminIdentities,
    store,
    skipWithdrawnIds,
    skipAppellantNotice,
  );

  assert.equal(store.written.length, 0, 'no write before the tick runs');
  await runOnce();

  assert.deepEqual(store.written, [
    { key: APPEAL_STALE_ALERT_POLICY_KEY, value: 'true', updatedBy: 'system' },
  ]);
});

test('makeDefaultAppealStaleAlertRun: restart-safety — a fresh factory seeded with the active marker AND a still-stale count on its first tick does not re-alert, and leaves the marker active', async () => {
  const { adapter, dms } = makeAdapter();
  const store = fakePolicyStore({ [APPEAL_STALE_ALERT_POLICY_KEY]: 'true' });
  const listOpenAppeals = async () => [appeal({ ageHours: 100 }), appeal({ ageHours: 200, id: 2 })];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAppealStaleAlertRun(
    [adapter],
    listOpenAppeals,
    listAdminIdentities,
    store,
    skipWithdrawnIds,
    skipAppellantNotice,
  );

  await runOnce();
  assert.equal(dms.length, 0, 'a restart mid-backlog must not re-fire a duplicate DM');

  await runOnce();
  assert.equal(dms.length, 0, 'a later tick with the same still-stale backlog must not fire either');
  assert.equal(store.written.length, 0, 'the already-active marker is never rewritten while nothing crosses');
});

test('makeDefaultAppealStaleAlertRun: re-arm survives a restart — the marker clears to "" when the count returns to 0, and a fresh factory alerts again on the next crossing', async () => {
  const { adapter, dms } = makeAdapter();
  const store = fakePolicyStore({ [APPEAL_STALE_ALERT_POLICY_KEY]: 'true' });
  const listAdminIdentities = async () => admins([{}]);

  const firstProcess = makeDefaultAppealStaleAlertRun(
    [adapter],
    async () => [],
    listAdminIdentities,
    store,
    skipWithdrawnIds,
    skipAppellantNotice,
  );
  await firstProcess(); // count drops to 0 -> re-arm
  assert.equal(dms.length, 0);
  assert.deepEqual(store.written, [{ key: APPEAL_STALE_ALERT_POLICY_KEY, value: '', updatedBy: 'system' }]);

  // A brand-new process (fresh in-memory tracker), seeded from the SAME
  // store the previous process just cleared.
  const secondProcess = makeDefaultAppealStaleAlertRun(
    [adapter],
    async () => [appeal({ ageHours: 100 })],
    listAdminIdentities,
    store,
    skipWithdrawnIds,
    skipAppellantNotice,
  );
  await secondProcess();
  assert.equal(dms.length, 1, 'a fresh crossing after the persisted re-arm alerts again');
  assert.deepEqual(store.written, [
    { key: APPEAL_STALE_ALERT_POLICY_KEY, value: '', updatedBy: 'system' },
    { key: APPEAL_STALE_ALERT_POLICY_KEY, value: 'true', updatedBy: 'system' },
  ]);
});

test('SECURITY: makeDefaultAppealStaleAlertRun never threads a member/admin identifier into updatePolicy — the actor is always the fixed "system" string', async () => {
  const { adapter } = makeAdapter();
  const store = fakePolicyStore();
  const secretAdminId = 'admin-should-never-be-the-actor';
  const listOpenAppeals = async () => [appeal({ ageHours: 100 })];
  const listAdminIdentities = async () => admins([{ platformUserId: secretAdminId }]);
  const runOnce = makeDefaultAppealStaleAlertRun(
    [adapter],
    listOpenAppeals,
    listAdminIdentities,
    store,
    skipWithdrawnIds,
    skipAppellantNotice,
  );

  await runOnce();

  assert.ok(store.written.length > 0);
  for (const write of store.written) {
    assert.equal(write.updatedBy, 'system');
    assert.notEqual(write.updatedBy, secretAdminId);
  }
});

test('alertAdmins: every admin returned by listAdminIdentities with a connected adapter receives exactly one DM', async () => {
  const { adapter, dms } = makeAdapter();
  const listAdminIdentities = async () => admins([{}, {}, {}]);

  await alertAdmins([adapter], 'stale-appeal alert', listAdminIdentities);

  assert.deepEqual(dms.map((d) => d.userId).sort(), ['admin-0', 'admin-1', 'admin-2']);
  assert.ok(dms.every((d) => d.text === 'stale-appeal alert'));
});

test('alertAdmins: recipient isolation — a WindowClosedError for one admin is queued via queueForWindowReopen at low priority and does not block delivery to the rest', async () => {
  const { adapter, dms, queued } = makeCloudAdapter({
    'admin-closed': new WindowClosedError('admin-closed'),
  });
  const listAdminIdentities = async () =>
    admins([
      { platform: 'whatsapp', platformUserId: 'admin-open' },
      { platform: 'whatsapp', platformUserId: 'admin-closed' },
    ]);

  await alertAdmins([adapter], 'stale-appeal alert, one window closed', listAdminIdentities);

  assert.deepEqual(
    dms.map((d) => d.userId),
    ['admin-open'],
    'the open-window admin is still delivered live',
  );
  assert.deepEqual(queued, [
    { userId: 'admin-closed', message: 'stale-appeal alert, one window closed', priority: 'low' },
  ]);
});

test('SECURITY: alertAdmins — a rejection that is NOT a WindowClosedError is never queued via queueForWindowReopen', async () => {
  const { dms, queued, adapter } = makeCloudAdapter({
    'admin-broken': new Error('502 from Graph API'),
  });
  const listAdminIdentities = async () =>
    admins([
      { platform: 'whatsapp', platformUserId: 'admin-ok' },
      { platform: 'whatsapp', platformUserId: 'admin-broken' },
    ]);

  await alertAdmins([adapter], 'stale-appeal alert, unrelated failure', listAdminIdentities);

  assert.deepEqual(
    dms.map((d) => d.userId),
    ['admin-ok'],
  );
  assert.deepEqual(
    queued,
    [],
    'a non-WindowClosedError rejection must never populate the window-reopen queue',
  );
});

test('alertAdmins: an admin with no adapter matching its platform (or a disconnected one) is silently skipped, never throws', async () => {
  const { adapter, dms } = makeAdapter(false);
  const listAdminIdentities = async () => admins([{}]);

  await assert.doesNotReject(alertAdmins([adapter], 'stale-appeal alert', listAdminIdentities));
  assert.equal(dms.length, 0);
});

test('startAppealStaleAlert: always-on, no enable flag — creates a timer even with no *_ENABLED env set', () => {
  const timer = startAppealStaleAlert([], async () => {});
  assert.notEqual(timer, null, 'this job is unconditionally enabled by design');
  if (timer) clearInterval(timer);
});

// --- appellant-side mid-flight stale notice (issue #1413) -------------------

/** Stands in for `recordAppellantStaleNotice`: an in-memory Set, same
 * "returns true only the first time" contract the real `INSERT ... ON
 * CONFLICT DO NOTHING` gives. Also exposes every id it was called with, so a
 * test can assert it was never called at all for a withdrawn appeal. */
function fakeAppellantNoticeRecorder(): {
  record: (id: number) => Promise<boolean>;
  calledWith: number[];
} {
  const seen = new Set<number>();
  const calledWith: number[] = [];
  return {
    record: async (id: number) => {
      calledWith.push(id);
      if (seen.has(id)) return false;
      seen.add(id);
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

test('appellant stale notice: sent exactly once per appeal id — a second tick for the same still-stale appeal does not re-send', async () => {
  const { adapter } = makeAdapter();
  const listOpenAppeals = async () => [
    appeal({ ageHours: 100, id: 5, platform: 'discord', userId: 'appellant-1' }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const { record: recordAppellantStaleNotice } = fakeAppellantNoticeRecorder();
  const { notifyStale, calls } = fakeNotifyStale();
  const runOnce = makeDefaultAppealStaleAlertRun(
    [adapter],
    listOpenAppeals,
    listAdminIdentities,
    fakePolicyStore(),
    skipWithdrawnIds,
    recordAppellantStaleNotice,
    notifyStale,
  );

  await runOnce();
  await runOnce();

  assert.deepEqual(calls, [{ userId: 'appellant-1', platform: 'discord' }]);
});

test(
  'appellant stale notice: fires independently of the admin crossing latch — an admin backlog already latched ' +
    'open (shouldAlert false) still gets the appellant notified',
  async () => {
    const { adapter, dms } = makeAdapter();
    const store = fakePolicyStore({ [APPEAL_STALE_ALERT_POLICY_KEY]: 'true' });
    const listOpenAppeals = async () => [
      appeal({ ageHours: 100, id: 11, platform: 'discord', userId: 'appellant-1' }),
    ];
    const listAdminIdentities = async () => admins([{}]);
    const { record: recordAppellantStaleNotice } = fakeAppellantNoticeRecorder();
    const { notifyStale, calls } = fakeNotifyStale();
    const runOnce = makeDefaultAppealStaleAlertRun(
      [adapter],
      listOpenAppeals,
      listAdminIdentities,
      store,
      skipWithdrawnIds,
      recordAppellantStaleNotice,
      notifyStale,
    );

    await runOnce();

    assert.equal(dms.length, 0, "the admin's own alert stays latched (already active) and does not re-send");
    assert.deepEqual(
      calls,
      [{ userId: 'appellant-1', platform: 'discord' }],
      "the appellant notice must not be gated behind the admin's own shouldAlert",
    );
  },
);

test("SECURITY: appellant stale notice is addressed only to the appeal's own userId, never an admin's id", async () => {
  const { adapter } = makeAdapter();
  const listOpenAppeals = async () => [
    appeal({ ageHours: 100, id: 21, platform: 'discord', userId: 'appellant-distinct-from-admin' }),
  ];
  const listAdminIdentities = async () => admins([{ platformUserId: 'admin-0' }]);
  const { record: recordAppellantStaleNotice } = fakeAppellantNoticeRecorder();
  const { notifyStale, calls } = fakeNotifyStale();
  const runOnce = makeDefaultAppealStaleAlertRun(
    [adapter],
    listOpenAppeals,
    listAdminIdentities,
    fakePolicyStore(),
    skipWithdrawnIds,
    recordAppellantStaleNotice,
    notifyStale,
  );

  await runOnce();

  assert.deepEqual(calls, [{ userId: 'appellant-distinct-from-admin', platform: 'discord' }]);
});

test(
  'appellant stale notice: a throwing recordAppellantStaleNotice for one appeal is caught, never blocking ' +
    "another stale appeal's notice or the admin alert",
  async () => {
    const { adapter, dms } = makeAdapter();
    const listOpenAppeals = async () => [
      appeal({ ageHours: 100, id: 31, platform: 'discord', userId: 'appellant-broken' }),
      appeal({ ageHours: 100, id: 32, platform: 'discord', userId: 'appellant-fine' }),
    ];
    const listAdminIdentities = async () => admins([{}]);
    const recordAppellantStaleNotice = async (id: number) => {
      if (id === 31) throw new Error('transient DB blip');
      return true;
    };
    const { notifyStale, calls } = fakeNotifyStale();
    const runOnce = makeDefaultAppealStaleAlertRun(
      [adapter],
      listOpenAppeals,
      listAdminIdentities,
      fakePolicyStore(),
      skipWithdrawnIds,
      recordAppellantStaleNotice,
      notifyStale,
    );

    await assert.doesNotReject(runOnce());

    assert.deepEqual(calls, [{ userId: 'appellant-fine', platform: 'discord' }]);
    assert.equal(dms.length, 1, 'the admin alert must still fire despite one appellant notice failing');
  },
);

test(
  "appellant stale notice: no connected adapter for the appeal's platform is a silent skip — no throw, " +
    'no notify call, and no idempotency row (so a later tick with an adapter can still notify)',
  async () => {
    const { adapter: discordAdapter } = makeAdapter(); // no whatsapp adapter registered at all
    const listOpenAppeals = async () => [
      appeal({ ageHours: 100, id: 61, platform: 'whatsapp', userId: 'appellant-1' }),
    ];
    const listAdminIdentities = async () => admins([{}]);
    const { record: recordAppellantStaleNotice, calledWith } = fakeAppellantNoticeRecorder();
    const { notifyStale, calls } = fakeNotifyStale();
    const runOnce = makeDefaultAppealStaleAlertRun(
      [discordAdapter],
      listOpenAppeals,
      listAdminIdentities,
      fakePolicyStore(),
      skipWithdrawnIds,
      recordAppellantStaleNotice,
      notifyStale,
    );

    await assert.doesNotReject(runOnce());

    assert.deepEqual(calls, [], 'no notify call when no adapter is registered for the platform');
    assert.deepEqual(calledWith, [], 'no idempotency row when the notice was never actually sent');
  },
);

test(
  'SECURITY: a withdrawn stale appeal produces zero recordAppellantStaleNotice/notifyAppealStale calls, and ' +
    "the admin-facing stale count/alertAdmins behaviour is byte-for-byte unchanged from today's for the same input " +
    '(issue #1413 acceptance criterion #2 — the withdrawal filter applies to the appellant loop only)',
  async () => {
    const { adapter, dms } = makeAdapter();
    const listOpenAppeals = async () => [
      appeal({ ageHours: 100, id: 41, platform: 'discord', userId: 'withdrawn-appellant' }),
      appeal({ ageHours: 100, id: 42, platform: 'discord', userId: 'live-appellant' }),
    ];
    const listAdminIdentities = async () => admins([{}]);
    const getWithdrawnIds = async (ids: readonly number[]) => new Set(ids.filter((id) => id === 41));
    const { record: recordAppellantStaleNotice, calledWith } = fakeAppellantNoticeRecorder();
    const { notifyStale, calls } = fakeNotifyStale();
    const runOnce = makeDefaultAppealStaleAlertRun(
      [adapter],
      listOpenAppeals,
      listAdminIdentities,
      fakePolicyStore(),
      getWithdrawnIds,
      recordAppellantStaleNotice,
      notifyStale,
    );

    await runOnce();

    assert.deepEqual(
      calls,
      [{ userId: 'live-appellant', platform: 'discord' }],
      'the withdrawn appeal must never reach the appellant notice',
    );
    assert.deepEqual(calledWith, [42], 'the withdrawn appeal id must never reach recordAppellantStaleNotice');
    // Both stale appeals (41 AND 42) still count toward the admin-facing
    // alert — withdrawal is not applied to the count this PR is scoped to
    // leave alone.
    assert.equal(
      dms.length,
      1,
      'the admin count/alert must include the withdrawn appeal, unchanged from today',
    );
    assert.match(dms[0].text, /^📋 2 open moderation appeal\(s\)/);
  },
);

test(
  'SECURITY: a WindowClosedError from the appellant sendDirectMessage is queued via queueForWindowReopen and ' +
    "swallowed — never rethrown, and never blocking another appeal's notice in the same tick",
  async () => {
    const { adapter, dms, queued } = makeCloudAdapter({
      'appellant-closed': new WindowClosedError('appellant-closed'),
    });
    const listOpenAppeals = async () => [
      appeal({ ageHours: 100, id: 51, platform: 'whatsapp', userId: 'appellant-closed' }),
      appeal({ ageHours: 100, id: 52, platform: 'whatsapp', userId: 'appellant-open' }),
    ];
    const listAdminIdentities = async () => admins([{}]);
    const { record: recordAppellantStaleNotice } = fakeAppellantNoticeRecorder();
    const runOnce = makeDefaultAppealStaleAlertRun(
      [adapter],
      listOpenAppeals,
      listAdminIdentities,
      fakePolicyStore(),
      skipWithdrawnIds,
      recordAppellantStaleNotice,
      notifyAppealStale,
    );

    await assert.doesNotReject(runOnce());

    assert.deepEqual(
      dms.map((d) => d.userId),
      ['appellant-open'],
      'the open-window appellant is still delivered live',
    );
    assert.equal(queued.length, 1);
    assert.equal(queued[0].userId, 'appellant-closed');
    assert.equal(queued[0].priority, 'low');
  },
);

test(
  'SECURITY: recordAppellantStaleNotice commits BEFORE the send — a WindowClosedError at send time never causes ' +
    'a later tick to re-notify the same appeal',
  async () => {
    const { adapter, dms, queued } = makeCloudAdapter({
      'appellant-closed': new WindowClosedError('appellant-closed'),
    });
    const listOpenAppeals = async () => [
      appeal({ ageHours: 100, id: 71, platform: 'whatsapp', userId: 'appellant-closed' }),
    ];
    const listAdminIdentities = async () => admins([{}]);
    const { record: recordAppellantStaleNotice, calledWith } = fakeAppellantNoticeRecorder();
    const runOnce = makeDefaultAppealStaleAlertRun(
      [adapter],
      listOpenAppeals,
      listAdminIdentities,
      fakePolicyStore(),
      skipWithdrawnIds,
      recordAppellantStaleNotice,
      notifyAppealStale,
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
      [71, 71],
      'the ON CONFLICT DO NOTHING insert is attempted every tick, but only inserts (and only sends) on the first',
    );
  },
);

// --- the scan bound (automated review of PR #1021) --------------------------

test(
  'the default listOpenAppeals asks listAppeals for APPEAL_STALE_ALERT_SCAN_LIMIT, never its 50-row default ' +
    '— that default is ordered created_at DESC, so a bare call hands this job the NEWEST open appeals and ' +
    'then filters them for the OLDEST, going quiet exactly as the backlog worsens',
  async () => {
    // Asserted against the SOURCE, deliberately. The argument only exists
    // inside a default parameter, so the sole runtime observation point is the
    // real `listAppeals` binding — and it is resolved at import time here, so
    // `t.mock.module` cannot retarget it from this file (the same constraint
    // tests/agentCoreCacheUsage.test.ts documents). Every other test in this
    // file injects `listOpenAppeals` and therefore bypasses the limit
    // entirely, which is precisely how the bare call shipped unnoticed — so a
    // behavioural test here would re-create the blind spot rather than close
    // it. Same technique as tests/conflictResolverEligibility.test.ts, which
    // reads its subject out of a workflow file.
    const source = await readFile(
      fileURLToPath(new URL('../src/module/appealStaleAlert.ts', import.meta.url)),
      'utf8',
    );
    assert.match(
      source,
      /listAppeals\('open',\s*APPEAL_STALE_ALERT_SCAN_LIMIT\)/,
      "the job must scan with the explicit constant — a bare listAppeals('open') silently takes 50 rows",
    );
    assert.doesNotMatch(source, /listAppeals\('open'\)/, 'no bare, unbounded-looking call may remain');
    assert.equal(
      APPEAL_STALE_ALERT_SCAN_LIMIT,
      200,
      "200 is listAppeals' own hard clamp — a larger value here would be a claim the repository does not honour",
    );
  },
);
