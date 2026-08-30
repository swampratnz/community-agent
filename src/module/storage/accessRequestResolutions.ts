import { pool } from '@swampratnz/agent-base/storage/db.js';

/**
 * Reads/writes for `access_request_resolutions` (issue #1239, the module
 * fragment `schema/81-access-request-resolutions.sql`) — an anonymous log of
 * access-request resolution duration + outcome, written alongside (never
 * instead of) `clearAccessRequest`'s existing delete-on-resolve behaviour.
 * Deliberately no platform/user id/display name column, so this file has no
 * caller-scoping to get wrong: every read is guild-wide by construction.
 */

export type AccessRequestResolutionOutcome = 'approved' | 'declined';

/**
 * Record one resolution event. The caller (`add_member`/
 * `decline_access_request`) must wrap this in its own non-blocking guard —
 * this function throws on a DB error like any other write, it does not
 * swallow one itself, so the "must never fail or block the resolution
 * action" acceptance criterion is enforced at the call site, not hidden here.
 */
export async function recordAccessRequestResolution(
  requestedAt: Date,
  outcome: AccessRequestResolutionOutcome,
): Promise<void> {
  await pool.query('INSERT INTO access_request_resolutions (requested_at, outcome) VALUES ($1, $2)', [
    requestedAt,
    outcome,
  ]);
}

export interface AccessRequestResolutionRow {
  requestedAt: Date;
  resolvedAt: Date;
  outcome: AccessRequestResolutionOutcome;
}

/**
 * Every resolution row with `resolved_at >= since` — unlike the scan-based
 * siblings this metric completes (reports/appeals/candidates/suggestions,
 * each capped at a bounded `list*` scan because their source rows stay in a
 * live, unboundedly-growing table), this table is insert-only and already
 * indexed on `resolved_at`, so the query needs no row-count ceiling or
 * "known approximation" caveat.
 */
export async function listAccessRequestResolutionsSince(since: Date): Promise<AccessRequestResolutionRow[]> {
  const { rows } = await pool.query<{
    requested_at: Date;
    resolved_at: Date;
    outcome: AccessRequestResolutionOutcome;
  }>('SELECT requested_at, resolved_at, outcome FROM access_request_resolutions WHERE resolved_at >= $1', [
    since,
  ]);
  return rows.map((row) => ({
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    outcome: row.outcome,
  }));
}
