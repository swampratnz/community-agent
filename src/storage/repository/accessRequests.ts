import type { Platform } from '../../platforms/types.js';
import { pool } from '../db.js';

/**
 * Gated-mode pending access-request queue: who has asked for access, how long
 * the oldest request has waited, and the admin-facing counts.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Access requests (gated-mode pending queue) -----------------------------

/**
 * Record that a gated guest addressed the bot. Identity + counts only — the
 * caller must never pass message content. Upserts so repeat pings from the
 * same user dedup into one row instead of growing unbounded.
 *
 * Returns whether this call created a FRESH row (`inserted`), via Postgres's
 * own `xmax = 0` trick on `RETURNING` — distinguishing "first insert" from
 * "repeat upsert" needs no extra query or column, just reading what the
 * upsert already tells us (issue #480). This is the debounce signal
 * `notifyAccessRequest`'s first-time-only real-time alert relies on: a
 * repeat ping from the same still-pending guest returns `inserted: false` and
 * must not notify again.
 *
 * Also returns `firstRequestedAt` (issue #591) — read off the same row via
 * the same `RETURNING` clause, so surfacing it to the returning-guest wait
 * clause in the gated notice costs zero new queries and zero new columns.
 */
export async function recordAccessRequest(input: {
  platform: Platform;
  userId: string;
  userName?: string;
}): Promise<{ inserted: boolean; firstRequestedAt: Date }> {
  const { rows } = await pool.query(
    `INSERT INTO access_requests (platform, user_id, user_name)
     VALUES ($1,$2,$3)
     ON CONFLICT (platform, user_id) DO UPDATE
       SET last_requested_at = now(),
           request_count = access_requests.request_count + 1,
           user_name = COALESCE(EXCLUDED.user_name, access_requests.user_name)
     RETURNING (xmax = 0) AS inserted, first_requested_at`,
    [input.platform, input.userId, input.userName ?? null],
  );
  return { inserted: rows[0]?.inserted === true, firstRequestedAt: rows[0].first_requested_at };
}

export interface AccessRequest {
  platform: Platform;
  userId: string;
  userName: string | null;
  firstRequestedAt: Date;
  lastRequestedAt: Date;
  requestCount: number;
}

export async function listAccessRequests(limit = 50): Promise<AccessRequest[]> {
  const { rows } = await pool.query(
    `SELECT platform, user_id, user_name, first_requested_at, last_requested_at, request_count
       FROM access_requests
      ORDER BY last_requested_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    platform: r.platform,
    userId: r.user_id,
    userName: r.user_name,
    firstRequestedAt: r.first_requested_at,
    lastRequestedAt: r.last_requested_at,
    requestCount: Number(r.request_count),
  }));
}

/** Clear a resolved access request (e.g. after add_member succeeds for that user). */
export async function clearAccessRequest(platform: Platform, userId: string): Promise<void> {
  await pool.query(`DELETE FROM access_requests WHERE platform = $1 AND user_id = $2`, [platform, userId]);
}

/**
 * Exact pending-guest count — a dedicated `COUNT(*)` rather than
 * `(await listAccessRequests()).length`, which would silently understate a
 * backlog past that function's `limit` (default 50) cap.
 */
export async function countAccessRequests(): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*) AS n FROM access_requests`);
  return Number(rows[0].n);
}

/**
 * Whole-day age of the oldest still-pending access request — the same
 * `MIN(first_requested_at)` oldest-age mechanic issue #450 applies to
 * reports/suggestions, applied here to `access_requests` (issue #515).
 * `first_requested_at` is set once at insert and never updated
 * (`recordAccessRequest`), and `clearAccessRequest` deletes the row on
 * `add_member`, so by construction every remaining row is unresolved
 * backlog and `MIN` over an empty table is `null`, never `0` — returned
 * as-is rather than coerced, so an admin/digest reader can never mistake
 * "no pending requests" for "a request that just arrived".
 */
export async function oldestAccessRequestAgeDays(): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT EXTRACT(DAY FROM now() - MIN(first_requested_at))::int AS age_days FROM access_requests`,
  );
  const ageDays = rows[0]?.age_days;
  return ageDays === null || ageDays === undefined ? null : Number(ageDays);
}
