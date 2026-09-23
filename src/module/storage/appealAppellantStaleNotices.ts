import { pool } from '@swampratnz/agent-base/storage/db.js';

/**
 * Reads/writes for `appeal_appellant_stale_notices` (issue #1413, the
 * module fragment `schema/90-appeal-appellant-stale-notices.sql`) — a
 * module-owned table consulted alongside the base `moderation_appeals`
 * table, byte-for-byte the same "base owns the row, module tracks something
 * beside it" pattern `knowledgeCandidateStaleNotices.ts` (#1408) established.
 * Every row this file ever reads or writes is looked up by appeal id
 * only — never by appellant identity, which this table does not store.
 */

/**
 * Record appeal `id`'s appellant as notified, IF NOT ALREADY recorded —
 * `INSERT ... ON CONFLICT DO NOTHING` makes the check-and-record atomic, so
 * two ticks processing the same stale appeal can never both win the race.
 * Returns whether THIS call actually inserted the row: `true` means the
 * appellant has never been notified for this appeal before (the caller
 * should send the DM now), `false` means a row already existed (already
 * notified — the caller must not send again).
 */
export async function recordAppellantStaleNotice(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    'INSERT INTO appeal_appellant_stale_notices (appeal_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Which of `ids` have already had their appellant notified. Empty input
 * short-circuits without a query — mirrors `getCandidateStaleNoticeIds`'s
 * read shape exactly (batch lookup by id, returned as a `Set`).
 */
export async function getAppellantStaleNoticeIds(ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { rows } = await pool.query<{ appeal_id: number }>(
    'SELECT appeal_id FROM appeal_appellant_stale_notices WHERE appeal_id = ANY($1)',
    [ids],
  );
  return new Set(rows.map((row) => row.appeal_id));
}
