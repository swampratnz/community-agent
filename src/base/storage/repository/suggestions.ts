import type { Platform } from '../../platforms/types.js';
import { pool } from '../db.js';
import { registerPurgeContributor } from '../lifecycle.js';

/**
 * Member-submitted bot-improvement suggestions (#46) — the queue admins triage
 * via list_suggestions / resolve_suggestion.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Suggestions (member-submitted bot-improvement queue, issue #46) ---------

/** Per-user cap on new suggestions within a rolling 24h window (anti-spam on the admin queue). */
export const SUGGESTION_RATE_LIMIT_PER_DAY = 3;
export const SUGGESTION_MAX_CHARS = 1000;

export type SuggestionStatus = 'new' | 'reviewed' | 'declined' | 'done';

export interface Suggestion {
  id: number;
  platform: Platform;
  userId: string;
  displayName: string | null;
  content: string;
  status: SuggestionStatus;
  createdAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

/**
 * Record a member's suggestion, enforcing a DB-backed rolling-24h cap per
 * user (COUNT(*) inside the insert, same restart-proof pattern as
 * createContentReport — never an in-memory or model-supplied counter).
 * Returns null when the caller is at/over the cap; the tool layer turns
 * that into a polite refusal.
 */
export async function createSuggestion(input: {
  platform: Platform;
  userId: string;
  displayName?: string;
  content: string;
}): Promise<{ id: number } | null> {
  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT count(*) AS n FROM suggestions
        WHERE platform = $1 AND user_id = $2
          AND created_at > now() - interval '24 hours'
     )
     INSERT INTO suggestions (platform, user_id, display_name, content)
     SELECT $1, $2, $3, $4
      WHERE (SELECT n FROM recent) < $5
     RETURNING id`,
    [
      input.platform,
      input.userId,
      input.displayName ?? null,
      input.content.slice(0, SUGGESTION_MAX_CHARS),
      SUGGESTION_RATE_LIMIT_PER_DAY,
    ],
  );
  return rows[0] ? { id: Number(rows[0].id) } : null;
}

/**
 * Admin-tier read of the shared suggestion queue, unscoped by submitter — a
 * member's own-only view is `listOwnSuggestions` below, not this function.
 */
export async function listSuggestions(status?: SuggestionStatus, limit = 50): Promise<Suggestion[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const params: unknown[] = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE status = $${params.length}`;
  }
  params.push(clampedLimit);
  const { rows } = await pool.query(
    `SELECT id, platform, user_id, display_name, content, status, created_at, reviewed_by, reviewed_at
       FROM suggestions
       ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    platform: r.platform as Platform,
    userId: r.user_id,
    displayName: r.display_name,
    content: r.content,
    status: r.status as SuggestionStatus,
    createdAt: r.created_at,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
  }));
}

/**
 * Exact pending-suggestion count — a dedicated `COUNT(*)` rather than
 * `(await listSuggestions('new')).length`, which would silently understate a
 * backlog past that function's `limit` (default 50) cap, same reasoning as
 * `countAccessRequests`/`countOpenReports` (issue #133).
 */
export async function countPendingSuggestions(): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*) AS n FROM suggestions WHERE status = 'new'`);
  return Number(rows[0].n);
}

/**
 * Whole-day age of the oldest still-pending suggestion — the same
 * `MIN(created_at)` oldest-age mechanic `oldestAccessRequestAgeDays` (#515)
 * applies to access requests, over exactly the `status = 'new'` row set
 * `countPendingSuggestions` counts (issue #450). Guild-wide, unscoped, matching
 * its sibling count. `MIN` over an empty (all-reviewed) set is `null`, never
 * `0`, and is returned as-is so a digest reader can never mistake "no pending
 * suggestions" for "one that just arrived".
 */
export async function oldestPendingSuggestionAgeDays(): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT EXTRACT(DAY FROM now() - MIN(created_at))::int AS age_days FROM suggestions WHERE status = 'new'`,
  );
  const ageDays = rows[0]?.age_days;
  return ageDays === null || ageDays === undefined ? null : Number(ageDays);
}

/**
 * Self-scoped read of a member's OWN suggestions — the only member-reachable
 * read of this table (the shared queue itself stays admin-only; see the doc
 * comment on listSuggestions above). Same query shape as listSuggestions with
 * `user_id = $2` appended, the same one-predicate-append technique
 * withdrawOwnReports uses to narrow listReports's admin-scoped query down to
 * the caller's own identity.
 */
export async function listOwnSuggestions(
  platform: Platform,
  userId: string,
  limit = 10,
): Promise<Suggestion[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
  const { rows } = await pool.query(
    `SELECT id, platform, user_id, display_name, content, status, created_at, reviewed_by, reviewed_at
       FROM suggestions
      WHERE platform = $1 AND user_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [platform, userId, clampedLimit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    platform: r.platform as Platform,
    userId: r.user_id,
    displayName: r.display_name,
    content: r.content,
    status: r.status as SuggestionStatus,
    createdAt: r.created_at,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
  }));
}

/**
 * Flip a suggestion's status once triaged. Returns the resolved row's
 * platform/userId/content (so the caller can notify the submitter) or null
 * if no row matched — same "no match" signal the old boolean return gave.
 */
export async function resolveSuggestion(
  id: number,
  status: Exclude<SuggestionStatus, 'new'>,
  reviewedBy: string,
): Promise<{ platform: Platform; userId: string; content: string } | null> {
  const { rows } = await pool.query(
    `UPDATE suggestions SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1
     RETURNING platform, user_id, content`,
    [id, status, reviewedBy],
  );
  return rows[0]
    ? { platform: rows[0].platform as Platform, userId: rows[0].user_id, content: rows[0].content }
    : null;
}

// --- Lifecycle registration (storage/lifecycle.ts) ---------------------------

registerPurgeContributor({
  name: 'suggestions',
  order: 50,
  async purge({ platform, userId }, tx) {
    const { rowCount: suggestions } = await tx.query(
      `DELETE FROM suggestions WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    return suggestions ?? 0;
  },
  async summarize({ platform, userId }, db) {
    const { rows: suggestionRows } = await db.query(
      `SELECT count(*) AS n FROM suggestions WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    return { suggestionsFiled: Number(suggestionRows[0]?.n ?? 0) };
  },
});
