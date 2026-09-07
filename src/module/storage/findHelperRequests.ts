import type { Platform } from '@swampratnz/agent-base/platforms/types.js';
import { pool } from '@swampratnz/agent-base/storage/db.js';
import { registerPurgeContributor } from '@swampratnz/agent-base/storage/lifecycle.js';

/**
 * Reads/writes for `find_helper_requests` (issue #1313, the module fragment
 * `schema/84-find-helper-requests.sql`) — the caller's own `find_helper`
 * receipt, the pull-based history `my_submissions` already gives every other
 * rate-capped member-write (`request_project_connection` got theirs in
 * #908). A module-owned auxiliary table beside the base
 * `helper_notifications` table, never mutating it — same "base owns the row,
 * module tracks something alongside it" pattern `accessRequestResolutions.ts`
 * established.
 *
 * Unlike `suggestionWithdrawals.ts`/`appealWithdrawals.ts`/
 * `accessRequestResolutions.ts`, this table stores direct requester PII
 * (`requester_platform`, `requester_user_id`, `topic`), so it registers a
 * purge contributor below rather than staying silent like those three
 * identity-free siblings — the same `(platform, userId)`-keyed pattern
 * `knowledge_gaps` uses.
 */

/**
 * Record one REAL `find_helper` ask — call this only after the matched or
 * noMatch branch has resolved, never on the `disabled`/`dailyCap`
 * early-returns (issue #1313 SECURITY criterion 3). Never logs the matched
 * candidate's identity: `find_helper`'s non-disclosure guarantee (`social.ts`)
 * means only the caller's own topic text and the boolean outcome are stored.
 */
export async function recordFindHelperRequest(
  platform: Platform,
  userId: string,
  topic: string,
  matched: boolean,
): Promise<void> {
  await pool.query(
    'INSERT INTO find_helper_requests (requester_platform, requester_user_id, topic, matched) VALUES ($1, $2, $3, $4)',
    [platform, userId, topic, matched],
  );
}

export interface FindHelperRequestReceipt {
  id: number;
  topic: string;
  matched: boolean;
  createdAt: Date;
}

/**
 * Self-scoped read of a member's OWN `find_helper` asks — the `my_submissions`
 * receipt this table exists for. Newest-first, clamped the same way
 * `listOwnProjectConnectionRequests` is.
 */
export async function listOwnFindHelperRequests(
  platform: Platform,
  userId: string,
  limit = 10,
): Promise<FindHelperRequestReceipt[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
  const { rows } = await pool.query<{ id: number; topic: string; matched: boolean; created_at: Date }>(
    `SELECT id, topic, matched, created_at FROM find_helper_requests
      WHERE requester_platform = $1 AND requester_user_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [platform, userId, clampedLimit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    topic: r.topic,
    matched: r.matched,
    createdAt: r.created_at,
  }));
}

// --- Lifecycle registration (storage/lifecycle.ts) --------------------------
registerPurgeContributor({
  name: 'find_helper_requests',
  order: 120,
  async purge({ platform, userId }, tx) {
    const { rowCount } = await tx.query(
      'DELETE FROM find_helper_requests WHERE requester_platform = $1 AND requester_user_id = $2',
      [platform, userId],
    );
    return rowCount ?? 0;
  },
});
