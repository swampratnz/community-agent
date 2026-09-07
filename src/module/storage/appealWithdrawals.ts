import { pool } from '@swampratnz/agent-base/storage/db.js';

/**
 * Reads/writes for `appeal_withdrawals` (issue #1278, the module fragment
 * `schema/83-appeal-withdrawals.sql`) — a module-owned table consulted
 * (never instead of a base write) alongside the base `moderation_appeals`
 * table, byte-for-byte the same "base owns the row, module tracks something
 * beside it" pattern `suggestionWithdrawals.ts` established for issue #1243.
 * Every caller-scoping decision (which appeals belong to which member) is
 * made by the caller of these functions via `listOwnAppeals`, never here —
 * this file only ever answers "has id N been withdrawn?".
 */

/**
 * Record one appeal's withdrawal. `ON CONFLICT DO NOTHING` makes a repeated
 * withdrawal of the same id idempotent — no duplicate row, no error — since
 * `withdraw_appeal` may be called more than once against an appeal it
 * already withdrew.
 */
export async function recordAppealWithdrawal(id: number): Promise<void> {
  await pool.query('INSERT INTO appeal_withdrawals (appeal_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
}

/**
 * Which of `ids` have been withdrawn. Empty input short-circuits without a
 * query — `resolve_appeal`'s single-id check and the empty-appeals branches
 * of `list_appeals`/`my_submissions` all call this.
 */
export async function getWithdrawnAppealIds(ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { rows } = await pool.query<{ appeal_id: number }>(
    'SELECT appeal_id FROM appeal_withdrawals WHERE appeal_id = ANY($1)',
    [ids],
  );
  return new Set(rows.map((row) => row.appeal_id));
}
