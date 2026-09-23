import { pool } from '@swampratnz/agent-base/storage/db.js';

/**
 * Reads/writes for `suggestion_submitter_stale_notices` (issue #1415, the
 * module fragment `schema/91-suggestion-submitter-stale-notices.sql`) — a
 * module-owned table consulted alongside the base `suggestions` table,
 * byte-for-byte the same "base owns the row, module tracks something beside
 * it" pattern `appealAppellantStaleNotices.ts` (#1413) established. Every row
 * this file ever reads or writes is looked up by suggestion id only — never
 * by submitter identity, which this table does not store.
 */

/**
 * Record suggestion `id`'s submitter as notified, IF NOT ALREADY recorded —
 * `INSERT ... ON CONFLICT DO NOTHING` makes the check-and-record atomic, so
 * two ticks processing the same stale suggestion can never both win the
 * race. Returns whether THIS call actually inserted the row: `true` means
 * the submitter has never been notified for this suggestion before (the
 * caller should send the DM now), `false` means a row already existed
 * (already notified — the caller must not send again).
 */
export async function recordSuggesterStaleNotice(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    'INSERT INTO suggestion_submitter_stale_notices (suggestion_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Which of `ids` have already had their submitter notified. Empty input
 * short-circuits without a query — mirrors `getAppellantStaleNoticeIds`'s
 * read shape exactly (batch lookup by id, returned as a `Set`).
 */
export async function getSuggesterStaleNoticeIds(ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { rows } = await pool.query<{ suggestion_id: number }>(
    'SELECT suggestion_id FROM suggestion_submitter_stale_notices WHERE suggestion_id = ANY($1)',
    [ids],
  );
  return new Set(rows.map((row) => row.suggestion_id));
}
