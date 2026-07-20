import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. ENGAGEMENT_ALERT_ENABLED is
// deliberately left unset so any use of startEngagementAlert() here
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

const { formatEngagementAlertMessage, makeDefaultEngagementAlertRun, startEngagementAlert } =
  await import('../src/engagementAlert.js');
const { pool, closeDb } = await import('../src/storage/db.js');
const { getLastEngagementAlertPercentage, recordEngagementAlertSent } =
  await import('../src/storage/repository.js');
const { getPendingAlertsForTests, resetPendingAlertsForTests } = await import('../src/pendingAlertQueue.js');

after(async () => {
  await closeDb();
});

type EngagementStats = {
  total: number;
  engaged: number;
  percentage: number;
  byPlatform: Array<{ platform: 'discord' | 'whatsapp'; total: number; engaged: number; percentage: number }>;
};

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
// technique as tests/departedAdminAlert.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function stats(overrides: Partial<EngagementStats> = {}): EngagementStats {
  return {
    total: 10,
    engaged: 4,
    percentage: 40,
    byPlatform: [{ platform: 'discord', total: 10, engaged: 4, percentage: 40 }],
    ...overrides,
  };
}

test('formatEngagementAlertMessage: wraps formatEngagementStats verbatim (no member identity, no reimplemented math)', () => {
  const message = formatEngagementAlertMessage(stats(), null);
  assert.match(message, /4\/10 present members have posted at least once \(40%\)/);
  assert.match(message, /- discord: 4\/10 \(40%\)/);
});

// Binding acceptance criterion 4 (issue #568 adversarial review): the
// empty-roster fallback must be byte-identical to engagement_stats' own
// fallback text — never a divide-by-zero or NaN%.
test("formatEngagementAlertMessage: empty-roster fallback is byte-identical to engagement_stats' own fallback text", () => {
  const message = formatEngagementAlertMessage(
    stats({ total: 0, engaged: 0, percentage: 0, byPlatform: [] }),
    null,
  );
  assert.equal(
    message,
    '📊 Weekly engagement snapshot:\nNo currently-present roster members to measure engagement against.\n' +
      'No prior week recorded yet to compare against.',
  );
  assert.ok(!message.includes('NaN'), 'SECURITY: an empty roster must never render NaN%');
});

// --- Trend suffix (issue #597), byte-tested per acceptance criterion 1 -----

test('formatEngagementAlertMessage: no prior percentage (first-ever run) renders a defined no-comparison form, never NaN/undefined', () => {
  const message = formatEngagementAlertMessage(stats({ percentage: 40 }), null);
  assert.match(message, /\nNo prior week recorded yet to compare against\.$/);
  assert.ok(!message.includes('NaN'));
  assert.ok(!message.includes('undefined'));
});

test('formatEngagementAlertMessage: a higher percentage than last week renders the exact ▲ delta to one decimal place', () => {
  const message = formatEngagementAlertMessage(stats({ percentage: 45.2 }), 40);
  assert.match(message, /\n▲ 5\.2pp vs last week\.$/);
});

test('formatEngagementAlertMessage: a lower percentage than last week renders the exact ▼ delta (absolute value) to one decimal place', () => {
  const message = formatEngagementAlertMessage(stats({ percentage: 36.8 }), 40);
  assert.match(message, /\n▼ 3\.2pp vs last week\.$/);
});

test('formatEngagementAlertMessage: an unchanged percentage renders "No change", not ▲0.0pp/▼0.0pp', () => {
  const message = formatEngagementAlertMessage(stats({ percentage: 40 }), 40);
  assert.match(message, /\nNo change vs last week\.$/);
});

test('SECURITY: formatEngagementAlertMessage never contains anything beyond aggregate integers/a percentage and the fixed fallback/trend strings', () => {
  const cases: Array<[EngagementStats, number | null]> = [
    [stats(), null],
    [stats({ total: 0, engaged: 0, percentage: 0, byPlatform: [] }), null],
    [stats({ percentage: 45.2 }), 40],
    [stats({ percentage: 36.8 }), 40],
    [stats({ percentage: 40 }), 40],
  ];
  for (const [s, previous] of cases) {
    const message = formatEngagementAlertMessage(s, previous);
    assert.doesNotMatch(message, /[a-zA-Z]{2,}#\d+/, 'no display-name-shaped token');
    assert.ok(!/\b\d{15,}\b/.test(message), 'no platform-user-id-shaped long numeric token');
    assert.match(
      message,
      /(No prior week recorded yet to compare against\.|▲ \d+\.\d+pp vs last week\.|▼ \d+\.\d+pp vs last week\.|No change vs last week\.)$/,
    );
  }
});

test('makeDefaultEngagementAlertRun: on the first eligible tick (no prior send), every super admin on every connected adapter is DMed once with the current percentage, and the send is recorded', async () => {
  const { adapter, dms } = makeAdapter();
  let recordedPercentage: number | null = null;
  const runOnce = makeDefaultEngagementAlertRun(
    [adapter],
    async () => stats({ percentage: 42 }),
    async () => false,
    async (percentage) => {
      recordedPercentage = percentage;
    },
    async () => null,
  );

  await runOnce();
  await flush();

  assert.equal(dms.length, 1, 'exactly one super admin is DMed');
  assert.equal(dms[0].userId, 'super-1');
  assert.match(dms[0].text, /42%/);
  assert.equal(recordedPercentage, 42, 'the send is recorded with the current percentage');
});

test('makeDefaultEngagementAlertRun: restart-safe cadence — a tick within the freshness window sends nothing further', async () => {
  const { adapter, dms } = makeAdapter();
  let recordCalls = 0;
  let getLastCalls = 0;
  const runOnce = makeDefaultEngagementAlertRun(
    [adapter],
    async () => stats(),
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
  assert.equal(getLastCalls, 0, 'the prior percentage is never read inside the freshness window');
});

// SECURITY (binding acceptance criterion 7): the fan-out must target exactly
// superAdminIds(platform) per connected adapter, never leaking into a
// community_users admin's DM, and must skip a disconnected adapter.
test('SECURITY: makeDefaultEngagementAlertRun delivers only to super admins on connected adapters, never a community_users admin, and skips a disconnected adapter', async () => {
  const { adapter: connected, dms: connectedDms } = makeAdapter();
  const disconnected: PlatformAdapter = {
    ...connected,
    isConnected: () => false,
  };
  const disconnectedDms: Array<{ userId: string; text: string }> = [];
  disconnected.sendDirectMessage = async (userId: string, text: string) => {
    disconnectedDms.push({ userId, text });
  };

  const runOnce = makeDefaultEngagementAlertRun(
    [connected, disconnected],
    async () => stats(),
    async () => false,
    async () => {},
    async () => null,
  );

  await runOnce();
  await flush();

  assert.deepEqual(
    connectedDms.map((d) => d.userId),
    ['super-1'],
    'only the configured super admin is DMed on the connected adapter',
  );
  assert.equal(disconnectedDms.length, 0, 'a disconnected adapter is never sent through');
});

// --- Read-before-write trend ordering (issue #597), acceptance criteria 2/3 -

test('makeDefaultEngagementAlertRun: reads the prior percentage before recording the new one, and renders the delta against it', async () => {
  const { adapter, dms } = makeAdapter();
  const callOrder: string[] = [];
  let recordedPercentage: number | null = null;
  const runOnce = makeDefaultEngagementAlertRun(
    [adapter],
    async () => stats({ percentage: 45 }),
    async () => false,
    async (percentage) => {
      callOrder.push('record');
      recordedPercentage = percentage;
    },
    async () => {
      callOrder.push('getLast');
      return 40;
    },
  );

  await runOnce();
  await flush();

  assert.deepEqual(
    callOrder,
    ['getLast', 'record'],
    'the prior percentage is read before this run is recorded',
  );
  assert.equal(recordedPercentage, 45, "this run's percentage is what gets persisted");
  assert.match(
    dms[0].text,
    /▲ 5\.0pp vs last week\./,
    'the delta compares against the prior value, not the new one',
  );
});

test('makeDefaultEngagementAlertRun: with no prior engagement_alert_sends row, still sends and renders the no-comparison form — never throws, never NaN', async () => {
  const { adapter, dms } = makeAdapter();
  const runOnce = makeDefaultEngagementAlertRun(
    [adapter],
    async () => stats({ percentage: 42 }),
    async () => false,
    async () => {},
    async () => null,
  );

  await runOnce();
  await flush();

  assert.equal(dms.length, 1);
  assert.match(dms[0].text, /No prior week recorded yet to compare against\.$/);
  assert.ok(!dms[0].text.includes('NaN'));
});

test('startEngagementAlert: ENGAGEMENT_ALERT_ENABLED unset (default) creates no timer', () => {
  const timer = startEngagementAlert([]);
  assert.equal(timer, null, 'disabled by default — no timer, no extra queries');
});

// --- Repository: last_percentage read-back (DB-integration) ---------------

test(
  'repository: getLastEngagementAlertPercentage is null with no row, then the persisted percentage after recordEngagementAlertSent',
  { skip },
  async () => {
    await pool.query('DELETE FROM engagement_alert_sends');

    assert.equal(
      await getLastEngagementAlertPercentage(),
      null,
      'a first-ever run has no prior percentage at all',
    );

    await recordEngagementAlertSent(42.5);
    assert.equal(
      await getLastEngagementAlertPercentage(),
      42.5,
      'the exact percentage passed in is persisted and read back',
    );

    await recordEngagementAlertSent(10);
    assert.equal(
      await getLastEngagementAlertPercentage(),
      10,
      'the singleton row is upserted, so the most recent send is what is read back',
    );

    await pool.query('DELETE FROM engagement_alert_sends');
  },
);

// engagementAlert.ts reuses departedAdminAlert.ts's exact `alertSuperAdmins`
// (issue #568), so extending that function's disconnect-handling (issue
// #593) fans out here too, intentionally — asserted directly rather than
// left implicit, per the #593 adversarial review's binding criterion 7.
test('makeDefaultEngagementAlertRun: with zero connected adapters, the weekly snapshot is queued instead of dropped (issue #593 fan-out via departedAdminAlert.ts)', async () => {
  resetPendingAlertsForTests();
  const disconnected: PlatformAdapter = { ...makeAdapter().adapter, isConnected: () => false };
  const disconnectedDms: Array<{ userId: string; text: string }> = [];
  disconnected.sendDirectMessage = async (userId: string, text: string) => {
    disconnectedDms.push({ userId, text });
  };

  const runOnce = makeDefaultEngagementAlertRun(
    [disconnected],
    async () => stats({ percentage: 55 }),
    async () => false,
    async () => {},
    async () => null, // stub the #597 prior-percentage read so this stays a DB-free unit test
  );

  await runOnce();
  await flush();

  assert.equal(disconnectedDms.length, 0, 'no send is attempted through the disconnected adapter');
  assert.equal(
    getPendingAlertsForTests().length,
    1,
    'the weekly snapshot is queued exactly once, not dropped',
  );
  assert.match(getPendingAlertsForTests()[0] ?? '', /55%/);
  resetPendingAlertsForTests();
});
