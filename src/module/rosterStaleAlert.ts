import { config } from '@swampratnz/agent-base/config.js';
import { logger } from '@swampratnz/agent-base/logger.js';
import { startTrackedJob } from '@swampratnz/agent-base/jobs/trackedJob.js';
import {
  listAdmins,
  listRoster,
  type AdminIdentity,
  type RosterEntry,
} from '@swampratnz/agent-base/storage/repository.js';
import { alertAdmins } from './appealStaleAlert.js';
import { persistedCrossingLatch, type CrossingLatchDeps } from './crossingLatch.js';
import { ROSTER_STALE_ALERT_POLICY_KEY } from './storage/policies.js';
import type { JobSpec } from '@swampratnz/agent-base/jobs/types.js';
import type { Platform, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/**
 * Staleness threshold (issue #1136 — the sixth and last admin review queue,
 * after `appealStaleAlert.ts`/`knowledgeCandidateStaleAlert.ts`/
 * `reportStaleAlert.ts`/`suggestionStaleAlert.ts`/`accessRequestStaleAlert.ts`,
 * to get a push complement). 168h (7 days) — the same cadence as
 * knowledge-candidates/suggestions/access-requests: a guest who has not been
 * added as a member has no fairness/mute-duration urgency, so reusing that
 * existing precedent is the right fit rather than inventing a new number.
 * Fixed, not configurable: a new env var would be a config-schema
 * (agent-base) change, the same discipline every sibling alert is scoped to
 * avoid.
 */
export const ROSTER_STALE_ALERT_THRESHOLD_HOURS = 168;

/**
 * How many `not_members` rows one tick scans per platform. 200 is
 * `listRoster`'s own hard clamp (`Math.min(Math.max(trunc(limit) || 50, 1),
 * 200)`), so it is the widest scan available from here — the default of 50
 * is far too narrow for a backlog signal, mirroring
 * `APPEAL_STALE_ALERT_SCAN_LIMIT`'s reasoning. `listRoster` orders
 * `COALESCE(left_at, joined_at) DESC`, so a bare call would hand this job
 * the 50 MOST RECENTLY joined not-yet-members and then filter them for the
 * OLDEST — exactly backwards, going quiet precisely as the onboarding
 * backlog it exists to report gets worse.
 */
export const ROSTER_STALE_ALERT_SCAN_LIMIT = 200;

/**
 * `listRoster`'s `days` argument only windows the `'recent'`/`'left'`
 * filters — the `'not_members'` filter (repository.ts) ignores it entirely
 * (`r.left_at IS NULL AND cu.id IS NULL`, no `joined_at` bound), so this
 * value is inert for this call today. Named and passed explicitly anyway
 * rather than left to a default, the same discipline `ROSTER_STALE_ALERT_SCAN_LIMIT`
 * follows, so a future reader — or a future upstream change to what
 * `'not_members'` filters on — doesn't have to re-derive that fact from the
 * repository source to trust that old rows are never windowed out.
 */
const ROSTER_STALE_ALERT_SCAN_DAYS = 90;

/**
 * Bare count + oldest-age-in-hours DM template — deliberately excludes every
 * guest's `displayName`, `userId`, and platform, matching every other
 * digest/alert signal's "bare integers only" convention in this codebase
 * (see `adminDigest.ts`'s `notMembersCount` line). The signature accepts
 * only `(count, oldestAgeHours)`, so a guest-identifying field is
 * unrepresentable by construction.
 */
export function formatRosterStaleAlertMessage(count: number, oldestAgeHours: number): string {
  return (
    `🆕 ${count} guest(s) have been waiting more than ` +
    `${ROSTER_STALE_ALERT_THRESHOLD_HOURS}h to be added as a member (oldest: ${oldestAgeHours}h) — ` +
    'run `list_roster` (filter: not_members) to review.'
  );
}

/** Pure: not_members rows -> the subset older than the threshold, at instant `now`. */
function staleNotMembers(rows: readonly RosterEntry[], now: number): RosterEntry[] {
  const thresholdMs = ROSTER_STALE_ALERT_THRESHOLD_HOURS * 3_600_000;
  return rows.filter((row) => now - row.joinedAt.getTime() >= thresholdMs);
}

/**
 * The platforms this staleness signal means anything on — reusing
 * `adminDigest.ts:1252`'s exact condition (`config.rbac.accessMode[platform]
 * === 'gated'`): an `'open'`-mode `not_members` row already has full
 * member-tool access, so its age is structurally meaningless and alerting on
 * it would just nag. Derived from the connected adapters the job was started
 * with, deduplicated, rather than a hand-maintained platform list.
 */
function gatedPlatforms(adapters: readonly PlatformAdapter[]): Platform[] {
  const platforms = new Set(adapters.map((adapter) => adapter.platform));
  return [...platforms].filter((platform) => config.rbac.accessMode[platform] === 'gated');
}

/**
 * Builds the default `runOnce` for `startRosterStaleAlert`: a guild-wide
 * crossing latch (`persistedCrossingLatch`, shared verbatim by every sibling
 * alert — issue #1198) over the COMBINED count, across every `'gated'`-mode
 * platform, of `not_members` rows whose `joinedAt` age is at least
 * `ROSTER_STALE_ALERT_THRESHOLD_HOURS`, computed fresh each tick from a
 * bounded per-platform `listRoster` scan. Alerts once on the tick the stale
 * count first leaves 0, stays silent while it remains >=1 (including a
 * partial decrease that never reaches 0), and re-arms once every stale guest
 * is added as a member (or leaves) and the count returns to 0. Unlike the
 * pre-#1198 in-memory-only latch, this state now survives a process restart:
 * see `persistedCrossingLatch`'s own doc comment. `listNotMembers`/
 * `listAdminIdentities`/`latchDeps` are injectable so tests can drive the
 * latch across ticks with no real DB and no timers.
 */
export function makeDefaultRosterStaleAlertRun(
  adapters: readonly PlatformAdapter[],
  listNotMembers: (platform: Platform) => Promise<RosterEntry[]> = (platform) =>
    listRoster(platform, 'not_members', ROSTER_STALE_ALERT_SCAN_DAYS, ROSTER_STALE_ALERT_SCAN_LIMIT),
  listAdminIdentities: () => Promise<AdminIdentity[]> = listAdmins,
  latchDeps?: CrossingLatchDeps,
): () => Promise<void> {
  const latch = persistedCrossingLatch(ROSTER_STALE_ALERT_POLICY_KEY, latchDeps);
  return async () => {
    const now = Date.now();
    const platforms = gatedPlatforms(adapters);
    const rowsByPlatform = await Promise.all(platforms.map((platform) => listNotMembers(platform)));
    const stale = staleNotMembers(rowsByPlatform.flat(), now);
    const step = await latch.step(stale.length);
    if (!step.shouldAlert) return;

    const oldestAgeHours = Math.floor(
      Math.max(...stale.map((row) => now - row.joinedAt.getTime())) / 3_600_000,
    );
    logger.warn(
      { count: stale.length, oldestAgeHours },
      'Roster stale alert: stale not_members count crossed zero',
    );
    await alertAdmins(
      adapters,
      formatRosterStaleAlertMessage(stale.length, oldestAgeHours),
      listAdminIdentities,
    );
    await step.commit();
  };
}

/**
 * Stale-onboarding admin nudge (issue #1136) — the always-on push complement
 * to `list_roster`'s (filter: not_members) pull-only view and the weekly
 * `notMembersCount` digest line (#460), and the sixth and last of the admin
 * review queues to get one. Unconditionally enabled, like every sibling
 * alert: no new env var, no config-schema change. Routed through the shared
 * `startTrackedJob` (same cadence as every other job in the registry) so a
 * throwing `runOnce` (e.g. a DB error from `listRoster`) gets the same
 * consecutive-failure alerting for free.
 */
export function startRosterStaleAlert(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultRosterStaleAlertRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('roster-stale-alert', adapters, true, runOnce);
}

// Registry entry (see src/module/jobs/registry.ts) — always on, no enable flag.
export const rosterStaleAlertJob: JobSpec = {
  name: 'roster-stale-alert',
  enabled: () => true,
  start: (adapters) => startRosterStaleAlert(adapters),
};
