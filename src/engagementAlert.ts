import { config } from './config.js';
import { logger } from './logger.js';
import { formatEngagementStats } from './agent/tools.js';
import {
  engagementStats,
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
 */
export function formatEngagementAlertMessage(stats: Awaited<ReturnType<typeof engagementStats>>): string {
  return `📊 Weekly engagement snapshot:\n${formatEngagementStats(stats)}`;
}

/**
 * Builds the default `runOnce` for `startEngagementAlert`. Unlike the
 * departed-admin alert's zero→nonzero latch (appropriate for a signal that's
 * usually zero), engagement % is a continuous value that's always
 * meaningful, so this follows the admin-digest's freshness-guard cadence
 * instead: eligible when there is no prior `engagement_alert_sends` row, or
 * the row is older than `FRESHNESS_DAYS` — restart-safe, so a redeploy
 * mid-week can't double-send. `stats`/`wasSentRecently`/`recordSent` are
 * injectable so tests can drive the cadence without a real DB; production
 * always uses the default, already-exported repository functions.
 */
export function makeDefaultEngagementAlertRun(
  adapters: readonly PlatformAdapter[],
  stats: () => Promise<Awaited<ReturnType<typeof engagementStats>>> = () => engagementStats(),
  wasSentRecently: (days: number) => Promise<boolean> = wasEngagementAlertSentRecently,
  recordSent: (percentage: number) => Promise<void> = recordEngagementAlertSent,
): () => Promise<void> {
  return async () => {
    if (await wasSentRecently(FRESHNESS_DAYS)) return;
    const s = await stats();
    logger.info({ percentage: s.percentage }, 'Engagement alert: sending weekly snapshot');
    void alertSuperAdmins(adapters, formatEngagementAlertMessage(s));
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
