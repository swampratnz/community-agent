import type { Platform } from '../../platforms/types.js';
import { pool } from '../db.js';
import { registerPurgeContributor } from '../lifecycle.js';

/**
 * Admin-curated, person-scoped notes (issue #45). Deliberately NOT part of
 * knowledge_search or memory recall: the table has no embedding column by
 * design and is only ever read through listMemberNotes/getMemberNote, so an
 * admin's private note about a member can never surface in a retrieval answer.
 *
 * Target validation (the member must exist in community_users) lives in the
 * tool layer so the refusal can be user-facing — do not add it here.
 *
 * Extracted verbatim from repository.ts (see repository.ts's header for why the
 * split exists); `repository.ts` re-exports everything here, so every existing
 * import site is unchanged.
 */

export const MEMBER_NOTE_MAX_CHARS = 1000;

export interface MemberNote {
  id: number;
  note: string;
  createdBy: string;
  createdAt: Date;
}

/**
 * Attach an admin-authored note to a member. Content is capped server-side;
 * target validation (the member must exist in community_users) lives in the
 * tool layer so the refusal message can be user-facing. Never in
 * knowledge_search or memory recall — this table has no embedding column by
 * design and is only read through listMemberNotes.
 */
export async function addMemberNote(input: {
  platform: Platform;
  userId: string;
  note: string;
  createdBy: string;
}): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO member_notes (platform, user_id, note, created_by)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [input.platform, input.userId, input.note.slice(0, MEMBER_NOTE_MAX_CHARS), input.createdBy],
  );
  return Number(rows[0].id);
}

export async function listMemberNotes(platform: Platform, userId: string): Promise<MemberNote[]> {
  const { rows } = await pool.query(
    `SELECT id, note, created_by, created_at
       FROM member_notes
      WHERE platform = $1 AND user_id = $2
      ORDER BY created_at DESC`,
    [platform, userId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

/** Fetch one note by id, so the delete CONFIRM can show whose note it is. */
export async function getMemberNote(
  id: number,
): Promise<{ platform: Platform; userId: string; note: string } | null> {
  const { rows } = await pool.query(`SELECT platform, user_id, note FROM member_notes WHERE id = $1`, [id]);
  if (rows.length === 0) return null;
  return { platform: rows[0].platform as Platform, userId: rows[0].user_id, note: rows[0].note };
}

/** Delete one note by id. Returns false if no row matched. */
export async function deleteMemberNote(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM member_notes WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

// --- Lifecycle registration (storage/lifecycle.ts) ---------------------------

registerPurgeContributor({
  name: 'member_notes',
  order: 40,
  async purge({ platform, userId }, tx) {
    const { rowCount: notes } = await tx.query(
      `DELETE FROM member_notes WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    return notes ?? 0;
  },
});
