import type { Platform } from '../../platforms/types.js';
import { pool } from '../db.js';
import { registerPurgeContributor } from '../lifecycle.js';

/**
 * Durable completion-DM watches for the super-admin `dev_team_dispatch` tool.
 * The poller in src/backgroundJobs.ts reads the unnotified rows, DMs the
 * requester when the dispatched job reaches a terminal state, and only then
 * stamps `notified_at` — so a failed send retries on the next tick rather than
 * being lost, and a succeeded one is never sent twice.
 *
 * Extracted verbatim from repository.ts (see repository.ts's header for why the
 * split exists); `repository.ts` re-exports everything here, so every existing
 * import site is unchanged.
 */

export interface DevTeamWatchInput {
  jobId: string;
  requesterPlatform: Platform;
  requesterUserId: string;
  mode: string;
  repo: string;
}

export interface DevTeamWatch {
  jobId: string;
  requesterPlatform: Platform;
  requesterUserId: string;
  mode: string;
  repo: string;
}

/**
 * Record a durable watch so the requester gets a completion DM once the
 * dispatched job reaches a terminal state (see the poller in
 * src/backgroundJobs.ts). `ON CONFLICT (job_id) DO NOTHING` makes a repeated
 * dispatch of the same id idempotent rather than an error.
 */
export async function insertDevTeamWatch(input: DevTeamWatchInput): Promise<void> {
  await pool.query(
    `INSERT INTO dev_team_watches (job_id, requester_platform, requester_user_id, mode, repo)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_id) DO NOTHING`,
    [input.jobId, input.requesterPlatform, input.requesterUserId, input.mode, input.repo],
  );
}

/** Watches whose job has not yet had its completion DM sent, oldest first. */
export async function listUnnotifiedDevTeamWatches(): Promise<DevTeamWatch[]> {
  const { rows } = await pool.query(
    `SELECT job_id, requester_platform, requester_user_id, mode, repo
       FROM dev_team_watches
      WHERE notified_at IS NULL
      ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    jobId: r.job_id,
    requesterPlatform: r.requester_platform as Platform,
    requesterUserId: r.requester_user_id,
    mode: r.mode,
    repo: r.repo,
  }));
}

/**
 * Stamp a watch as notified so its completion DM is never sent twice — the
 * poller calls this only AFTER a successful `sendDirectMessage`, so a failed
 * send leaves the row unnotified for the next tick to retry.
 */
export async function markDevTeamWatchNotified(jobId: string): Promise<void> {
  await pool.query(`UPDATE dev_team_watches SET notified_at = now() WHERE job_id = $1`, [jobId]);
}

// --- Lifecycle registration (storage/lifecycle.ts) ---------------------------

registerPurgeContributor({
  name: 'dev_team_watches',
  order: 120,
  async purge({ platform, userId }, tx) {
    // dev_team_watches (super-admin dev-team dispatches) is keyed on the same
    // (platform, user id) identity — purge coherence for a requester's
    // job-watch rows (which record the repo/mode/job id they dispatched).
    const { rowCount: devTeamWatches } = await tx.query(
      `DELETE FROM dev_team_watches WHERE requester_platform = $1 AND requester_user_id = $2`,
      [platform, userId],
    );
    return devTeamWatches ?? 0;
  },
});
