import { config } from './config.js';
import { logger } from './logger.js';
import { superAdminIds } from './auth/roles.js';
import { usageStats } from './storage/repository.js';
import { BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD } from './backgroundJobs.js';
import {
  buildJobFailureAlert,
  initialJobFailureTracker,
  recordJobRun,
  stepJobFailureTracker,
  type JobFailureTracker,
} from './backgroundJobHealth.js';
import type { PlatformAdapter } from './platforms/types.js';

type UsageAlertStats = Awaited<ReturnType<typeof usageStats>>;

const CHECK_INTERVAL_MS = 60 * 60_000; // hourly — cheap read query, no need for health.ts's 30s cadence

export interface UsageAlertTracker {
  crossed: boolean;
}

export function initialUsageAlertTracker(): UsageAlertTracker {
  return { crossed: false };
}

/**
 * Pure rolling-window latch: `outbound` (replies in the last 24h) is a
 * coarse proxy for shared Max-pool draw, not a precise token count — short
 * vs long replies draw differently, so operators should tune the threshold
 * to their own traffic. An alert fires once when outbound first reaches the
 * threshold, and the latch only re-arms once a later check sees outbound
 * drop back under — so oscillating just above the threshold across ticks
 * yields exactly one alert, not one per tick.
 */
export function stepUsageAlertTracker(
  tracker: UsageAlertTracker,
  outbound: number,
  threshold: number,
): { tracker: UsageAlertTracker; shouldAlert: boolean } {
  if (outbound < threshold) {
    return { tracker: { crossed: false }, shouldAlert: false };
  }
  return { tracker: { crossed: true }, shouldAlert: !tracker.crossed };
}

/**
 * Pure DM text builder (issue #401) so the message content — in particular
 * the added `backgroundCostUsd` clause — is directly testable without
 * standing up a full adapter/timer harness. The `~$X.XX recorded` figure
 * keeps its existing, documented meaning (conversational-reply cost only);
 * background-job cost is a distinct clause, never summed into it, so a
 * deployment with all three background features off produces a
 * byte-identical message to before this issue.
 */
export function formatUsageAlertMessage(stats: UsageAlertStats, threshold: number): string {
  return (
    `⚠️ Usage alert: ${stats.outbound} replies in the last 24h (threshold ${threshold}).` +
    (stats.costUsd > 0 ? ` ~$${stats.costUsd.toFixed(2)} recorded.` : '') +
    (stats.backgroundCostUsd > 0
      ? ` ~$${stats.backgroundCostUsd.toFixed(2)} background jobs (moderation/digest/refresh).`
      : '') +
    ' Reply count is a coarse proxy for shared Max-pool draw, not an exact reading — consider pause_bot if this is unexpected.'
  );
}

/**
 * Hourly check of usageStats(1) (rolling 24h) against USAGE_ALERT_DAILY_REPLIES.
 * Disabled (no timer created) unless the threshold is configured. On trip,
 * DMs super admins via the same sendDirectMessage path health.ts's
 * disconnect alert already uses — no new privileged tool, no new send
 * cadence, no message content or per-user detail beyond the aggregate
 * usage_stats already exposes.
 */
export function startUsageAlert(adapters: readonly PlatformAdapter[]): ReturnType<typeof setInterval> | null {
  const threshold = config.behaviour.usageAlertDailyReplies;
  if (!threshold) return null;

  let tracker = initialUsageAlertTracker();
  let failureTracker: JobFailureTracker = initialJobFailureTracker();
  let lastSuccessAt: number | null = null;

  const check = () => {
    usageStats(1)
      .then((stats) => {
        lastSuccessAt = Date.now();
        failureTracker = stepJobFailureTracker(
          failureTracker,
          false,
          BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD,
        ).tracker;
        recordJobRun('usage-alert', failureTracker, Date.now(), lastSuccessAt);

        const step = stepUsageAlertTracker(tracker, stats.outbound, threshold);
        tracker = step.tracker;
        if (step.shouldAlert) {
          logger.warn(
            { outbound: stats.outbound, threshold, costUsd: stats.costUsd },
            'Usage alert threshold crossed',
          );
          void alertSuperAdmins(adapters, formatUsageAlertMessage(stats, threshold));
        }
      })
      .catch((err) => {
        logger.error({ err }, 'Usage alert check failed');
        const step = stepJobFailureTracker(failureTracker, true, BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD);
        failureTracker = step.tracker;
        recordJobRun('usage-alert', failureTracker, Date.now(), lastSuccessAt);
        if (step.shouldAlert) {
          void alertSuperAdmins(
            adapters,
            buildJobFailureAlert('usage-alert', failureTracker.consecutiveFailures, lastSuccessAt),
          );
        }
      });
  };
  check();
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref();
  return timer;
}

async function alertSuperAdmins(adapters: readonly PlatformAdapter[], message: string): Promise<void> {
  for (const adapter of adapters) {
    if (!adapter.isConnected()) continue; // can't send through a dead connection
    for (const id of superAdminIds(adapter.platform)) {
      adapter
        .sendDirectMessage(id, message)
        .catch((err) => logger.warn({ err, platform: adapter.platform, id }, 'Usage alert DM failed'));
    }
  }
}
