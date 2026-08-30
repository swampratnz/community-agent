import { config } from '@swampratnz/agent-base/config.js';
import { logger } from '@swampratnz/agent-base/logger.js';
import { listAdminRoster, type AdminRosterEntry } from '@swampratnz/agent-base/storage/repository.js';
import { startTrackedJob } from '@swampratnz/agent-base/jobs/trackedJob.js';
import { alertSuperAdmins as sendSuperAdminAlert } from '@swampratnz/agent-base/notifications.js';
import { persistedCrossingLatch, type CrossingLatchDeps } from './crossingLatch.js';
import { DEPARTED_ADMIN_ALERT_POLICY_KEY } from './storage/policies.js';
import type { JobSpec } from '@swampratnz/agent-base/jobs/types.js';
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/**
 * Bare-count DM template (issue #472) — deliberately excludes which admin(s)
 * departed (that's the named, deferred growth path): a display name,
 * platform user id, or platform string must never appear here, matching
 * every other digest/alert signal's "bare integer only" convention in this
 * codebase.
 */
export function formatDepartedAdminAlertMessage(count: number): string {
  return (
    `⚠️ ${count} admin(s) have left the server/group but still hold bot-admin privilege — ` +
    'run `list_admins` to review and `revoke_admin` if appropriate.'
  );
}

/**
 * Builds the default `runOnce` for `startDepartedAdminAlert`, closing a
 * threshold-1 latch (`persistedCrossingLatch`, shared verbatim by every
 * sibling alert — issue #1198; the original in-memory shape here, per the
 * adversarial-review note on issue #472, is what every later sibling copied)
 * over one `listAdminRoster()` call per tick. `listRoster`/`latchDeps` are
 * injectable so tests can drive the latch across ticks without a real DB —
 * production always uses the defaults (the exported `listAdminRoster` and
 * the real policy store).
 *
 * The underlying `stepUsageAlertTracker(tracker, count, 1)` gives exactly the
 * latch this signal needs: `count < 1` (i.e. `count === 0`) is "not crossed"
 * (silently re-arms), any `count >= 1` is "crossed" and alerts only on the
 * tick that first left the `count === 0` state — a partial decrease (e.g.
 * 3 -> 1, never reaching 0) never re-arms, since it never satisfies
 * `count < 1`. Unlike the pre-#1198 in-memory-only latch, this state now
 * survives a process restart: see `persistedCrossingLatch`'s own doc
 * comment.
 *
 * `alertSuperAdmins` is now awaited (previously `void alertSuperAdmins(...)`,
 * fire-and-forget) so the persisted marker write can follow "the fan-out
 * returned", the same ordering every sibling alert uses. This changes
 * nothing about actual DM delivery timing: `alertSuperAdmins` fires each
 * recipient's `sendDirectMessage` without awaiting it internally (per-
 * recipient isolation, `notifications.ts`), so its own returned promise was
 * already settling on the same tick whether or not a caller awaited it.
 */
export function makeDefaultDepartedAdminAlertRun(
  adapters: readonly PlatformAdapter[],
  listRoster: () => Promise<AdminRosterEntry[]> = listAdminRoster,
  latchDeps?: CrossingLatchDeps,
): () => Promise<void> {
  const latch = persistedCrossingLatch(DEPARTED_ADMIN_ALERT_POLICY_KEY, latchDeps);
  return async () => {
    const roster = await listRoster();
    const count = roster.filter((entry) => entry.leftServer).length;
    const step = await latch.step(count);
    if (step.shouldAlert) {
      logger.warn({ count }, 'Departed-admin alert: departed-but-still-admin count crossed zero');
      await alertSuperAdmins(adapters, formatDepartedAdminAlertMessage(count));
      await step.commit();
    }
  };
}

/**
 * Departed-admin visibility alert (issue #472), off unless
 * `DEPARTED_ADMIN_ALERT_ENABLED`. Closes #428's own named deferred growth
 * path: `listAdminRoster()`/`list_admins` already compute and surface
 * `leftServer` per admin, but only on pull (a super admin has to think to
 * run `list_admins`) — this adds the missing push, DMing every super admin
 * once when the departed-but-still-admin count first becomes non-zero.
 * Routed through the shared `startTrackedJob` (same 6h cadence as every
 * other opt-in job in `backgroundJobs.ts`) so a throwing `runOnce` (e.g. a
 * DB error from `listAdminRoster`) gets the same consecutive-failure
 * alerting for free, instead of a bespoke tracker.
 */
export function startDepartedAdminAlert(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultDepartedAdminAlertRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('departed-admin-alert', adapters, config.departedAdminAlert.enabled, runOnce);
}

// Registry entry (see src/module/jobs/registry.ts) — gate mirrors startDepartedAdminAlert's own flag.
export const departedAdminAlertJob: JobSpec = {
  name: 'departed-admin-alert',
  enabled: (cfg) => cfg.departedAdminAlert.enabled,
  start: (adapters) => startDepartedAdminAlert(adapters),
};

/**
 * Exported (issue #568) so `engagementAlert.ts`/`adminLeverageAlert.ts` can
 * reuse this exact super-admin-only, connected-adapters-only fan-out by
 * import rather than a second copy — the adversarial-review note on #568 pins
 * this as those jobs' shared entry point for "super admins only" DM delivery.
 * The delivery mechanics themselves now live in `notifications.ts`'s
 * `alertSuperAdmins` (the codebase-wide single source of truth), so a
 * delivery fix like #593's disconnect handling reaches every producer by
 * construction, not by duplicating the fix.
 */
export async function alertSuperAdmins(adapters: readonly PlatformAdapter[], message: string): Promise<void> {
  await sendSuperAdminAlert(adapters, message, {
    label: 'Departed-admin alert',
    queueWhenDisconnected: true,
  });
}
