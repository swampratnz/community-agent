import { pool } from '@swampratnz/agent-base/storage/db.js';

/**
 * Reads/writes for `knowledge_candidate_stale_notices` (issue #1408, the
 * module fragment `schema/89-knowledge-candidate-stale-notices.sql`) — a
 * module-owned table consulted alongside the base `knowledge_candidates`
 * table, byte-for-byte the same "base owns the row, module tracks something
 * beside it" pattern `reportReporterStaleNotices.ts` (#1375) established.
 * Every row this file ever reads or writes is looked up by candidate id
 * only — never by submitter identity, which this table does not store.
 */

/**
 * Record candidate `id`'s submitter as notified, IF NOT ALREADY recorded —
 * `INSERT ... ON CONFLICT DO NOTHING` makes the check-and-record atomic, so
 * two admins processing the same stale candidate in the same tick can never
 * both win the race. Returns whether THIS call actually inserted the row:
 * `true` means the submitter has never been notified for this candidate
 * before (the caller should send the DM now), `false` means a row already
 * existed (already notified — the caller must not send again).
 */
export async function recordCandidateStaleNotice(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    'INSERT INTO knowledge_candidate_stale_notices (candidate_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Which of `ids` have already had their submitter notified. Empty input
 * short-circuits without a query — mirrors `getReporterStaleNoticeIds`'s
 * read shape exactly (batch lookup by id, returned as a `Set`).
 */
export async function getCandidateStaleNoticeIds(ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { rows } = await pool.query<{ candidate_id: number }>(
    'SELECT candidate_id FROM knowledge_candidate_stale_notices WHERE candidate_id = ANY($1)',
    [ids],
  );
  return new Set(rows.map((row) => row.candidate_id));
}
