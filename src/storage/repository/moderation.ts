import type { Platform } from '../../platforms/types.js';
import { pool } from '../db.js';

/**
 * Moderation state: auto-moderation strike counts, the bot-side WhatsApp block
 * list (#572), and the durable appeal_moderation record (#554). One module —
 * these are three sections of the same domain in repository.ts, kept in their
 * original order with their section banners intact.
 *
 * None of these carries a conversation-scoped admin read; the scoped
 * reporting/feedback reads stay in repository.ts for their own dedicated
 * extraction, where the 🔒 scoping can be reviewed on its own.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Auto-moderation strikes -------------------------------------------------

export interface NewWarning {
  platform: string;
  userId: string;
  reason: string;
  excerpt: string | null;
  source: 'auto' | 'admin';
  issuedBy: string | null;
}

/** Record one warning against a member. */
export async function addWarning(w: NewWarning): Promise<void> {
  await pool.query(
    `INSERT INTO member_warnings (platform, user_id, reason, excerpt, source, issued_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [w.platform, w.userId, w.reason, w.excerpt, w.source, w.issuedBy],
  );
}

/**
 * Active (uncleared) strike count for a member — the block trigger. When
 * `windowDays` is given, strikes older than that rolling window no longer
 * count (MODERATION_STRIKE_WINDOW_DAYS); omitted, behaviour is unbounded
 * (every uncleared strike counts, regardless of age — today's default). The
 * window is always a bound parameter passed through `make_interval`, never
 * interpolated into the query text, so the query shape can't be altered by a
 * hostile/config value.
 */
export async function countActiveWarnings(
  platform: string,
  userId: string,
  windowDays?: number,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM member_warnings
      WHERE platform = $1 AND user_id = $2 AND cleared_at IS NULL
        AND ($3::int IS NULL OR created_at >= now() - make_interval(days => $3::int))`,
    [platform, userId, windowDays ?? null],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Count of distinct members on `platform` who are CURRENTLY muted — their
 * active (uncleared) strike count is `>= strikeLimit` — honouring the same
 * optional rolling `windowDays` bound `countActiveWarnings` uses, so the
 * digest's definition of "muted" can never drift from the actual mute
 * trigger in `moderator.ts` (issue #357). Bound parameters only, never
 * interpolated, same injection posture as `countActiveWarnings`.
 */
export async function countMutedMembers(
  platform: string,
  strikeLimit: number,
  windowDays?: number,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT user_id FROM member_warnings
        WHERE platform = $1 AND cleared_at IS NULL
          AND ($3::int IS NULL OR created_at >= now() - make_interval(days => $3::int))
        GROUP BY user_id
       HAVING COUNT(*) >= $2
     ) t`,
    [platform, strikeLimit, windowDays ?? null],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Count of distinct members on `platform` whose UNWINDOWED active-strike
 * count is `>= strikeLimit` but whose WINDOWED active-strike count (the same
 * `windowDays` bound `countMutedMembers`/`countActiveWarnings` use) is
 * `< strikeLimit` — the cohort `countMutedMembers`'s windowed definition
 * necessarily and correctly excludes (issue #357) once enough of a member's
 * strikes age out of the window that they stop being counted "currently
 * muted", even though nothing ever unmuted them — there is no auto-unmute;
 * `clear_warnings` is the only path (docs/SECURITY.md). Mutually exclusive
 * with `countMutedMembers`'s windowed `>= strikeLimit` set by construction
 * (issue #403).
 *
 * This is an OVER-APPROXIMATION, not a precise "is this member still muted"
 * signal: mute state is never persisted (there is no `muted_members` table,
 * only `member_warnings`), and an actual mute only ever fired when a past
 * scan's WINDOWED count crossed `strikeLimit`. A member whose strikes
 * accrued slowly enough that the windowed count never crossed the limit at
 * any scan can still satisfy unwindowed `>= strikeLimit` here despite never
 * having been muted. Callers must hedge this as "may still be muted", never
 * assert it as exact.
 *
 * Short-circuits to `0` with NO query at all when `windowDays` is
 * `undefined` — the windowed and unwindowed counts are then always
 * identical by construction, so this cohort is provably empty, and the
 * signal is fully inert unless MODERATION_STRIKE_WINDOW_DAYS is configured.
 * Bound parameters only, same injection posture as `countMutedMembers`.
 */
export async function countStaleMutedMembers(
  platform: string,
  strikeLimit: number,
  windowDays?: number,
): Promise<number> {
  if (windowDays === undefined) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT user_id FROM member_warnings
        WHERE platform = $1 AND cleared_at IS NULL
        GROUP BY user_id
       HAVING COUNT(*) >= $2
          AND COUNT(*) FILTER (WHERE created_at >= now() - make_interval(days => $3::int)) < $2
     ) t`,
    [platform, strikeLimit, windowDays],
  );
  return rows[0]?.n ?? 0;
}

export interface MutedMemberRow {
  userId: string;
  status: 'active' | 'stale';
  strikeCount: number;
  lastWarningAt: Date;
}

/**
 * Enumerate the members `countMutedMembers` and `countStaleMutedMembers`
 * would each count, by identity rather than a bare number (issue #487, the
 * growth path #403 explicitly named and deferred) — the "who" a digest's
 * `🔇 N member(s) currently muted` count can't answer on its own.
 *
 * One query computes both the windowed and unwindowed active-strike count
 * per user with the exact same predicates those two count functions use, and
 * a row is tagged `'active'` when the windowed count (or the unwindowed
 * count, when `windowDays` is `undefined` — identical by construction, same
 * short-circuit `countStaleMutedMembers` relies on) is `>= strikeLimit`,
 * else `'stale'` when only the unwindowed count is. Because `'active'` is
 * decided first and `'stale'` only applies to rows the HAVING clause let
 * through on the unwindowed branch, the two tags are mutually exclusive by
 * construction — never both, never neither, for a row that appears at all.
 *
 * `strikeCount` reports whichever count decided the tag (windowed for
 * `'active'`, unwindowed for `'stale'`), so an admin sees the number that
 * actually explains why the row is here. Ordered newest-warning-first,
 * capped at `limit`. Bound parameters only, same injection posture as
 * `countMutedMembers`/`countStaleMutedMembers`.
 *
 * Deliberately excludes `reason`/`excerpt` (message content) — those stay
 * behind `listMemberWarnings`, one level deeper, same boundary `clear_warnings`/
 * `list_member_warnings` already draw.
 */
export async function listMutedMembers(
  platform: string,
  strikeLimit: number,
  windowDays?: number,
  limit = 50,
): Promise<MutedMemberRow[]> {
  const { rows } = await pool.query(
    `SELECT user_id,
            MAX(created_at) AS last_warning_at,
            COUNT(*) FILTER (
              WHERE $3::int IS NULL OR created_at >= now() - make_interval(days => $3::int)
            ) AS windowed_count,
            COUNT(*) AS unwindowed_count
       FROM member_warnings
      WHERE platform = $1 AND cleared_at IS NULL
      GROUP BY user_id
     HAVING COUNT(*) FILTER (
              WHERE $3::int IS NULL OR created_at >= now() - make_interval(days => $3::int)
            ) >= $2
         OR COUNT(*) >= $2
      ORDER BY MAX(created_at) DESC
      LIMIT $4`,
    [platform, strikeLimit, windowDays ?? null, limit],
  );
  return rows.map((r) => {
    const windowedCount = Number(r.windowed_count);
    const unwindowedCount = Number(r.unwindowed_count);
    const active = windowedCount >= strikeLimit;
    return {
      userId: r.user_id,
      status: active ? ('active' as const) : ('stale' as const),
      strikeCount: active ? windowedCount : unwindowedCount,
      lastWarningAt: r.last_warning_at,
    };
  });
}

/**
 * Clear all of a member's active warnings (an admin action), stamping who
 * cleared them and when. Returns the number of strikes cleared, so the caller
 * can tell "actually unblocked them" from "they had nothing to clear".
 */
export async function clearWarnings(platform: string, userId: string, clearedBy: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE member_warnings
        SET cleared_at = now(), cleared_by = $3
      WHERE platform = $1 AND user_id = $2 AND cleared_at IS NULL`,
    [platform, userId, clearedBy],
  );
  return rowCount ?? 0;
}

export interface MemberWarningRow {
  createdAt: Date;
  source: 'auto' | 'admin';
  reason: string;
  excerpt: string | null;
  issuedBy: string | null;
  clearedAt: Date | null;
  clearedBy: string | null;
}

/**
 * Full warning history (both `source: 'auto'` and `source: 'admin'` rows,
 * reason/excerpt included) for one member — the `list_member_warnings` read
 * `moderation_history` structurally can't provide, since it reads only
 * `admin_audit`, never `member_warnings` (issue #410). Scoped by
 * `(platform, userId)` only, matching `clearWarnings`' own scope — the table
 * has no `conversation_id` column (docs/SECURITY.md: "any admin may clear
 * anyone's [warnings]").
 */
export async function listMemberWarnings(
  platform: string,
  userId: string,
  limit = 20,
): Promise<MemberWarningRow[]> {
  const { rows } = await pool.query(
    `SELECT created_at, source, reason, excerpt, issued_by, cleared_at, cleared_by
       FROM member_warnings
      WHERE platform = $1 AND user_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [platform, userId, limit],
  );
  return rows.map((r) => ({
    createdAt: r.created_at,
    source: r.source,
    reason: r.reason,
    excerpt: r.excerpt,
    issuedBy: r.issued_by,
    clearedAt: r.cleared_at,
    clearedBy: r.cleared_by,
  }));
}

// --- Block list (bot-side WhatsApp block, issue #572) -----------------------

/**
 * Block a `(platform, externalId)` identity — the router checks this before
 * role resolution or any storage, so a blocked sender gets no reply and no
 * footprint, in both `open` and `gated` access mode. Upserts rather than
 * inserting so re-blocking an already-blocked identity refreshes the reason/
 * blocker/timestamp instead of erroring on the primary key.
 */
export async function blockUser(
  platform: string,
  externalId: string,
  blockedBy: string,
  reason: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO blocked_users (platform, external_id, blocked_by, reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (platform, external_id)
     DO UPDATE SET blocked_by = $3, reason = $4, blocked_at = now()`,
    [platform, externalId, blockedBy, reason],
  );
}

/** Unblock a `(platform, externalId)` identity. Returns whether a row was actually removed. */
export async function unblockUser(platform: string, externalId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM blocked_users WHERE platform = $1 AND external_id = $2`,
    [platform, externalId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Router hot-path check (issue #572): is this sender currently blocked?
 * Index-backed by `blocked_users`' own primary key — same shape/cost as the
 * rate-limit and role-resolution lookups already in the inbound path.
 */
export async function isUserBlocked(platform: string, externalId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM blocked_users WHERE platform = $1 AND external_id = $2`, [
    platform,
    externalId,
  ]);
  return rows.length > 0;
}

// --- Moderation appeals (durable record of appeal_moderation, issue #554) --

export type ModerationAppealStatus = 'open' | 'resolved' | 'dismissed';

export interface ModerationAppeal {
  id: number;
  platform: Platform;
  userId: string;
  userName: string | null;
  reason: string | null;
  activeWarnings: number;
  strikeLimit: number;
  status: ModerationAppealStatus;
  createdAt: Date;
  resolvedBy: string | null;
  resolvedAt: Date | null;
}

function mapModerationAppeal(r: {
  id: number | string;
  platform: string;
  user_id: string;
  user_name: string | null;
  reason: string | null;
  active_warnings: number | string;
  strike_limit: number | string;
  status: string;
  created_at: Date;
  resolved_by: string | null;
  resolved_at: Date | null;
}): ModerationAppeal {
  return {
    id: Number(r.id),
    platform: r.platform as Platform,
    userId: r.user_id,
    userName: r.user_name,
    reason: r.reason,
    activeWarnings: Number(r.active_warnings),
    strikeLimit: Number(r.strike_limit),
    status: r.status as ModerationAppealStatus,
    createdAt: r.created_at,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
  };
}

/**
 * Record a member's appeal of their own active auto-moderation warning(s) —
 * the durable counterpart to the best-effort `notifyAppealFiled` DM
 * (`appeal_moderation`, issue #554). Called only after the tool's own
 * eligibility (`countActiveWarnings > 0`) and cooldown (`reserveAppealSlot`)
 * gates pass, so this insert can't be flooded by a repeat caller — see
 * `appeal_moderation` in tools.ts, which is the only caller.
 * `activeWarnings`/`strikeLimit` are a point-in-time snapshot, matching what
 * the accompanying DM already reports, not a live join to `member_warnings`.
 */
export async function createModerationAppeal(input: {
  platform: Platform;
  userId: string;
  userName: string | null;
  reason?: string;
  activeWarnings: number;
  strikeLimit: number;
}): Promise<{ id: number }> {
  const { rows } = await pool.query(
    `INSERT INTO moderation_appeals
       (platform, user_id, user_name, reason, active_warnings, strike_limit)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      input.platform,
      input.userId,
      input.userName,
      input.reason ?? null,
      input.activeWarnings,
      input.strikeLimit,
    ],
  );
  return { id: Number(rows[0].id) };
}

/**
 * Self-scoped read of a member's OWN filed appeals (issue #709) — mirrors
 * `listOwnReports`'s exact narrowing of `listReports`'s shape, appending
 * `platform = $1 AND user_id = $2` (resolved from caller context, never a
 * tool-argument-supplied id) to `listAppeals`'s query, so a member can only
 * ever see appeals they themselves filed.
 */
export async function listOwnAppeals(
  platform: Platform,
  userId: string,
  limit = 10,
): Promise<ModerationAppeal[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
  const { rows } = await pool.query(
    `SELECT id, platform, user_id, user_name, reason, active_warnings, strike_limit,
            status, created_at, resolved_by, resolved_at
       FROM moderation_appeals
      WHERE platform = $1 AND user_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [platform, userId, clampedLimit],
  );
  return rows.map(mapModerationAppeal);
}

/**
 * Admin-tier, guild-wide read of filed appeals (issue #554) — deliberately
 * NOT conversation-scoped, matching `list_member_warnings`/`clear_warnings`:
 * warnings/mutes are guild-wide state, so an appeal about one carries no
 * conversation boundary to scope by. Optional `status` filter, newest first.
 */
export async function listAppeals(status?: ModerationAppealStatus, limit = 50): Promise<ModerationAppeal[]> {
  const params: unknown[] = [];
  const filters: string[] = [];
  if (status) {
    params.push(status);
    filters.push(`status = $${params.length}`);
  }
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  params.push(clampedLimit);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT id, platform, user_id, user_name, reason, active_warnings, strike_limit,
            status, created_at, resolved_by, resolved_at
       FROM moderation_appeals
       ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapModerationAppeal);
}

/**
 * Flip an appeal's status (resolved/dismissed) once triaged — non-destructive
 * (only `status`/`resolved_by`/`resolved_at` change), no CONFIRM needed,
 * mirroring `resolveContentReport`. Deliberately never touches
 * `member_warnings` or mute state — that stays `clear_warnings`' job alone
 * (issue #554's scope guardrail: no automatic linkage). Guild-wide, same
 * non-conversation-scoped boundary as `listAppeals`. Returns null if no
 * matching row was found (unknown id).
 */
export async function resolveModerationAppeal(
  id: number,
  status: 'resolved' | 'dismissed',
  resolvedBy: string,
): Promise<ModerationAppeal | null> {
  const { rows } = await pool.query(
    `UPDATE moderation_appeals
        SET status = $2, resolved_by = $3, resolved_at = now()
      WHERE id = $1
      RETURNING id, platform, user_id, user_name, reason, active_warnings, strike_limit,
                status, created_at, resolved_by, resolved_at`,
    [id, status, resolvedBy],
  );
  return rows[0] ? mapModerationAppeal(rows[0]) : null;
}

/**
 * Guild-wide-by-platform count of open appeals, for the admin digest backlog
 * signal #554/#622 both deferred (issue #631) — same shape as
 * `countMutedMembers`: a dedicated `COUNT(*)` read, bound parameters only,
 * never interpolated. Excludes `resolved`/`dismissed` rows and other
 * platforms' rows, same boundary `listAppeals` draws.
 */
export async function countOpenAppeals(platform: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM moderation_appeals WHERE platform = $1 AND status = 'open'`,
    [platform],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Whole-day age of the oldest open appeal for this platform — the same
 * `MIN(created_at)` oldest-age mechanic `oldestOpenReportAgeDays` (#450)
 * applies to reports, over the identical `platform`/`status = 'open'`
 * predicate `countOpenAppeals` counts (issues #631/#743 both named this as
 * the deferred growth path, built here in #787). `MIN` over an empty scoped
 * set is `null`, never `0`, and is returned as-is so a digest/tool reader can
 * never mistake "no open appeals" for "one that just arrived".
 */
export async function oldestOpenAppealAgeDays(platform: string): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT EXTRACT(DAY FROM now() - MIN(created_at))::int AS age_days FROM moderation_appeals WHERE platform = $1 AND status = 'open'`,
    [platform],
  );
  const ageDays = rows[0]?.age_days;
  return ageDays === null || ageDays === undefined ? null : Number(ageDays);
}
