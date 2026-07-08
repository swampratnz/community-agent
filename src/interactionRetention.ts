import { config } from './config.js';
import { logger } from './logger.js';
import { purgeOldInteractions } from './storage/repository.js';
import { startTrackedJob } from './backgroundJobs.js';
import type { PlatformAdapter } from './platforms/types.js';

const DAY_MS = 24 * 60 * 60_000;

/**
 * Age-based purge of raw `interactions` (SECURITY.md retention policy). Off
 * unless INTERACTION_RETENTION_DAYS is set. Routed through the shared
 * `startTrackedJob` helper (issue #291) for consecutive-failure alerting,
 * matching the other opt-in background jobs — but `startTrackedJob` ticks
 * every 6h, not daily, so the freshness guard below (skip while the last
 * successful purge is under a day old) keeps the actual purge itself
 * running once daily, same as before #291. A within-the-day tick is a
 * deliberate no-op and counts as a tracker *success*, never a failure —
 * the purge is idempotent, so this is purely about not hammering the DB
 * 4x/day for no benefit, not about correctness.
 */
export function startRetentionPurge(
  adapters: readonly PlatformAdapter[],
  purge: (days: number) => Promise<number> = purgeOldInteractions,
): ReturnType<typeof setInterval> | null {
  const days = config.behaviour.interactionRetentionDays;
  let lastRunAt: number | null = null;
  const runOnce = async () => {
    const now = Date.now();
    if (lastRunAt !== null && now - lastRunAt < DAY_MS) return;
    const count = await purge(days);
    lastRunAt = now;
    logger.info({ days, count }, 'Purged old interactions (retention policy)');
  };
  return startTrackedJob('interaction-retention-purge', adapters, days > 0, runOnce);
}
