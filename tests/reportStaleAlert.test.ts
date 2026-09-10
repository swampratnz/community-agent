import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';
import type { OutgoingMessage, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';
import { fakePolicyStore } from './support/fakePolicyStore.js';

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
  REPORT_STALE_ALERT_THRESHOLD_HOURS,
  REPORT_STALE_ALERT_SCAN_LIMIT,
  formatReportStaleAlertMessage,
  makeDefaultReportStaleAlertRun,
  startReportStaleAlert,
} = await import('../src/module/reportStaleAlert.js');
const { WindowClosedError } = await import('@swampratnz/agent-base/platforms/whatsapp/cloudAdapter.js');
const { REPORT_STALE_ALERT_POLICY_KEY } = await import('../src/module/storage/policies.js');

type Platform = 'discord' | 'whatsapp';
type ContentReport = {
  id: number;
  platform: Platform;
  reporterUserId: string;
  reporterName: string | null;
  conversationId: string;
  targetUserId: string | null;
  messageId: string | null;
  reason: string;
  status: 'open' | 'resolved' | 'dismissed' | 'withdrawn';
  createdAt: Date;
  resolvedBy: string | null;
  resolvedAt: Date | null;
};
type AdminIdentity = { platform: Platform; platformUserId: string };

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

function report(overrides: Partial<ContentReport> & { ageHours: number }): ContentReport {
  const { ageHours, ...rest } = overrides;
  return {
    id: 1,
    platform: 'discord',
    reporterUserId: 'reporter-1',
    reporterName: 'Some Reporter',
    conversationId: 'convo-1',
    targetUserId: null,
    messageId: null,
    reason: 'harassment',
    status: 'open',
    createdAt: hoursAgo(ageHours),
    resolvedBy: null,
    resolvedAt: null,
    ...rest,
  };
}

function admins(entries: Array<Partial<AdminIdentity>>): AdminIdentity[] {
  return entries.map((e, i) => ({ platform: 'discord', platformUserId: `admin-${i}`, ...e }));
}

// Stands in for the real `recordReporterStaleNotice` (issue #1375): always
// reports "already notified" (false), so the reporter-notify branch added to
// makeDefaultReportStaleAlertRun's loop is a guaranteed no-op for every test
// below that isn't specifically exercising the reporter-notify path itself —
// otherwise a stale report's reporter DM would land in the very same `dms`
// array these tests assert the admin alert count against.
const skipReporterNotice = async () => false;

function makeAdapter(
  connected = true,
  scopeByUser: Record<string, string[]> = {},
): {
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
    async conversationsForUser(userId: string) {
      return scopeByUser[userId] ?? [];
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

test('formatReportStaleAlertMessage: fixed template with the bare count and oldest-age-in-hours only', () => {
  assert.equal(
    formatReportStaleAlertMessage(1, 60),
    '🚩 1 open content report(s) in your conversations have been waiting more than 48h for review ' +
      '(oldest: 60h) — run `list_reports` to review.',
  );
  assert.equal(
    formatReportStaleAlertMessage(4, 300),
    '🚩 4 open content report(s) in your conversations have been waiting more than 48h for review ' +
      '(oldest: 300h) — run `list_reports` to review.',
  );
});

test('SECURITY: formatReportStaleAlertMessage never contains anything beyond the fixed template + two integers, for any count/age', () => {
  for (const [count, age] of [
    [0, 0],
    [1, 48],
    [7, 999],
  ]) {
    const message = formatReportStaleAlertMessage(count, age);
    assert.match(
      message,
      /^🚩 \d+ open content report\(s\) in your conversations have been waiting more than 48h for review \(oldest: \d+h\) — run `list_reports` to review\.$/,
    );
  }
});

test('SECURITY: the crossing-tick alert DM contains no report id, reporter, target, message id, or reason, even when the stale set contains them', async () => {
  const { adapter, dms } = makeAdapter(true, { 'admin-0': ['convo-1'] });
  const secretReporterId = 'secret-reporter-id-4f2a';
  const secretTargetId = 'secret-target-id-9b1c';
  const secretMessageId = 'secret-message-id-77aa';
  const secretReason = 'secret-report-reason-text';
  // Built EAGERLY, before runOnce() captures its clock — see
  // tests/appealStaleAlert.test.ts's identical comment (issue #1071): the job
  // reads `Date.now()` first and only then awaits listOpenReportsForAdmin(),
  // so a fixture dated INSIDE that lazy callback stamps createdAt later than
  // `now`, undershooting the intended age by a hair.
  const staleReports = [
    report({
      ageHours: 60,
      id: 999,
      reporterUserId: secretReporterId,
      targetUserId: secretTargetId,
      messageId: secretMessageId,
      reason: secretReason,
      platform: 'discord',
    }),
  ];
  const listOpenReportsForAdmin = async () => staleReports;
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultReportStaleAlertRun(
    [adapter],
    listAdminIdentities,
    listOpenReportsForAdmin,
    async () => [],
    fakePolicyStore(),
    skipReporterNotice,
  );

  await runOnce();

  assert.equal(dms.length, 1);
  const body = dms[0].text;
  assert.ok(!body.includes('999'), 'report id must never appear in the alert DM');
  assert.ok(!body.includes(secretReporterId), 'reporter id must never appear in the alert DM');
  assert.ok(!body.includes(secretTargetId), 'target id must never appear in the alert DM');
  assert.ok(!body.includes(secretMessageId), 'message id must never appear in the alert DM');
  assert.ok(!body.includes(secretReason), 'reason text must never appear in the alert DM');
  assert.equal(
    body,
    '🚩 1 open content report(s) in your conversations have been waiting more than 48h for review ' +
      '(oldest: 60h) — run `list_reports` to review.',
  );
});

test('makeDefaultReportStaleAlertRun: an open-reports set with none older than the threshold never alerts', async () => {
  const { adapter, dms } = makeAdapter(true, { 'admin-0': ['convo-1'] });
  const listOpenReportsForAdmin = async () => [
    report({ ageHours: 1 }),
    report({ ageHours: REPORT_STALE_ALERT_THRESHOLD_HOURS - 1 }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultReportStaleAlertRun(
    [adapter],
    listAdminIdentities,
    listOpenReportsForAdmin,
    async () => [],
    fakePolicyStore(),
    skipReporterNotice,
  );

  await runOnce();

  assert.equal(dms.length, 0, 'nothing older than the threshold must never trip the alert');
});

test('makeDefaultReportStaleAlertRun: alerts exactly once on the tick the stale count first becomes >0, then stays silent while it remains >0 — including a partial decrease that never reaches 0', async () => {
  const { adapter, dms } = makeAdapter(true, { 'admin-0': ['convo-1'] });
  let staleCount = 0;
  const listOpenReportsForAdmin = async () =>
    Array.from({ length: staleCount }, (_, i) => report({ ageHours: 60, id: i }));
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultReportStaleAlertRun(
    [adapter],
    listAdminIdentities,
    listOpenReportsForAdmin,
    async () => [],
    fakePolicyStore(),
    skipReporterNotice,
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

test('makeDefaultReportStaleAlertRun: the latch re-arms once the stale count returns to exactly 0, and a later crossing alerts again', async () => {
  const { adapter, dms } = makeAdapter(true, { 'admin-0': ['convo-1'] });
  let staleCount = 2;
  const listOpenReportsForAdmin = async () =>
    Array.from({ length: staleCount }, (_, i) => report({ ageHours: 60, id: i }));
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultReportStaleAlertRun(
    [adapter],
    listAdminIdentities,
    listOpenReportsForAdmin,
    async () => [],
    fakePolicyStore(),
    skipReporterNotice,
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

test(
  "makeDefaultReportStaleAlertRun: restart-safety — seeded from a store already holding an admin's own key " +
    "active, that admin's still->=1 first tick does not re-send the DM",
  async () => {
    const { adapter, dms } = makeAdapter(true, { 'admin-0': ['convo-1'] });
    const store = fakePolicyStore({ [REPORT_STALE_ALERT_POLICY_KEY]: ['discord:admin-0'] });
    const listOpenReportsForAdmin = async () => [report({ ageHours: 60 })];
    const listAdminIdentities = async () => admins([{}]);
    const runOnce = makeDefaultReportStaleAlertRun(
      [adapter],
      listAdminIdentities,
      listOpenReportsForAdmin,
      async () => [],
      store,
      skipReporterNotice,
    );

    await runOnce();

    assert.equal(
      dms.length,
      0,
      'a fresh process must not re-fire for an already-active, still-stale backlog',
    );
  },
);

test(
  "makeDefaultReportStaleAlertRun: an admin's re-arm is persisted synchronously and survives a restart — a " +
    'fresh run reseeded from the written store alerts again on a later crossing',
  async () => {
    const { adapter, dms } = makeAdapter(true, { 'admin-0': ['convo-1'] });
    const store = fakePolicyStore();
    let staleCount = 2;
    const listOpenReportsForAdmin = async () =>
      Array.from({ length: staleCount }, (_, i) => report({ ageHours: 60, id: i }));
    const listAdminIdentities = async () => admins([{}]);
    const runOnce = makeDefaultReportStaleAlertRun(
      [adapter],
      listAdminIdentities,
      listOpenReportsForAdmin,
      async () => [],
      store,
      skipReporterNotice,
    );

    await runOnce(); // 0 -> 2, crosses
    assert.equal(dms.length, 1);
    assert.deepEqual(await store.readPolicy(REPORT_STALE_ALERT_POLICY_KEY), ['discord:admin-0']);

    staleCount = 0;
    await runOnce(); // re-arms, persisted synchronously — no commit() call needed
    assert.deepEqual(await store.readPolicy(REPORT_STALE_ALERT_POLICY_KEY), []);

    // Simulate a restart: a brand-new run, seeded from the same (now re-armed) store.
    staleCount = 1;
    const restarted = makeDefaultReportStaleAlertRun(
      [adapter],
      listAdminIdentities,
      listOpenReportsForAdmin,
      async () => [],
      store,
      skipReporterNotice,
    );
    await restarted(); // 0 -> 1, crosses again
    assert.equal(
      dms.length,
      2,
      'a fresh crossing after a persisted re-arm alerts again, even from a brand-new process',
    );
  },
);

test(
  "SECURITY: per-admin isolation of persisted state — a two-admin run's crossing latch persists only the " +
    "admin(s) whose own count actually crossed, never the other admin's key",
  async () => {
    const { adapter, dms } = makeAdapter(true, {
      'admin-a': ['convo-a'],
      'admin-b': ['convo-b'],
    });
    const store = fakePolicyStore();
    const staleReport = report({ ageHours: 60, id: 1, conversationId: 'convo-a' });
    const listOpenReportsForAdmin = async (scope: readonly string[]) =>
      scope.includes(staleReport.conversationId) ? [staleReport] : [];
    const listAdminIdentities = async () =>
      admins([{ platformUserId: 'admin-a' }, { platformUserId: 'admin-b' }]);
    const runOnce = makeDefaultReportStaleAlertRun(
      [adapter],
      listAdminIdentities,
      listOpenReportsForAdmin,
      async () => [],
      store,
      skipReporterNotice,
    );

    await runOnce();

    assert.deepEqual(
      dms.map((d) => d.userId),
      ['admin-a'],
    );
    assert.deepEqual(
      await store.readPolicy(REPORT_STALE_ALERT_POLICY_KEY),
      ['discord:admin-a'],
      "admin-b never crossed, so admin-b's key must never appear in the persisted active set",
    );
  },
);

test(
  'makeDefaultReportStaleAlertRun: a malformed stored value (not an array) is treated as an empty active set, ' +
    'with no throw and no suppressed alert',
  async () => {
    const { adapter, dms } = makeAdapter(true, { 'admin-0': ['convo-1'] });
    const store = fakePolicyStore({ [REPORT_STALE_ALERT_POLICY_KEY]: 'not-an-array' });
    const listOpenReportsForAdmin = async () => [report({ ageHours: 60 })];
    const listAdminIdentities = async () => admins([{}]);
    const runOnce = makeDefaultReportStaleAlertRun(
      [adapter],
      listAdminIdentities,
      listOpenReportsForAdmin,
      async () => [],
      store,
      skipReporterNotice,
    );

    await assert.doesNotReject(runOnce());
    assert.equal(dms.length, 1, 'a malformed stored value must not suppress a genuine crossing');
  },
);

test(
  'SECURITY: two admins with disjoint conversationsForUser scopes — admin A never alerts/counts a report only ' +
    'admin B can see, and vice versa',
  async () => {
    const { adapter, dms } = makeAdapter(true, {
      'admin-a': ['convo-a'],
      'admin-b': ['convo-b'],
    });
    // A single aged report, visible only in convo-a. The injected
    // listOpenReportsForAdmin stands in for listReports' own SQL scoping:
    // it returns the report only when the admin's own scope contains its
    // conversation, exactly what the real conversation_id = ANY($n) filter
    // enforces.
    const staleReport = report({ ageHours: 60, id: 42, conversationId: 'convo-a' });
    const listOpenReportsForAdmin = async (scope: readonly string[]) =>
      scope.includes(staleReport.conversationId) ? [staleReport] : [];
    const listAdminIdentities = async () =>
      admins([{ platformUserId: 'admin-a' }, { platformUserId: 'admin-b' }]);
    const runOnce = makeDefaultReportStaleAlertRun(
      [adapter],
      listAdminIdentities,
      listOpenReportsForAdmin,
      async () => [],
      fakePolicyStore(),
      skipReporterNotice,
    );

    await runOnce();

    assert.deepEqual(
      dms.map((d) => d.userId),
      ['admin-a'],
      'only the admin whose own scope contains the stale report is alerted',
    );
  },
);

test(
  'SECURITY: a report filed against an admin (or a linked identity) never counts toward or triggers that ' +
    "admin's own alert — pinned via the accused-admin exclusion's viewerIds threading",
  async () => {
    const { adapter, dms } = makeAdapter(true, { 'admin-0': ['convo-1'] });
    // The injected listOpenReportsForAdmin stands in for listReports' own
    // accused-admin exclusion: it excludes any report whose targetUserId is
    // in the resolved viewerIds, exactly what the real OR is_dm ... <> ALL()
    // predicate enforces.
    const reportAgainstAdmin = report({
      ageHours: 60,
      id: 7,
      targetUserId: 'admin-0-whatsapp-identity',
    });
    const listOpenReportsForAdmin = async (_scope: readonly string[], viewerIds: readonly string[]) =>
      [reportAgainstAdmin].filter((r) => !r.targetUserId || !viewerIds.includes(r.targetUserId));
    const listAdminIdentities = async () => admins([{}]);
    // Linked identity resolution: this admin's WhatsApp identity is the
    // report's target, matching link_member's cross-platform linking.
    const resolveViewerIds = async () => ['admin-0', 'admin-0-whatsapp-identity'];
    const runOnce = makeDefaultReportStaleAlertRun(
      [adapter],
      listAdminIdentities,
      listOpenReportsForAdmin,
      resolveViewerIds,
      fakePolicyStore(),
      skipReporterNotice,
    );

    await runOnce();

    assert.equal(
      dms.length,
      0,
      'a report filed against the admin themselves must never trigger their own alert',
    );
  },
);

test('SECURITY: a WindowClosedError for one admin is queued via queueForWindowReopen (not dropped) and does not block delivery to the rest', async () => {
  const { adapter, dms, queued } = makeCloudAdapter({
    'admin-closed': new WindowClosedError('admin-closed'),
  });
  const listOpenReportsForAdmin = async () => [report({ ageHours: 60 })];
  const listAdminIdentities = async () =>
    admins([
      { platform: 'whatsapp', platformUserId: 'admin-open' },
      { platform: 'whatsapp', platformUserId: 'admin-closed' },
    ]);
  const runOnce = makeDefaultReportStaleAlertRun(
    [adapter],
    listAdminIdentities,
    listOpenReportsForAdmin,
    async () => [],
    fakePolicyStore(),
    skipReporterNotice,
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

test(
  'SECURITY: a throwing per-admin read (conversationsForUser/resolveViewerIds/listOpenReportsForAdmin) for one ' +
    "admin never aborts the tick — every other admin is still scanned and alerted, matching adminDigest.ts's " +
    'whole-sequence per-admin isolation rather than a send-only try/catch',
  async () => {
    const dms: Array<{ userId: string; text: string }> = [];
    const adapter: PlatformAdapter = {
      platform: 'discord',
      adminCapabilities: new Set(),
      async start() {},
      async stop() {},
      isConnected: () => true,
      onMessage() {},
      async sendMessage(_out: OutgoingMessage) {},
      async sendDirectMessage(userId: string, text: string) {
        dms.push({ userId, text });
      },
      async conversationsForUser(userId: string) {
        if (userId === 'admin-broken') throw new Error('transient DB blip');
        return ['convo-1'];
      },
      async performAdminAction() {
        return '';
      },
    };
    const listOpenReportsForAdmin = async () => [report({ ageHours: 60 })];
    const listAdminIdentities = async () =>
      admins([{ platformUserId: 'admin-broken' }, { platformUserId: 'admin-fine' }]);
    const runOnce = makeDefaultReportStaleAlertRun(
      [adapter],
      listAdminIdentities,
      listOpenReportsForAdmin,
      async () => [],
      fakePolicyStore(),
      skipReporterNotice,
    );

    await assert.doesNotReject(runOnce());

    assert.deepEqual(
      dms.map((d) => d.userId),
      ['admin-fine'],
      "the broken admin's read failure must not suppress the alert to the other, healthy admin",
    );
  },
);

test('alertReportStale: an admin with no adapter matching its platform (or a disconnected one) is silently skipped, never throws', async () => {
  const { adapter, dms } = makeAdapter(false);
  const listOpenReportsForAdmin = async () => [report({ ageHours: 60 })];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultReportStaleAlertRun(
    [adapter],
    listAdminIdentities,
    listOpenReportsForAdmin,
    async () => [],
    fakePolicyStore(),
    skipReporterNotice,
  );

  await assert.doesNotReject(runOnce());
  assert.equal(dms.length, 0);
});

test('startReportStaleAlert: always-on, no enable flag — creates a timer even with no *_ENABLED env set', () => {
  const timer = startReportStaleAlert([], async () => {});
  assert.notEqual(timer, null, 'this job is unconditionally enabled by design');
  if (timer) clearInterval(timer);
});

// --- reporter-side mid-flight stale notice (issue #1375) -------------------

/** Stands in for `recordReporterStaleNotice`: an in-memory Set, same
 * "returns true only the first time" contract the real `INSERT ... ON
 * CONFLICT DO NOTHING` gives. */
function fakeReporterNoticeRecorder(): (id: number) => Promise<boolean> {
  const seen = new Set<number>();
  return async (id: number) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
}

function fakeNotifyStale(): {
  notifyStale: (adapter: PlatformAdapter, reporterUserId: string, platform: Platform) => Promise<void>;
  calls: Array<{ reporterUserId: string; platform: Platform }>;
} {
  const calls: Array<{ reporterUserId: string; platform: Platform }> = [];
  return {
    notifyStale: async (_adapter, reporterUserId, platform) => {
      calls.push({ reporterUserId, platform });
    },
    calls,
  };
}

test('reporter stale notice: sent exactly once per report id — a second tick for the same still-stale report does not re-send', async () => {
  const { adapter } = makeAdapter(true, { 'admin-0': ['convo-1'] });
  const listOpenReportsForAdmin = async () => [report({ ageHours: 60, id: 5, reporterUserId: 'reporter-1' })];
  const listAdminIdentities = async () => admins([{}]);
  const recordReporterStaleNotice = fakeReporterNoticeRecorder();
  const { notifyStale, calls } = fakeNotifyStale();
  const runOnce = makeDefaultReportStaleAlertRun(
    [adapter],
    listAdminIdentities,
    listOpenReportsForAdmin,
    async () => [],
    fakePolicyStore(),
    recordReporterStaleNotice,
    notifyStale,
  );

  await runOnce();
  await runOnce();

  assert.deepEqual(calls, [{ reporterUserId: 'reporter-1', platform: 'discord' }]);
});

test('reporter stale notice: two admins sharing the same stale report in the same tick only ever notify the reporter once', async () => {
  const { adapter } = makeAdapter(true, { 'admin-a': ['convo-shared'], 'admin-b': ['convo-shared'] });
  const sharedReport = report({
    ageHours: 60,
    id: 9,
    reporterUserId: 'reporter-1',
    conversationId: 'convo-shared',
  });
  const listOpenReportsForAdmin = async () => [sharedReport];
  const listAdminIdentities = async () =>
    admins([{ platformUserId: 'admin-a' }, { platformUserId: 'admin-b' }]);
  const recordReporterStaleNotice = fakeReporterNoticeRecorder();
  const { notifyStale, calls } = fakeNotifyStale();
  const runOnce = makeDefaultReportStaleAlertRun(
    [adapter],
    listAdminIdentities,
    listOpenReportsForAdmin,
    async () => [],
    fakePolicyStore(),
    recordReporterStaleNotice,
    notifyStale,
  );

  await runOnce();

  assert.equal(
    calls.length,
    1,
    'the second admin processing the same report id must see it already recorded',
  );
});

test(
  "reporter stale notice: fires independently of this admin's own crossing latch — an admin already latched " +
    'open (shouldAlert false) still gets their reporter notified',
  async () => {
    const { adapter, dms } = makeAdapter(true, { 'admin-0': ['convo-1'] });
    const store = fakePolicyStore({ [REPORT_STALE_ALERT_POLICY_KEY]: ['discord:admin-0'] });
    const listOpenReportsForAdmin = async () => [
      report({ ageHours: 60, id: 11, reporterUserId: 'reporter-1' }),
    ];
    const listAdminIdentities = async () => admins([{}]);
    const recordReporterStaleNotice = fakeReporterNoticeRecorder();
    const { notifyStale, calls } = fakeNotifyStale();
    const runOnce = makeDefaultReportStaleAlertRun(
      [adapter],
      listAdminIdentities,
      listOpenReportsForAdmin,
      async () => [],
      store,
      recordReporterStaleNotice,
      notifyStale,
    );

    await runOnce();

    assert.equal(dms.length, 0, "the admin's own alert stays latched (already active) and does not re-send");
    assert.deepEqual(
      calls,
      [{ reporterUserId: 'reporter-1', platform: 'discord' }],
      "the reporter notice must not be gated behind the admin's own shouldAlert",
    );
  },
);

test("SECURITY: reporter stale notice is addressed only to the report's own reporterUserId, never the admin's own id", async () => {
  const { adapter } = makeAdapter(true, { 'admin-0': ['convo-1'] });
  const listOpenReportsForAdmin = async () => [
    report({ ageHours: 60, id: 21, reporterUserId: 'reporter-distinct-from-admin' }),
  ];
  const listAdminIdentities = async () => admins([{ platformUserId: 'admin-0' }]);
  const recordReporterStaleNotice = fakeReporterNoticeRecorder();
  const { notifyStale, calls } = fakeNotifyStale();
  const runOnce = makeDefaultReportStaleAlertRun(
    [adapter],
    listAdminIdentities,
    listOpenReportsForAdmin,
    async () => [],
    fakePolicyStore(),
    recordReporterStaleNotice,
    notifyStale,
  );

  await runOnce();

  assert.deepEqual(calls, [{ reporterUserId: 'reporter-distinct-from-admin', platform: 'discord' }]);
});

test("reporter stale notice: a throwing recordReporterStaleNotice for one report is caught, never blocking another stale report or this admin's own alert", async () => {
  const { adapter, dms } = makeAdapter(true, { 'admin-0': ['convo-1'] });
  const listOpenReportsForAdmin = async () => [
    report({ ageHours: 60, id: 31, reporterUserId: 'reporter-broken' }),
    report({ ageHours: 60, id: 32, reporterUserId: 'reporter-fine' }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const recordReporterStaleNotice = async (id: number) => {
    if (id === 31) throw new Error('transient DB blip');
    return true;
  };
  const { notifyStale, calls } = fakeNotifyStale();
  const runOnce = makeDefaultReportStaleAlertRun(
    [adapter],
    listAdminIdentities,
    listOpenReportsForAdmin,
    async () => [],
    fakePolicyStore(),
    recordReporterStaleNotice,
    notifyStale,
  );

  await assert.doesNotReject(runOnce());

  assert.deepEqual(calls, [{ reporterUserId: 'reporter-fine', platform: 'discord' }]);
  assert.equal(dms.length, 1, "this admin's own alert must still fire despite one reporter notice failing");
});

// --- the scan bound -----------------------------------------------------

test(
  'the default listOpenReportsForAdmin asks listReports for REPORT_STALE_ALERT_SCAN_LIMIT, never its 50-row ' +
    'default — that default is ordered created_at DESC, so a bare call hands this job the NEWEST open reports ' +
    'and then filters them for the OLDEST, going quiet exactly as the backlog worsens',
  async () => {
    // Asserted against the SOURCE, deliberately — same technique as
    // tests/appealStaleAlert.test.ts's own scan-bound test: the argument
    // only exists inside a default parameter, so the sole runtime
    // observation point is the real `listReports` binding, resolved at
    // import time. Every other test in this file injects
    // `listOpenReportsForAdmin` and therefore bypasses the limit entirely.
    const source = await readFile(
      fileURLToPath(new URL('../src/module/reportStaleAlert.ts', import.meta.url)),
      'utf8',
    );
    assert.match(
      source,
      /listReports\(scope,\s*'open',\s*REPORT_STALE_ALERT_SCAN_LIMIT,\s*viewerIds\)/,
      "the job must scan with the explicit constant — a bare listReports(scope, 'open') would silently take 50 rows",
    );
    assert.equal(
      REPORT_STALE_ALERT_SCAN_LIMIT,
      200,
      "200 is listReports' own hard clamp — a larger value here would be a claim the repository does not honour",
    );
  },
);
