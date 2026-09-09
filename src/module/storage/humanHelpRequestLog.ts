import { pool } from '@swampratnz/agent-base/storage/db.js';

/**
 * Reads/writes for `human_help_request_log` (issue #1364, the module
 * fragment `schema/87-human-help-request-log.sql`) — an anonymous log of
 * "a `request_human_help` ask happened, at this time", written alongside
 * (never instead of) `feedback.ts`'s existing turn-scoped
 * `turnState.humanHelpRequested` flag / live `notifyAdmins` escalation.
 * Deliberately no platform/user id/outcome column at all, even sparser than
 * `accessRequestResolutions.ts` — every read here is guild-wide by
 * construction and there is nothing for `forget_me`/`purge_user_data` to
 * reach.
 */

/**
 * Record one genuine (under-cap) `request_human_help` call. The caller
 * (`feedback.ts`) must wrap this in its own non-blocking guard — this
 * function throws on a DB error like any other write, it does not swallow
 * one itself, so the "must never fail or block the tool's reply or the live
 * notifyAdmins escalation" acceptance criterion is enforced at the call
 * site, not hidden here.
 */
export async function recordHumanHelpRequest(): Promise<void> {
  await pool.query('INSERT INTO human_help_request_log DEFAULT VALUES');
}

/**
 * Count of asks since `since` — the admin-digest frequency signal. Mirrors
 * `countHelperMatchesSince`'s exact shape (`@swampratnz/agent-base`'s
 * `memberDiscovery.ts`).
 */
export async function countHumanHelpRequestsSince(since: Date): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM human_help_request_log WHERE created_at > $1',
    [since],
  );
  return Number(rows[0].n);
}

/**
 * Timestamp of the most recent ask ever recorded, or `null` if none — the
 * admin-digest recency signal. Unbounded by `since` (unlike
 * `countHumanHelpRequestsSince`): the most recent ask could predate the
 * digest's own freshness window, and that's still worth surfacing once the
 * count itself is nonzero.
 */
export async function mostRecentHumanHelpRequestAt(): Promise<Date | null> {
  const { rows } = await pool.query<{ created_at: Date | null }>(
    'SELECT max(created_at) AS created_at FROM human_help_request_log',
  );
  return rows[0]?.created_at ?? null;
}
