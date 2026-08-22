import { logger } from '@swampratnz/agent-base/logger.js';
import { startTrackedJob } from '@swampratnz/agent-base/jobs/trackedJob.js';
import { initialUsageAlertTracker, stepUsageAlertTracker } from '@swampratnz/agent-base/usageAlert.js';
import { WindowClosedError } from '@swampratnz/agent-base/platforms/types.js';
import {
  listAdmins,
  listReports,
  resolveLinkedIdentities,
  type AdminIdentity,
  type ContentReport,
} from '@swampratnz/agent-base/storage/repository.js';
import type { JobSpec } from '@swampratnz/agent-base/jobs/types.js';
import type { Platform, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/**
 * Staleness threshold (issue #1084). Shortest of the three crossing-latch
 * queues (appeals 72h, knowledge candidates 168h) — `content_reports` is the
 * "someone needs help with abuse/harassment" queue, so it gets the tightest
 * SLA. Fixed, not configurable: a new env var would be a config-schema
 * (agent-base) change, same discipline #1020/#1073 were explicitly scoped to
 * avoid.
 */
export const REPORT_STALE_ALERT_THRESHOLD_HOURS = 48;

/**
 * How many of one admin's open reports one tick scans. `listReports`'s own
 * hard clamp is 200 (`Math.min(Math.max(trunc(limit) || 50, 1), 200)`), so
 * this is the widest a caller can ask for. Like `listAppeals` (and unlike
 * `listKnowledgeCandidates`), `listReports` has no `oldestFirst` param and
 * always orders `created_at DESC` — newest first — so a bare call would hand
 * this job the newest open reports and then filter them for the oldest,
 * going backwards exactly as the backlog worsens past 200. 200 bounds that
 * failure rather than removing it, the identical tradeoff
 * `appealStaleAlert.ts` accepts for the same reason.
 */
export const REPORT_STALE_ALERT_SCAN_LIMIT = 200;

/**
 * Bare count + oldest-age-in-hours DM template — deliberately excludes every
 * report's id, reporter, target, message id, and reason, matching every
 * other digest/alert signal's "bare integers only" convention in this
 * codebase (see `formatAppealStaleAlertMessage`). The signature accepts only
 * `(count, oldestAgeHours)`, so a report field is unrepresentable by
 * construction.
 */
export function formatReportStaleAlertMessage(count: number, oldestAgeHours: number): string {
  return (
    `🚩 ${count} open content report(s) in your conversations have been waiting more than ` +
    `${REPORT_STALE_ALERT_THRESHOLD_HOURS}h for review (oldest: ${oldestAgeHours}h) — run \`list_reports\` to review.`
  );
}

/** Pure: one admin's open reports -> the subset older than the threshold, at instant `now`. */
function staleOpenReports(reports: readonly ContentReport[], now: number): ContentReport[] {
  const thresholdMs = REPORT_STALE_ALERT_THRESHOLD_HOURS * 3_600_000;
  return reports.filter((report) => now - report.createdAt.getTime() >= thresholdMs);
}

/**
 * Builds the default `runOnce` for `startReportStaleAlert`: unlike
 * `appealStaleAlert.ts`/`knowledgeCandidateStaleAlert.ts` (both guild-wide,
 * unscoped queues with a single crossing latch and a single broadcast
 * message), `content_reports` is conversation-scoped per admin with an
 * accused-admin exclusion (`list_reports`, `reportsAdmin.ts`) — a guild-wide
 * count here would either leak a report's existence to an admin outside its
 * scope, or expose a report filed against the very admin receiving it. So
 * the latch and the DM are both **per admin**, keyed by
 * `${platform}:${platformUserId}`: each admin's own open-report set is
 * gathered via the same `adapter.conversationsForUser` +
 * `resolveLinkedIdentities` resolution `adminDigest.ts`/`reportsAdmin.ts`
 * already use, so an admin's alert can never reflect a report outside their
 * own scope or one filed against one of their own linked identities.
 *
 * Alerts an admin once on the tick their own stale count first leaves zero,
 * stays silent while it remains >=1 (including a partial decrease that never
 * reaches zero), and re-arms once their own stale count returns to zero —
 * the identical per-queue semantics the two sibling jobs ship with, applied
 * per admin instead of guild-wide. `listAdminIdentities`/
 * `listOpenReportsForAdmin`/`resolveViewerIds` are injectable so tests can
 * drive the latch across ticks and across admins with no real DB and no
 * timers.
 */
export function makeDefaultReportStaleAlertRun(
  adapters: readonly PlatformAdapter[],
  listAdminIdentities: () => Promise<AdminIdentity[]> = listAdmins,
  listOpenReportsForAdmin: (
    scope: readonly string[],
    viewerIds: readonly string[],
  ) => Promise<ContentReport[]> = (scope, viewerIds) =>
    listReports(scope, 'open', REPORT_STALE_ALERT_SCAN_LIMIT, viewerIds),
  resolveViewerIds: (platform: Platform, platformUserId: string) => Promise<readonly string[]> = async (
    platform,
    platformUserId,
  ) => (await resolveLinkedIdentities(platform, platformUserId)).map((identity) => identity.userId),
): () => Promise<void> {
  const trackers = new Map<string, ReturnType<typeof initialUsageAlertTracker>>();
  return async () => {
    const now = Date.now();
    for (const admin of await listAdminIdentities()) {
      // Mirrors adminDigest.ts's own per-admin skip: no connected adapter for
      // this admin's platform means there is nowhere to deliver the DM.
      const adapter = adapters.find((a) => a.platform === admin.platform && a.isConnected());
      if (!adapter) continue;

      const scope = await adapter.conversationsForUser(admin.platformUserId);
      // Accused-admin exclusion (issue #197): every identity linked to this
      // admin, not just their current-platform id, matching list_reports.
      const viewerIds = await resolveViewerIds(admin.platform, admin.platformUserId);
      const reports = await listOpenReportsForAdmin(scope, viewerIds);
      const stale = staleOpenReports(reports, now);

      const key = `${admin.platform}:${admin.platformUserId}`;
      const tracker = trackers.get(key) ?? initialUsageAlertTracker();
      const step = stepUsageAlertTracker(tracker, stale.length, 1);
      trackers.set(key, step.tracker);
      if (!step.shouldAlert) continue;

      const oldestAgeHours = Math.floor(
        Math.max(...stale.map((report) => now - report.createdAt.getTime())) / 3_600_000,
      );
      const message = formatReportStaleAlertMessage(stale.length, oldestAgeHours);
      logger.warn(
        { platform: admin.platform, id: admin.platformUserId, count: stale.length, oldestAgeHours },
        'Report stale alert: stale open-report count crossed zero for admin',
      );
      try {
        await adapter.sendDirectMessage(admin.platformUserId, message);
      } catch (err) {
        if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
          adapter.queueForWindowReopen(admin.platformUserId, message, 'low');
          logger.warn(
            { platform: admin.platform, id: admin.platformUserId },
            "Report stale alert: recipient's window is closed, queued for reopen",
          );
        } else {
          logger.warn(
            { err, platform: admin.platform, id: admin.platformUserId },
            'Report stale alert: per-admin send failed',
          );
        }
      }
    }
  };
}

/**
 * Stale-content-report admin nudge (issue #1084) — the always-on push
 * complement to `list_reports`' pull-only view and the weekly
 * `oldestOpenReportAgeDays` digest line. Unconditionally enabled, like
 * `appealStaleAlertJob`/`knowledgeCandidateStaleAlertJob`: no new env var, no
 * config-schema change. Routed through the shared `startTrackedJob` (same 6h
 * cadence as every other job in the registry) so a throwing `runOnce` (e.g. a
 * DB error from `listReports`) gets the same consecutive-failure alerting for
 * free.
 */
export function startReportStaleAlert(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultReportStaleAlertRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('report-stale-alert', adapters, true, runOnce);
}

// Registry entry (see src/module/jobs/registry.ts) — always on, no enable flag.
export const reportStaleAlertJob: JobSpec = {
  name: 'report-stale-alert',
  enabled: () => true,
  start: (adapters) => startReportStaleAlert(adapters),
};
