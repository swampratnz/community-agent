import type { Platform } from '@swampratnz/agent-base/platforms/types.js';
import { pool } from '@swampratnz/agent-base/storage/db.js';
import { registerPurgeContributor } from '@swampratnz/agent-base/storage/lifecycle.js';

/**
 * Reads/writes for `access_request_stale_notices` (issue #1421, the module
 * fragment `schema/92-access-request-stale-notices.sql`) — a module-owned
 * table consulted alongside the base `access_requests` table, the same
 * "base owns the row, module tracks something beside it" pattern its
 * `88`-`91` siblings established. UNLIKE those siblings, this table DOES
 * carry requester identity — `AccessRequest` has no anonymous numeric id, so
 * idempotency has nowhere else to key on — which is why it follows
 * `findHelperRequests.ts`'s registered-purge-hook precedent instead. See the
 * schema fragment's own doc comment for the full rationale.
 */

export interface AccessRequestStaleNoticeKey {
  platform: Platform;
  userId: string;
}

/**
 * Record `(platform, userId)`'s guest as notified, IF NOT ALREADY recorded —
 * `INSERT ... ON CONFLICT DO NOTHING` makes the check-and-record atomic, so
 * two ticks processing the same stale request can never both win the race.
 * Returns whether THIS call actually inserted the row: `true` means the
 * guest has never been notified before (the caller should send the DM now),
 * `false` means a row already existed (already notified — the caller must
 * not send again).
 */
export async function recordAccessRequestStaleNotice(platform: Platform, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'INSERT INTO access_request_stale_notices (platform, platform_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [platform, userId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Delete every notice row whose `(platform, userId)` is NOT present in
 * `activeKeys` — the reconciliation `accessRequestStaleAlert.ts` runs every
 * tick against the FULL pending-access-request scan (not just the stale
 * subset), so a base row that disappears via `add_member`
 * (`clearAccessRequest`), a decline, `forget_me`/`purge_user_data`, or
 * `purgeOldAccessRequests`' retention sweep has its companion notice row
 * swept within one job cycle — no permanently-dangling identity row. An
 * empty `activeKeys` deletes every row, which is correct: nothing pending
 * means every existing notice is an orphan.
 *
 * `unnest($1::text[], $2::text[])` zips the parallel platform/userId arrays
 * into rows for the composite-key comparison — the same technique
 * agent-base's `getPublishedInterestsForOwners` uses for an `IN`, applied
 * here to a `NOT IN`.
 */
export async function pruneAccessRequestStaleNotices(
  activeKeys: readonly AccessRequestStaleNoticeKey[],
): Promise<void> {
  await pool.query(
    `DELETE FROM access_request_stale_notices
      WHERE NOT (platform, platform_user_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
    [activeKeys.map((k) => k.platform), activeKeys.map((k) => k.userId)],
  );
}

// --- Lifecycle registration (storage/lifecycle.ts) --------------------------
registerPurgeContributor({
  name: 'access_request_stale_notices',
  order: 122,
  async purge({ platform, userId }, tx) {
    const { rowCount } = await tx.query(
      'DELETE FROM access_request_stale_notices WHERE platform = $1 AND platform_user_id = $2',
      [platform, userId],
    );
    return rowCount ?? 0;
  },
});
