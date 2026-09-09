import type { Platform } from '@swampratnz/agent-base/platforms/types.js';
import { pool } from '@swampratnz/agent-base/storage/db.js';
import { registerPurgeContributor } from '@swampratnz/agent-base/storage/lifecycle.js';

/**
 * Reads/writes for `set_interest_match_alerts` (issue #1332, the module
 * fragment `schema/85-interest-match-alert-optins.sql`) — the opt-in table
 * `interestMatchAlert.ts`'s job scans and `who_is_into`'s self-match path
 * (`searchMemberInterestsForSelf`) gets its push complement from. A
 * module-owned auxiliary table beside the base `member_interests` row, never
 * mutating it — same "base owns the row, module tracks something alongside
 * it" pattern `findHelperRequests.ts` established for exactly this reason
 * (the module can't add a column to a base table).
 *
 * The row stores direct identity (`platform`, `user_id`) and nothing else,
 * so — like `findHelperRequests.ts` and unlike the identity-free
 * `suggestionWithdrawals.ts`/`appealWithdrawals.ts`/
 * `accessRequestResolutions.ts` — it registers a purge contributor below.
 */

/** Upsert (opt in) or delete (opt out) the caller's own row — instantly reversible, no history kept. */
export async function setInterestMatchAlertOptIn(
  platform: Platform,
  userId: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await pool.query(
      'INSERT INTO interest_match_alert_optins (platform, user_id) VALUES ($1, $2) ON CONFLICT (platform, user_id) DO NOTHING',
      [platform, userId],
    );
    return;
  }
  await pool.query('DELETE FROM interest_match_alert_optins WHERE platform = $1 AND user_id = $2', [
    platform,
    userId,
  ]);
}

export interface InterestMatchAlertOptInKey {
  platform: Platform;
  userId: string;
}

/** Every opted-in identity — `interestMatchAlert.ts`'s per-tick scan set. */
export async function listInterestMatchAlertOptIns(): Promise<InterestMatchAlertOptInKey[]> {
  const { rows } = await pool.query<{ platform: Platform; user_id: string }>(
    'SELECT platform, user_id FROM interest_match_alert_optins',
  );
  return rows.map((r) => ({ platform: r.platform, userId: r.user_id }));
}

// --- Lifecycle registration (storage/lifecycle.ts) --------------------------
registerPurgeContributor({
  name: 'interest_match_alert_optins',
  order: 121,
  async purge({ platform, userId }, tx) {
    const { rowCount } = await tx.query(
      'DELETE FROM interest_match_alert_optins WHERE platform = $1 AND user_id = $2',
      [platform, userId],
    );
    return rowCount ?? 0;
  },
});
