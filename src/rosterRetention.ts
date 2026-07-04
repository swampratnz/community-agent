import { config } from './config.js';
import { logger } from './logger.js';
import { purgeDepartedRoster } from './storage/repository.js';

const DAY_MS = 24 * 60 * 60_000;

/**
 * Age-based purge of `server_roster` rows for departed members (issue #136).
 * Off unless ROSTER_DEPARTED_RETENTION_DAYS is set. Runs on its own timer,
 * gated only on its own config — independent of INTERACTION_RETENTION_DAYS,
 * so one purge being disabled never suppresses the other. Same
 * immediate-run-then-daily cadence as the interactions retention purge in
 * src/index.ts.
 */
export function startRosterRetentionPurge(): ReturnType<typeof setInterval> | null {
  const days = config.behaviour.rosterDepartedRetentionDays;
  if (days <= 0) return null;
  const run = () => {
    purgeDepartedRoster(days)
      .then((count) => logger.info({ days, count }, 'Purged departed roster rows (retention policy)'))
      .catch((err) => logger.error({ err }, 'Roster retention purge failed'));
  };
  run();
  const timer = setInterval(run, DAY_MS);
  timer.unref();
  return timer;
}
