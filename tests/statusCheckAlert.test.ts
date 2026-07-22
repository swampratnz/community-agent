import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Anthropic status-check consecutive-failure alerting (issue #321). Its own
// process/file because STATUS_CHECK_ENABLED is pinned ON here (opposite of
// tests/backgroundJobsDisabled.test.ts, which leaves it unset) — config is
// parsed once per process at import time, so "enabled" and "disabled"
// behaviour can't share a file.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';
process.env.STATUS_CHECK_ENABLED = 'true';
process.env.STATUS_CHECK_POLL_MINUTES = '5';

const {
  startStatusCheck,
  statusCheckAlertThreshold,
  stepStatusIncidentTracker,
  initialStatusIncidentTracker,
} = await import('../src/backgroundJobs.js');
const { getJobHealthSnapshot, resetJobHealthRegistryForTests } =
  await import('../src/backgroundJobHealth.js');
const { pollAnthropicStatus, resetStatusCacheForTests } = await import('../src/status/anthropicStatus.js');

const POLL_MS = 5 * 60_000;
const THRESHOLD = statusCheckAlertThreshold(5);

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
// asserting — same technique as tests/backgroundJobs.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('statusCheckAlertThreshold: ~1h of consecutive failures before alerting, floored at 3 regardless of the configured poll interval', () => {
  assert.equal(statusCheckAlertThreshold(5), 12, 'default 5-min cadence: 12 consecutive failures (~1h)');
  assert.equal(statusCheckAlertThreshold(60), 3, 'a 1h cadence floors at 3, not 1');
  assert.equal(statusCheckAlertThreshold(1440), 3, 'a 24h cadence still floors at 3');
  assert.equal(statusCheckAlertThreshold(1), 60, 'a 1-min cadence needs a full hour of failures');
});

test('startStatusCheck: sends exactly one super-admin DM after runOnce reports failure on consecutive ticks reaching the cadence-scaled threshold, none before, none after', async (t) => {
  const { adapter, dms } = makeAdapter();
  const runOnce = async () => false; // mirrors pollAnthropicStatus reporting a degraded fetch

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startStatusCheck([adapter], runOnce);
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

test('startStatusCheck: a successful poll after a failure streak resets the tracker silently, and a fresh streak of threshold failures alerts again (not a one-shot latch)', async (t) => {
  const { adapter, dms } = makeAdapter();
  let mode: 'fail' | 'succeed' = 'fail';
  const runOnce = async () => mode === 'succeed';

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startStatusCheck([adapter], runOnce);
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
    assert.equal(dms.length, 1, 'a successful poll never itself sends a DM');

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

test("startStatusCheck: polls at config.statusCheck.pollMinutes, not backgroundJobs.ts's 6h TICK_INTERVAL_MS the other jobs share (issue #321)", async (t) => {
  const { adapter } = makeAdapter();
  let calls = 0;
  const runOnce = async () => {
    calls++;
    return true;
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startStatusCheck([adapter], runOnce);
  try {
    await flush();
    assert.equal(calls, 1, 'the initial run fires immediately');
    t.mock.timers.tick(POLL_MS - 1);
    await flush();
    assert.equal(calls, 1, 'no second run before a full STATUS_CHECK_POLL_MINUTES interval elapses');
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, 2, 'a second run fires exactly at the configured poll interval, not a 6h tick');
  } finally {
    clearInterval(timer!);
  }
});

test("startStatusCheck: records 'anthropic-status-check' in the shared job-health registry on both a successful and a failed run (issue #467)", async (t) => {
  resetJobHealthRegistryForTests();
  const { adapter } = makeAdapter();
  let mode: 'fail' | 'succeed' = 'fail';
  const runOnce = async () => mode === 'succeed';

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startStatusCheck([adapter], runOnce);
  try {
    await flush(); // 1st run fails
    let snap = getJobHealthSnapshot()['anthropic-status-check'];
    assert.ok(snap, 'a snapshot is recorded after the first (failed) run');
    assert.equal(snap.consecutiveFailures, 1);
    assert.equal(snap.lastSuccessAt, null);

    mode = 'succeed';
    t.mock.timers.tick(POLL_MS);
    await flush(); // 2nd run succeeds
    snap = getJobHealthSnapshot()['anthropic-status-check'];
    assert.equal(snap!.consecutiveFailures, 0, 'a success resets consecutiveFailures in the registry');
    assert.ok(snap!.lastSuccessAt !== null, 'a success records a lastSuccessAt in the registry');
  } finally {
    clearInterval(timer!);
  }
});

test('SECURITY: the status-check alert DM body never contains a caught error message or stack — only the fixed template (job name, failure count, last-success timestamp)', async (t) => {
  const sentinel = 'sentinel-secret-path-or-query-fragment-status';
  const { adapter, dms } = makeAdapter();
  // Exercises the defensive try/catch backstop: pollAnthropicStatus itself
  // never throws, but the wrapper must not leak an error's message/stack
  // even if runOnce ever did.
  const runOnce = async () => {
    throw new Error(sentinel);
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startStatusCheck([adapter], runOnce);
  try {
    await flush();
    for (let i = 1; i < THRESHOLD; i++) {
      t.mock.timers.tick(POLL_MS);
      await flush();
    }
    assert.equal(dms.length, 1, 'threshold reached, one alert sent');
    const body = dms[0].text;
    assert.ok(!body.includes(sentinel), 'the DM body must never contain the caught error message');
    assert.match(
      body,
      new RegExp(
        `^⚠️ Background job 'anthropic-status-check' has failed ${THRESHOLD} consecutive times ` +
          `\\(last success: never this run\\)\\. Check server logs for details\\.$`,
      ),
    );
  } finally {
    clearInterval(timer!);
  }
});

// --- proactive incident DM (issue #601) --------------------------------------

const ALL_OPERATIONAL_BODY = JSON.stringify({
  status: { indicator: 'none', description: 'All Systems Operational' },
  incidents: [],
});

const INCIDENT_BODY = JSON.stringify({
  status: { indicator: 'major', description: 'Major System Outage' },
  incidents: [
    {
      name: 'Elevated errors on the Messages API',
      impact: 'major',
      status: 'investigating',
      updated_at: '2026-07-07T00:00:00.000Z',
    },
  ],
});

const OTHER_INCIDENT_BODY = JSON.stringify({
  status: { indicator: 'critical', description: 'Complete API Outage' },
  incidents: [
    {
      name: 'Total outage on the Messages API',
      impact: 'critical',
      status: 'investigating',
      updated_at: '2026-07-07T01:00:00.000Z',
    },
  ],
});

test(
  'stepStatusIncidentTracker: none -> incident fires once, stays silent while non-none persists, ' +
    're-arms on return to none, and fires again on a later separate incident',
  () => {
    let tracker = initialStatusIncidentTracker();

    let step = stepStatusIncidentTracker(tracker, 'none');
    assert.equal(step.shouldAlert, false, 'staying at none never alerts');
    tracker = step.tracker;

    step = stepStatusIncidentTracker(tracker, 'minor');
    assert.equal(step.shouldAlert, true, 'none -> minor fires exactly once');
    tracker = step.tracker;

    step = stepStatusIncidentTracker(tracker, 'major');
    assert.equal(step.shouldAlert, false, 'staying non-none (even at a different level) does not re-fire');
    tracker = step.tracker;

    step = stepStatusIncidentTracker(tracker, 'none');
    assert.equal(step.shouldAlert, false, 'the resolve transition itself never alerts');
    tracker = step.tracker;

    step = stepStatusIncidentTracker(tracker, 'critical');
    assert.equal(step.shouldAlert, true, 'a later, separate incident after re-arming fires again');
  },
);

test(
  'startStatusCheck: DMs super admins exactly once on a none -> incident transition, no repeat while the ' +
    'incident stays active, no DM on the resolve transition, and fires again for a later separate incident',
  async (t) => {
    resetStatusCacheForTests();
    const { adapter, dms } = makeAdapter();
    let body = ALL_OPERATIONAL_BODY;
    // Wires the real pollAnthropicStatus/cache path (rather than a fake
    // boolean) so the incident branch — which reads getStatusCache() after a
    // successful poll — is exercised end to end, per the approved criteria.
    const runOnce = () => pollAnthropicStatus(async () => body);

    t.mock.timers.enable({ apis: ['setInterval'] });
    const timer = startStatusCheck([adapter], runOnce);
    try {
      await flush(); // initial run: operational
      assert.equal(dms.length, 0, 'no DM while status stays operational');

      body = INCIDENT_BODY;
      t.mock.timers.tick(POLL_MS);
      await flush();
      assert.equal(dms.length, 1, 'exactly one DM on the none -> incident transition');
      assert.match(dms[0].text, /Elevated errors on the Messages API/);

      t.mock.timers.tick(POLL_MS); // still the same incident
      await flush();
      assert.equal(dms.length, 1, 'no repeat DM while the incident stays active');

      body = ALL_OPERATIONAL_BODY;
      t.mock.timers.tick(POLL_MS); // resolves
      await flush();
      assert.equal(dms.length, 1, 'the resolve transition itself sends no DM (out of scope for this issue)');

      body = OTHER_INCIDENT_BODY;
      t.mock.timers.tick(POLL_MS); // a later, separate incident
      await flush();
      assert.equal(dms.length, 2, 'a later, separate incident after re-arming alerts again');
      assert.match(dms[1].text, /Total outage on the Messages API/);
    } finally {
      clearInterval(timer!);
    }
  },
);

test('SECURITY: a poll that FAILS never advances the incident latch, even if the last-known-good cache is an active incident', async (t) => {
  resetStatusCacheForTests();
  const { adapter, dms } = makeAdapter();
  // First poll succeeds and caches an incident (arms nothing yet — the very
  // first successful poll transitions from the tracker's initial "inactive"
  // state, so this itself fires once, matching the DM test above).
  let mode: 'incident' | 'fail' = 'incident';
  const runOnce = () =>
    pollAnthropicStatus(async () => {
      if (mode === 'fail') throw new Error('network down');
      return INCIDENT_BODY;
    });

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startStatusCheck([adapter], runOnce);
  try {
    await flush();
    assert.equal(dms.length, 1, 'the first successful poll observing an incident alerts once');

    mode = 'fail';
    t.mock.timers.tick(POLL_MS);
    await flush();
    assert.equal(dms.length, 1, 'a failed poll never re-evaluates or re-fires the incident latch');
  } finally {
    clearInterval(timer!);
  }
});

test(
  'SECURITY: the proactive incident DM targets only the configured super admins, via the same ' +
    'alertSuperAdmins/sendDirectMessage fan-out every other proactive alert in this file uses — no admin, ' +
    'member, or guest recipient, and nothing derived from message-content-supplied roles',
  async (t) => {
    resetStatusCacheForTests();
    const { adapter, dms } = makeAdapter();
    let body = ALL_OPERATIONAL_BODY;
    const runOnce = () => pollAnthropicStatus(async () => body);

    t.mock.timers.enable({ apis: ['setInterval'] });
    const timer = startStatusCheck([adapter], runOnce);
    try {
      await flush();
      body = INCIDENT_BODY;
      t.mock.timers.tick(POLL_MS);
      await flush();
      assert.equal(dms.length, 1);
      assert.deepEqual(
        dms.map((d) => d.userId),
        ['super-1'],
        'the DM recipient is exactly the configured SUPER_ADMIN_DISCORD_IDS set — the same super-admin-only ' +
          'fan-out as every job-failure alert above, no broader audience',
      );
    } finally {
      clearInterval(timer!);
    }
  },
);
