import type { Platform } from '@swampratnz/agent-base/platforms/types.js';
import { pool } from '@swampratnz/agent-base/storage/db.js';
import { registerPurgeContributor } from '@swampratnz/agent-base/storage/lifecycle.js';

/**
 * Reads/writes for `connection_outcomes` (issue #1354, the module fragment
 * `schema/87-connection-outcomes.sql`) — the missing OUTCOME signal for
 * `find_helper`/`request_project_connection` (`social.ts`), which are
 * already counted (`helper_notifications`/`project_connection_requests`) and
 * receipted (`find_helper_requests.ts`/`my_submissions`) but never asked
 * whether the handoff actually helped. A module-owned auxiliary table beside
 * those base tables, never mutating them — same "base owns the row, module
 * tracks something alongside it" pattern `findHelperRequests.ts`/
 * `projectNoteRecords.ts` established.
 *
 * Stores direct requester PII (`requester_platform`, `requester_user_id`),
 * so it registers a purge contributor below, the same (platform, userId)-
 * keyed pattern `findHelperRequests.ts` uses.
 */

export type ConnectionOutcomeKind = 'find_helper' | 'project_connection';

/**
 * Record one REAL connection made — call this only from `find_helper`'s
 * `matched` branch or `request_project_connection`'s `sent` branch (issue
 * #1354 acceptance criterion 1), never from a refusal/cap/no-match branch of
 * either tool: this is the follow-up job's own obligation list, and a
 * non-event must never manufacture one. `followup_sent_at`/`outcome`/
 * `responded_at` all start NULL.
 */
export async function recordConnectionOutcome(
  kind: ConnectionOutcomeKind,
  platform: Platform,
  userId: string,
): Promise<void> {
  await pool.query(
    'INSERT INTO connection_outcomes (requester_platform, requester_user_id, kind) VALUES ($1, $2, $3)',
    [platform, userId, kind],
  );
}

export interface DueConnectionOutcomeFollowup {
  id: number;
  requesterPlatform: Platform;
  requesterUserId: string;
}

/**
 * Atomically claims up to `limit` due rows (`followup_sent_at IS NULL` and
 * older than `cutoff`) and stamps `followup_sent_at` on them in the SAME
 * statement — the follow-up job's idempotency guarantee (issue #1354
 * acceptance criterion 2): a row this claims can never be returned to a
 * later run (this tick or a subsequent one), because `followup_sent_at` is
 * no longer NULL the instant this query returns it, regardless of whether
 * the DM that follows actually lands. `FOR UPDATE SKIP LOCKED` additionally
 * makes two concurrent calls (there should never be two, given
 * `startTrackedJob`'s own re-entrancy guard, but this costs nothing) return
 * disjoint row sets rather than double-claiming.
 */
export async function claimDueConnectionOutcomeFollowups(
  cutoff: Date,
  limit = 200,
): Promise<DueConnectionOutcomeFollowup[]> {
  const { rows } = await pool.query<{ id: number; requester_platform: Platform; requester_user_id: string }>(
    `UPDATE connection_outcomes
        SET followup_sent_at = now()
      WHERE id IN (
        SELECT id FROM connection_outcomes
         WHERE followup_sent_at IS NULL AND created_at < $1
         ORDER BY created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, requester_platform, requester_user_id`,
    [cutoff, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    requesterPlatform: r.requester_platform,
    requesterUserId: r.requester_user_id,
  }));
}

export type RateConnectionOutcomeResult = 'recorded' | 'already_recorded' | 'not_found';

/**
 * Self-scoped, write-once rating (issue #1354 acceptance criterion 4) —
 * `rate_connection_outcome`'s entire implementation. Every query below is
 * scoped to the CALLER's own `(platform, userId)`, so this can never read or
 * mutate another member's row:
 *
 *  - the UPDATE only ever touches a row this caller owns AND that has no
 *    `responded_at` yet — a concurrent double-call races into this atomic
 *    claim rather than a check-then-act window;
 *  - if that UPDATE touched nothing, the follow-up SELECT (still scoped to
 *    the caller's own identity) distinguishes "exists but already responded"
 *    (`'already_recorded'`) from "doesn't exist, or belongs to someone else"
 *    (`'not_found'` — deliberately the SAME result for both, so the tool's
 *    reply text can be identical either way and never lets a caller fish for
 *    which id numbers exist).
 */
export async function rateConnectionOutcome(
  id: number,
  platform: Platform,
  userId: string,
  helpful: boolean,
): Promise<RateConnectionOutcomeResult> {
  const outcome = helpful ? 'helpful' : 'not_helpful';
  const { rows: updated } = await pool.query(
    `UPDATE connection_outcomes
        SET outcome = $4, responded_at = now()
      WHERE id = $1 AND requester_platform = $2 AND requester_user_id = $3 AND responded_at IS NULL
      RETURNING id`,
    [id, platform, userId, outcome],
  );
  if (updated.length > 0) return 'recorded';
  const { rows: existing } = await pool.query(
    'SELECT 1 FROM connection_outcomes WHERE id = $1 AND requester_platform = $2 AND requester_user_id = $3',
    [id, platform, userId],
  );
  return existing.length > 0 ? 'already_recorded' : 'not_found';
}

export interface ConnectionOutcomeStats {
  total: number;
  responded: number;
  helpful: number;
}

/**
 * The admin digest's additive aggregate (issue #1354 acceptance criterion
 * 5) — "of N connections made, M reported helpful (of K who responded)"
 * over the same `since` window `adminDigest.ts`'s other flywheel signals
 * use. Bare counts only, guild-wide and unscoped like
 * `countHelperMatchesSince`/`countProjectConnectionsSince` (neither
 * `find_helper` nor `request_project_connection` is conversation-scoped).
 */
export async function countConnectionOutcomesSince(since: Date): Promise<ConnectionOutcomeStats> {
  const { rows } = await pool.query<{ total: string; responded: string; helpful: string }>(
    `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE responded_at IS NOT NULL) AS responded,
        COUNT(*) FILTER (WHERE outcome = 'helpful') AS helpful
      FROM connection_outcomes
      WHERE created_at >= $1`,
    [since],
  );
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    responded: Number(row?.responded ?? 0),
    helpful: Number(row?.helpful ?? 0),
  };
}

// --- Lifecycle registration (storage/lifecycle.ts) --------------------------
registerPurgeContributor({
  name: 'connection_outcomes',
  order: 230,
  async purge({ platform, userId }, tx) {
    const { rowCount } = await tx.query(
      'DELETE FROM connection_outcomes WHERE requester_platform = $1 AND requester_user_id = $2',
      [platform, userId],
    );
    return rowCount ?? 0;
  },
});
