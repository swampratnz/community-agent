import { logger } from '../logger.js';
import {
  buildJobFailureAlert,
  initialJobFailureTracker,
  recordJobRun,
  stepJobFailureTracker,
  type BackgroundJobName,
  type JobFailureTracker,
} from '../backgroundJobHealth.js';
import { alertSuperAdmins as sendSuperAdminAlert } from '../notifications.js';
import type { PlatformAdapter } from '../platforms/types.js';

const TICK_INTERVAL_MS = 6 * 3_600_000;

/**
 * Three consecutive failed *scheduled* runs before the first alert — given
 * each job's own freshness guard, that's roughly 3 days of brokenness for
 * the daily jobs before an operator is DMed. No env var: alerting is
 * automatic whenever the corresponding job's own enable flag is already on
 * (issue #263). Exported (issue #426) so `usageAlert.ts` can reuse the same
 * threshold for its own inlined tracker instead of redefining it.
 */
export const BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD = 3;

/**
 * Wires a job's tracker + threshold-alert plumbing around an injectable
 * `runOnce`, closing a `JobFailureTracker` and `lastSuccessAt` over the
 * timer (same pattern `usageAlert.ts` uses for its own closed-over
 * `tracker` variable). `runOnce` resolving (including a no-op "not due
 * yet" skip) counts as success and silently resets the tracker; throwing
 * counts as a failure and steps it, DMing super admins via the same
 * `notifications.ts` fan-out `usageAlert.ts`/`health.ts` already use once
 * the threshold is reached.
 *
 * Exported (issue #291) so the retention purges (src/retention.ts) can wire
 * through the same tracker/alert plumbing from their own file, instead of
 * duplicating it.
 */
export function startTrackedJob(
  jobName: BackgroundJobName,
  adapters: readonly PlatformAdapter[],
  enabled: boolean,
  runOnce: () => Promise<void>,
): ReturnType<typeof setInterval> | null {
  if (!enabled) return null;

  let tracker: JobFailureTracker = initialJobFailureTracker();
  let lastSuccessAt: number | null = null;
  // Re-entrancy latch: a run that outlives its tick (a docs-ingest sweep can
  // approach the 6h interval) must not overlap the next one — overlapping
  // passes duplicate work and race each other's writes. This is the same
  // guard the dev-team watch poller carries (audit M6); hoisting it here
  // covers every tracked job at once.
  let inFlight = false;

  const run = async () => {
    if (inFlight) {
      logger.warn({ job: jobName }, 'Background job tick skipped — previous run still in flight');
      return;
    }
    inFlight = true;
    try {
      await runOnce();
      lastSuccessAt = Date.now();
      tracker = stepJobFailureTracker(tracker, false, BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD).tracker;
      recordJobRun(jobName, tracker, Date.now(), lastSuccessAt);
    } catch (err) {
      logger.error({ err, job: jobName }, 'Background job run failed');
      const step = stepJobFailureTracker(tracker, true, BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD);
      tracker = step.tracker;
      recordJobRun(jobName, tracker, Date.now(), lastSuccessAt);
      if (step.shouldAlert) {
        void alertSuperAdmins(
          adapters,
          buildJobFailureAlert(jobName, tracker.consecutiveFailures, lastSuccessAt),
        );
      }
    } finally {
      inFlight = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), TICK_INTERVAL_MS);
  timer.unref();
  return timer;
}

// If every adapter is disconnected, the failure-threshold DM is queued
// (shared with health.ts/tools.ts — see src/pendingAlertQueue.ts) instead of
// silently dropped, and flushed through the first adapter to reconnect via
// health.ts's existing flushPendingAlerts (issue #545).
export async function alertSuperAdmins(adapters: readonly PlatformAdapter[], message: string): Promise<void> {
  await sendSuperAdminAlert(adapters, message, {
    label: 'Background job failure alert',
    queueWhenDisconnected: true,
  });
}
