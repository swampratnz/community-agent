import { test, after } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/strings/notices.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/engagementAlert.test.ts. ADMIN_LEVERAGE_ALERT_ENABLED
// is deliberately left unset so any use of startAdminLeverageAlert() here
// exercises the disabled-by-default path (the enabled path's consecutive-
// failure alerting is covered by tests/backgroundJobs.test.ts and
// tests/backgroundJobsDisabled.test.ts, which pin the flag per-process like
// every other opt-in job) — this file focuses on the pure message builder,
// the weekly-cadence run function, and the DB-backed trend persistence
// (skipped cleanly when DATABASE_URL is unset, per CLAUDE.md).
const hasDb = Boolean(process.env.DATABASE_URL);
const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS ??= 'admin-open,admin-closed';

const { formatAdminLeverageAlertMessage, makeDefaultAdminLeverageAlertRun, startAdminLeverageAlert } =
  await import('../src/adminLeverageAlert.js');
const { pool, closeDb } = await import('../src/storage/db.js');
const { getLastAdminLeverageAlertRate, recordAdminLeverageAlertSent } =
  await import('../src/storage/repository.js');
const { getPendingAlertsForTests, resetPendingAlertsForTests } = await import('../src/pendingAlertQueue.js');
const { WindowClosedError } = await import('../src/platforms/whatsapp/cloudAdapter.js');

after(async () => {
  await closeDb();
});

type ActivityRow = {
  platform: 'discord' | 'whatsapp';
  actorUserId: string;
  actionCount: number;
  successCount: number;
  failureCount: number;
  lastActionAt: Date;
};

function activityRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    platform: 'discord',
    actorUserId: 'admin-actor-1',
    actionCount: 5,
    successCount: 5,
    failureCount: 0,
    lastActionAt: new Date(),
    ...overrides,
  };
}

function makeAdapter(): { adapter: PlatformAdapter; dms: Array<{ userId: string; text: string }> } {
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
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return { adapter, dms };
}

// alertSuperAdmins is fire-and-forget (`void alertSuperAdmins(...)`, no
// await), so give the microtask queue a turn before asserting — same
// technique as tests/engagementAlert.test.ts / tests/departedAdminAlert.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A fake Cloud-like adapter (mirrors `tests/notifyAdminsWindowReopenQueue.test.ts`'s
 * `makeFakeCloudAdapter`): `sendDirectMessage` rejects with whatever
 * `rejections[userId]` names, and `queueForWindowReopen` records what was
 * queued, per-recipient, for assertion (issue #888).
 */
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

// --- formatAdminLeverageAlertMessage ----------------------------------------

test('formatAdminLeverageAlertMessage: renders bare total actions, admin count and the derived rate', () => {
  const message = formatAdminLeverageAlertMessage(14, 5, null);
  assert.equal(message, '📊 Admin leverage this week: 14 actions / 5 admins = 2.8/admin');
});

// Acceptance criterion 4: adminCount === 0 must never divide by zero.
test('formatAdminLeverageAlertMessage: zero admins renders a defined "no current admins" message, never NaN/Infinity', () => {
  const message = formatAdminLeverageAlertMessage(0, 0, null);
  assert.equal(message, '📊 Admin leverage this week: no current admins to measure against.');
  assert.ok(!message.includes('NaN'));
  assert.ok(!message.includes('Infinity'));
});

test('formatAdminLeverageAlertMessage: zero actions with admins present renders a 0.0/admin rate, not a "no admins" fallback', () => {
  const message = formatAdminLeverageAlertMessage(0, 3, null);
  assert.equal(message, '📊 Admin leverage this week: 0 actions / 3 admins = 0.0/admin');
});

// Acceptance criterion 5: trend null-safety — no suffix on the first-ever run.
test('formatAdminLeverageAlertMessage: no prior rate (first-ever run) renders no trend suffix', () => {
  const message = formatAdminLeverageAlertMessage(14, 5, null);
  assert.ok(!message.includes('▲'));
  assert.ok(!message.includes('▼'));
  assert.ok(!message.includes('since last week'));
});

test('formatAdminLeverageAlertMessage: a higher rate than last week renders the exact ▲ delta to one decimal place', () => {
  const message = formatAdminLeverageAlertMessage(15, 5, 2.0); // rate = 3.0
  assert.match(message, /▲ 1\.0 since last week\.$/);
});

test('formatAdminLeverageAlertMessage: a lower rate than last week renders the exact ▼ delta (absolute value) to one decimal place', () => {
  const message = formatAdminLeverageAlertMessage(10, 5, 3.0); // rate = 2.0
  assert.match(message, /▼ 1\.0 since last week\.$/);
});

test('formatAdminLeverageAlertMessage: an unchanged rate renders "No change", not ▲0.0/▼0.0', () => {
  const message = formatAdminLeverageAlertMessage(10, 5, 2.0); // rate = 2.0
  assert.match(message, /No change since last week\.$/);
});

// Binding SECURITY criterion 6: the message never carries any admin identity.
test('SECURITY: formatAdminLeverageAlertMessage never contains an admin actorUserId/platformUserId or display name — only bare integers and the fixed rate/trend text', () => {
  const cases: Array<[number, number, number | null]> = [
    [14, 5, null],
    [0, 0, null],
    [15, 5, 2.0],
    [10, 5, 3.0],
    [10, 5, 2.0],
  ];
  for (const [totalActions, adminCount, previousRate] of cases) {
    const message = formatAdminLeverageAlertMessage(totalActions, adminCount, previousRate);
    assert.doesNotMatch(message, /[a-zA-Z]{2,}#\d+/, 'no display-name-shaped token');
    assert.ok(!/\b\d{15,}\b/.test(message), 'no platform-user-id-shaped long numeric token');
    assert.doesNotMatch(message, /admin-actor|actorUserId|platformUserId/i);
  }
});

// --- makeDefaultAdminLeverageAlertRun ---------------------------------------

test('makeDefaultAdminLeverageAlertRun: on the first eligible tick (no prior send), every super admin on every connected adapter is DMed once with the aggregated total/count/rate, and the send is recorded', async () => {
  const { adapter, dms } = makeAdapter();
  let recordedRate: number | null = -1;
  const runOnce = makeDefaultAdminLeverageAlertRun(
    [adapter],
    async () => [
      activityRow({ actionCount: 9 }),
      activityRow({ actorUserId: 'admin-actor-2', actionCount: 5 }),
    ],
    async () => [
      { platform: 'discord', platformUserId: 'a1' },
      { platform: 'discord', platformUserId: 'a2' },
    ],
    async () => false,
    async (rate) => {
      recordedRate = rate;
    },
    async () => null,
  );

  await runOnce();
  await flush();

  assert.equal(dms.length, 1, 'exactly one super admin is DMed');
  assert.equal(dms[0].userId, 'super-1');
  assert.match(dms[0].text, /14 actions \/ 2 admins = 7\.0\/admin/);
  assert.equal(recordedRate, 7, 'the send is recorded with the derived rate');
});

// adminLeverageAlert.ts imports departedAdminAlert.ts's `alertSuperAdmins` by
// reference (issue #785) rather than a second copy — this test proves that
// shared function's window-reopen fix (tests/departedAdminAlert.test.ts)
// reaches this producer too, with zero code change of its own (issue #888
// acceptance criterion 3).
test(
  "makeDefaultAdminLeverageAlertRun: inherits departedAdminAlert.ts's shared alertSuperAdmins window-reopen " +
    "fix — a WindowClosedError rejection queues via queueForWindowReopen at 'system' priority instead of " +
    'only logging, with no code change in this producer (issue #888 acceptance criterion 3)',
  async () => {
    const { adapter, dms, queued } = makeCloudAdapter({
      'admin-closed': new WindowClosedError('admin-closed'),
    });
    const runOnce = makeDefaultAdminLeverageAlertRun(
      [adapter],
      async () => [activityRow({ actionCount: 9 })],
      async () => [{ platform: 'discord', platformUserId: 'a1' }],
      async () => false,
      async () => {},
      async () => null,
    );

    await runOnce();
    await flush();

    assert.deepEqual(
      dms.map((d) => d.userId),
      ['admin-open'],
      'the open-window recipient is still delivered live',
    );
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.userId, 'admin-closed');
    assert.equal(queued[0]?.priority, 'system');
  },
);

test('makeDefaultAdminLeverageAlertRun: zero admins records a null rate rather than a divide-by-zero artifact', async () => {
  const { adapter } = makeAdapter();
  let recordedRate: number | null = -1;
  const runOnce = makeDefaultAdminLeverageAlertRun(
    [adapter],
    async () => [],
    async () => [],
    async () => false,
    async (rate) => {
      recordedRate = rate;
    },
    async () => null,
  );

  await runOnce();
  await flush();

  assert.equal(recordedRate, null, 'zero admins persists a null rate, never NaN/Infinity');
});

test('makeDefaultAdminLeverageAlertRun: restart-safe cadence — a tick within the freshness window sends nothing further', async () => {
  const { adapter, dms } = makeAdapter();
  let recordCalls = 0;
  let getLastCalls = 0;
  const runOnce = makeDefaultAdminLeverageAlertRun(
    [adapter],
    async () => [activityRow()],
    async () => [{ platform: 'discord', platformUserId: 'a1' }],
    async () => true, // already sent recently
    async () => {
      recordCalls += 1;
    },
    async () => {
      getLastCalls += 1;
      return null;
    },
  );

  await runOnce();
  await flush();

  assert.equal(dms.length, 0, 'no DM within the freshness window');
  assert.equal(recordCalls, 0, 'no send is recorded when the tick is not eligible');
  assert.equal(getLastCalls, 0, 'the prior rate is never read inside the freshness window');
});

// SECURITY (binding acceptance criterion 7): the fan-out must target exactly
// superAdminIds(platform) per connected adapter, never leaking into a
// community_users admin's DM, and must skip a disconnected adapter.
test('SECURITY: makeDefaultAdminLeverageAlertRun delivers only to super admins on connected adapters, never a community_users admin, and skips a disconnected adapter', async () => {
  const { adapter: connected, dms: connectedDms } = makeAdapter();
  const disconnected: PlatformAdapter = {
    ...connected,
    isConnected: () => false,
  };
  const disconnectedDms: Array<{ userId: string; text: string }> = [];
  disconnected.sendDirectMessage = async (userId: string, text: string) => {
    disconnectedDms.push({ userId, text });
  };

  const runOnce = makeDefaultAdminLeverageAlertRun(
    [connected, disconnected],
    async () => [activityRow()],
    async () => [
      { platform: 'discord', platformUserId: 'a1' },
      { platform: 'discord', platformUserId: 'not-a-super-admin' },
    ],
    async () => false,
    async () => {},
    async () => null,
  );

  await runOnce();
  await flush();

  assert.deepEqual(
    connectedDms.map((d) => d.userId),
    ['super-1'],
    'only the configured super admin is DMed on the connected adapter — never a community_users admin id',
  );
  assert.ok(
    !connectedDms.some((d) => d.userId === 'not-a-super-admin' || d.userId === 'a1'),
    'a community_users admin platform id is never a DM recipient',
  );
  assert.equal(disconnectedDms.length, 0, 'a disconnected adapter is never sent through');
});

test('makeDefaultAdminLeverageAlertRun: reads the prior rate before recording the new one, and renders the delta against it', async () => {
  const { adapter, dms } = makeAdapter();
  const callOrder: string[] = [];
  let recordedRate: number | null = -1;
  const runOnce = makeDefaultAdminLeverageAlertRun(
    [adapter],
    async () => [activityRow({ actionCount: 20 })],
    async () => [
      { platform: 'discord', platformUserId: 'a1' },
      { platform: 'discord', platformUserId: 'a2' },
    ],
    async () => false,
    async (rate) => {
      callOrder.push('record');
      recordedRate = rate;
    },
    async () => {
      callOrder.push('getLast');
      return 5;
    },
  );

  await runOnce();
  await flush();

  assert.deepEqual(callOrder, ['getLast', 'record'], 'the prior rate is read before this run is recorded');
  assert.equal(recordedRate, 10, "this run's rate is what gets persisted");
  assert.match(
    dms[0].text,
    /▲ 5\.0 since last week\./,
    'the delta compares against the prior value, not the new one',
  );
});

test('startAdminLeverageAlert: ADMIN_LEVERAGE_ALERT_ENABLED unset (default) creates no timer', () => {
  const timer = startAdminLeverageAlert([]);
  assert.equal(timer, null, 'disabled by default — no timer, no extra queries');
});

// SECURITY (binding acceptance criterion 8): the disabled path never writes
// to admin_leverage_alert_sends and never sends a DM on a job tick.
test('SECURITY: with the flag unset, startAdminLeverageAlert never invokes runOnce, so no admin_leverage_alert_sends write and no DM occurs on a job tick', async () => {
  const { adapter, dms } = makeAdapter();
  const runOnce = async () => {
    throw new Error('unreachable: admin-leverage-alert is disabled — runOnce must never be invoked');
  };
  const timer = startAdminLeverageAlert([adapter], runOnce);
  assert.equal(timer, null);
  assert.equal(dms.length, 0);
});

test('makeDefaultAdminLeverageAlertRun: with zero connected adapters, the weekly snapshot is queued instead of dropped (issue #593 fan-out via departedAdminAlert.ts)', async () => {
  resetPendingAlertsForTests();
  const disconnected: PlatformAdapter = { ...makeAdapter().adapter, isConnected: () => false };
  const disconnectedDms: Array<{ userId: string; text: string }> = [];
  disconnected.sendDirectMessage = async (userId: string, text: string) => {
    disconnectedDms.push({ userId, text });
  };

  const runOnce = makeDefaultAdminLeverageAlertRun(
    [disconnected],
    async () => [activityRow({ actionCount: 6 })],
    async () => [
      { platform: 'discord', platformUserId: 'a1' },
      { platform: 'discord', platformUserId: 'a2' },
      { platform: 'discord', platformUserId: 'a3' },
    ],
    async () => false,
    async () => {},
    async () => null,
  );

  await runOnce();
  await flush();

  assert.equal(disconnectedDms.length, 0, 'no send is attempted through the disconnected adapter');
  assert.equal(
    getPendingAlertsForTests().length,
    1,
    'the weekly snapshot is queued exactly once, not dropped',
  );
  assert.match(getPendingAlertsForTests()[0] ?? '', /6 actions \/ 3 admins = 2\.0\/admin/);
  resetPendingAlertsForTests();
});

// --- Repository: last_rate read-back (DB-integration) ----------------------

test(
  'repository: getLastAdminLeverageAlertRate is null with no row, then the persisted rate after recordAdminLeverageAlertSent, and null again after a zero-admin (null) run',
  { skip },
  async () => {
    await pool.query('DELETE FROM admin_leverage_alert_sends');

    assert.equal(await getLastAdminLeverageAlertRate(), null, 'a first-ever run has no prior rate at all');

    await recordAdminLeverageAlertSent(2.8);
    assert.equal(
      await getLastAdminLeverageAlertRate(),
      2.8,
      'the exact rate passed in is persisted and read back',
    );

    await recordAdminLeverageAlertSent(null);
    assert.equal(
      await getLastAdminLeverageAlertRate(),
      null,
      'a zero-admin run persists a null rate, read back as null (not 0 or NaN)',
    );

    await recordAdminLeverageAlertSent(1.5);
    assert.equal(
      await getLastAdminLeverageAlertRate(),
      1.5,
      'the singleton row is upserted, so the most recent send is what is read back',
    );

    await pool.query('DELETE FROM admin_leverage_alert_sends');
  },
);
