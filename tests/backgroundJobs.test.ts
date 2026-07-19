import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';
import type { BackgroundJobName } from '../src/backgroundJobHealth.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. All five job flags are pinned
// ON here (opposite of tests/backgroundJobsDisabled.test.ts, in its own
// process — config is parsed once per process at import time, so "enabled"
// and "disabled" behaviour can't share a file) so the alerting wiring below
// can be exercised end to end with injected `runOnce`/`purge` functions and
// mocked timers — never a real DB call, real network fetch, or real 6h
// wait. INTERACTION_RETENTION_DAYS/ROSTER_DEPARTED_RETENTION_DAYS use their
// respective config minimums (7/30) since config rejects any smaller
// nonzero value.
//
// hasDb is captured BEFORE the DATABASE_URL fallback below so the issue #335
// tests further down (which route through the REAL defaultXRun functions —
// including their DB-backed freshness guards — rather than a directly-
// throwing mock runOnce) can skip cleanly without a real Postgres, same
// convention as tests/{docsIngest,knowledgeRefresh,contextBuilder}.test.ts.
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
process.env.CONTEXT_BUILDER_ENABLED = 'true';
process.env.KNOWLEDGE_REFRESH_ENABLED = 'true';
process.env.DOCS_INGEST_ENABLED = 'true';
process.env.KNOWLEDGE_LINK_CHECK_ENABLED = 'true';
process.env.INTERACTION_RETENTION_DAYS = '7';
process.env.ROSTER_DEPARTED_RETENTION_DAYS = '30';
process.env.ADMIN_DIGEST_ENABLED = 'true';
process.env.DEPARTED_ADMIN_ALERT_ENABLED = 'true';
process.env.ENGAGEMENT_ALERT_ENABLED = 'true';

const {
  startContextBuilder,
  startKnowledgeRefresh,
  startDocsIngest,
  startKnowledgeLinkCheck,
  startEmbeddingHealthCheckJob,
  defaultDocsIngestRun,
  defaultKnowledgeRefreshRun,
  defaultContextBuilderRun,
  defaultKnowledgeLinkCheckRun,
} = await import('../src/backgroundJobs.js');
const { startRetentionPurge } = await import('../src/interactionRetention.js');
const { startRosterRetentionPurge } = await import('../src/rosterRetention.js');
const { startAdminDigest } = await import('../src/adminDigest.js');
const { startDepartedAdminAlert } = await import('../src/departedAdminAlert.js');
const { startEngagementAlert } = await import('../src/engagementAlert.js');
const { REFRESH_TOPICS, REFRESH_TITLES } = await import('../src/context/knowledgeRefresh.js');
const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const pgvector = (await import('pgvector/pg')).default;
const { getJobHealthSnapshot, resetJobHealthRegistryForTests } =
  await import('../src/backgroundJobHealth.js');

after(async () => {
  await closeDb();
});

const SIX_HOURS_MS = 6 * 3_600_000;
/**
 * Far enough in the future that ANY real row a concurrently-running test
 * file might write (this table is shared DB-wide, unscoped) reads as
 * "long ago" against it — the issue #335 tests below mock Date to this so
 * each job's own freshness guard (which compares a real DB timestamp
 * against Date.now()) can never be blocked by another test's fresh write.
 */
const FAR_FUTURE_MS = () => Date.now() + 5 * 365 * 24 * 3_600_000;

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
// asserting — same technique as tests/agentCoreUsageLimitAlert.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const JOBS = [
  ['startContextBuilder', startContextBuilder],
  ['startKnowledgeRefresh', startKnowledgeRefresh],
  ['startDocsIngest', startDocsIngest],
  ['startKnowledgeLinkCheck', startKnowledgeLinkCheck],
  ['startRetentionPurge', startRetentionPurge],
  ['startRosterRetentionPurge', startRosterRetentionPurge],
  ['startEmbeddingHealthCheckJob', startEmbeddingHealthCheckJob],
  ['startAdminDigest', startAdminDigest],
  ['startDepartedAdminAlert', startDepartedAdminAlert],
  ['startEngagementAlert', startEngagementAlert],
] as const;

/** Maps each starter above to the BackgroundJobName key it records under in the shared job-health registry (issue #467). */
const JOB_NAMES: Record<(typeof JOBS)[number][0], BackgroundJobName> = {
  startContextBuilder: 'context-builder',
  startKnowledgeRefresh: 'knowledge-refresh',
  startDocsIngest: 'docs-ingest',
  startKnowledgeLinkCheck: 'knowledge-link-check',
  startRetentionPurge: 'interaction-retention-purge',
  startRosterRetentionPurge: 'roster-retention-purge',
  startEmbeddingHealthCheckJob: 'embedding-model',
  startAdminDigest: 'admin-digest',
  startDepartedAdminAlert: 'departed-admin-alert',
  startEngagementAlert: 'engagement-alert',
};

for (const [name, start] of JOBS) {
  test(`${name}: sends exactly one super-admin DM after its run function throws on 3 consecutive scheduled ticks, and zero DMs while failures stay below threshold`, async (t) => {
    const { adapter, dms } = makeAdapter();
    const runOnce = async () => {
      throw new Error(`sentinel-${name}`);
    };

    t.mock.timers.enable({ apis: ['setInterval'] });
    const timer = start([adapter], runOnce);
    assert.ok(timer, `${name}: enabled — a timer is created`);
    try {
      await flush(); // 1st scheduled run (fires immediately) fails
      assert.equal(dms.length, 0, `${name}: no DM after the 1st consecutive failure`);
      t.mock.timers.tick(SIX_HOURS_MS);
      await flush(); // 2nd
      assert.equal(dms.length, 0, `${name}: no DM after the 2nd consecutive failure`);
      t.mock.timers.tick(SIX_HOURS_MS);
      await flush(); // 3rd — threshold reached
      assert.equal(dms.length, 1, `${name}: exactly one DM on the 3rd consecutive failure`);
      t.mock.timers.tick(SIX_HOURS_MS);
      await flush(); // 4th — still failing
      assert.equal(dms.length, 1, `${name}: no repeat DM while the failure streak continues`);
    } finally {
      clearInterval(timer);
    }
  });
}

// --- issue #467: every job kind mirrors its tracker update into the shared,
// in-memory job-health registry `/healthz` reads from (getJobHealthSnapshot).
// Each job's own registry entry is independent of the others, so the reset
// below only needs to happen once per test, not per job.

for (const [name, start] of JOBS) {
  test(`${name}: a successful run() records a fresh, non-alerted snapshot for '${JOB_NAMES[name]}' in the shared job-health registry`, async (t) => {
    resetJobHealthRegistryForTests();
    const { adapter } = makeAdapter();
    const runOnce = async () => {};

    t.mock.timers.enable({ apis: ['setInterval'] });
    const timer = start([adapter], runOnce);
    try {
      await flush();
      const snap = getJobHealthSnapshot()[JOB_NAMES[name]];
      assert.ok(snap, `${name}: a snapshot is recorded after its first run`);
      assert.equal(snap.consecutiveFailures, 0, `${name}: a success records zero consecutive failures`);
      assert.equal(snap.alerted, false, `${name}: a success never leaves alerted true`);
      assert.ok(snap.lastSuccessAt !== null, `${name}: a successful run records a lastSuccessAt`);
    } finally {
      clearInterval(timer!);
    }
  });

  test(`${name}: a failed run() records a non-zero consecutiveFailures (and no lastSuccessAt yet) for '${JOB_NAMES[name]}' in the shared job-health registry`, async (t) => {
    resetJobHealthRegistryForTests();
    const { adapter } = makeAdapter();
    const runOnce = async () => {
      throw new Error(`sentinel-registry-${name}`);
    };

    t.mock.timers.enable({ apis: ['setInterval'] });
    const timer = start([adapter], runOnce);
    try {
      await flush();
      const snap = getJobHealthSnapshot()[JOB_NAMES[name]];
      assert.ok(snap, `${name}: a snapshot is recorded after its first (failed) run`);
      assert.equal(snap.consecutiveFailures, 1, `${name}: the 1st consecutive failure is reflected`);
      assert.equal(snap.alerted, false, `${name}: below threshold, alerted stays false`);
      assert.equal(snap.lastSuccessAt, null, `${name}: never having succeeded, lastSuccessAt stays null`);
    } finally {
      clearInterval(timer!);
    }
  });
}

test("SECURITY: a job's registry entry after a failed run() never contains the caught error message or stack — only the numeric/boolean/timestamp fields", async (t) => {
  resetJobHealthRegistryForTests();
  const sentinel = 'sentinel-secret-path-or-query-fragment-registry-wiring';
  const { adapter } = makeAdapter();
  const runOnce = async () => {
    throw new Error(sentinel);
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDocsIngest([adapter], runOnce);
  try {
    await flush();
    const snap = getJobHealthSnapshot()['docs-ingest']!;
    assert.deepEqual(
      new Set(Object.keys(snap)),
      new Set(['consecutiveFailures', 'alerted', 'lastRunAt', 'lastSuccessAt']),
    );
    assert.ok(
      !JSON.stringify(snap).includes(sentinel),
      'the registry entry must never contain the caught error message',
    );
  } finally {
    clearInterval(timer!);
  }
});

test('each of the ten jobs keeps an independent tracker: one failure each (below threshold) alerts zero times total', async (t) => {
  const { adapter, dms } = makeAdapter();
  const failOnce = async () => {
    throw new Error('sentinel-independent');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timers = [
    startContextBuilder([adapter], failOnce),
    startKnowledgeRefresh([adapter], failOnce),
    startDocsIngest([adapter], failOnce),
    startKnowledgeLinkCheck([adapter], failOnce),
    startRetentionPurge([adapter], failOnce),
    startRosterRetentionPurge([adapter], failOnce),
    startEmbeddingHealthCheckJob([adapter], failOnce),
    startAdminDigest([adapter], failOnce),
    startDepartedAdminAlert([adapter], failOnce),
    startEngagementAlert([adapter], failOnce),
  ];
  try {
    await flush();
    assert.equal(
      dms.length,
      0,
      'ten distinct jobs each failing once (< threshold) never alerts — trackers are independent',
    );
  } finally {
    for (const timer of timers) if (timer) clearInterval(timer);
  }
});

test("startEmbeddingHealthCheckJob: a successful run after a failure streak resets that job's tracker, so a fresh streak of 3 further failures alerts again (not a one-shot latch) — and it has no enable flag, so this exercises unconditionally (issue #376)", async (t) => {
  const { adapter, dms } = makeAdapter();
  let mode: 'fail' | 'succeed' = 'fail';
  const runOnce = async () => {
    if (mode === 'fail') throw new Error('sentinel-rearm-embedding');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startEmbeddingHealthCheckJob([adapter], runOnce);
  try {
    await flush(); // failure 1
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 2
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 3 -> alert
    assert.equal(dms.length, 1, 'first streak of 3 consecutive failures alerts once');

    mode = 'succeed';
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // success -> silently resets the tracker
    assert.equal(dms.length, 1, 'a successful run never itself sends a DM');

    mode = 'fail';
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 1 of the new streak
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 2
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 3 -> alerts again
    assert.equal(dms.length, 2, 'a fresh streak of 3 failures after recovery alerts again');
  } finally {
    clearInterval(timer!);
  }
});

test("startContextBuilder: a successful run after a failure streak resets that job's tracker, so a fresh streak of 3 further failures alerts again (not a one-shot latch)", async (t) => {
  const { adapter, dms } = makeAdapter();
  let mode: 'fail' | 'succeed' = 'fail';
  const runOnce = async () => {
    if (mode === 'fail') throw new Error('sentinel-rearm');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startContextBuilder([adapter], runOnce);
  try {
    await flush(); // failure 1
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 2
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 3 -> alert
    assert.equal(dms.length, 1, 'first streak of 3 consecutive failures alerts once');

    mode = 'succeed';
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // success -> silently resets the tracker
    assert.equal(dms.length, 1, 'a successful run never itself sends a DM');

    mode = 'fail';
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 1 of the new streak
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 2
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 3 -> alerts again
    assert.equal(dms.length, 2, 'a fresh streak of 3 failures after recovery alerts again');
  } finally {
    clearInterval(timer!);
  }
});

test("startAdminDigest: a successful run after a failure streak resets that job's tracker, so a fresh streak of 3 further failures alerts again (not a one-shot latch, issue #385)", async (t) => {
  const { adapter, dms } = makeAdapter();
  let mode: 'fail' | 'succeed' = 'fail';
  const runOnce = async () => {
    if (mode === 'fail') throw new Error('sentinel-rearm-admindigest');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startAdminDigest([adapter], runOnce);
  try {
    await flush(); // failure 1
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 2
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 3 -> alert
    assert.equal(dms.length, 1, 'first streak of 3 consecutive failures alerts once');

    mode = 'succeed';
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // success -> silently resets the tracker
    assert.equal(dms.length, 1, 'a successful run never itself sends a DM');

    mode = 'fail';
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 1 of the new streak
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 2
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 3 -> alerts again
    assert.equal(dms.length, 2, 'a fresh streak of 3 failures after recovery alerts again');
  } finally {
    clearInterval(timer!);
  }
});

for (const [jobName, start, sentinel] of [
  ['interaction-retention-purge', startRetentionPurge, 'sentinel-rearm-interaction'],
  ['roster-retention-purge', startRosterRetentionPurge, 'sentinel-rearm-roster'],
] as const) {
  test(
    `${jobName}: a successful run after a failure streak resets that job's tracker, so a fresh streak of ` +
      `3 further failures alerts again (not a one-shot latch) — including through issue #291's freshness guard`,
    async (t) => {
      const { adapter, dms } = makeAdapter();
      let mode: 'fail' | 'succeed' = 'fail';
      const purge = async (_days: number) => {
        if (mode === 'fail') throw new Error(sentinel);
        return 0;
      };

      // Date must advance in lockstep with the mocked interval here (unlike
      // the always-failing tests elsewhere in this file), because the
      // purge starters' own freshness guard reads Date.now() to decide
      // whether a tick is actually due — same convention as
      // tests/health.test.ts.
      t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
      const timer = start([adapter], purge);
      try {
        await flush(); // failure 1 (fires immediately; nothing has succeeded yet, so the guard never blocks a failing attempt)
        t.mock.timers.tick(SIX_HOURS_MS);
        await flush(); // failure 2
        t.mock.timers.tick(SIX_HOURS_MS);
        await flush(); // failure 3 -> alert
        assert.equal(dms.length, 1, `${jobName}: first streak of 3 consecutive failures alerts once`);

        mode = 'succeed';
        t.mock.timers.tick(SIX_HOURS_MS);
        await flush(); // success -> silently resets the tracker, and arms the freshness guard for ~24h
        assert.equal(dms.length, 1, `${jobName}: a successful run never itself sends a DM`);

        mode = 'fail';
        // The next three 6h ticks still land inside the freshness guard's
        // ~24h window since the success above, so each is a silent no-op —
        // `purge` is never even invoked, let alone allowed to throw (a
        // guarded skip is itself a tracker "success").
        for (let i = 0; i < 3; i++) {
          t.mock.timers.tick(SIX_HOURS_MS);
          await flush();
        }
        assert.equal(
          dms.length,
          1,
          `${jobName}: no alert while ticks stay inside the post-success freshness window`,
        );

        // The next three ticks land past the guard window (now ~24h+ since
        // the last success), so `purge` runs for real again — a fresh
        // streak of 3 consecutive failures that alerts again.
        t.mock.timers.tick(SIX_HOURS_MS);
        await flush(); // failure 1 of the new streak
        t.mock.timers.tick(SIX_HOURS_MS);
        await flush(); // failure 2
        t.mock.timers.tick(SIX_HOURS_MS);
        await flush(); // failure 3 -> alerts again
        assert.equal(
          dms.length,
          2,
          `${jobName}: a fresh streak of 3 failures after recovery (and the freshness window clearing) alerts again`,
        );
      } finally {
        clearInterval(timer!);
      }
    },
  );
}

for (const [jobName, start] of [
  ['interaction-retention-purge', startRetentionPurge],
  ['roster-retention-purge', startRosterRetentionPurge],
] as const) {
  test(
    `${jobName}: a within-a-day tick after a successful run is a no-op — the purge itself stays daily even ` +
      `though startTrackedJob ticks every 6h (issue #291)`,
    async (t) => {
      const { adapter } = makeAdapter();
      let purgeCalls = 0;
      const purge = async (_days: number) => {
        purgeCalls++;
        return 0;
      };

      t.mock.timers.enable({ apis: ['setInterval'] });
      const timer = start([adapter], purge);
      try {
        await flush(); // 1st scheduled run (fires immediately) — nothing has run yet, so it's due
        assert.equal(purgeCalls, 1, `${jobName}: the first run actually calls purge`);
        t.mock.timers.tick(SIX_HOURS_MS);
        await flush();
        t.mock.timers.tick(SIX_HOURS_MS);
        await flush();
        t.mock.timers.tick(SIX_HOURS_MS);
        await flush(); // 3 further 6h ticks (18h of scheduled ticks), but real wall-clock time elapsed is only milliseconds
        assert.equal(
          purgeCalls,
          1,
          `${jobName}: further ticks within the same real day never re-invoke purge — the freshness guard ` +
            `keeps the actual purge daily`,
        );
      } finally {
        clearInterval(timer!);
      }
    },
  );
}

test('DM routing: the alert is delivered via sendDirectMessage + superAdminIds(platform), skipping any adapter whose isConnected() is false', async (t) => {
  const { adapter: connected, dms: connectedDms } = makeAdapter();
  const { adapter: disconnectedBase, dms: disconnectedDms } = makeAdapter();
  const disconnected: PlatformAdapter = { ...disconnectedBase, isConnected: () => false };

  const alwaysFail = async () => {
    throw new Error('sentinel-routing');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDocsIngest([connected, disconnected], alwaysFail);
  try {
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // threshold reached
    assert.equal(connectedDms.length, 1, 'the connected adapter receives the alert DM');
    assert.equal(disconnectedDms.length, 0, 'a disconnected adapter is skipped, never DMed');
  } finally {
    clearInterval(timer!);
  }
});

test('SECURITY: the alert DM body never contains the caught error message or stack — only the fixed template (job name, failure count, last-success timestamp)', async (t) => {
  const sentinel = 'sentinel-secret-path-or-query-fragment-9f3a';
  const { adapter, dms } = makeAdapter();
  const runOnce = async () => {
    throw new Error(sentinel);
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDocsIngest([adapter], runOnce);
  try {
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // threshold reached
    assert.equal(dms.length, 1, 'threshold reached, one alert sent');
    const body = dms[0].text;
    assert.ok(!body.includes(sentinel), 'the DM body must never contain the caught error message');
    assert.match(
      body,
      /^⚠️ Background job 'docs-ingest' has failed 3 consecutive times \(last success: never this run\)\. Check server logs for details\.$/,
    );
  } finally {
    clearInterval(timer!);
  }
});

test('SECURITY: the alert DM body for interaction-retention-purge never contains the caught error message or stack — only the fixed template (job name, failure count, last-success timestamp)', async (t) => {
  const sentinel = 'sentinel-secret-path-or-query-fragment-interaction';
  const { adapter, dms } = makeAdapter();
  const purge = async (_days: number) => {
    throw new Error(sentinel);
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startRetentionPurge([adapter], purge);
  try {
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // threshold reached
    assert.equal(dms.length, 1, 'threshold reached, one alert sent');
    const body = dms[0].text;
    assert.ok(!body.includes(sentinel), 'the DM body must never contain the caught error message');
    assert.match(
      body,
      /^⚠️ Background job 'interaction-retention-purge' has failed 3 consecutive times \(last success: never this run\)\. Check server logs for details\.$/,
    );
  } finally {
    clearInterval(timer!);
  }
});

test('SECURITY: the alert DM body for roster-retention-purge never contains the caught error message or stack — only the fixed template (job name, failure count, last-success timestamp)', async (t) => {
  const sentinel = 'sentinel-secret-path-or-query-fragment-roster';
  const { adapter, dms } = makeAdapter();
  const purge = async (_days: number) => {
    throw new Error(sentinel);
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startRosterRetentionPurge([adapter], purge);
  try {
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // threshold reached
    assert.equal(dms.length, 1, 'threshold reached, one alert sent');
    const body = dms[0].text;
    assert.ok(!body.includes(sentinel), 'the DM body must never contain the caught error message');
    assert.match(
      body,
      /^⚠️ Background job 'roster-retention-purge' has failed 3 consecutive times \(last success: never this run\)\. Check server logs for details\.$/,
    );
  } finally {
    clearInterval(timer!);
  }
});

test('SECURITY: the alert DM body for embedding-model never contains the caught error message or stack — only the fixed template (job name, failure count, last-success timestamp)', async (t) => {
  const sentinel = 'sentinel-secret-path-or-query-fragment-embedding';
  const { adapter, dms } = makeAdapter();
  const runOnce = async () => {
    throw new Error(sentinel);
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startEmbeddingHealthCheckJob([adapter], runOnce);
  try {
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // threshold reached
    assert.equal(dms.length, 1, 'threshold reached, one alert sent');
    const body = dms[0].text;
    assert.ok(!body.includes(sentinel), 'the DM body must never contain the caught error message');
    assert.match(
      body,
      /^⚠️ Background job 'embedding-model' has failed 3 consecutive times \(last success: never this run\)\. Check server logs for details\.$/,
    );
  } finally {
    clearInterval(timer!);
  }
});

test('SECURITY: the alert DM body for admin-digest never contains the caught error message or stack — only the fixed template (job name, failure count, last-success timestamp) (issue #385)', async (t) => {
  const sentinel = 'sentinel-secret-path-or-query-fragment-admindigest';
  const { adapter, dms } = makeAdapter();
  const runOnce = async () => {
    throw new Error(sentinel);
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startAdminDigest([adapter], runOnce);
  try {
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // threshold reached
    assert.equal(dms.length, 1, 'threshold reached, one alert sent');
    const body = dms[0].text;
    assert.ok(!body.includes(sentinel), 'the DM body must never contain the caught error message');
    assert.match(
      body,
      /^⚠️ Background job 'admin-digest' has failed 3 consecutive times \(last success: never this run\)\. Check server logs for details\.$/,
    );
  } finally {
    clearInterval(timer!);
  }
});

test("startDepartedAdminAlert: a successful run after a failure streak resets that job's tracker, so a fresh streak of 3 further failures alerts again (not a one-shot latch, issue #472)", async (t) => {
  const { adapter, dms } = makeAdapter();
  let mode: 'fail' | 'succeed' = 'fail';
  const runOnce = async () => {
    if (mode === 'fail') throw new Error('sentinel-rearm-departedadmin');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDepartedAdminAlert([adapter], runOnce);
  try {
    await flush(); // failure 1
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 2
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 3 -> alert
    assert.equal(dms.length, 1, 'first streak of 3 consecutive failures alerts once');

    mode = 'succeed';
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // success -> silently resets the tracker
    assert.equal(dms.length, 1, 'a successful run never itself sends a DM');

    mode = 'fail';
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 1 of the new streak
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 2
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 3 -> alerts again
    assert.equal(dms.length, 2, 'a fresh streak of 3 failures after recovery alerts again');
  } finally {
    clearInterval(timer!);
  }
});

test('SECURITY: the alert DM body for departed-admin-alert never contains the caught error message or stack — only the fixed template (job name, failure count, last-success timestamp) (issue #472)', async (t) => {
  const sentinel = 'sentinel-secret-path-or-query-fragment-departedadmin';
  const { adapter, dms } = makeAdapter();
  const runOnce = async () => {
    throw new Error(sentinel);
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDepartedAdminAlert([adapter], runOnce);
  try {
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // threshold reached
    assert.equal(dms.length, 1, 'threshold reached, one alert sent');
    const body = dms[0].text;
    assert.ok(!body.includes(sentinel), 'the DM body must never contain the caught error message');
    assert.match(
      body,
      /^⚠️ Background job 'departed-admin-alert' has failed 3 consecutive times \(last success: never this run\)\. Check server logs for details\.$/,
    );
  } finally {
    clearInterval(timer!);
  }
});

test("startEngagementAlert: a successful run after a failure streak resets that job's tracker, so a fresh streak of 3 further failures alerts again (not a one-shot latch, issue #568)", async (t) => {
  const { adapter, dms } = makeAdapter();
  let mode: 'fail' | 'succeed' = 'fail';
  const runOnce = async () => {
    if (mode === 'fail') throw new Error('sentinel-rearm-engagement');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startEngagementAlert([adapter], runOnce);
  try {
    await flush(); // failure 1
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 2
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 3 -> alert
    assert.equal(dms.length, 1, 'first streak of 3 consecutive failures alerts once');

    mode = 'succeed';
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // success -> silently resets the tracker
    assert.equal(dms.length, 1, 'a successful run never itself sends a DM');

    mode = 'fail';
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 1 of the new streak
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 2
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 3 -> alerts again
    assert.equal(dms.length, 2, 'a fresh streak of 3 failures after recovery alerts again');
  } finally {
    clearInterval(timer!);
  }
});

test('SECURITY: the alert DM body for engagement-alert never contains the caught error message or stack — only the fixed template (job name, failure count, last-success timestamp) (issue #568)', async (t) => {
  const sentinel = 'sentinel-secret-path-or-query-fragment-engagement';
  const { adapter, dms } = makeAdapter();
  const runOnce = async () => {
    throw new Error(sentinel);
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startEngagementAlert([adapter], runOnce);
  try {
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // threshold reached
    assert.equal(dms.length, 1, 'threshold reached, one alert sent');
    const body = dms[0].text;
    assert.ok(!body.includes(sentinel), 'the DM body must never contain the caught error message');
    assert.match(
      body,
      /^⚠️ Background job 'engagement-alert' has failed 3 consecutive times \(last success: never this run\)\. Check server logs for details\.$/,
    );
  } finally {
    clearInterval(timer!);
  }
});

// --- issue #335: docsIngest/knowledgeRefresh/contextBuilder now actually
// signal TOTAL failure to startTrackedJob (previously these three run
// functions never threw, no matter how badly they failed, so #263's
// consecutive-failure alert could never fire for them). The tests below call
// the REAL defaultXRun wrappers — not a directly-throwing mock runOnce — so
// they exercise the freshness guard, the run function, and the new
// total-vs-partial-failure signal together. They need a real DB (the
// freshness guards read a real timestamp), and mock Date to FAR_FUTURE_MS so
// a concurrently-running test file's own writes to these DB-wide (unscoped)
// tables can never make the guard skip a run this test expects to happen.

test(
  'defaultDocsIngestRun throws when the llms.txt index itself fails to fetch on every attempt (real total failure, injected fetchText)',
  { skip },
  async (t) => {
    const alwaysFailingFetch = async (_url: string): Promise<string> => {
      throw new Error('network down');
    };
    t.mock.timers.enable({ apis: ['Date'], now: FAR_FUTURE_MS() });
    await assert.rejects(() => defaultDocsIngestRun(alwaysFailingFetch));
  },
);

test(
  'defaultDocsIngestRun does NOT throw on a reachable index that parses to zero page URLs — a legitimate no-op run',
  { skip },
  async (t) => {
    const emptyIndex = async (_url: string): Promise<string> => '# Index\n\nno links here';
    t.mock.timers.enable({ apis: ['Date'], now: FAR_FUTURE_MS() });
    await assert.doesNotReject(() => defaultDocsIngestRun(emptyIndex));
  },
);

test(
  'defaultDocsIngestRun throws when the index itself is reachable but EVERY page fetch fails — the index fetch succeeding says nothing about page reachability (issue #335 follow-up)',
  { skip },
  async (t) => {
    const pageUrl = `${config.docsIngest.indexUrl.replace(/\/[^/]*$/, '')}/docs/en/api/messages.md`;
    const indexOkAllPagesFail = async (url: string): Promise<string> => {
      if (url === config.docsIngest.indexUrl) return `- [messages](${pageUrl})`;
      throw new Error('docs host blocked the request');
    };
    t.mock.timers.enable({ apis: ['Date'], now: FAR_FUTURE_MS() });
    await assert.rejects(() => defaultDocsIngestRun(indexOkAllPagesFail));
  },
);

test(
  'defaultKnowledgeLinkCheckRun does NOT throw on a legitimate zero-attempted-failure run (real freshness guard + real sweep, injected fetch/lookup that never fails)',
  { skip },
  async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: FAR_FUTURE_MS() });
    const alwaysOk = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: (async () => ({
        status: 200,
        headers: { get: () => null },
        body: null,
      })) as unknown as typeof fetch,
    };
    await assert.doesNotReject(() => defaultKnowledgeLinkCheckRun(alwaysOk));
  },
);

test(
  'defaultKnowledgeRefreshRun throws when every fixed topic errors on every attempt (real total failure, injected research)',
  { skip },
  async (t) => {
    const alwaysThrows = async (_q: string): Promise<string | null> => {
      throw new Error('web search unavailable');
    };
    t.mock.timers.enable({ apis: ['Date'], now: FAR_FUTURE_MS() });
    await assert.rejects(() => defaultKnowledgeRefreshRun(alwaysThrows));
  },
);

test(
  'SECURITY: defaultKnowledgeRefreshRun does NOT throw on a partial failure (1 of 2 fixed topics erroring) — pinning that per-item resilience can never regress into an alert-on-every-blip, since startTrackedJob only ever alerts on a THROW',
  { skip },
  async (t) => {
    const partialFail = async (topicQuery: string): Promise<string | null> => {
      if (topicQuery === REFRESH_TOPICS[0].query) throw new Error('transient failure for topic 1');
      return 'Briefing bullet for topic 2.';
    };
    t.mock.timers.enable({ apis: ['Date'], now: FAR_FUTURE_MS() });
    try {
      await assert.doesNotReject(() => defaultKnowledgeRefreshRun(partialFail));
    } finally {
      await pool.query(`DELETE FROM knowledge WHERE title = ANY($1)`, [[...REFRESH_TITLES]]);
    }
  },
);

/** Seed one eligible cluster (>= config default minDistinctUsers=3) on a private axis for the context-builder tests below. */
async function seedEligibleCluster(run: string, axis: number): Promise<void> {
  const vec = new Array(config.db.embeddingDim).fill(0);
  vec[axis] = 1;
  for (let i = 0; i < 3; i++) {
    await pool.query(
      `INSERT INTO interactions (platform, conversation_id, user_id, role, direction, content, embedding)
       VALUES ('discord', $1, $2, 'member', 'inbound', $3, $4)`,
      [`${run}-chan`, `${run}-u${i}`, `${run} recurring question ${i}`, pgvector.toSql(vec)],
    );
  }
}

test(
  'defaultContextBuilderRun throws when every attempted cluster fails to summarise (real total failure, injected summarize)',
  { skip },
  async (t) => {
    const run = `bgjobs335ctx${Date.now()}`;
    await seedEligibleCluster(run, 40);
    t.mock.timers.enable({ apis: ['Date'], now: FAR_FUTURE_MS() });
    try {
      await assert.rejects(() =>
        defaultContextBuilderRun(async () => {
          throw new Error('model unavailable');
        }),
      );
    } finally {
      await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [`${run}-chan`]);
    }
  },
);

test(
  'startDocsIngest (via startTrackedJob): sends exactly one super-admin DM after 3 consecutive SCHEDULED ticks of a REAL total-failure result routed through defaultDocsIngestRun — not a directly-throwing mock runOnce',
  { skip },
  async (t) => {
    const { adapter, dms } = makeAdapter();
    const alwaysFailingFetch = async (_url: string): Promise<string> => {
      throw new Error('network down');
    };

    // Unlike the directly-mocked-runOnce tests elsewhere in this file,
    // defaultDocsIngestRun's freshness guard makes a REAL DB round-trip
    // (latestDocsIngestAt) before failing — a single setImmediate (flush())
    // isn't enough turns of the event loop for real socket I/O to settle, so
    // this test gives each tick a short real wall-clock wait instead.
    const flushDb = () => new Promise((resolve) => setTimeout(resolve, 100));

    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: FAR_FUTURE_MS() });
    const timer = startDocsIngest([adapter], () => defaultDocsIngestRun(alwaysFailingFetch));
    try {
      await flushDb(); // 1st scheduled run (fires immediately) fails for real
      assert.equal(dms.length, 0, 'no DM after the 1st consecutive failure');
      t.mock.timers.tick(SIX_HOURS_MS);
      await flushDb(); // 2nd
      assert.equal(dms.length, 0, 'no DM after the 2nd consecutive failure');
      t.mock.timers.tick(SIX_HOURS_MS);
      await flushDb(); // 3rd — threshold reached
      assert.equal(dms.length, 1, 'exactly one DM on the 3rd consecutive failure');
      const body = dms[0].text;
      assert.ok(!body.includes('network down'), 'the DM body must never contain the underlying fetch error');
    } finally {
      clearInterval(timer!);
    }
  },
);
