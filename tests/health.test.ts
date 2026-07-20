import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// (including WHATSAPP_PROVIDER=cloud config) before importing anything that
// (transitively) loads it. A short HEALTH_ALERT_AFTER_MINUTES keeps the fake
// clock advance below small and readable.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER = 'cloud';
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID ??= 'test-phone-id';
process.env.WHATSAPP_CLOUD_ACCESS_TOKEN ??= 'test-access-token';
process.env.WHATSAPP_CLOUD_VERIFY_TOKEN ??= 'test-verify-token';
process.env.WHATSAPP_CLOUD_APP_SECRET ??= 'test-app-secret';
process.env.HEALTH_ALERT_AFTER_MINUTES = '1';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1,super-2';

const {
  startDisconnectAlerts,
  alertSuperAdmins,
  flushPendingAlerts,
  getPendingAlertsForTests,
  resetPendingAlertsForTests,
} = await import('../src/health.js');
const { getPendingAlertEntriesForTests, queuePendingAlert: queueRawPendingAlert } =
  await import('../src/pendingAlertQueue.js');
const { WhatsAppCloudAdapter } = await import('../src/platforms/whatsapp/cloudAdapter.js');
const { logger } = await import('../src/logger.js');
// Cross-producer cap test below (issue #545) drives the OTHER two shared-
// queue producers directly, without their own test files' env/setup.
const { startTrackedJob } = await import('../src/backgroundJobs.js');
const { notifyReportFiled } = await import('../src/agent/tools.js');
// One of #593's four new pending-alert-queue producers, imported directly to
// prove the flush path (unmodified since #545) also drains a message queued
// from a NEW producer, not just the original three.
const { alertSuperAdmins: departedAdminAlertSuperAdmins } = await import('../src/departedAdminAlert.js');

function makeFakeAdapter(connected: boolean): {
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
    async sendMessage() {},
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

test('alertSuperAdmins: with at least one connected adapter, DMs every super admin on that adapter exactly as before and queues nothing', async (t) => {
  t.after(() => resetPendingAlertsForTests());
  resetPendingAlertsForTests();
  const { adapter: connectedAdapter, dms } = makeFakeAdapter(true);
  const { adapter: disconnectedAdapter } = makeFakeAdapter(false);

  await alertSuperAdmins([disconnectedAdapter, connectedAdapter], 'test message');

  assert.deepEqual(
    dms.map((d) => d.userId).sort(),
    ['super-1', 'super-2'],
    'every super admin should be DMed via the connected adapter',
  );
  assert.equal(dms[0]?.text, 'test message');
  assert.deepEqual(
    getPendingAlertsForTests(),
    [],
    'nothing should be queued when a connected adapter exists',
  );
});

test('alertSuperAdmins: with zero connected adapters, the message is queued instead of dropped, and a warn log fires', async (t) => {
  t.after(() => resetPendingAlertsForTests());
  resetPendingAlertsForTests();
  const { adapter: disconnectedA } = makeFakeAdapter(false);
  const { adapter: disconnectedB } = makeFakeAdapter(false);

  const warnLogs: unknown[][] = [];
  t.mock.method(logger, 'warn', (...args: unknown[]) => {
    warnLogs.push(args);
  });

  await alertSuperAdmins([disconnectedA, disconnectedB], 'undeliverable message');

  assert.deepEqual(getPendingAlertsForTests(), ['undeliverable message']);
  assert.ok(
    warnLogs.some((args) => typeof args[1] === 'string' && /could not be delivered live/.test(args[1])),
    'a warn log must record the undelivered alert',
  );
});

test('alertSuperAdmins: the pending queue never exceeds 5 entries, dropping the oldest first', async () => {
  resetPendingAlertsForTests();
  const { adapter: disconnected } = makeFakeAdapter(false);

  for (let i = 1; i <= 6; i++) {
    await alertSuperAdmins([disconnected], `message-${i}`);
  }

  assert.deepEqual(
    getPendingAlertsForTests(),
    ['message-2', 'message-3', 'message-4', 'message-5', 'message-6'],
    'the oldest entry (message-1) should have been dropped once the cap of 5 was exceeded',
  );
});

test('flushPendingAlerts: on reconnect, every queued message is sent via the reconnected adapter to every super admin, then the queue is cleared', async () => {
  resetPendingAlertsForTests();
  const { adapter: disconnected } = makeFakeAdapter(false);
  await alertSuperAdmins([disconnected], 'queued-message-1');
  await alertSuperAdmins([disconnected], 'queued-message-2');
  assert.equal(getPendingAlertsForTests().length, 2);

  const { adapter: reconnected, dms } = makeFakeAdapter(true);
  await flushPendingAlerts(reconnected);

  assert.deepEqual(
    dms.map((d) => d.text).sort(),
    ['queued-message-1', 'queued-message-1', 'queued-message-2', 'queued-message-2'],
    'every queued message should be flushed to every super admin (2 messages x 2 admins = 4 DMs)',
  );
  assert.deepEqual(
    dms.map((d) => d.userId).sort(),
    ['super-1', 'super-1', 'super-2', 'super-2'],
    'the flush should reach every super admin, not just one',
  );
  assert.deepEqual(getPendingAlertsForTests(), [], 'the queue must be empty after a successful flush');
});

test(
  'flushPendingAlerts: a mixed-source queue — one entry queued via health.ts, one via backgroundJobs.ts, ' +
    'one via tools.ts — is fully flushed and cleared through the same reconnect path, with no new flush ' +
    'machinery (issue #545)',
  async (t) => {
    resetPendingAlertsForTests();

    // 1. health.ts's own alertSuperAdmins, all adapters disconnected.
    const { adapter: disconnectedHealth } = makeFakeAdapter(false);
    await alertSuperAdmins([disconnectedHealth], 'from-health');

    // 2. backgroundJobs.ts's alertSuperAdmins, reached via startTrackedJob's
    // failure-threshold branch (3 consecutive failures), all adapters
    // disconnected.
    const { adapter: disconnectedJob } = makeFakeAdapter(false);
    const alwaysFail = async () => {
      throw new Error('sentinel-mixed-flush');
    };
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.enable({ apis: ['setInterval'] });
    const timer = startTrackedJob('docs-ingest', [disconnectedJob], true, alwaysFail);
    try {
      await flush(); // 1st scheduled run (fires immediately) fails
      t.mock.timers.tick(6 * 3_600_000);
      await flush(); // 2nd
      t.mock.timers.tick(6 * 3_600_000);
      await flush(); // 3rd — threshold reached, queues
    } finally {
      clearInterval(timer!);
    }

    // 3. tools.ts's notifySuperAdmins (via notifyReportFiled), no adapter
    // connected on either registered platform.
    const disconnectedTools = { ...makeFakeAdapter(false).adapter, platform: 'whatsapp' as const };
    await notifyReportFiled((platform) => (platform === 'whatsapp' ? disconnectedTools : undefined), {
      id: 545,
      reporterUserId: 'reporter-1',
      reporterName: 'Reporter One',
      conversationId: 'convo-1',
      reason: 'from-tools',
    });

    assert.equal(getPendingAlertsForTests().length, 3, 'all three producers queued exactly one entry each');

    const { adapter: reconnected, dms } = makeFakeAdapter(true);
    await flushPendingAlerts(reconnected);

    assert.equal(dms.length, 6, 'three queued messages x two super admins each = 6 DMs');
    assert.ok(
      dms.some((d) => d.text === 'from-health'),
      'the health.ts-sourced message was flushed',
    );
    assert.ok(
      dms.some((d) => /docs-ingest/.test(d.text)),
      'the backgroundJobs.ts-sourced message was flushed',
    );
    assert.ok(
      dms.some((d) => /#545/.test(d.text)),
      'the tools.ts-sourced message was flushed',
    );
    assert.deepEqual(
      getPendingAlertsForTests(),
      [],
      'the shared queue must be fully cleared after the flush',
    );
  },
);

test(
  "flushPendingAlerts: a message queued from one of issue #593's new producers " +
    '(departedAdminAlert.ts) with every adapter disconnected is delivered to every super admin ' +
    "through the reconnected adapter, via health.ts's existing flush path, unmodified",
  async () => {
    resetPendingAlertsForTests();

    const { adapter: disconnected } = makeFakeAdapter(false);
    await departedAdminAlertSuperAdmins([disconnected], 'from-departed-admin-alert-593');

    assert.equal(getPendingAlertsForTests().length, 1, 'the new producer queued exactly one entry');

    const { adapter: reconnected, dms } = makeFakeAdapter(true);
    await flushPendingAlerts(reconnected);

    assert.equal(dms.length, 2, 'one queued message x two super admins');
    assert.ok(
      dms.every((d) => d.text === 'from-departed-admin-alert-593'),
      "the new producer's message was flushed to every super admin, unmodified",
    );
    assert.deepEqual(getPendingAlertsForTests(), [], 'the queue is cleared after the flush');
  },
);

// --- issue #625: structured recipients on the shared queue --------------

test(
  "SECURITY: health.ts's own alertSuperAdmins and tools.ts's notifySuperAdmins (via notifyReportFiled) " +
    'queue entries with no `recipients` field — issue #625 only added an opt-in recipient set for ' +
    'notifyAdmins; these producers are unaffected and still flush to superAdminIds()',
  async () => {
    resetPendingAlertsForTests();

    const { adapter: disconnectedHealth } = makeFakeAdapter(false);
    await alertSuperAdmins([disconnectedHealth], 'from-health-625');

    const disconnectedTools = { ...makeFakeAdapter(false).adapter, platform: 'whatsapp' as const };
    await notifyReportFiled((platform) => (platform === 'whatsapp' ? disconnectedTools : undefined), {
      id: 625,
      reporterUserId: 'reporter-1',
      reporterName: 'Reporter One',
      conversationId: 'convo-1',
      reason: 'from-tools-625',
    });

    const entries = getPendingAlertEntriesForTests();
    assert.equal(entries.length, 2);
    assert.ok(
      entries.every((e) => e.recipients === undefined),
      'neither recipient-less producer should populate `recipients`',
    );
    resetPendingAlertsForTests();
  },
);

test(
  'flushPendingAlerts: an entry queued WITH recipients (issue #625) is delivered only to those recipients, ' +
    "filtered to the reconnected adapter's platform — never to superAdminIds()",
  async () => {
    resetPendingAlertsForTests();

    queueRawPendingAlert('🔔 structured-entry alert', 'system', [
      { platform: 'discord', platformUserId: 'admin-discord-1' },
      { platform: 'discord', platformUserId: 'admin-discord-2' },
      { platform: 'whatsapp', platformUserId: 'admin-whatsapp-1' },
    ]);

    const { adapter: reconnectedDiscord, dms } = makeFakeAdapter(true);
    await flushPendingAlerts(reconnectedDiscord);

    assert.deepEqual(
      dms.map((d) => d.userId).sort(),
      ['admin-discord-1', 'admin-discord-2'],
      'only the recipients captured at queue time, filtered to the reconnected platform, are delivered — ' +
        'the whatsapp recipient is excluded (wrong platform) and neither configured super admin ' +
        "(super-1/super-2) receives anything, since this entry's recipients are never superAdminIds()",
    );
    assert.deepEqual(getPendingAlertsForTests(), [], 'the queue is cleared after the flush');
  },
);

test('flushPendingAlerts: a queued entry with an empty recipients array (all recipients filtered out for this platform) sends nothing and does not throw', async () => {
  resetPendingAlertsForTests();

  queueRawPendingAlert('🔔 whatsapp-only alert', 'system', [
    { platform: 'whatsapp', platformUserId: 'admin-whatsapp-1' },
  ]);

  const { adapter: reconnectedDiscord, dms } = makeFakeAdapter(true);
  await flushPendingAlerts(reconnectedDiscord);

  assert.deepEqual(dms, [], 'no discord recipient matches, so nothing is sent through the discord adapter');
  assert.deepEqual(getPendingAlertsForTests(), [], 'the queue is still cleared after the flush');
});

test('flushPendingAlerts: a throwing sendDirectMessage during flush is logged and the message dropped, not re-queued', async (t) => {
  resetPendingAlertsForTests();
  const { adapter: disconnected } = makeFakeAdapter(false);
  await alertSuperAdmins([disconnected], 'queued-message');
  assert.equal(getPendingAlertsForTests().length, 1);

  const warnLogs: unknown[][] = [];
  t.mock.method(logger, 'warn', (...args: unknown[]) => {
    warnLogs.push(args);
  });
  const throwingAdapter = makeFakeAdapter(true).adapter;
  throwingAdapter.sendDirectMessage = async () => {
    throw new Error('send failed');
  };

  await flushPendingAlerts(throwingAdapter);

  assert.deepEqual(
    getPendingAlertsForTests(),
    [],
    'a failed flush send must drop the message, not re-queue it',
  );
  assert.ok(
    warnLogs.some((args) => typeof args[1] === 'string' && /flush failed/.test(args[1])),
    'a warn log must record the failed flush send',
  );
});

test('startDisconnectAlerts: a message queued during a total outage is flushed the moment the platform reconnects', (t) => {
  resetPendingAlertsForTests();
  let connected = false;
  const { adapter, dms } = makeFakeAdapter(true);
  adapter.isConnected = () => connected;

  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const timer = startDisconnectAlerts([adapter]);
  try {
    t.mock.timers.tick(30_000); // first check: disconnect begins
    t.mock.timers.tick(60_000); // past HEALTH_ALERT_AFTER_MINUTES=1 — alert fires, queues (zero connected)
    assert.equal(
      getPendingAlertsForTests().length,
      1,
      'the alert should have been queued while disconnected',
    );

    connected = true;
    t.mock.timers.tick(30_000); // next check sees reconnect -> flush
  } finally {
    clearInterval(timer);
  }

  assert.equal(dms.length, 1, 'the queued alert should have been flushed via the reconnected adapter');
  assert.match(dms[0]?.text ?? '', /has been disconnected for over 1 minute\(s\)\./);
  assert.deepEqual(getPendingAlertsForTests(), [], 'the queue must be empty after the flush');
});

// --- SECURITY: no new content class reaches the flushed DM (issue #534) ----

test(
  'SECURITY: a flushed queued alert is byte-identical to the fixed disconnect-alert template — no free text, ' +
    'no user-supplied content can reach this DM path',
  async () => {
    resetPendingAlertsForTests();
    const platform = 'discord';
    const minutes = 1;
    const template = `🔴 ${platform} has been disconnected for over ${minutes} minute(s).`;
    const { adapter: disconnected } = makeFakeAdapter(false);
    await alertSuperAdmins([disconnected], template);

    const { adapter: reconnected, dms } = makeFakeAdapter(true);
    await flushPendingAlerts(reconnected);

    assert.equal(dms.length, 2); // one per super admin
    for (const dm of dms) {
      assert.equal(
        dm.text,
        '🔴 discord has been disconnected for over 1 minute(s).',
        'the flushed message must exactly equal the fixed template, with no additional or free text appended',
      );
    }
  },
);

test('a WhatsApp Cloud adapter whose consecutive-send-failure counter has crossed the threshold is reported disconnected, and health.ts still fires the sustained-disconnect error log even with no other adapter to DM through', (t) => {
  const adapter = new WhatsAppCloudAdapter();
  // Simulate `start()` having succeeded (listener up) and 3 consecutive
  // real-message send failures (e.g. a revoked access token), without
  // spinning up a real HTTP server or making real Graph API calls.
  (adapter as unknown as { server: object }).server = {};
  (adapter as unknown as { consecutiveSendFailures: number }).consecutiveSendFailures = 3;
  assert.equal(
    adapter.isConnected(),
    false,
    'isConnected() must reflect the crossed threshold so health.ts has something real to alert on',
  );

  const errorLogs: unknown[][] = [];
  t.mock.method(logger, 'error', (...args: unknown[]) => {
    errorLogs.push(args);
  });
  // alertSuperAdmins DMs through connected adapters only; with a single,
  // disconnected adapter there is nothing to send through, but the error
  // log below must still fire as the backstop so the outage is never silent.
  t.mock.method(adapter, 'sendDirectMessage', async () => {
    throw new Error('unreachable: the only adapter is reported disconnected, so no DM should be attempted');
  });

  // health.ts's check() reads Date.now() internally, so the fake clock must
  // move Date along with the interval timer or the debounce math (`now -
  // disconnectedSince`) still sees real wall-clock time.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const timer = startDisconnectAlerts([adapter]);
  try {
    t.mock.timers.tick(30_000); // first 30s check: disconnect begins
    t.mock.timers.tick(60_000); // past HEALTH_ALERT_AFTER_MINUTES=1
  } finally {
    clearInterval(timer);
  }

  assert.ok(
    errorLogs.some((args) => args[1] === 'Platform sustained disconnect'),
    'the error-level log must fire as a backstop even when no adapter is connected to DM through',
  );
});
