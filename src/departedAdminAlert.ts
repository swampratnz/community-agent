import { config } from './config.js';
import { logger } from './logger.js';
import { superAdminIds } from './auth/roles.js';
import { listAdminRoster, type AdminRosterEntry } from './storage/repository.js';
import { startTrackedJob } from './backgroundJobs.js';
import { initialUsageAlertTracker, stepUsageAlertTracker } from './usageAlert.js';
import { queuePendingAlert } from './pendingAlertQueue.js';
import type { PlatformAdapter } from './platforms/types.js';

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
 * threshold-1 latch (reusing `usageAlert.ts`'s own pure `stepUsageAlertTracker`
 * by import rather than copy, per the adversarial-review note on issue #472)
 * over one `listAdminRoster()` call per tick. `listRoster` is injectable so
 * tests can drive the latch across ticks without a real DB — production
 * always uses the default, already-exported `listAdminRoster`.
 *
 * `stepUsageAlertTracker(tracker, count, 1)` gives exactly the latch this
 * signal needs: `count < 1` (i.e. `count === 0`) is "not crossed" (silently
 * re-arms), any `count >= 1` is "crossed" and alerts only on the tick that
 * first left the `count === 0` state — a partial decrease (e.g. 3 -> 1,
 * never reaching 0) never re-arms, since it never satisfies `count < 1`.
 */
export function makeDefaultDepartedAdminAlertRun(
  adapters: readonly PlatformAdapter[],
  listRoster: () => Promise<AdminRosterEntry[]> = listAdminRoster,
): () => Promise<void> {
  let tracker = initialUsageAlertTracker();
  return async () => {
    const roster = await listRoster();
    const count = roster.filter((entry) => entry.leftServer).length;
    const step = stepUsageAlertTracker(tracker, count, 1);
    tracker = step.tracker;
    if (step.shouldAlert) {
      logger.warn({ count }, 'Departed-admin alert: departed-but-still-admin count crossed zero');
      void alertSuperAdmins(adapters, formatDepartedAdminAlertMessage(count));
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

/**
 * Exported (issue #568) so `engagementAlert.ts` can reuse this exact
 * super-admin-only, connected-adapters-only fan-out by import rather than a
 * second copy — the adversarial-review note on #568 pins this as the single
 * source of truth for "super admins only" DM delivery across both jobs. That
 * makes this function's disconnect-handling (issue #593) apply to both
 * producers by construction, not by duplicating the fix.
 */
export async function alertSuperAdmins(adapters: readonly PlatformAdapter[], message: string): Promise<void> {
  const connected = adapters.filter((adapter) => adapter.isConnected());
  if (connected.length === 0) {
    logger.warn(
      { message },
      'Departed-admin alert could not be delivered live — no connected adapter; queued for flush on reconnect',
    );
    queuePendingAlert(message, 'system'); // super-admin-only alert — never evicted by a member-reachable alert (#545)
    return;
  }
  for (const adapter of connected) {
    for (const id of superAdminIds(adapter.platform)) {
      adapter
        .sendDirectMessage(id, message)
        .catch((err) =>
          logger.warn({ err, platform: adapter.platform, id }, 'Departed-admin alert DM failed'),
        );
    }
  }
}
