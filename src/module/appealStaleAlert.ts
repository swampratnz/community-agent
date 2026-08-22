import { logger } from '@swampratnz/agent-base/logger.js';
import { startTrackedJob } from '@swampratnz/agent-base/jobs/trackedJob.js';
import { initialUsageAlertTracker, stepUsageAlertTracker } from '@swampratnz/agent-base/usageAlert.js';
import { WindowClosedError } from '@swampratnz/agent-base/platforms/types.js';
import {
  listAdmins,
  listAppeals,
  type AdminIdentity,
  type ModerationAppeal,
} from '@swampratnz/agent-base/storage/repository.js';
import type { JobSpec } from '@swampratnz/agent-base/jobs/types.js';
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/**
 * Staleness threshold (issue #1020, the deliberate smaller re-proposal of
 * #1016 — see that issue for the full rejection/re-proposal history). Fixed,
 * not configurable: a new env var would be a config-schema (agent-base)
 * change, which this proposal was explicitly scoped to avoid.
 */
export const APPEAL_STALE_ALERT_THRESHOLD_HOURS = 72;

/**
 * How many open appeals one tick scans. `listAppeals`' own hard clamp is 200
 * (`Math.min(Math.max(trunc(limit) || 50, 1), 200)`), so this is the widest a
 * caller can ask for; the default of 50 is far too narrow for a backlog
 * signal. See `makeDefaultAppealStaleAlertRun`'s doc comment for why the
 * order (`created_at DESC`) makes the default actively wrong here rather than
 * merely partial, and for the agent-base follow-up that would remove the
 * bound entirely.
 */
export const APPEAL_STALE_ALERT_SCAN_LIMIT = 200;

/**
 * Bare count + oldest-age-in-hours DM template — deliberately excludes every
 * appeal's id, `userId`/`userName`, platform, and reason, matching every
 * other digest/alert signal's "bare integers only" convention in this
 * codebase (see `openAppealsCount` in `adminDigest.ts`).
 */
export function formatAppealStaleAlertMessage(count: number, oldestAgeHours: number): string {
  return (
    `📋 ${count} open moderation appeal(s) have been waiting more than ` +
    `${APPEAL_STALE_ALERT_THRESHOLD_HOURS}h for review (oldest: ${oldestAgeHours}h) — run \`list_appeals\` to review.`
  );
}

/** Pure: open appeals -> the subset older than the threshold, at instant `now`. */
function staleOpenAppeals(appeals: readonly ModerationAppeal[], now: number): ModerationAppeal[] {
  const thresholdMs = APPEAL_STALE_ALERT_THRESHOLD_HOURS * 3_600_000;
  return appeals.filter((appeal) => now - appeal.createdAt.getTime() >= thresholdMs);
}

/**
 * Mirrors `adminDigest.ts`'s own per-admin delivery loop (not
 * `notify.ts`'s `notifyAdmins`, which is built for a turn-scoped
 * `adapterFor`/`excludeUserId`, and not `departedAdminAlert.ts`'s
 * `alertSuperAdmins`, whose audience is super admins, not the `listAdmins()`
 * roster `list_appeals` itself serves): per-admin try/catch isolation so one
 * admin's failed/closed-window send never blocks delivery to the rest
 * (issue #998's pattern). A `WindowClosedError` with a truthy
 * `queueForWindowReopen` is queued at `'low'` priority — matching
 * `adminDigest.ts`'s own per-recipient DMs, not the `'system'` priority
 * `alertSuperAdmins` uses for its broadcast alerts.
 */
export async function alertAdmins(
  adapters: readonly PlatformAdapter[],
  message: string,
  listAdminIdentities: () => Promise<AdminIdentity[]> = listAdmins,
): Promise<void> {
  const admins = await listAdminIdentities();
  for (const admin of admins) {
    const adapter = adapters.find((a) => a.platform === admin.platform && a.isConnected());
    if (!adapter) continue;
    try {
      await adapter.sendDirectMessage(admin.platformUserId, message);
    } catch (err) {
      if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
        adapter.queueForWindowReopen(admin.platformUserId, message, 'low');
        logger.warn(
          { platform: admin.platform, id: admin.platformUserId },
          "Appeal stale alert: recipient's window is closed, queued for reopen",
        );
      } else {
        logger.warn(
          { err, platform: admin.platform, id: admin.platformUserId },
          'Appeal stale alert: per-admin send failed',
        );
      }
    }
  }
}

/**
 * Builds the default `runOnce` for `startAppealStaleAlert`: a guild-wide
 * crossing latch (`stepUsageAlertTracker`, imported by reference exactly
 * like `departedAdminAlert.ts` does — not copied) over the COUNT of open
 * appeals older than `APPEAL_STALE_ALERT_THRESHOLD_HOURS`, computed fresh
 * each tick from a bounded `listAppeals` scan (see below). Alerts once on the
 * tick the stale
 * count first leaves 0, stays silent while it remains >=1 (including a
 * partial decrease that never reaches 0), and re-arms once every stale
 * appeal is resolved/dismissed and the count returns to 0 — the identical
 * semantics `departedAdminAlertJob` already ships with, accepted here as the
 * explicit tradeoff for needing zero persistence (see issue #1020's
 * "guild-wide count latch, not per-appeal dedup" scoping). `listOpenAppeals`/
 * `listAdminIdentities` are injectable so tests can drive the latch across
 * ticks with no real DB and no timers.
 *
 * The explicit `APPEAL_STALE_ALERT_SCAN_LIMIT` is load-bearing, not decoration.
 * `listAppeals` is a LIMIT-bounded list read whose default is 50 AND whose
 * order is `created_at DESC` — newest first. Calling it bare would therefore
 * hand this job the 50 NEWEST open appeals and then filter them for the
 * OLDEST, which is backwards: past 50 open appeals the genuinely overdue ones
 * are exactly the rows excluded, so the alert would go quiet precisely as the
 * backlog it exists to report got worse. 200 is `listAppeals`' own hard clamp
 * (`Math.min(..., 200)`), so it is the widest scan available from here.
 *
 * That bounds the failure rather than removing it: above 200 open appeals the
 * count still understates. Removing it needs a dedicated aggregate — the
 * `countOpenAppeals`/`oldestOpenAppealAgeDays` shape, but predicated on an age
 * threshold and unscoped by platform — which lives in agent-base, so it is a
 * follow-up there rather than a raw query smuggled in here (nothing in
 * `src/module/` reaches past the repository layer, and this job should not be
 * the first).
 */
export function makeDefaultAppealStaleAlertRun(
  adapters: readonly PlatformAdapter[],
  listOpenAppeals: () => Promise<ModerationAppeal[]> = () =>
    listAppeals('open', APPEAL_STALE_ALERT_SCAN_LIMIT),
  listAdminIdentities: () => Promise<AdminIdentity[]> = listAdmins,
): () => Promise<void> {
  let tracker = initialUsageAlertTracker();
  return async () => {
    const now = Date.now();
    const appeals = await listOpenAppeals();
    const stale = staleOpenAppeals(appeals, now);
    const step = stepUsageAlertTracker(tracker, stale.length, 1);
    tracker = step.tracker;
    if (!step.shouldAlert) return;

    const oldestAgeHours = Math.floor(
      Math.max(...stale.map((appeal) => now - appeal.createdAt.getTime())) / 3_600_000,
    );
    logger.warn(
      { count: stale.length, oldestAgeHours },
      'Appeal stale alert: stale open appeal count crossed zero',
    );
    await alertAdmins(
      adapters,
      formatAppealStaleAlertMessage(stale.length, oldestAgeHours),
      listAdminIdentities,
    );
  };
}

/**
 * Stale-appeal admin nudge (issue #1020) — the always-on push complement to
 * `list_appeals`' pull-only view and the weekly `oldestOpenAppealAgeDays`
 * digest line (#787). Unconditionally enabled, like
 * `disconnectAlertsJob`/`embeddingHealthCheckJob`: no new env var, no
 * config-schema change (an agent-base change this proposal was explicitly
 * scoped to avoid). Routed through the shared `startTrackedJob` (same 6h
 * cadence as every other job in the registry) so a throwing `runOnce` (e.g.
 * a DB error from `listAppeals`) gets the same consecutive-failure alerting
 * for free.
 */
export function startAppealStaleAlert(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultAppealStaleAlertRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('appeal-stale-alert', adapters, true, runOnce);
}

// Registry entry (see src/module/jobs/registry.ts) — always on, no enable flag.
export const appealStaleAlertJob: JobSpec = {
  name: 'appeal-stale-alert',
  enabled: () => true,
  start: (adapters) => startAppealStaleAlert(adapters),
};
