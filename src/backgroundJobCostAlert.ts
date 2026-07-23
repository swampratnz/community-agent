import { config } from './config.js';
import { logger } from './logger.js';
import { superAdminIds } from './auth/roles.js';
import { startTrackedJob } from './backgroundJobs.js';
import { sumBackgroundJobCosts, type BackgroundJob } from './storage/repository.js';
import type { PlatformAdapter } from './platforms/types.js';

/** The three background jobs that write `background_job_costs` rows (issue #401) — a fixed enum, never derived from anything dynamic. */
const TRACKED_JOBS: readonly BackgroundJob[] = ['moderation_llm', 'context_builder', 'knowledge_refresh'];

export interface BackgroundJobCostAlertTracker {
  crossed: boolean;
}

export function initialBackgroundJobCostAlertTracker(): BackgroundJobCostAlertTracker {
  return { crossed: false };
}

/**
 * Pure per-job rolling-window latch (issue #610), same shape as
 * `usageAlert.ts`'s `stepUsageAlertTracker` but with the two-part trigger the
 * proposal specifies: a job alerts only when its trailing-24h cost is BOTH
 * above the absolute floor (`minUsd`, stops a cold-start job with a near-zero
 * baseline from paging on noise) AND above `multiplier` times its trailing
 * 7-day daily average. An alert fires once when both conditions first hold;
 * the latch only re-arms once a later tick sees the cost drop back under
 * either condition — so oscillating just above the threshold across ticks
 * yields exactly one alert, not one per tick.
 */
export function stepBackgroundJobCostAlertTracker(
  tracker: BackgroundJobCostAlertTracker,
  todayCost: number,
  baselineAvg: number,
  multiplier: number,
  minUsd: number,
): { tracker: BackgroundJobCostAlertTracker; shouldAlert: boolean } {
  const over = todayCost > minUsd && todayCost > multiplier * baselineAvg;
  if (!over) {
    return { tracker: { crossed: false }, shouldAlert: false };
  }
  return { tracker: { crossed: true }, shouldAlert: !tracker.crossed };
}

/**
 * Pure DM text builder — directly testable without a DB or timer, same
 * convention as `formatUsageAlertMessage`/`formatUsageCostDigestMessage`. The
 * only dynamic content is the fixed job-name enum plus two `toFixed(2)`
 * dollar figures — never a user id, conversation id, or message excerpt, and
 * never the underlying error text (a throwing `sumBackgroundJobCosts` never
 * reaches this function — see `startBackgroundJobCostAlert`'s failure path).
 */
export function formatBackgroundJobCostAlertMessage(
  job: BackgroundJob,
  todayCost: number,
  baselineAvg: number,
): string {
  return (
    `⚠️ Background job cost spike: '${job}' cost ~$${todayCost.toFixed(2)} in the last 24h — ` +
    `well above its trailing 7-day daily average of ~$${baselineAvg.toFixed(2)}. ` +
    'Check usage_stats / server logs for details.'
  );
}

/**
 * Builds the default `runOnce`, closing a per-job tracker map over the tick
 * (same "closure holds mutable state across ticks" shape `usageAlert.ts`'s
 * `startUsageAlert` uses for its single tracker, just keyed per job here).
 * Every dependency is injectable (tests only); production always uses the
 * already-exported repository default. Deliberately makes only the two calls
 * the proposal pins — `sumCosts(1)` for today's trailing-24h cost and
 * `sumCosts(7)` for the trailing 7-day baseline — no new SQL, schema, or
 * migration. A job absent from either window (no cost recorded) is treated
 * as 0, not skipped.
 */
export function makeDefaultBackgroundJobCostAlertRun(
  adapters: readonly PlatformAdapter[],
  deps: {
    sumCosts?: (days: number) => Promise<{ total: number; byJob: Array<{ job: string; costUsd: number }> }>;
  } = {},
): () => Promise<void> {
  const sumCosts = deps.sumCosts ?? sumBackgroundJobCosts;
  const trackers = new Map<BackgroundJob, BackgroundJobCostAlertTracker>();

  return async () => {
    const multiplier = config.backgroundJobCostAlert.multiplier;
    const minUsd = config.backgroundJobCostAlert.minUsd;
    const [today, baseline] = await Promise.all([sumCosts(1), sumCosts(7)]);

    for (const job of TRACKED_JOBS) {
      const todayCost = today.byJob.find((r) => r.job === job)?.costUsd ?? 0;
      const baselineTotal = baseline.byJob.find((r) => r.job === job)?.costUsd ?? 0;
      const baselineAvg = baselineTotal / 7;

      const tracker = trackers.get(job) ?? initialBackgroundJobCostAlertTracker();
      const step = stepBackgroundJobCostAlertTracker(tracker, todayCost, baselineAvg, multiplier, minUsd);
      trackers.set(job, step.tracker);

      if (step.shouldAlert) {
        logger.warn({ job, todayCost, baselineAvg, multiplier, minUsd }, 'Background job cost spike alert');
        void alertSuperAdmins(adapters, formatBackgroundJobCostAlertMessage(job, todayCost, baselineAvg));
      }
    }
  };
}

/**
 * Proactive super-admin DM when a background job's trailing-24h cost spikes
 * far above its own trailing baseline (issue #610) — the one aggregate in
 * `usage_stats`' fully-instrumented cost area with zero proactive push (its
 * `backgroundCostByJob` breakdown is pull-only). Off unless
 * `BACKGROUND_JOB_COST_ALERT_ENABLED`, consistent with this repo's convention
 * for new proactive DMs.
 *
 * Routed through the shared `startTrackedJob` (same 6h outer tick as every
 * other opt-in job) rather than a bespoke timer — a throwing `runOnce` (e.g.
 * a DB error from `sumBackgroundJobCosts`) gets the existing consecutive-
 * failure alerting for free, via `buildJobFailureAlert`'s fixed, non-leaking
 * template — this module never catches the error itself, so a raw error
 * string can never reach a DM.
 */
export function startBackgroundJobCostAlert(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultBackgroundJobCostAlertRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob(
    'background-job-cost-alert',
    adapters,
    config.backgroundJobCostAlert.enabled,
    runOnce,
  );
}

async function alertSuperAdmins(adapters: readonly PlatformAdapter[], message: string): Promise<void> {
  for (const adapter of adapters) {
    if (!adapter.isConnected()) continue; // can't send through a dead connection
    for (const id of superAdminIds(adapter.platform)) {
      adapter
        .sendDirectMessage(id, message)
        .catch((err) => logger.warn({ err, platform: adapter.platform, id }, 'Cost-spike alert DM failed'));
    }
  }
}
