import type { Platform } from '../../platforms/types.js';
import { logger } from '../../logger.js';
import { pool } from '../db.js';

/**
 * Server-roster persistence: who is currently in the guild, join/leave
 * transitions, and the departed-member rows the retention sweep prunes.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Server roster (join/leave persistence) ----------------------------------

/**
 * Upsert a roster row for someone present in the server. Used by both the
 * join event and the startup backfill, so it must be idempotent for an
 * already-present user: display name refreshes, nothing else moves. A user
 * whose row is marked left re-activates as a rejoin (left_at cleared,
 * rejoined_count bumped, joined_at reset to now). Identity metadata only —
 * callers must never pass message content (SECURITY.md invariant).
 */
export async function upsertRosterMember(input: {
  platform: Platform;
  userId: string;
  displayName?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO server_roster (platform, user_id, display_name)
     VALUES ($1,$2,$3)
     ON CONFLICT (platform, user_id) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, server_roster.display_name),
       rejoined_count = CASE
         WHEN server_roster.left_at IS NOT NULL
         THEN server_roster.rejoined_count + 1 ELSE server_roster.rejoined_count END,
       joined_at = CASE
         WHEN server_roster.left_at IS NOT NULL THEN now() ELSE server_roster.joined_at END,
       left_at = NULL`,
    [input.platform, input.userId, input.displayName ?? null],
  );
}

/**
 * Mark a roster row as left. No-op (false) if unknown or already marked left.
 * Also removes the departed member's shared projects (issue #646) and
 * published interests (issue #634): unlike most member-owned data (which
 * stays until an explicit forget_me/purge — membership alone isn't a privacy
 * request), both are PUBLISHED artifacts whose premise is "a current member
 * of this community built/is into this" — once they've left, showing them to
 * remaining members as if they were still around is misleading, so they go
 * with them automatically, same as each feature's stated lifecycle.
 */
export async function markRosterLeave(platform: Platform, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE server_roster SET left_at = now()
      WHERE platform = $1 AND user_id = $2 AND left_at IS NULL`,
    [platform, userId],
  );
  const left = (rowCount ?? 0) > 0;
  if (left) {
    await pool
      .query(`DELETE FROM member_projects WHERE platform = $1 AND user_id = $2`, [platform, userId])
      .catch((err) => logger.warn({ err, platform }, 'Roster-leave member_projects cleanup failed'));
    await pool
      .query(`DELETE FROM member_interests WHERE platform = $1 AND user_id = $2`, [platform, userId])
      .catch((err) => logger.warn({ err, platform }, 'Roster-leave member_interests cleanup failed'));
    // helper_notifications (issue #729) rides along the same departure, in
    // EITHER role — a departed member's find_helper handoff log (as helper
    // or requester) shouldn't linger once member_interests/member_projects
    // above are already gone for them.
    await pool
      .query(
        `DELETE FROM helper_notifications
          WHERE (helper_platform = $1 AND helper_user_id = $2)
             OR (requester_platform = $1 AND requester_user_id = $2)`,
        [platform, userId],
      )
      .catch((err) => logger.warn({ err, platform }, 'Roster-leave helper_notifications cleanup failed'));
  }
  return left;
}

export type RosterFilter = 'recent' | 'not_members' | 'left' | 'all';

export interface RosterEntry {
  userId: string;
  displayName: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  rejoinedCount: number;
  isMember: boolean;
}

/**
 * Roster view for admins. Deliberately guild-wide, not conversation-scoped —
 * the roster is the same member list every server member already sees
 * (documented in SECURITY.md alongside list_access_requests). 'not_members'
 * is the onboarding queue: present in the server but never added to
 * community_users.
 */
export async function listRoster(
  platform: Platform,
  filter: RosterFilter = 'recent',
  days = 7,
  limit = 50,
): Promise<RosterEntry[]> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 90);
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);

  const params: unknown[] = [platform];
  let where = 'r.platform = $1';
  if (filter === 'recent') {
    params.push(`${clampedDays} days`);
    where += ` AND r.left_at IS NULL AND r.joined_at > now() - $${params.length}::interval`;
  } else if (filter === 'left') {
    params.push(`${clampedDays} days`);
    where += ` AND r.left_at IS NOT NULL AND r.left_at > now() - $${params.length}::interval`;
  } else if (filter === 'not_members') {
    where += ' AND r.left_at IS NULL AND cu.id IS NULL';
  }
  params.push(clampedLimit);

  const { rows } = await pool.query(
    `SELECT r.user_id, r.display_name, r.joined_at, r.left_at, r.rejoined_count,
            (cu.id IS NOT NULL) AS is_member
       FROM server_roster r
       LEFT JOIN community_users cu
         ON cu.platform = r.platform AND cu.platform_user_id = r.user_id
      WHERE ${where}
      ORDER BY COALESCE(r.left_at, r.joined_at) DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    joinedAt: r.joined_at,
    leftAt: r.left_at,
    rejoinedCount: Number(r.rejoined_count),
    isMember: Boolean(r.is_member),
  }));
}

/**
 * Growth-pulse counts for the roster summary line. `notMembers` (issue #460)
 * is the standing size of the onboarding queue — the same `left_at IS NULL
 * AND cu.id IS NULL` predicate `listRoster`'s `'not_members'` filter uses
 * (repository.ts's `listRoster`) — added as one more `FILTER` on this same
 * single-table scan via a `LEFT JOIN community_users`, reusing that table's
 * existing `UNIQUE (platform, platform_user_id)` index. Unlike
 * `joinedThisWeek`, it carries no rolling window: a guest who joined months
 * ago and was never added stays counted here indefinitely.
 */
export async function rosterCounts(
  platform: Platform,
): Promise<{ total: number; joinedThisWeek: number; leftThisWeek: number; notMembers: number }> {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE r.left_at IS NULL) AS total,
       count(*) FILTER (WHERE r.left_at IS NULL AND r.joined_at > now() - interval '7 days') AS joined_week,
       count(*) FILTER (WHERE r.left_at IS NOT NULL AND r.left_at > now() - interval '7 days') AS left_week,
       count(*) FILTER (WHERE r.left_at IS NULL AND cu.id IS NULL) AS not_members
     FROM server_roster r
     LEFT JOIN community_users cu
       ON cu.platform = r.platform AND cu.platform_user_id = r.user_id
     WHERE r.platform = $1`,
    [platform],
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    joinedThisWeek: Number(rows[0]?.joined_week ?? 0),
    leftThisWeek: Number(rows[0]?.left_week ?? 0),
    notMembers: Number(rows[0]?.not_members ?? 0),
  };
}

export interface EngagementBreakdown {
  platform: Platform;
  total: number;
  engaged: number;
  /** Percentage rounded to one decimal place; 0 when total is 0 (issue #419). */
  percentage: number;
}

/**
 * Guild-wide engagement %: what fraction of currently-present roster members
 * (issue #419) have ever sent an inbound message. Denominator is
 * `server_roster` where `left_at IS NULL` (durable, Discord-complete /
 * WhatsApp-partial); numerator is the subset of those rows matched by
 * distinct `(platform, user_id)` on an inbound `interactions` row —
 * `interactions` is age-purged per `INTERACTION_RETENTION_DAYS`, so this is a
 * "within the retention window" figure, not a lifetime one. Aggregate-only by
 * design (super-admin `engagement_stats` tool, adversarial review #419): no
 * per-member identity is ever returned, only counts and a percentage.
 */
export async function engagementStats(platform?: Platform): Promise<{
  total: number;
  engaged: number;
  percentage: number;
  byPlatform: EngagementBreakdown[];
}> {
  const params: unknown[] = [];
  let where = 'r.left_at IS NULL';
  if (platform) {
    params.push(platform);
    where += ` AND r.platform = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT r.platform,
            count(*) AS total,
            count(e.user_id) AS engaged
       FROM server_roster r
       LEFT JOIN (
         SELECT DISTINCT platform, user_id FROM interactions WHERE direction = 'inbound'
       ) e ON e.platform = r.platform AND e.user_id = r.user_id
      WHERE ${where}
      GROUP BY r.platform
      ORDER BY r.platform`,
    params,
  );
  const pct = (engaged: number, total: number) => (total > 0 ? Math.round((engaged / total) * 1000) / 10 : 0);
  const byPlatform: EngagementBreakdown[] = rows.map((r) => {
    const total = Number(r.total);
    const engaged = Number(r.engaged);
    return { platform: r.platform as Platform, total, engaged, percentage: pct(engaged, total) };
  });
  const total = byPlatform.reduce((sum, p) => sum + p.total, 0);
  const engaged = byPlatform.reduce((sum, p) => sum + p.engaged, 0);
  return { total, engaged, percentage: pct(engaged, total), byPlatform };
}

/**
 * Age-based retention: delete `server_roster` rows for members who have
 * LEFT (left_at IS NOT NULL) more than `days` ago. Currently-present members
 * (left_at IS NULL) are never touched, regardless of `days`. Returns the
 * number of rows deleted, for operator-visible logging.
 */
export async function purgeDepartedRoster(days: number): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM server_roster WHERE left_at IS NOT NULL AND left_at < now() - ($1::text || ' days')::interval`,
    [days],
  );
  return rowCount ?? 0;
}
