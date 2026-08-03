import { config } from '@swampratnz/agent-base/config.js';
import { logger } from '@swampratnz/agent-base/logger.js';
import {
  adminActivitySummary,
  listAdmins,
  getLastAdminLeverageAlertRate,
  recordAdminLeverageAlertSent,
  wasAdminLeverageAlertSentRecently,
} from '@swampratnz/agent-base/storage/repository.js';
import { startTrackedJob } from '@swampratnz/agent-base/jobs/trackedJob.js';
import { alertSuperAdmins } from './departedAdminAlert.js';
import type { JobSpec } from '@swampratnz/agent-base/jobs/types.js';
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/**
 * How stale the persisted `admin_leverage_alert_sends` guard must be before a
 * tick is eligible to send again — a weekly cadence, restart-safe like
 * `engagementAlert.ts`'s own `FRESHNESS_DAYS` guard (issue #785), since
 * `actionsPerAdmin` is a continuous value that's always meaningful rather
 * than a signal that's usually zero (which is what `departedAdminAlert.ts`'s
 * zero→nonzero latch is for).
 */
const FRESHNESS_DAYS = 7;

/**
 * Renders the weekly admin-leverage snapshot: bare total action count, bare
 * admin count, and the derived actions-per-admin rate — never any admin's
 * `actorUserId`/`platformUserId` or display name, matching every other
 * digest/alert line's "bare aggregate, no identity" convention in this
 * codebase (e.g. `formatDepartedAdminAlertMessage`, `formatEngagementAlert
 * Message`). `adminCount === 0` renders a fixed "no current admins" line
 * instead of dividing by zero. Appends a week-over-week `▲`/`▼`/"No change"
 * trend suffix on the rate, reusing `formatEngagementAlertMessage`'s exact
 * one-decimal-place convention — `previousRate === null` (no prior
 * `admin_leverage_alert_sends` row) renders no suffix at all, the same
 * first-run null-safety.
 */
export function formatAdminLeverageAlertMessage(
  totalActions: number,
  adminCount: number,
  previousRate: number | null,
): string {
  if (adminCount === 0) {
    return '📊 Admin leverage this week: no current admins to measure against.';
  }
  const rate = totalActions / adminCount;
  const base = `📊 Admin leverage this week: ${totalActions} actions / ${adminCount} admins = ${rate.toFixed(1)}/admin`;
  if (previousRate === null) return base;
  const diff = rate - previousRate;
  const trend =
    diff > 0
      ? ` ▲ ${diff.toFixed(1)} since last week.`
      : diff < 0
        ? ` ▼ ${Math.abs(diff).toFixed(1)} since last week.`
        : ' No change since last week.';
  return `${base}${trend}`;
}

/**
 * Builds the default `runOnce` for `startAdminLeverageAlert`. Every
 * dependency is injectable so tests can drive the cadence without a real DB;
 * production always uses the default, already-exported repository
 * functions. The prior rate is read via `getLastRate` *before* `recordSent`
 * persists this run's value, mirroring `makeDefaultEngagementAlertRun`'s
 * read-old-then-persist-new ordering so the delta always compares against
 * last week's rate, not this week's.
 */
export function makeDefaultAdminLeverageAlertRun(
  adapters: readonly PlatformAdapter[],
  activitySummary: () => Promise<Awaited<ReturnType<typeof adminActivitySummary>>> = () =>
    adminActivitySummary(7),
  admins: () => Promise<Awaited<ReturnType<typeof listAdmins>>> = listAdmins,
  wasSentRecently: (days: number) => Promise<boolean> = wasAdminLeverageAlertSentRecently,
  recordSent: (rate: number | null) => Promise<void> = recordAdminLeverageAlertSent,
  getLastRate: () => Promise<number | null> = getLastAdminLeverageAlertRate,
): () => Promise<void> {
  return async () => {
    if (await wasSentRecently(FRESHNESS_DAYS)) return;
    const [summary, roster] = await Promise.all([activitySummary(), admins()]);
    const totalActions = summary.reduce((sum, row) => sum + row.actionCount, 0);
    const adminCount = roster.length;
    const previousRate = await getLastRate();
    logger.info({ totalActions, adminCount, previousRate }, 'Admin leverage alert: sending weekly snapshot');
    void alertSuperAdmins(adapters, formatAdminLeverageAlertMessage(totalActions, adminCount, previousRate));
    await recordSent(adminCount === 0 ? null : totalActions / adminCount);
  };
}

/**
 * Weekly admin-leverage alert (issue #785), off unless
 * `ADMIN_LEVERAGE_ALERT_ENABLED`. Closes the same pull-only gap #472/#568
 * closed for other super-admin-only signals: `adminActivitySummary()`
 * (issue #488) already computes per-actor `admin_audit` volume, but only on
 * pull via the `admin_activity` tool — a super admin only sees it if they
 * think to run the tool again. Routed through the shared `startTrackedJob`
 * (same 6h tick cadence as every other opt-in job) so a throwing `runOnce`
 * (e.g. a DB error from `adminActivitySummary`/`listAdmins`) gets the same
 * consecutive-failure alerting for free, instead of a bespoke tracker.
 */
export function startAdminLeverageAlert(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultAdminLeverageAlertRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('admin-leverage-alert', adapters, config.adminLeverageAlert.enabled, runOnce);
}

// Registry entry (see src/module/jobs/registry.ts) — gate mirrors startAdminLeverageAlert's own flag.
export const adminLeverageAlertJob: JobSpec = {
  name: 'admin-leverage-alert',
  enabled: (cfg) => cfg.adminLeverageAlert.enabled,
  start: (adapters) => startAdminLeverageAlert(adapters),
};
