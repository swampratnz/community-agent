import { config } from './config.js';
import { logger } from './logger.js';
import { purgeDepartedRoster } from './storage/repository.js';
import { startTrackedJob } from './backgroundJobs.js';
import type { PlatformAdapter } from './platforms/types.js';

const DAY_MS = 24 * 60 * 60_000;

/**
 * Age-based purge of `server_roster` rows for departed members (issue #136).
 * Off unless ROSTER_DEPARTED_RETENTION_DAYS is set. Runs on its own timer,
 * gated only on its own config — independent of INTERACTION_RETENTION_DAYS,
 * so one purge being disabled never suppresses the other. Routed through the
 * shared `startTrackedJob` helper (issue #291) for consecutive-failure
 * alerting; see src/interactionRetention.ts for the matching freshness-guard
 * rationale that keeps the actual purge daily even though `startTrackedJob`
 * itself ticks every 6h.
 */
export function startRosterRetentionPurge(
  adapters: readonly PlatformAdapter[],
  purge: (days: number) => Promise<number> = purgeDepartedRoster,
): ReturnType<typeof setInterval> | null {
  const days = config.behaviour.rosterDepartedRetentionDays;
  let lastRunAt: number | null = null;
  const runOnce = async () => {
    const now = Date.now();
    if (lastRunAt !== null && now - lastRunAt < DAY_MS) return;
    const count = await purge(days);
    lastRunAt = now;
    logger.info({ days, count }, 'Purged departed roster rows (retention policy)');
  };
  return startTrackedJob('roster-retention-purge', adapters, days > 0, runOnce);
}
