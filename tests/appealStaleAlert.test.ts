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
  const runOnce = makeDefaultAppealStaleAlertRun([adapter], listOpenAppeals, listAdminIdentities, store);

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
  const runOnce = makeDefaultAppealStaleAlertRun([adapter], listOpenAppeals, listAdminIdentities, store);

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

  const firstProcess = makeDefaultAppealStaleAlertRun([adapter], async () => [], listAdminIdentities, store);
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
  const runOnce = makeDefaultAppealStaleAlertRun([adapter], listOpenAppeals, listAdminIdentities, store);

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
