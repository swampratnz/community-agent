import { config } from './config.js';
import { logger } from './logger.js';
import { formatEngagementStats } from './agent/tools.js';
import {
  engagementStats,
  getLastEngagementAlertPercentage,
  recordEngagementAlertSent,
  wasEngagementAlertSentRecently,
} from './storage/repository.js';
import { startTrackedJob } from './backgroundJobs.js';
import { alertSuperAdmins } from './departedAdminAlert.js';
import type { PlatformAdapter } from './platforms/types.js';

/**
 * How stale the persisted `engagement_alert_sends` guard must be before a
 * tick is eligible to send again — a weekly cadence, restart-safe via the
 * same `sent_at`-guard shape `wasAdminDigestSentRecently` uses (issue #568).
 */
const FRESHNESS_DAYS = 7;

/**
 * Thin wrapper around `engagement_stats`'s own pure formatter (issue #419) —
 * the pushed DM is byte-identical in shape to the on-demand tool reply,
 * never a bespoke rendering. Inherits that formatter's privacy contract:
 * aggregate counts and a percentage only, never a member identity, and the
 * fixed "No currently-present roster members…" fallback when the roster is
 * empty (never a divide-by-zero or `NaN%`).
 *
 * Appends a week-over-week trend suffix (issue #597), mirroring
 * `formatUsageCostDigestMessage`'s ▲/▼/"No change" convention but in
 * percentage points, not dollars. `previousPercentage === null` (no prior
 * `engagement_alert_sends` row — first-ever run) renders a defined
 * no-comparison form instead of `NaN`/`undefined`. Both figures are already
 * rounded to one decimal place by `engagementStats()` (`repository.ts`'s
 * `pct` helper), so the delta is computed from those rounded values and
 * formatted to the same one-decimal precision — never a floating-point
 * artifact like `5.199999pp`.
 */
export function formatEngagementAlertMessage(
  stats: Awaited<ReturnType<typeof engagementStats>>,
  previousPercentage: number | null,
): string {
  const snapshot = `📊 Weekly engagement snapshot:\n${formatEngagementStats(stats)}`;
  if (previousPercentage === null) {
    return `${snapshot}\nNo prior week recorded yet to compare against.`;
  }
  const diff = stats.percentage - previousPercentage;
  const trend =
    diff > 0
      ? `▲ ${diff.toFixed(1)}pp vs last week.`
      : diff < 0
        ? `▼ ${Math.abs(diff).toFixed(1)}pp vs last week.`
        : 'No change vs last week.';
  return `${snapshot}\n${trend}`;
}

/**
 * Builds the default `runOnce` for `startEngagementAlert`. Unlike the
 * departed-admin alert's zero→nonzero latch (appropriate for a signal that's
 * usually zero), engagement % is a continuous value that's always
 * meaningful, so this follows the admin-digest's freshness-guard cadence
 * instead: eligible when there is no prior `engagement_alert_sends` row, or
 * the row is older than `FRESHNESS_DAYS` — restart-safe, so a redeploy
 * mid-week can't double-send. `stats`/`wasSentRecently`/`getLastPercentage`/
 * `recordSent` are injectable so tests can drive the cadence without a real
 * DB; production always uses the default, already-exported repository
 * functions. The prior percentage is read via `getLastPercentage` *before*
 * `recordSent` persists this run's value (issue #597), mirroring
 * `makeDefaultUsageCostDigestRun`'s read-old-then-persist-new ordering so the
 * delta always compares against last week's figure, not this week's.
 */
export function makeDefaultEngagementAlertRun(
  adapters: readonly PlatformAdapter[],
  stats: () => Promise<Awaited<ReturnType<typeof engagementStats>>> = () => engagementStats(),
  wasSentRecently: (days: number) => Promise<boolean> = wasEngagementAlertSentRecently,
  recordSent: (percentage: number) => Promise<void> = recordEngagementAlertSent,
  getLastPercentage: () => Promise<number | null> = getLastEngagementAlertPercentage,
): () => Promise<void> {
  return async () => {
    if (await wasSentRecently(FRESHNESS_DAYS)) return;
    const s = await stats();
    const previousPercentage = await getLastPercentage();
    logger.info(
      { percentage: s.percentage, previousPercentage },
      'Engagement alert: sending weekly snapshot',
    );
    void alertSuperAdmins(adapters, formatEngagementAlertMessage(s, previousPercentage));
    await recordSent(s.percentage);
  };
}

/**
 * Weekly engagement-percentage alert (issue #568), off unless
 * `ENGAGEMENT_ALERT_ENABLED`. Closes the same pull-only gap #472/#480 closed
 * for other super-admin-only signals: `engagement_stats` (issue #419)
 * already computes the guild-wide engagement percentage, but only on pull —
 * a super admin only sees it if they think to run the tool again. Routed
 * through the shared `startTrackedJob` (same 6h tick cadence as every other
 * opt-in job in `backgroundJobs.ts`) so a throwing `runOnce` (e.g. a DB
 * error from `engagementStats`) gets the same consecutive-failure alerting
 * for free, instead of a bespoke tracker.
 */
export function startEngagementAlert(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultEngagementAlertRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('engagement-alert', adapters, config.engagementAlert.enabled, runOnce);
}
