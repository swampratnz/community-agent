import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Dev-team-watch consecutive-failure alerting (issue #452). Its own
// process/file because DEV_TEAM_ENABLED is pinned ON here (opposite of
// tests/devTeamWatch.test.ts, which leaves it unset so its own "disabled"
// assertion stays genuine) — config is parsed once per process at import
// time, so "enabled" and "disabled" behaviour can't share a file.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';
process.env.DEV_TEAM_ENABLED = 'true';
process.env.DEV_TEAM_ENDPOINT_URL = 'https://dev-team.example.internal';
process.env.DEV_TEAM_AUTH_TOKEN = 'test-dev-team-token';
// Left at the default (1 min) deliberately — this file pins the fast-cadence
// end of statusCheckAlertThreshold; tests/devTeamWatchAlertCoarseCadence.test.ts
// pins the floored end with DEV_TEAM_WATCH_POLL_MINUTES=60.

const { startDevTeamWatchPoller, statusCheckAlertThreshold } = await import('../src/backgroundJobs.js');
const { getJobHealthSnapshot, resetJobHealthRegistryForTests } =
  await import('../src/backgroundJobHealth.js');

const POLL_MS = 1 * 60_000;
const THRESHOLD = statusCheckAlertThreshold(1);

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

// run()'s alert path is fire-and-forget (`void alertSuperAdmins(...)`, no
// await), so give the microtask queue a turn after each tick before
// asserting — same technique as tests/statusCheckAlert.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('statusCheckAlertThreshold(1): a 1-min cadence (DEV_TEAM_WATCH_POLL_MINUTES default) needs a full hour of failures — cadence-scaled, not the flat threshold of 3', () => {
  assert.equal(THRESHOLD, 60);
});

test('startDevTeamWatchPoller: sends exactly one super-admin DM after runOnce throws on consecutive ticks reaching the cadence-scaled threshold, none before, none after', async (t) => {
  const { adapter, dms } = makeAdapter();
  const runOnce = async () => {
    throw new Error('dev-team status endpoint unreachable');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDevTeamWatchPoller([adapter], runOnce);
  assert.ok(timer, 'enabled — a timer is created');
  try {
    await flush(); // 1st scheduled run (fires immediately) fails
    for (let i = 1; i < THRESHOLD; i++) {
      assert.equal(dms.length, 0, `no DM after ${i} consecutive failure(s) (below threshold ${THRESHOLD})`);
      t.mock.timers.tick(POLL_MS);
      await flush();
    }
    assert.equal(dms.length, 1, `exactly one DM on reaching the threshold (${THRESHOLD})`);
    t.mock.timers.tick(POLL_MS);
    await flush(); // one more failure past the threshold
    assert.equal(dms.length, 1, 'no repeat DM while the failure streak continues');
  } finally {
    clearInterval(timer);
  }
});

test('startDevTeamWatchPoller: a successful run after a failure streak resets the tracker silently, and a fresh streak of threshold failures alerts again (not a one-shot latch)', async (t) => {
  const { adapter, dms } = makeAdapter();
  let mode: 'fail' | 'succeed' = 'fail';
  const runOnce = async () => {
    if (mode === 'fail') throw new Error('dev-team status endpoint unreachable');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDevTeamWatchPoller([adapter], runOnce);
  try {
    await flush();
    for (let i = 1; i < THRESHOLD; i++) {
      t.mock.timers.tick(POLL_MS);
      await flush();
    }
    assert.equal(dms.length, 1, 'first streak of failures reaching the threshold alerts once');

    mode = 'succeed';
    t.mock.timers.tick(POLL_MS);
    await flush(); // success -> silently resets the tracker
    assert.equal(dms.length, 1, 'a successful run never itself sends a DM');

    mode = 'fail';
    for (let i = 0; i < THRESHOLD; i++) {
      t.mock.timers.tick(POLL_MS);
      await flush();
    }
    assert.equal(dms.length, 2, 'a fresh streak of threshold failures after recovery alerts again');
  } finally {
    clearInterval(timer!);
  }
});

test("startDevTeamWatchPoller: polls at config.devTeam.watchPollMinutes, not backgroundJobs.ts's 6h TICK_INTERVAL_MS the other jobs share", async (t) => {
  const { adapter } = makeAdapter();
  let calls = 0;
  const runOnce = async () => {
    calls++;
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDevTeamWatchPoller([adapter], runOnce);
  try {
    await flush();
    assert.equal(calls, 1, 'the initial run fires immediately');
    t.mock.timers.tick(POLL_MS - 1);
    await flush();
    assert.equal(calls, 1, 'no second run before a full DEV_TEAM_WATCH_POLL_MINUTES interval elapses');
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, 2, 'a second run fires exactly at the configured poll interval, not a 6h tick');
  } finally {
    clearInterval(timer!);
  }
});

test('runDevTeamWatchOnce per-watch best-effort retry semantics are untouched by the outer failure tracker: a single bad watch does not itself count as a tracked outer failure', async (t) => {
  // The default runOnce wraps runDevTeamWatchOnce, which already swallows a
  // single bad watch's status-check failure (tests/devTeamWatch.test.ts
  // covers that in isolation). Here we only assert the outer poller's own
  // injected runOnce contract: resolving (even having done nothing useful)
  // counts as success for the tracker, never as a failure.
  const { adapter, dms } = makeAdapter();
  const runOnce = async () => {}; // mirrors a pass with zero unnotified watches, or one bad watch swallowed internally

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDevTeamWatchPoller([adapter], runOnce);
  try {
    for (let i = 0; i < THRESHOLD + 5; i++) {
      await flush();
      t.mock.timers.tick(POLL_MS);
    }
    assert.equal(
      dms.length,
      0,
      'a resolving runOnce never trips the failure tracker, however many ticks pass',
    );
  } finally {
    clearInterval(timer!);
  }
});

test("startDevTeamWatchPoller: records 'dev-team-watch' in the shared job-health registry on both a successful and a failed run (issue #467)", async (t) => {
  resetJobHealthRegistryForTests();
  const { adapter } = makeAdapter();
  let mode: 'fail' | 'succeed' = 'fail';
  const runOnce = async () => {
    if (mode === 'fail') throw new Error('dev-team status endpoint unreachable');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDevTeamWatchPoller([adapter], runOnce);
  try {
    await flush(); // 1st run fails
    let snap = getJobHealthSnapshot()['dev-team-watch'];
    assert.ok(snap, 'a snapshot is recorded after the first (failed) run');
    assert.equal(snap.consecutiveFailures, 1);
    assert.equal(snap.lastSuccessAt, null);

    mode = 'succeed';
    t.mock.timers.tick(POLL_MS);
    await flush(); // 2nd run succeeds
    snap = getJobHealthSnapshot()['dev-team-watch'];
    assert.equal(snap!.consecutiveFailures, 0, 'a success resets consecutiveFailures in the registry');
    assert.ok(snap!.lastSuccessAt !== null, 'a success records a lastSuccessAt in the registry');
  } finally {
    clearInterval(timer!);
  }
});

test('SECURITY: the dev-team-watch failure alert DM body never contains a watch jobId, repo, requester identifier, or the caught error message — only the fixed template', async (t) => {
  const sentinel = 'sentinel-jobId-job-42-repo-owner/name-requester-super-1';
  const { adapter, dms } = makeAdapter();
  // Exercises the outer poll's failure path with a service-originated error
  // that could plausibly embed watch identifiers, mirroring the real
  // failure modes (dead endpoint, expired token, DB outage).
  const runOnce = async () => {
    throw new Error(sentinel);
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDevTeamWatchPoller([adapter], runOnce);
  try {
    await flush();
    for (let i = 1; i < THRESHOLD; i++) {
      t.mock.timers.tick(POLL_MS);
      await flush();
    }
    assert.equal(dms.length, 1, 'threshold reached, one alert sent');
    const body = dms[0].text;
    assert.ok(!body.includes(sentinel), 'the DM body must never contain the caught error message');
    assert.ok(!body.includes('job-42'), 'the DM body must never contain a watch jobId');
    assert.ok(!body.includes('owner/name'), 'the DM body must never contain a watch repo');
    assert.ok(!body.includes('super-1'), 'the DM body must never contain a requester identifier');
    assert.match(
      body,
      new RegExp(
        `^⚠️ Background job 'dev-team-watch' has failed ${THRESHOLD} consecutive times ` +
          `\\(last success: never this run\\)\\. Check server logs for details\\.$`,
      ),
    );
  } finally {
    clearInterval(timer!);
  }
});
