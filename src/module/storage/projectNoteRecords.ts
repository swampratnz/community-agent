import type { Platform } from '@swampratnz/agent-base/platforms/types.js';
import { pool } from '@swampratnz/agent-base/storage/db.js';
import { registerPurgeContributor } from '@swampratnz/agent-base/storage/lifecycle.js';

/**
 * Reads/writes for `project_note_authors`/`project_note_withdrawals` (issue
 * #1344, the module fragment `schema/85-project-note-records.sql`) — the
 * self-service correction path `project_note` never had. Module-owned
 * auxiliary tables beside the base `project_notes` table, never mutating it,
 * the same "base owns the row, module tracks something alongside it" pattern
 * `suggestionWithdrawals.ts`/`appealWithdrawals.ts`/`findHelperRequests.ts`
 * established.
 *
 * Every caller-scoping decision (does THIS caller own note N) is made here,
 * not by the tool handler, so `isOwnProjectNote` is the one place that can
 * ever answer yes.
 */

/**
 * Record who authored a note, right after a successful `saveProjectNote`.
 * `ON CONFLICT DO NOTHING` — the caller (project_note's handler) treats this
 * as a best-effort side write and never retries it, so a duplicate call for
 * the same note id (which should not happen; note ids are not reused) must
 * not throw.
 */
export async function recordProjectNoteAuthor(
  noteId: number,
  platform: Platform,
  userId: string,
): Promise<void> {
  await pool.query(
    'INSERT INTO project_note_authors (note_id, author_platform, author_user_id) VALUES ($1, $2, $3) ON CONFLICT (note_id) DO NOTHING',
    [noteId, platform, userId],
  );
}

/**
 * Whether `platform`/`userId` is the recorded author of `noteId`. False for
 * an unknown note id AND for a note authored by someone else — deliberately
 * indistinguishable to the caller, so `withdraw_project_note` can return the
 * identical refusal either way (issue #205's wording rule, reused here).
 */
export async function isOwnProjectNote(noteId: number, platform: Platform, userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM project_note_authors WHERE note_id = $1 AND author_platform = $2 AND author_user_id = $3',
    [noteId, platform, userId],
  );
  return rows.length > 0;
}

/**
 * Record one note's withdrawal. `ON CONFLICT DO NOTHING` makes a repeated
 * withdrawal of the same id idempotent — no duplicate row, no error — since
 * `withdraw_project_note` may be called more than once against a note it
 * already withdrew.
 */
export async function recordProjectNoteWithdrawal(noteId: number): Promise<void> {
  await pool.query('INSERT INTO project_note_withdrawals (note_id) VALUES ($1) ON CONFLICT DO NOTHING', [
    noteId,
  ]);
}

/**
 * Which of `ids` have been withdrawn. Empty input short-circuits without a
 * query — `project_recall`'s filter step calls this with every hit's id.
 */
export async function getWithdrawnProjectNoteIds(ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { rows } = await pool.query<{ note_id: number }>(
    'SELECT note_id FROM project_note_withdrawals WHERE note_id = ANY($1)',
    [ids],
  );
  return new Set(rows.map((row) => row.note_id));
}

// --- Lifecycle registration (storage/lifecycle.ts) --------------------------
//
// project_note_authors stores direct identity (author_platform/
// author_user_id), so a forget_me/purge_user_data run must erase the
// caller's own rows here — the same (platform, userId)-keyed pattern
// findHelperRequests.ts uses. This deliberately does NOT touch the
// underlying base project_notes content, matching project_remove_member's
// already-accepted "revokes access/breaks the link, does not erase the
// team's contributions" precedent: only the traceability back to the author
// is erased. project_note_withdrawals stores no identity at all, so it
// registers no purge contributor, the same reasoning suggestion_withdrawals/
// appeal_withdrawals already document.
registerPurgeContributor({
  name: 'project_note_authors',
  order: 220,
  async purge({ platform, userId }, tx) {
    const { rowCount } = await tx.query(
      'DELETE FROM project_note_authors WHERE author_platform = $1 AND author_user_id = $2',
      [platform, userId],
    );
    return rowCount ?? 0;
  },
});
