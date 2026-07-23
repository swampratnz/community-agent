import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. BACKGROUND_JOB_COST_ALERT_ENABLED
// is deliberately left unset so any use of startBackgroundJobCostAlert() here
// exercises the disabled-by-default path (the enabled path's consecutive-
// failure/rearm behaviour is covered by tests/backgroundJobs.test.ts and
// tests/backgroundJobsDisabled.test.ts, which pin the flag per-process like
// every other opt-in job) — this file focuses on the pure tracker, the pure
// formatter, the injectable windowed runOnce, and the DB-backed spike/debounce/
// rearm integration, skipped cleanly when DATABASE_URL is unset (per
// CLAUDE.md). BACKGROUND_JOB_COST_ALERT_MULTIPLIER/_MIN_USD are left unset so
// the defaults (3 / 1) apply, matching the integration test's fixture values.
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

const {
  initialBackgroundJobCostAlertTracker,
  stepBackgroundJobCostAlertTracker,
  formatBackgroundJobCostAlertMessage,
  makeDefaultBackgroundJobCostAlertRun,
  startBackgroundJobCostAlert,
} = await import('../src/backgroundJobCostAlert.js');
const { pool, closeDb } = await import('../src/storage/db.js');
const { sumBackgroundJobCosts } = await import('../src/storage/repository.js');
const { config } = await import('../src/config.js');
type BackgroundJob = 'moderation_llm' | 'context_builder' | 'knowledge_refresh';

after(async () => {
  await closeDb();
});

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
// technique as tests/usageCostDigest.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// --- Config defaults (issue #610 acceptance criterion 1) --------------------

test('config: BACKGROUND_JOB_COST_ALERT_ENABLED defaults false, MULTIPLIER defaults 3, MIN_USD defaults 1', () => {
  assert.equal(config.backgroundJobCostAlert.enabled, false);
  assert.equal(config.backgroundJobCostAlert.multiplier, 3);
  assert.equal(config.backgroundJobCostAlert.minUsd, 1);
});

// --- stepBackgroundJobCostAlertTracker (pure, no DB/timer) -------------------

test('stepBackgroundJobCostAlertTracker: below both the floor and the multiplier threshold never alerts', () => {
  const step = stepBackgroundJobCostAlertTracker(initialBackgroundJobCostAlertTracker(), 0.5, 0.1, 3, 1);
  assert.equal(step.shouldAlert, false);
  assert.equal(step.tracker.crossed, false);
});

test('stepBackgroundJobCostAlertTracker: above the multiplier threshold but below the absolute floor never alerts', () => {
  // baselineAvg=0.1, multiplier=3 -> threshold 0.3; todayCost=0.5 clears that but not the $1 floor.
  const step = stepBackgroundJobCostAlertTracker(initialBackgroundJobCostAlertTracker(), 0.5, 0.1, 3, 1);
  assert.equal(step.shouldAlert, false);
});

test('stepBackgroundJobCostAlertTracker: above the absolute floor but below the multiplier threshold never alerts', () => {
  // baselineAvg=1, multiplier=3 -> threshold 3; todayCost=2 clears the $1 floor but not 3x baseline.
  const step = stepBackgroundJobCostAlertTracker(initialBackgroundJobCostAlertTracker(), 2, 1, 3, 1);
  assert.equal(step.shouldAlert, false);
});

test('stepBackgroundJobCostAlertTracker: exactly at the floor (todayCost === minUsd) does not alert — strictly greater-than required', () => {
  const step = stepBackgroundJobCostAlertTracker(initialBackgroundJobCostAlertTracker(), 1, 0, 3, 1);
  assert.equal(step.shouldAlert, false, 'todayCost equal to minUsd is not "over"');
});

test('stepBackgroundJobCostAlertTracker: exactly at multiplier * baselineAvg does not alert — strictly greater-than required', () => {
  // baselineAvg=1, multiplier=3 -> threshold exactly 3; todayCost=3 must not alert.
  const step = stepBackgroundJobCostAlertTracker(initialBackgroundJobCostAlertTracker(), 3, 1, 3, 1);
  assert.equal(step.shouldAlert, false, 'todayCost equal to multiplier*baselineAvg is not "over"');
});

test('stepBackgroundJobCostAlertTracker: baselineAvg === 0 does not alert unless the absolute floor is also cleared', () => {
  const underFloor = stepBackgroundJobCostAlertTracker(initialBackgroundJobCostAlertTracker(), 1, 0, 3, 1);
  assert.equal(
    underFloor.shouldAlert,
    false,
    'todayCost === minUsd, still not over even with a zero baseline',
  );

  const overFloor = stepBackgroundJobCostAlertTracker(initialBackgroundJobCostAlertTracker(), 1.01, 0, 3, 1);
  assert.equal(
    overFloor.shouldAlert,
    true,
    'a zero baseline makes the multiplier condition trivially true — the floor is what still gates it',
  );
});

test('stepBackgroundJobCostAlertTracker: both conditions true fires exactly once, not on every subsequent tick while still over', () => {
  let tracker = initialBackgroundJobCostAlertTracker();
  const first = stepBackgroundJobCostAlertTracker(tracker, 10, 1, 3, 1);
  assert.equal(first.shouldAlert, true, 'first crossing alerts');
  assert.equal(first.tracker.crossed, true);
  tracker = first.tracker;

  const second = stepBackgroundJobCostAlertTracker(tracker, 12, 1, 3, 1);
  assert.equal(second.shouldAlert, false, 'still over — no repeat alert');
  tracker = second.tracker;

  const third = stepBackgroundJobCostAlertTracker(tracker, 0.5, 1, 3, 1);
  assert.equal(third.shouldAlert, false, 'dropping back under never alerts');
  assert.equal(third.tracker.crossed, false, 'silently re-arms once back under');
  tracker = third.tracker;

  const fourth = stepBackgroundJobCostAlertTracker(tracker, 10, 1, 3, 1);
  assert.equal(fourth.shouldAlert, true, 'a fresh crossing after re-arming alerts again');
});

// --- formatBackgroundJobCostAlertMessage (pure, byte-tested) ----------------

test('formatBackgroundJobCostAlertMessage: exact template with job name and two toFixed(2) dollar figures', () => {
  assert.equal(
    formatBackgroundJobCostAlertMessage('moderation_llm', 12.5, 2.333),
    "⚠️ Background job cost spike: 'moderation_llm' cost ~$12.50 in the last 24h — " +
      'well above its trailing 7-day daily average of ~$2.33. ' +
      'Check usage_stats / server logs for details.',
  );
});

test('formatBackgroundJobCostAlertMessage: names each of the three tracked jobs exactly', () => {
  for (const job of ['moderation_llm', 'context_builder', 'knowledge_refresh'] as const) {
    const message = formatBackgroundJobCostAlertMessage(job, 5, 1);
    assert.match(message, new RegExp(`^⚠️ Background job cost spike: '${job}'`));
  }
});

test('SECURITY: formatBackgroundJobCostAlertMessage is a fixed template carrying only the job-name enum and two dollar figures — never a user id, conversation id, display name, or raw error text', () => {
  const cases: Array<[BackgroundJob, number, number]> = [
    ['moderation_llm', 0, 0],
    ['context_builder', 12.345, 2.001],
    ['knowledge_refresh', 999.999, 0.001],
  ];
  const pattern =
    /^⚠️ Background job cost spike: '(moderation_llm|context_builder|knowledge_refresh)' cost ~\$\d+\.\d{2} in the last 24h — well above its trailing 7-day daily average of ~\$\d+\.\d{2}\. Check usage_stats \/ server logs for details\.$/;
  for (const [job, todayCost, baselineAvg] of cases) {
    const message = formatBackgroundJobCostAlertMessage(job, todayCost, baselineAvg);
    assert.match(message, pattern);
    assert.doesNotMatch(message, /\buser[-_]?id\b|\bconversation[-_]?id\b|discord|whatsapp|@\w+/i);
  }
});

// --- makeDefaultBackgroundJobCostAlertRun (injected deps, no real DB) -------

test('makeDefaultBackgroundJobCostAlertRun: makes exactly the two pinned calls — days=1 for today, days=7 for the baseline — no other window', async () => {
  const { adapter } = makeAdapter();
  const calledWithDays: number[] = [];
  const runOnce = makeDefaultBackgroundJobCostAlertRun([adapter], {
    sumCosts: async (days) => {
      calledWithDays.push(days);
      return { total: 0, byJob: [] };
    },
  });

  await runOnce();

  assert.deepEqual(calledWithDays.sort(), [1, 7], 'exactly two calls, for days=1 and days=7');
});

test('makeDefaultBackgroundJobCostAlertRun: a job absent from a window is treated as 0, not skipped', async () => {
  const { adapter, dms } = makeAdapter();
  const runOnce = makeDefaultBackgroundJobCostAlertRun([adapter], {
    sumCosts: async (days) => {
      if (days === 1) return { total: 0, byJob: [] }; // moderation_llm absent -> today cost 0
      return { total: 21, byJob: [{ job: 'moderation_llm', costUsd: 21 }] }; // baselineAvg = 3
    },
  });

  await runOnce();
  await flush();

  assert.equal(dms.length, 0, 'a job with 0 today-cost never alerts, regardless of baseline');
});

test('makeDefaultBackgroundJobCostAlertRun: a job whose spike clears both conditions sends exactly one DM naming it', async () => {
  const { adapter, dms } = makeAdapter();
  const runOnce = makeDefaultBackgroundJobCostAlertRun([adapter], {
    sumCosts: async (days) => {
      if (days === 1) return { total: 10, byJob: [{ job: 'context_builder', costUsd: 10 }] };
      return { total: 7, byJob: [{ job: 'context_builder', costUsd: 7 }] }; // baselineAvg = 1
    },
  });

  await runOnce();
  await flush();

  assert.equal(dms.length, 1);
  assert.match(dms[0].text, /'context_builder'/);
  assert.equal(dms[0].userId, 'super-1');
});

test('makeDefaultBackgroundJobCostAlertRun: each tracked job keeps an independent tracker across ticks within the same runOnce instance', async () => {
  const { adapter, dms } = makeAdapter();
  let spike = true;
  const runOnce = makeDefaultBackgroundJobCostAlertRun([adapter], {
    sumCosts: async (days) => {
      if (!spike) return { total: 0, byJob: [] };
      if (days === 1) {
        return {
          total: 20,
          byJob: [
            { job: 'moderation_llm', costUsd: 10 },
            { job: 'knowledge_refresh', costUsd: 10 },
          ],
        };
      }
      return {
        total: 14,
        byJob: [
          { job: 'moderation_llm', costUsd: 7 },
          { job: 'knowledge_refresh', costUsd: 7 },
        ],
      };
    },
  });

  await runOnce();
  await flush();
  assert.equal(dms.length, 2, 'both spiking jobs alert on the first crossing tick');

  await runOnce();
  await flush();
  assert.equal(dms.length, 2, 'no repeat alert on a second tick while still over, for either job');

  spike = false;
  await runOnce();
  await flush();
  assert.equal(dms.length, 2, 'dropping back under sends no alert and re-arms both latches');
});

test('startBackgroundJobCostAlert: BACKGROUND_JOB_COST_ALERT_ENABLED unset (default) creates no timer', () => {
  const timer = startBackgroundJobCostAlert([]);
  assert.equal(timer, null, 'disabled by default — no timer, no extra queries');
});

// --- Repository integration (DB-backed spike/debounce/rearm) ---------------

test(
  'integration: a job whose trailing-24h cost is > multiplier x its trailing-7-day daily average and above the floor alerts exactly once, does not re-alert on a second tick while still over, and re-arms once the cost drops back under (issue #610)',
  { skip },
  async () => {
    await pool.query(`DELETE FROM background_job_costs WHERE job = 'moderation_llm'`);

    // Baseline: one row 6 days ago. Today: one row now, well above both the
    // $1 floor and 3x the (dilution-inclusive) trailing-7-day daily average.
    await pool.query(
      `INSERT INTO background_job_costs (job, cost_usd, created_at) VALUES ('moderation_llm', 0.7, now() - interval '6 days')`,
    );
    const insertToday = () =>
      pool.query(
        `INSERT INTO background_job_costs (job, cost_usd, created_at) VALUES ('moderation_llm', 2.5, now())`,
      );
    await insertToday();

    const { adapter, dms } = makeAdapter();
    const runOnce = makeDefaultBackgroundJobCostAlertRun([adapter], { sumCosts: sumBackgroundJobCosts });

    await runOnce();
    await flush();
    assert.equal(dms.length, 1, 'first tick over threshold alerts exactly once');
    assert.match(dms[0].text, /'moderation_llm'/);

    await runOnce();
    await flush();
    assert.equal(dms.length, 1, 'second consecutive tick under the same condition does not re-alert');

    await pool.query(`DELETE FROM background_job_costs WHERE job = 'moderation_llm' AND cost_usd = 2.5`);
    await runOnce();
    await flush();
    assert.equal(dms.length, 1, 'a tick after the cost drops back under does not alert');

    await insertToday();
    await runOnce();
    await flush();
    assert.equal(dms.length, 2, 'the latch re-armed — a fresh crossing alerts again');

    await pool.query(`DELETE FROM background_job_costs WHERE job = 'moderation_llm'`);
  },
);
