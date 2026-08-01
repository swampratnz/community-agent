import { config } from './config.js';
import { logger } from './logger.js';
import { purgeOldAccessRequests } from './storage/repository.js';
import { startTrackedJob } from './backgroundJobs.js';
import type { PlatformAdapter } from './platforms/types.js';

const DAY_MS = 24 * 60 * 60_000;

/**
 * Age-based purge of stale pending `access_requests` rows (issue #939). Off
 * unless ACCESS_REQUEST_RETENTION_DAYS is set. Runs on its own timer, gated
 * only on its own config — independent of INTERACTION_RETENTION_DAYS and
 * ROSTER_DEPARTED_RETENTION_DAYS, so one purge being disabled never suppresses
 * another. Routed through the shared `startTrackedJob` helper (issue #291) for
 * consecutive-failure alerting; see src/interactionRetention.ts for the
 * matching freshness-guard rationale that keeps the actual purge daily even
 * though `startTrackedJob` itself ticks every 6h.
 *
 * This is the third of the three retention sweeps and closes the last PII
 * store that had no expiry at all: an approved requester's row is deleted by
 * `clearAccessRequest`, but a NEVER-approved one used to live forever. See
 * `purgeOldAccessRequests` for why the clock runs off `last_requested_at`.
 */
export function startAccessRequestRetentionPurge(
  adapters: readonly PlatformAdapter[],
  purge: (days: number) => Promise<number> = purgeOldAccessRequests,
): ReturnType<typeof setInterval> | null {
  const days = config.behaviour.accessRequestRetentionDays;
  let lastRunAt: number | null = null;
  const runOnce = async () => {
    const now = Date.now();
    if (lastRunAt !== null && now - lastRunAt < DAY_MS) return;
    const count = await purge(days);
    lastRunAt = now;
    logger.info({ days, count }, 'Purged stale pending access requests (retention policy)');
  };
  return startTrackedJob('access-request-retention-purge', adapters, days > 0, runOnce);
}
