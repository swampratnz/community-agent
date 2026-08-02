import { config } from './config.js';
import { logger } from './logger.js';
import { purgeDepartedRoster, purgeOldAccessRequests, purgeOldInteractions } from './storage/repository.js';
import { startTrackedJob } from './backgroundJobs.js';
import type { BackgroundJobName } from './backgroundJobHealth.js';
import type { PlatformAdapter } from './platforms/types.js';

const DAY_MS = 24 * 60 * 60_000;

/**
 * The one parameterised retention sweep behind all three age-based purges
 * (interactions, departed roster rows, stale pending access requests) —
 * previously three byte-similar modules. Each purge stays gated only on its
 * OWN `days` config, so one being disabled never suppresses another (issue
 * #136's adversarial-review requirement, re-pinned by #939). Routed through
 * the shared `startTrackedJob` helper (issue #291) for consecutive-failure
 * alerting — but `startTrackedJob` ticks every 6h, not daily, so the
 * freshness guard below (skip while the last successful purge is under a
 * day old) keeps the actual purge itself running once daily. A
 * within-the-day tick is a deliberate no-op and counts as a tracker
 * *success*, never a failure — the purges are idempotent, so this is purely
 * about not hammering the DB 4x/day for no benefit, not about correctness.
 */
function startRetentionJob(
  adapters: readonly PlatformAdapter[],
  opts: {
    jobName: BackgroundJobName;
    days: number;
    purge: (days: number) => Promise<number>;
    logMessage: string;
  },
): ReturnType<typeof setInterval> | null {
  const { jobName, days, purge, logMessage } = opts;
  let lastRunAt: number | null = null;
  const runOnce = async () => {
    const now = Date.now();
    if (lastRunAt !== null && now - lastRunAt < DAY_MS) return;
    const count = await purge(days);
    lastRunAt = now;
    logger.info({ days, count }, logMessage);
  };
  return startTrackedJob(jobName, adapters, days > 0, runOnce);
}

/**
 * Age-based purge of raw `interactions` (SECURITY.md retention policy) —
 * the enforcement half of the retention promise there. Off unless
 * INTERACTION_RETENTION_DAYS is set.
 */
export function startRetentionPurge(
  adapters: readonly PlatformAdapter[],
  purge: (days: number) => Promise<number> = purgeOldInteractions,
): ReturnType<typeof setInterval> | null {
  return startRetentionJob(adapters, {
    jobName: 'interaction-retention-purge',
    days: config.behaviour.interactionRetentionDays,
    purge,
    logMessage: 'Purged old interactions (retention policy)',
  });
}

/**
 * Age-based purge of `server_roster` rows for departed members (issue
 * #136). Off unless ROSTER_DEPARTED_RETENTION_DAYS is set.
 */
export function startRosterRetentionPurge(
  adapters: readonly PlatformAdapter[],
  purge: (days: number) => Promise<number> = purgeDepartedRoster,
): ReturnType<typeof setInterval> | null {
  return startRetentionJob(adapters, {
    jobName: 'roster-retention-purge',
    days: config.behaviour.rosterDepartedRetentionDays,
    purge,
    logMessage: 'Purged departed roster rows (retention policy)',
  });
}

/**
 * Age-based purge of stale pending `access_requests` rows (issue #939). Off
 * unless ACCESS_REQUEST_RETENTION_DAYS is set. This closed the last PII
 * store that had no expiry at all: an approved requester's row is deleted by
 * `clearAccessRequest`, but a never-approved one used to live forever. See
 * `purgeOldAccessRequests` for why the clock runs off `last_requested_at`.
 */
export function startAccessRequestRetentionPurge(
  adapters: readonly PlatformAdapter[],
  purge: (days: number) => Promise<number> = purgeOldAccessRequests,
): ReturnType<typeof setInterval> | null {
  return startRetentionJob(adapters, {
    jobName: 'access-request-retention-purge',
    days: config.behaviour.accessRequestRetentionDays,
    purge,
    logMessage: 'Purged stale pending access requests (retention policy)',
  });
}
