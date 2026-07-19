import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// usage-alert consecutive-failure alerting (issue #426): its own process/file
// because USAGE_ALERT_DAILY_REPLIES must be pinned ON here, and usageStats
// must be mocked before anything imports storage/repository.js — neither can
// share a process with tests/usageAlert.test.ts, which deliberately leaves
// USAGE_ALERT_DAILY_REPLIES unset to exercise the disabled-by-default path
// (config is parsed once per process at import time; same file-split
// convention as tests/statusCheckAlert.test.ts vs
// tests/backgroundJobsDisabled.test.ts).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';
process.env.USAGE_ALERT_DAILY_REPLIES = '10';

const POLL_MS = 60 * 60_000; // usageAlert.ts's fixed hourly CHECK_INTERVAL_MS

type UsageStats = Awaited<ReturnType<typeof import('../src/storage/repository.js').usageStats>>;

const BASE_STATS: Omit<UsageStats, 'outbound'> = {
  inbound: 10,
  costUsd: 0,
  topUsers: [],
  costByRole: [],
  backgroundCostUsd: 0,
  shortcutHits: { total: 0, byKind: [] },
  backgroundCostByJob: [],
  cacheUsage: { readTokens: 0, creationTokens: 0 },
  autoAnswerUsage: { count: 0, costUsd: 0 },
};

let mode: 'succeed' | 'fail' = 'succeed';
let outbound = 5; // under the configured threshold (10) by default — isolates the failure tracker from the threshold-crossing latch

async function mockUsageStats(): Promise<UsageStats> {
  if (mode === 'fail') throw new Error('usage_stats query failed (simulated)');
  return { ...BASE_STATS, outbound };
}

// usageStats is a static import inside usageAlert.ts, so once that module has
// been imported anywhere in this process the binding is fixed (same trap as
// tests/backgroundJobCost.test.ts) — install the mock once and reuse the
// cached import across every test in this file.
let modulesPromise: Promise<{
  startUsageAlert: typeof import('../src/usageAlert.js').startUsageAlert;
  BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD: number;
  getJobHealthSnapshot: typeof import('../src/backgroundJobHealth.js').getJobHealthSnapshot;
  resetJobHealthRegistryForTests: typeof import('../src/backgroundJobHealth.js').resetJobHealthRegistryForTests;
}> | null = null;
async function modules(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!modulesPromise) {
    modulesPromise = (async () => {
      const realRepo = await import('../src/storage/repository.js');
      t.mock.module('../src/storage/repository.js', {
        namedExports: { ...realRepo, usageStats: mockUsageStats },
      });
      const [
        { startUsageAlert },
        { BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD },
        { getJobHealthSnapshot, resetJobHealthRegistryForTests },
      ] = await Promise.all([
        import('../src/usageAlert.js'),
        import('../src/backgroundJobs.js'),
        import('../src/backgroundJobHealth.js'),
      ]);
      return {
        startUsageAlert,
        BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD,
        getJobHealthSnapshot,
        resetJobHealthRegistryForTests,
      };
    })();
  }
  return modulesPromise;
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

// check()'s alert path is fire-and-forget (`void alertSuperAdmins(...)`, no
// await), so give the microtask queue a turn after each tick before
// asserting — same technique as tests/statusCheckAlert.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('startUsageAlert: a single usageStats(1) failure logs and is swallowed — no DM, no throw (issue #426 criterion 1: below threshold, the poller stays silent exactly as before)', async (t) => {
  const { startUsageAlert } = await modules(t);
  mode = 'fail';
  outbound = 5;
  const { adapter, dms } = makeAdapter();

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startUsageAlert([adapter]);
  assert.ok(timer, 'enabled — a timer is created');
  try {
    await flush();
    assert.equal(dms.length, 0, 'a single failure, below the consecutive-failure threshold, sends no DM');
  } finally {
    clearInterval(timer);
    mode = 'succeed';
  }
});

test('startUsageAlert: sends exactly one super-admin DM after usageStats(1) fails on consecutive ticks reaching BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD, none before, none after', async (t) => {
  const { startUsageAlert, BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD } = await modules(t);
  mode = 'fail';
  outbound = 5;
  const { adapter, dms } = makeAdapter();

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startUsageAlert([adapter]);
  try {
    await flush(); // 1st scheduled run (fires immediately) fails
    for (let i = 1; i < BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD; i++) {
      assert.equal(
        dms.length,
        0,
        `no DM after ${i} consecutive failure(s) (below threshold ${BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD})`,
      );
      t.mock.timers.tick(POLL_MS);
      await flush();
    }
    assert.equal(
      dms.length,
      1,
      `exactly one DM on reaching the threshold (${BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD})`,
    );
    assert.match(dms[0].text, /^⚠️ Background job 'usage-alert' has failed \d+ consecutive times/);
    t.mock.timers.tick(POLL_MS);
    await flush(); // one more failure past the threshold
    assert.equal(dms.length, 1, 'no repeat DM while the failure streak continues');
  } finally {
    clearInterval(timer!);
    mode = 'succeed';
  }
});

test('startUsageAlert: a successful check after a failure streak resets the tracker silently, and a fresh streak alerts again (not a one-shot latch)', async (t) => {
  const { startUsageAlert, BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD } = await modules(t);
  mode = 'fail';
  outbound = 5;
  const { adapter, dms } = makeAdapter();

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startUsageAlert([adapter]);
  try {
    await flush();
    for (let i = 1; i < BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD; i++) {
      t.mock.timers.tick(POLL_MS);
      await flush();
    }
    assert.equal(dms.length, 1, 'first streak of failures reaching the threshold alerts once');

    mode = 'succeed';
    t.mock.timers.tick(POLL_MS);
    await flush(); // success -> silently resets the failure tracker
    assert.equal(dms.length, 1, 'a successful check never itself sends a DM');

    mode = 'fail';
    for (let i = 0; i < BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD; i++) {
      t.mock.timers.tick(POLL_MS);
      await flush();
    }
    assert.equal(dms.length, 2, 'a fresh streak of threshold failures after recovery alerts again');
  } finally {
    clearInterval(timer!);
    mode = 'succeed';
  }
});

test("startUsageAlert: records 'usage-alert' in the shared job-health registry on both a successful and a failed check (issue #467)", async (t) => {
  const { startUsageAlert, getJobHealthSnapshot, resetJobHealthRegistryForTests } = await modules(t);
  resetJobHealthRegistryForTests();
  mode = 'fail';
  outbound = 5;
  const { adapter } = makeAdapter();

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startUsageAlert([adapter]);
  try {
    await flush(); // 1st check fails
    let snap = getJobHealthSnapshot()['usage-alert'];
    assert.ok(snap, 'a snapshot is recorded after the first (failed) check');
    assert.equal(snap.consecutiveFailures, 1);
    assert.equal(snap.lastSuccessAt, null);

    mode = 'succeed';
    t.mock.timers.tick(POLL_MS);
    await flush(); // 2nd check succeeds
    snap = getJobHealthSnapshot()['usage-alert'];
    assert.equal(snap!.consecutiveFailures, 0, 'a success resets consecutiveFailures in the registry');
    assert.ok(snap!.lastSuccessAt !== null, 'a success records a lastSuccessAt in the registry');
  } finally {
    clearInterval(timer!);
    mode = 'succeed';
  }
});

test('startUsageAlert: the usage-threshold-crossed alert and the check-failure alert are fully independent — neither suppresses, duplicates, nor re-arms the other', async (t) => {
  const { startUsageAlert, BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD } = await modules(t);
  mode = 'succeed';
  outbound = 5; // under the USAGE_ALERT_DAILY_REPLIES=10 threshold
  const { adapter, dms } = makeAdapter();

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startUsageAlert([adapter]);
  try {
    await flush();
    assert.equal(dms.length, 0, 'below threshold, succeeding — no alert of either kind yet');

    // Drive a full failure streak to the threshold: fires the check-failure alert.
    mode = 'fail';
    for (let i = 0; i < BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD; i++) {
      t.mock.timers.tick(POLL_MS);
      await flush();
    }
    assert.equal(dms.length, 1, 'check-failure streak reaches the threshold and alerts once');
    assert.match(dms[0].text, /^⚠️ Background job 'usage-alert'/);

    // Recover with outbound now over the usage threshold: fires the
    // independent threshold-crossed alert, and silently resets the failure
    // tracker without an extra "recovered" DM of its own.
    mode = 'succeed';
    outbound = 15;
    t.mock.timers.tick(POLL_MS);
    await flush();
    assert.equal(dms.length, 2, 'the usage-threshold-crossed alert fires as its own, independent signal');
    assert.match(dms[1].text, /^⚠️ Usage alert:/);

    // Still over threshold on the next tick: the threshold latch is debounced
    // (no repeat), confirming the check-failure alert above didn't consume
    // or re-arm it.
    t.mock.timers.tick(POLL_MS);
    await flush();
    assert.equal(dms.length, 2, 'the debounced threshold latch does not repeat while still over');

    // A fresh failure streak alerts again even though the threshold latch is
    // still (silently) crossed — the two trackers never gate one another.
    mode = 'fail';
    for (let i = 0; i < BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD; i++) {
      t.mock.timers.tick(POLL_MS);
      await flush();
    }
    assert.equal(
      dms.length,
      3,
      'a fresh check-failure streak alerts again, independent of the threshold latch',
    );
    assert.match(dms[2].text, /^⚠️ Background job 'usage-alert'/);
  } finally {
    clearInterval(timer!);
    mode = 'succeed';
    outbound = 5;
  }
});
