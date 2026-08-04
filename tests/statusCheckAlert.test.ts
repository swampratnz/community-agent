import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

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
// The status feed URL has NO default in agent-base — a framework must not ship
// one vendor's status page — so this deployment sets it explicitly, and so
// must a test that exercises the poller (see .env.example).
process.env.STATUS_CHECK_API_URL ??= 'https://status.claude.com/api/v2/summary.json';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS ??= 'admin-open,admin-closed';
process.env.STATUS_CHECK_ENABLED = 'true';
process.env.STATUS_CHECK_POLL_MINUTES = '5';

const {
  startStatusCheck,
  statusCheckAlertThreshold,
  stepStatusIncidentTracker,
  initialStatusIncidentTracker,
} = await import('../src/module/backgroundJobs.js');
const { getJobHealthSnapshot, resetJobHealthRegistryForTests } =
  await import('@swampratnz/agent-base/backgroundJobHealth.js');
const {
  pollAnthropicStatus,
  resetStatusCacheForTests,
  formatStatusResolvedAlert,
  formatStatusMessage,
  getStatusCache,
} = await import('../src/module/status/anthropicStatus.js');
const { WindowClosedError } = await import('@swampratnz/agent-base/platforms/whatsapp/cloudAdapter.js');

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
    assert.equal(snap.consecutiveFailures, 0, 'a success resets consecutiveFailures in the registry');
    assert.ok(snap.lastSuccessAt !== null, 'a success records a lastSuccessAt in the registry');
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
    assert.equal(step.shouldAlert, false, 'the resolve transition itself never fires shouldAlert');
    tracker = step.tracker;

    step = stepStatusIncidentTracker(tracker, 'critical');
    assert.equal(step.shouldAlert, true, 'a later, separate incident after re-arming fires again');
  },
);

test(
  'stepStatusIncidentTracker: shouldAlertResolved (issue #905) is true only on the active(true) -> none ' +
    'transition, false for every other case, and never true alongside shouldAlert in the same step',
  () => {
    let tracker = initialStatusIncidentTracker();

    // none -> none: never armed, never fires either flag.
    let step = stepStatusIncidentTracker(tracker, 'none');
    assert.equal(step.shouldAlert, false);
    assert.equal(step.shouldAlertResolved, false, 'none -> none never fires the resolved alert');
    tracker = step.tracker;

    // none -> incident: arms the latch, fires shouldAlert only.
    step = stepStatusIncidentTracker(tracker, 'minor');
    assert.equal(step.shouldAlert, true);
    assert.equal(step.shouldAlertResolved, false, 'the start transition never fires the resolved alert');
    tracker = step.tracker;

    // incident -> incident (repeat, still active): neither flag fires.
    step = stepStatusIncidentTracker(tracker, 'minor');
    assert.equal(step.shouldAlert, false);
    assert.equal(step.shouldAlertResolved, false, 'repeating the same active incident fires neither flag');
    tracker = step.tracker;

    // incident -> different-but-still-non-none incident: neither flag fires.
    step = stepStatusIncidentTracker(tracker, 'critical');
    assert.equal(
      step.shouldAlert,
      false,
      'escalating severity while still active does not re-fire shouldAlert',
    );
    assert.equal(step.shouldAlertResolved, false, 'escalating severity while still active is not a resolve');
    tracker = step.tracker;

    // active(true) -> none: the resolve edge. Fires shouldAlertResolved only.
    step = stepStatusIncidentTracker(tracker, 'none');
    assert.equal(step.shouldAlert, false, 'shouldAlert and shouldAlertResolved are never both true');
    assert.equal(step.shouldAlertResolved, true, 'active -> none fires the resolved alert exactly once');
    tracker = step.tracker;

    // none -> none again, now that the latch is disarmed: neither flag fires.
    step = stepStatusIncidentTracker(tracker, 'none');
    assert.equal(step.shouldAlert, false);
    assert.equal(
      step.shouldAlertResolved,
      false,
      'a disarmed latch does not re-fire resolved on repeat none',
    );

    // Exhaustively re-check every transition never yields both flags true.
    for (const from of ['none', 'minor', 'major', 'critical'] as const) {
      for (const to of ['none', 'minor', 'major', 'critical'] as const) {
        const t = stepStatusIncidentTracker({ active: from !== 'none' }, to);
        assert.ok(
          !(t.shouldAlert && t.shouldAlertResolved),
          `shouldAlert and shouldAlertResolved must never both be true (${from} -> ${to})`,
        );
      }
    }
  },
);

test(
  'startStatusCheck: DMs super admins exactly once on a none -> incident transition, no repeat while the ' +
    'incident stays active, exactly one resolved DM on the resolve transition, and fires again (start + ' +
    'resolved) for a later separate incident (issue #905)',
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
      assert.equal(dms.length, 2, 'exactly one resolved DM follows the incident-start DM, in order');
      assert.match(dms[1].text, /resolved/i);
      assert.doesNotMatch(dms[1].text, /Elevated errors on the Messages API/);

      body = OTHER_INCIDENT_BODY;
      t.mock.timers.tick(POLL_MS); // a later, separate incident
      await flush();
      assert.equal(dms.length, 3, 'a later, separate incident after re-arming alerts again');
      assert.match(dms[2].text, /Total outage on the Messages API/);
    } finally {
      clearInterval(timer!);
    }
  },
);

test('startStatusCheck: a none -> none sequence (status stays operational) yields zero alertSuperAdmins calls', async (t) => {
  resetStatusCacheForTests();
  const { adapter, dms } = makeAdapter();
  const runOnce = () => pollAnthropicStatus(async () => ALL_OPERATIONAL_BODY);

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startStatusCheck([adapter], runOnce);
  try {
    await flush();
    t.mock.timers.tick(POLL_MS);
    await flush();
    t.mock.timers.tick(POLL_MS);
    await flush();
    assert.equal(dms.length, 0, 'staying operational across several polls sends no DM at all');
  } finally {
    clearInterval(timer!);
  }
});

test(
  'startStatusCheck: a none -> major -> major -> none sequence still yields exactly one start DM and one ' +
    'resolved DM — no repeat while the incident remains active across multiple polls',
  async (t) => {
    resetStatusCacheForTests();
    const { adapter, dms } = makeAdapter();
    let body = ALL_OPERATIONAL_BODY;
    const runOnce = () => pollAnthropicStatus(async () => body);

    t.mock.timers.enable({ apis: ['setInterval'] });
    const timer = startStatusCheck([adapter], runOnce);
    try {
      await flush(); // none

      body = INCIDENT_BODY;
      t.mock.timers.tick(POLL_MS); // -> major
      await flush();
      assert.equal(dms.length, 1, 'one start DM');

      t.mock.timers.tick(POLL_MS); // still major
      await flush();
      t.mock.timers.tick(POLL_MS); // still major
      await flush();
      assert.equal(dms.length, 1, 'no repeat start DM across multiple polls while still active');

      body = ALL_OPERATIONAL_BODY;
      t.mock.timers.tick(POLL_MS); // -> none
      await flush();
      assert.equal(dms.length, 2, 'exactly one resolved DM follows');
    } finally {
      clearInterval(timer!);
    }
  },
);

// --- Per-recipient window-reopen queue extension (issue #888) ---
//
// The status-incident DM above shares backgroundJobs.ts's single
// module-private `alertSuperAdmins` with the failure-threshold alert
// (tests/backgroundJobs.test.ts pins the fix there) — this test proves that
// shared function's window-reopen fix reaches the status-incident producer
// too, with zero code change of its own (acceptance criterion 3).
test(
  "startStatusCheck: the status-incident DM inherits backgroundJobs.ts's shared alertSuperAdmins " +
    "window-reopen fix — a WindowClosedError rejection queues via queueForWindowReopen at 'system' " +
    'priority instead of only logging, with no code change in this producer (issue #888 acceptance criterion 3)',
  async (t) => {
    resetStatusCacheForTests();
    const { adapter, dms, queued } = makeCloudAdapter({
      'admin-closed': new WindowClosedError('admin-closed'),
    });
    let body = ALL_OPERATIONAL_BODY;
    const runOnce = () => pollAnthropicStatus(async () => body);

    t.mock.timers.enable({ apis: ['setInterval'] });
    const timer = startStatusCheck([adapter], runOnce);
    try {
      await flush(); // initial run: operational
      body = INCIDENT_BODY;
      t.mock.timers.tick(POLL_MS);
      await flush(); // none -> incident transition, one DM

      assert.deepEqual(
        dms.map((d) => d.userId),
        ['admin-open'],
        'the open-window recipient is still delivered live',
      );
      assert.equal(queued.length, 1);
      assert.equal(queued[0]?.userId, 'admin-closed');
      assert.equal(queued[0]?.priority, 'system');
      assert.match(queued[0]?.message ?? '', /Elevated errors on the Messages API/);
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

test(
  'SECURITY: the resolved alert (issue #905) targets exactly the same super-admin recipient set as the ' +
    'incident-start alert — no broadened scope, no channel post — and its body exposes no data beyond ' +
    'what formatStatusMessage/state.summary already surfaces to any check_status caller: on the resolve ' +
    'edge the body equals the incident-free formatStatusMessage rendering and contains no incident name ' +
    'or description string',
  async (t) => {
    resetStatusCacheForTests();
    const { adapter, dms } = makeAdapter();
    let body = ALL_OPERATIONAL_BODY;
    const runOnce = () => pollAnthropicStatus(async () => body);

    t.mock.timers.enable({ apis: ['setInterval'] });
    const timer = startStatusCheck([adapter], runOnce);
    try {
      await flush(); // initial run: operational
      body = INCIDENT_BODY;
      t.mock.timers.tick(POLL_MS); // none -> incident: start DM
      await flush();

      body = ALL_OPERATIONAL_BODY;
      t.mock.timers.tick(POLL_MS); // incident -> none: resolved DM
      await flush();

      assert.equal(dms.length, 2, 'exactly one start DM and one resolved DM');
      assert.deepEqual(
        dms.map((d) => d.userId),
        ['super-1', 'super-1'],
        'the resolved DM recipient set is identical to the incident-start DM recipient set — super admins only',
      );

      const resolvedBody = dms[1].text;
      const state = getStatusCache();
      assert.ok(state);
      const memberFacingBody = formatStatusMessage(state, Date.now());
      assert.equal(
        resolvedBody,
        formatStatusResolvedAlert(state, Date.now()),
        'sanity: the sent DM matches the pure formatter for the same state',
      );
      assert.ok(
        resolvedBody.includes(memberFacingBody),
        'the resolved DM body must contain exactly the incident-free formatStatusMessage rendering — no ' +
          'data beyond what a member-tier check_status caller already sees',
      );
      assert.doesNotMatch(
        resolvedBody,
        /Elevated errors on the Messages API/,
        'the resolved DM must carry no incident name string from the prior, now-resolved incident',
      );
      assert.doesNotMatch(
        resolvedBody,
        /Major System Outage/,
        'the resolved DM must carry no incident description string from the prior, now-resolved incident',
      );
    } finally {
      clearInterval(timer!);
    }
  },
);
