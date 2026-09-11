import { logger } from '@swampratnz/agent-base/logger.js';
import { startTrackedJob } from '@swampratnz/agent-base/jobs/trackedJob.js';
import { WindowClosedError } from '@swampratnz/agent-base/platforms/types.js';
import {
  listAdmins,
  listAppeals,
  type AdminIdentity,
  type ModerationAppeal,
} from '@swampratnz/agent-base/storage/repository.js';
import { persistedCrossingLatch, type CrossingLatchDeps } from './crossingLatch.js';
import { APPEAL_STALE_ALERT_POLICY_KEY } from './storage/policies.js';
import { getWithdrawnAppealIds } from './storage/appealWithdrawals.js';
import { recordAppellantStaleNotice as recordAppellantStaleNoticeDefault } from './storage/appealAppellantStaleNotices.js';
import { notifyAppealStale } from './agent/tools/notify.js';
import type { JobSpec } from '@swampratnz/agent-base/jobs/types.js';
import type { Platform, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

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
 * crossing latch (`persistedCrossingLatch`, shared verbatim by every sibling
 * alert — issue #1198) over the COUNT of open appeals older than
 * `APPEAL_STALE_ALERT_THRESHOLD_HOURS`, computed fresh each tick from a
 * bounded `listAppeals` scan (see below). Alerts once on the tick the stale
 * count first leaves 0, stays silent while it remains >=1 (including a
 * partial decrease that never reaches 0), and re-arms once every stale
 * appeal is resolved/dismissed and the count returns to 0. Unlike the
 * pre-#1198 in-memory-only latch, this state now survives a process restart:
 * see `persistedCrossingLatch`'s own doc comment. `listOpenAppeals`/
 * `listAdminIdentities`/`latchDeps` are injectable so tests can drive the
 * latch across ticks with no real DB and no timers.
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
 *
 * Also sends the APPELLANT their own one-time "still being reviewed" DM
 * (issue #1413, mirroring `knowledgeCandidateStaleAlert.ts`'s #1408
 * mechanism verbatim) for each appeal in `stale` — evaluated right after
 * `stale` is computed, unconditionally, INDEPENDENT of the admin crossing
 * latch below: an admin backlog already latched open (so `step.shouldAlert`
 * is false) must not silently suppress the signal to an appellant who has
 * never been notified about this particular appeal before. A withdrawn
 * appeal (present in `getWithdrawnAppealIds`) is skipped entirely — no
 * record, no notify call — SCOPED TO THIS LOOP ONLY: the admin-facing stale
 * COUNT below still includes a withdrawn appeal, unchanged from today,
 * because that is a separate, pre-existing behaviour this PR is explicitly
 * scoped to leave alone. Idempotency is `recordAppellantStaleNotice`'s
 * `INSERT ... ON CONFLICT DO NOTHING` alone — no second latch — so an appeal
 * already flagged (by an earlier tick) is a no-op, and because that record
 * commits BEFORE the send, a `WindowClosedError` at send time can never
 * cause a later tick to re-notify. Routed via `adapters.find` on the
 * appeal's OWN `platform`, never any caller-supplied value; a missing/
 * disconnected adapter for that platform is a silent skip, matching every
 * sibling job's adapter-missing handling. A failure recording or sending one
 * appeal's notice is caught per-appeal so it can never suppress the notice
 * to any other stale appeal's appellant, nor the admin alert below.
 */
export function makeDefaultAppealStaleAlertRun(
  adapters: readonly PlatformAdapter[],
  listOpenAppeals: () => Promise<ModerationAppeal[]> = () =>
    listAppeals('open', APPEAL_STALE_ALERT_SCAN_LIMIT),
  listAdminIdentities: () => Promise<AdminIdentity[]> = listAdmins,
  latchDeps?: CrossingLatchDeps,
  getWithdrawnIds: (ids: readonly number[]) => Promise<Set<number>> = getWithdrawnAppealIds,
  recordAppellantStaleNotice: (appealId: number) => Promise<boolean> = recordAppellantStaleNoticeDefault,
  notifyStale: (
    adapter: PlatformAdapter,
    userId: string,
    platform: Platform,
  ) => Promise<void> = notifyAppealStale,
): () => Promise<void> {
  const latch = persistedCrossingLatch(APPEAL_STALE_ALERT_POLICY_KEY, latchDeps);
  return async () => {
    const now = Date.now();
    const appeals = await listOpenAppeals();
    const stale = staleOpenAppeals(appeals, now);

    // Appellant-side mid-flight notice (issue #1413) — independent of the
    // admin crossing latch below (see the function doc comment): every
    // still-stale, non-withdrawn appeal is offered a one-time notice every
    // tick, gated only by the ON CONFLICT DO NOTHING insert. The withdrawal
    // filter applies ONLY to this loop — the admin-facing stale count
    // computed below is untouched.
    const withdrawnIds = await getWithdrawnIds(stale.map((appeal) => appeal.id));
    for (const staleAppeal of stale) {
      if (withdrawnIds.has(staleAppeal.id)) continue;
      // Mirrors every sibling job's adapter-missing handling: resolved
      // BEFORE recordAppellantStaleNotice, so an appeal whose appellant
      // platform has no connected adapter is never marked as notified — it
      // stays eligible for a real notice on a later tick, once an adapter
      // exists.
      const adapter = adapters.find((a) => a.platform === staleAppeal.platform && a.isConnected());
      if (!adapter) continue;
      try {
        const isFirstNotice = await recordAppellantStaleNotice(staleAppeal.id);
        if (!isFirstNotice) continue;
        await notifyStale(adapter, staleAppeal.userId, staleAppeal.platform);
      } catch (err) {
        logger.warn(
          { err, platform: staleAppeal.platform, appealId: staleAppeal.id },
          'Appeal stale alert: appellant notice failed',
        );
      }
    }

    const step = await latch.step(stale.length);
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
    await step.commit();
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
