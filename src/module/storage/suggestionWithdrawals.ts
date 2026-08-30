import { pool } from '@swampratnz/agent-base/storage/db.js';

/**
 * Reads/writes for `suggestion_withdrawals` (issue #1243, the module
 * fragment `schema/82-suggestion-withdrawals.sql`) — a module-owned table
 * consulted (never instead of a base write) alongside the base `suggestions`
 * table, the same "base owns the row, module tracks something beside it"
 * pattern `accessRequestResolutions.ts` established for issue #1239. Every
 * caller-scoping decision (which suggestions belong to which member) is made
 * by the caller of these functions via `listOwnSuggestions`, never here —
 * this file only ever answers "has id N been withdrawn?".
 */

/**
 * Record one suggestion's withdrawal. `ON CONFLICT DO NOTHING` makes a
 * repeated withdrawal of the same id idempotent — no duplicate row, no
 * error — since `withdraw_suggestion` may be called more than once against
 * a suggestion it already withdrew.
 */
export async function recordSuggestionWithdrawal(id: number): Promise<void> {
  await pool.query('INSERT INTO suggestion_withdrawals (suggestion_id) VALUES ($1) ON CONFLICT DO NOTHING', [
    id,
  ]);
}

/**
 * Which of `ids` have been withdrawn. Empty input short-circuits without a
 * query — `resolve_suggestion`'s single-id check and the empty-suggestions
 * branches of `list_suggestions`/`my_submissions` all call this.
 */
export async function getWithdrawnSuggestionIds(ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { rows } = await pool.query<{ suggestion_id: number }>(
    'SELECT suggestion_id FROM suggestion_withdrawals WHERE suggestion_id = ANY($1)',
    [ids],
  );
  return new Set(rows.map((row) => row.suggestion_id));
}
