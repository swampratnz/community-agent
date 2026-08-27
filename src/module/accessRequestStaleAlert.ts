import { logger } from '@swampratnz/agent-base/logger.js';
import { startTrackedJob } from '@swampratnz/agent-base/jobs/trackedJob.js';
import {
  listAdmins,
  listAccessRequests,
  type AccessRequest,
  type AdminIdentity,
} from '@swampratnz/agent-base/storage/repository.js';
import { alertAdmins } from './appealStaleAlert.js';
import { persistedCrossingLatch, type CrossingLatchDeps } from './crossingLatch.js';
import { ACCESS_REQUEST_STALE_ALERT_POLICY_KEY } from './storage/policies.js';
import type { JobSpec } from '@swampratnz/agent-base/jobs/types.js';
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/**
 * Staleness threshold (issue #1100, the fifth and last `review_queue` queue
 * to get a push complement — see `appealStaleAlert.ts`/
 * `knowledgeCandidateStaleAlert.ts`/`reportStaleAlert.ts`/
 * `suggestionStaleAlert.ts`). 168h (7 days) — knowledge-candidates'/
 * suggestions' cadence, not appeals' 72h: a pending guest has no
 * fairness/mute-duration urgency, so reusing the existing 168h precedent is
 * the right fit rather than inventing a new number. Fixed, not configurable:
 * a new env var would be a config-schema (agent-base) change, same
 * discipline every sibling alert was explicitly scoped to avoid.
 */
export const ACCESS_REQUEST_STALE_ALERT_THRESHOLD_HOURS = 168;

/**
 * How many pending access requests one tick scans. Unlike `listAppeals`/
 * `listSuggestions`, `listAccessRequests` has NO hard clamp on its `limit`
 * argument (default 50, but a caller can ask for any number) — so this is
 * not "the widest scan available", it is this job's own choice of how far to
 * look. `listAccessRequests` orders `last_requested_at DESC`, not
 * `first_requested_at`, so a low limit could miss a guest who pinged once,
 * long ago, and never again (they sort toward the bottom as later requests
 * from other guests push them down) — see
 * `makeDefaultAccessRequestStaleAlertRun`'s doc comment. 500 is chosen as
 * generous headroom over any realistic pending-guest backlog for a single
 * community, the same bounded-scan tradeoff the sibling alerts accept.
 */
export const ACCESS_REQUEST_STALE_ALERT_SCAN_LIMIT = 500;

/**
 * Bare count + oldest-age-in-hours DM template — deliberately excludes every
 * guest's `userName`, `userId`, and platform, matching every other
 * digest/alert signal's "bare integers only" convention in this codebase
 * (see `formatAppealStaleAlertMessage`/`formatSuggestionStaleAlertMessage`).
 * The signature accepts only `(count, oldestAgeHours)`, so a guest-identifying
 * field is unrepresentable by construction.
 */
export function formatAccessRequestStaleAlertMessage(count: number, oldestAgeHours: number): string {
  return (
    `🚪 ${count} pending access request(s) have been waiting more than ` +
    `${ACCESS_REQUEST_STALE_ALERT_THRESHOLD_HOURS}h (7d) for review (oldest: ${oldestAgeHours}h) — ` +
    'run `list_access_requests` to review.'
  );
}

/** Pure: pending access requests -> the subset older than the threshold, at instant `now`. */
function staleAccessRequests(requests: readonly AccessRequest[], now: number): AccessRequest[] {
  const thresholdMs = ACCESS_REQUEST_STALE_ALERT_THRESHOLD_HOURS * 3_600_000;
  return requests.filter((request) => now - request.firstRequestedAt.getTime() >= thresholdMs);
}

/**
 * Builds the default `runOnce` for `startAccessRequestStaleAlert`: a
 * guild-wide crossing latch (`persistedCrossingLatch`, shared verbatim by
 * every sibling alert — issue #1198) over the COUNT of pending access
 * requests whose `firstRequestedAt` age is at least
 * `ACCESS_REQUEST_STALE_ALERT_THRESHOLD_HOURS`, computed fresh each tick from
 * a bounded `listAccessRequests` scan. Alerts once on the tick the stale
 * count first leaves 0, stays silent while it remains >=1 (including a
 * partial decrease that never reaches 0), and re-arms once every stale
 * request resolves (`add_member`, which calls `clearAccessRequest`, or
 * `purgeOldAccessRequests`' retention sweep if enabled) and the count
 * returns to 0. Unlike the pre-#1198 in-memory-only latch, this state now
 * survives a process restart: see `persistedCrossingLatch`'s own doc
 * comment. `listPendingAccessRequests`/`listAdminIdentities`/`latchDeps` are
 * injectable so tests can drive the latch across ticks with no real DB and
 * no timers.
 *
 * The explicit `ACCESS_REQUEST_STALE_ALERT_SCAN_LIMIT` is load-bearing, not
 * decoration — see that constant's doc comment for why a bare call would be
 * backwards: `listAccessRequests` orders `last_requested_at DESC`, so a
 * caller who pinged once long ago and never again sorts toward the bottom of
 * the scan as later requests from other guests push them down, exactly the
 * kind of stale request this alert exists to surface.
 */
export function makeDefaultAccessRequestStaleAlertRun(
  adapters: readonly PlatformAdapter[],
  listPendingAccessRequests: () => Promise<AccessRequest[]> = () =>
    listAccessRequests(ACCESS_REQUEST_STALE_ALERT_SCAN_LIMIT),
  listAdminIdentities: () => Promise<AdminIdentity[]> = listAdmins,
  latchDeps?: CrossingLatchDeps,
): () => Promise<void> {
  const latch = persistedCrossingLatch(ACCESS_REQUEST_STALE_ALERT_POLICY_KEY, latchDeps);
  return async () => {
    const now = Date.now();
    const requests = await listPendingAccessRequests();
    const stale = staleAccessRequests(requests, now);
    const step = await latch.step(stale.length);
    if (!step.shouldAlert) return;

    const oldestAgeHours = Math.floor(
      Math.max(...stale.map((request) => now - request.firstRequestedAt.getTime())) / 3_600_000,
    );
    logger.warn(
      { count: stale.length, oldestAgeHours },
      'Access request stale alert: stale pending-access-request count crossed zero',
    );
    await alertAdmins(
      adapters,
      formatAccessRequestStaleAlertMessage(stale.length, oldestAgeHours),
      listAdminIdentities,
    );
    await step.commit();
  };
}

/**
 * Stale-access-request admin nudge (issue #1100) — the always-on push
 * complement to `list_access_requests`' pull-only view and the weekly
 * `oldestAccessRequestAgeDays` digest line (#515), and the last of
 * `review_queue`'s five queues to get one. Unconditionally enabled, like
 * every sibling alert: no new env var, no config-schema change. Routed
 * through the shared `startTrackedJob` (same cadence as every other job in
 * the registry) so a throwing `runOnce` (e.g. a DB error from
 * `listAccessRequests`) gets the same consecutive-failure alerting for free.
 */
export function startAccessRequestStaleAlert(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultAccessRequestStaleAlertRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('access-request-stale-alert', adapters, true, runOnce);
}

// Registry entry (see src/module/jobs/registry.ts) — always on, no enable flag.
export const accessRequestStaleAlertJob: JobSpec = {
  name: 'access-request-stale-alert',
  enabled: () => true,
  start: (adapters) => startAccessRequestStaleAlert(adapters),
};
