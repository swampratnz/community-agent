import { logger } from './logger.js';
import { superAdminIds } from './auth/roles.js';
import { queuePendingAlert } from './pendingAlertQueue.js';
import { WindowClosedError } from './platforms/types.js';
import type { PlatformAdapter } from './platforms/types.js';

/**
 * Per-producer options for `alertSuperAdmins`. The two fields are exactly the
 * two axes the six pre-consolidation copies had drifted on — everything else
 * (recipient set, per-recipient fire-and-forget sends, WindowClosedError →
 * queueForWindowReopen handling) was already identical across all of them.
 */
export interface SuperAdminAlertOptions {
  /**
   * Log label, e.g. 'Usage alert' — appears verbatim in every log line this
   * fan-out emits, so operators can attribute a failed or queued DM to its
   * producer without a stack trace.
   */
  label: string;
  /**
   * What to do when EVERY adapter is disconnected: `true` queues the message
   * via `queuePendingAlert` for flush on reconnect (reactive alerts that fire
   * once per condition — a missed one is gone for good); `false` drops it
   * silently (periodic digests/cost alerts whose next scheduled run
   * re-reports from source data anyway, so queueing would deliver stale
   * numbers after an outage).
   */
  queueWhenDisconnected: boolean;
}

/**
 * The one super-admin DM fan-out — the single source of truth for "super
 * admins only" alert delivery, replacing six per-module copies (health,
 * backgroundJobs, usageAlert, departedAdminAlert, usageCostDigest,
 * backgroundJobCostAlert) that had drifted on the two axes captured in
 * `SuperAdminAlertOptions`. Producers keep a thin, purpose-named wrapper
 * binding their label and disconnect policy, so their call sites and tests
 * are unchanged and a future delivery fix (like #593's disconnect handling
 * or #888's window-reopen queueing) lands here once, for every producer.
 *
 * SECURITY: the recipient set is `superAdminIds` — derived from env config,
 * never from message content or the DB — and a queued message goes in at
 * 'system' priority, which `pendingAlertQueue` never evicts for a
 * member-reachable alert (#545). Sends are fire-and-forget per recipient: one
 * closed WhatsApp window (queued for reopen via `queueForWindowReopen`) or
 * one failed DM (logged) never blocks delivery to the rest.
 */
export async function alertSuperAdmins(
  adapters: readonly PlatformAdapter[],
  message: string,
  opts: SuperAdminAlertOptions,
): Promise<void> {
  const connected = adapters.filter((adapter) => adapter.isConnected());
  if (connected.length === 0) {
    if (opts.queueWhenDisconnected) {
      logger.warn(
        { message },
        `${opts.label} could not be delivered live — no connected adapter; queued for flush on reconnect`,
      );
      queuePendingAlert(message, 'system'); // super-admin-only alert — never evicted by a member-reachable alert (#545)
    }
    return;
  }
  for (const adapter of connected) {
    for (const id of superAdminIds(adapter.platform)) {
      adapter.sendDirectMessage(id, message).catch((err) => {
        if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
          adapter.queueForWindowReopen(id, message, 'system');
          logger.warn(
            { platform: adapter.platform, id },
            `${opts.label}: recipient window closed, queued for reopen`,
          );
          return;
        }
        logger.warn({ err, platform: adapter.platform, id }, `${opts.label} DM failed`);
      });
    }
  }
}

/**
 * Factory for the guild-wide rolling-hour alert-slot reserver — the one
 * sliding window behind every keyless admin-alert rate cap, replacing five
 * identical private copies in `router.ts` (access-request, knowledge-gap,
 * stale-knowledge, repeat-question, escalation) and the mirror copy in
 * `moderation/moderator.ts`. Each call returns an independent window with its
 * own private timestamp state, so distinct alert categories can never consume
 * each other's slots. The returned reserver prunes entries older than an hour
 * on every call (no external sweep needed), returns false without reserving
 * once `limit` is reached inside the window, and is deliberately keyless —
 * guild-wide, matching the guild-wide admin audience of every caller; the
 * per-conversation-keyed reservers in `agent/tools.ts` are a different shape
 * and stay put.
 */
export function makeAlertSlotReserver(): (limit: number) => boolean {
  const timestamps: number[] = [];
  return (limit: number): boolean => {
    const now = Date.now();
    const recent = timestamps.filter((t) => now - t < 3_600_000);
    timestamps.length = 0;
    timestamps.push(...recent);
    if (recent.length >= limit) return false;
    timestamps.push(now);
    return true;
  };
}
