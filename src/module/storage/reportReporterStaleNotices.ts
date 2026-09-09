import { pool } from '@swampratnz/agent-base/storage/db.js';

/**
 * Reads/writes for `report_reporter_stale_notices` (issue #1375, the module
 * fragment `schema/88-report-reporter-stale-notices.sql`) — a module-owned
 * table consulted alongside the base `content_reports` table, byte-for-byte
 * the same "base owns the row, module tracks something beside it" pattern
 * `appealWithdrawals.ts`/`suggestionWithdrawals.ts` established. Every row
 * this file ever reads or writes is looked up by report id only — never by
 * reporter identity, which this table does not store.
 */

/**
 * Record report `id`'s reporter as notified, IF NOT ALREADY recorded —
 * `INSERT ... ON CONFLICT DO NOTHING` makes the check-and-record atomic, so
 * two admins sharing a conversation processing the same stale report in the
 * same tick can never both win the race. Returns whether THIS call actually
 * inserted the row: `true` means the reporter has never been notified for
 * this report before (the caller should send the DM now), `false` means a
 * row already existed (already notified — the caller must not send again).
 */
export async function recordReporterStaleNotice(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    'INSERT INTO report_reporter_stale_notices (report_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Which of `ids` have already had their reporter notified. Empty input
 * short-circuits without a query — mirrors `getWithdrawnAppealIds`'s read
 * shape exactly (batch lookup by id, returned as a `Set`).
 */
export async function getReporterStaleNoticeIds(ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { rows } = await pool.query<{ report_id: number }>(
    'SELECT report_id FROM report_reporter_stale_notices WHERE report_id = ANY($1)',
    [ids],
  );
  return new Set(rows.map((row) => row.report_id));
}
