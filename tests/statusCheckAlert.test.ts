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

const { startStatusCheck, statusCheckAlertThreshold } = await import('../src/backgroundJobs.js');
const { getJobHealthSnapshot, resetJobHealthRegistryForTests } =
  await import('../src/backgroundJobHealth.js');

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
