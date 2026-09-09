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
 * Count of notes `platform`/`userId` has authored — `my_data`'s (issue #1363)
 * self-scoped read, mirroring `isOwnProjectNote`'s per-caller query shape but
 * counting instead of checking one id.
 */
export async function countOwnProjectNoteAuthorships(platform: Platform, userId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*) FROM project_note_authors WHERE author_platform = $1 AND author_user_id = $2',
    [platform, userId],
  );
  return Number(rows[0].count);
}

/**
 * Best-effort content preview capture (issue #1366), written right after
 * `recordProjectNoteAuthor` from the same call. `ON CONFLICT DO NOTHING` —
 * the caller (`project_note`'s handler) treats this as best-effort and never
 * retries, the same discipline `recordProjectNoteAuthor` uses.
 */
export async function recordProjectNotePreview(
  noteId: number,
  projectSlug: string,
  preview: string,
): Promise<void> {
  await pool.query(
    'INSERT INTO project_note_previews (note_id, project_slug, preview) VALUES ($1, $2, $3) ON CONFLICT (note_id) DO NOTHING',
    [noteId, projectSlug, preview],
  );
}

/** One row of `listOwnProjectNotePreviews` — `my_project_notes`' render input. */
export interface OwnProjectNotePreview {
  id: number;
  projectSlug: string;
  preview: string;
  createdAt: Date;
}

/**
 * The caller's own authored-note previews, newest first, capped — `my_project_notes`'
 * (issue #1366) self-scoped read. `project_note_previews` carries no identity
 * of its own, so scoping joins through `project_note_authors` — the same
 * "prove ownership via the authors table" shape `isOwnProjectNote` already
 * uses. A note written before this shipped (no preview row) or in the
 * narrow window between #1344 and this landing (author row but no preview
 * row) is simply absent from the listing — no backfill, matching
 * `withdraw_project_note`'s own precedent for a pre-existing note with no
 * author row.
 */
export async function listOwnProjectNotePreviews(
  platform: Platform,
  userId: string,
  limit: number,
): Promise<OwnProjectNotePreview[]> {
  const { rows } = await pool.query<{
    note_id: number;
    project_slug: string;
    preview: string;
    created_at: Date;
  }>(
    `SELECT p.note_id, p.project_slug, p.preview, p.created_at
       FROM project_note_previews p
       JOIN project_note_authors a ON a.note_id = p.note_id
      WHERE a.author_platform = $1 AND a.author_user_id = $2
      ORDER BY p.created_at DESC
      LIMIT $3`,
    [platform, userId, limit],
  );
  return rows.map((row) => ({
    id: row.note_id,
    projectSlug: row.project_slug,
    preview: row.preview,
    createdAt: row.created_at,
  }));
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
// project_note_previews stores no identity column at all (issue #1366), so it
// can only be scoped to an identity by joining through project_note_authors
// — which means this contributor MUST run and complete before the
// project_note_authors contributor below deletes the very rows this join
// depends on. registerPurgeContributor sorts contributors ascending by
// `order` before running them inside the same transaction, so `219 < 220`
// is what guarantees that sequencing; a naive contributor placed AFTER order
// 220 would find an empty join and silently orphan every preview row for
// this identity (the failure mode the SECURITY test in
// tests/myProjectNotes.test.ts pins directly).
registerPurgeContributor({
  name: 'project_note_previews',
  order: 219,
  async purge({ platform, userId }, tx) {
    const { rowCount } = await tx.query(
      `DELETE FROM project_note_previews
        WHERE note_id IN (
          SELECT note_id FROM project_note_authors
           WHERE author_platform = $1 AND author_user_id = $2
        )`,
      [platform, userId],
    );
    return rowCount ?? 0;
  },
});

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
