import type { Platform } from '../../platforms/types.js';
import { pool } from '../db.js';
import type { Queryable } from './shared.js';
import { registerPurgeContributor } from '../lifecycle.js';

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

/**
 * Clear a resolved access request (e.g. after add_member succeeds for that
 * user) — and, since issue #939, the ERASURE path for this table too: this is
 * the single deletion path `purgeSingleIdentity` delegates to for
 * `forget_me`/`purge_user_data`.
 *
 * Takes an optional {@link Queryable} for exactly the reason
 * `forgetLidMappingsForPhone` does (PR #935 review): the privacy purge must be
 * able to pass its own transaction `client` so this delete commits or rolls
 * back atomically with the rest of the erasure, and there must be ONE copy of
 * the DELETE so a future predicate change can't apply to the add_member path
 * but not the erasure path — that kind of drift is a PII-retention bug, not a
 * cosmetic one.
 *
 * Returns the row count (0 or 1 — `UNIQUE (platform, user_id)`) so the purge
 * can include it in its total rather than silently dropping it.
 */
export async function clearAccessRequest(
  platform: Platform,
  userId: string,
  db: Queryable = pool,
): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM access_requests WHERE platform = $1 AND user_id = $2`, [
    platform,
    userId,
  ]);
  return rowCount ?? 0;
}

/**
 * Age-based retention: delete pending access requests that have gone quiet for
 * `days` (issue #939). Until this existed, `access_requests` was the one PII
 * store in the schema with NO expiry at all — the only delete was
 * `clearAccessRequest` on approval, so a non-member's name and (on WhatsApp)
 * phone number sat there indefinitely for anyone who asked and was never
 * added. That is the population least likely to have any relationship with
 * this community, so it is the last data that should be kept forever.
 *
 * Keyed on `last_requested_at`, NOT `first_requested_at`: the row should
 * expire once the person STOPS asking, not on a fixed clock from their first
 * ping. A guest still actively requesting is still an open request and is
 * never purged, however old their first attempt is.
 *
 * Deleting a row is not the same as resolving it — a purged guest who asks
 * again gets a genuinely fresh row, so `recordAccessRequest` reports
 * `inserted: true` and the first-time-only admin alert fires again (correct: a
 * new request months later deserves a new notification), and their
 * `first_requested_at` wait clock restarts.
 *
 * NOTE the interaction with {@link oldestAccessRequestAgeDays}: when this is
 * enabled, the admin digest's oldest-pending age can never exceed `days`,
 * because anything older has been deleted. The floor in config.ts
 * (MIN_ACCESS_REQUEST_RETENTION_DAYS) exists so that ceiling always stays well
 * above the horizon admins actually triage on.
 */
export async function purgeOldAccessRequests(days: number): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM access_requests WHERE last_requested_at < now() - ($1::text || ' days')::interval`,
    [days],
  );
  return rowCount ?? 0;
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
 *
 * One caveat once ACCESS_REQUEST_RETENTION_DAYS is enabled (issue #939): this
 * value is then bounded above by that setting, since
 * {@link purgeOldAccessRequests} has already deleted anything quiet for
 * longer. "Oldest pending: 29 days" under a 30-day retention means the oldest
 * SURVIVING request, not necessarily the oldest ever made.
 */
export async function oldestAccessRequestAgeDays(): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT EXTRACT(DAY FROM now() - MIN(first_requested_at))::int AS age_days FROM access_requests`,
  );
  const ageDays = rows[0]?.age_days;
  return ageDays === null || ageDays === undefined ? null : Number(ageDays);
}

// --- Lifecycle registration (storage/lifecycle.ts) ---------------------------

registerPurgeContributor({
  name: 'access_requests',
  order: 210,
  async purge({ platform, userId }, tx) {
    // access_requests (issue #939). Previously the ONLY route out of this
    // table was `clearAccessRequest` on approval, so someone who asked for
    // access and was never added had their display name — and on WhatsApp
    // their phone number, since that IS the user id there — retained
    // indefinitely with no erasure path and no expiry. docs/SECURITY.md named
    // it a metadata-only exception to guest invisibility, which is true of its
    // CONTENT but was never a licence to keep the identity forever.
    //
    // Delegates to `clearAccessRequest` with the purge transaction's client,
    // for the same one-deletion-path reason as the LID mapping contributor
    // rather than inlining a second DELETE here.
    //
    // Deleting a PENDING request cannot be an end-run around moderation, which
    // is why this is safe where `blocked_users` deliberately is not: an
    // access_requests row grants nothing and gates nothing — it is a queue
    // entry. Someone who erases it and asks again simply reappears in the
    // queue as a fresh request.
    return clearAccessRequest(platform, userId, tx);
  },
});
