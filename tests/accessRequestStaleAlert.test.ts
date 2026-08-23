import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';
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
  );

  await runOnce();

  assert.equal(dms.length, 0, 'nothing older than the threshold must never trip the alert');
});

test('makeDefaultAccessRequestStaleAlertRun: an access request exactly at the threshold DOES trigger the alert', async () => {
  const { adapter, dms } = makeAdapter();
  const listPendingAccessRequests = async () => [
    accessRequest({ ageHours: ACCESS_REQUEST_STALE_ALERT_THRESHOLD_HOURS }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultAccessRequestStaleAlertRun(
    [adapter],
    listPendingAccessRequests,
    listAdminIdentities,
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
