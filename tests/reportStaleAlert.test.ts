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
  REPORT_STALE_ALERT_THRESHOLD_HOURS,
  REPORT_STALE_ALERT_SCAN_LIMIT,
  formatReportStaleAlertMessage,
  makeDefaultReportStaleAlertRun,
  startReportStaleAlert,
} = await import('../src/module/reportStaleAlert.js');
const { WindowClosedError } = await import('@swampratnz/agent-base/platforms/whatsapp/cloudAdapter.js');

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

test('alertReportStale: an admin with no adapter matching its platform (or a disconnected one) is silently skipped, never throws', async () => {
  const { adapter, dms } = makeAdapter(false);
  const listOpenReportsForAdmin = async () => [report({ ageHours: 60 })];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultReportStaleAlertRun(
    [adapter],
    listAdminIdentities,
    listOpenReportsForAdmin,
    async () => [],
  );

  await assert.doesNotReject(runOnce());
  assert.equal(dms.length, 0);
});

test('startReportStaleAlert: always-on, no enable flag — creates a timer even with no *_ENABLED env set', () => {
  const timer = startReportStaleAlert([], async () => {});
  assert.notEqual(timer, null, 'this job is unconditionally enabled by design');
  if (timer) clearInterval(timer);
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
