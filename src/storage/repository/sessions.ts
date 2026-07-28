import type { Platform } from '../../platforms/types.js';
import { logger } from '../../logger.js';
import { pool } from '../db.js';

/**
 * Agent session continuity: the per-conversation session id the SDK resumes,
 * plus the recall reads (searchMemory / userMessages) behind memory context.
 *
 * 🔒 Carries conversation-scoped admin reads: `conversationIds` narrows a read
 * to the conversations the caller is actually in (null = super_admin,
 * unrestricted). That filter is built in SQL here, NOT by callers — moved
 * verbatim, predicate for predicate.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Sessions --------------------------------------------------------------

export interface StoredSession {
  sessionId: string;
  turnCount: number;
  updatedAt: Date;
}

export async function getClaudeSession(
  platform: Platform,
  conversationId: string,
): Promise<StoredSession | null> {
  let rows: Array<{ claude_session_id: string | null; turn_count: unknown; updated_at: Date }>;
  try {
    ({ rows } = await pool.query(
      `SELECT claude_session_id, turn_count, updated_at
       FROM sessions WHERE platform = $1 AND conversation_id = $2`,
      [platform, conversationId],
    ));
  } catch (err) {
    // Degrade to "no stored session" so the turn starts fresh instead of
    // dying — runAgentTurn already treats null as start-fresh (issue #52).
    logger.warn({ err }, 'Session lookup failed; starting a fresh session');
    return null;
  }
  const row = rows[0];
  if (!row?.claude_session_id) return null;
  return {
    sessionId: row.claude_session_id,
    turnCount: Number(row.turn_count ?? 0),
    updatedAt: row.updated_at,
  };
}

/** Upsert the session id; the turn counter increments on resume, resets on a new session. */
export async function setClaudeSessionId(
  platform: Platform,
  conversationId: string,
  sessionId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (platform, conversation_id, claude_session_id, turn_count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (platform, conversation_id)
     DO UPDATE SET
       turn_count = CASE
         WHEN sessions.claude_session_id = EXCLUDED.claude_session_id
         THEN sessions.turn_count + 1 ELSE 1 END,
       claude_session_id = EXCLUDED.claude_session_id`,
    [platform, conversationId, sessionId],
  );
}

/** Drop a stored session id (e.g. after a failed resume) so the next turn starts fresh. */
export async function clearClaudeSessionId(platform: Platform, conversationId: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET claude_session_id = NULL, updated_at = now()
      WHERE platform = $1 AND conversation_id = $2`,
    [platform, conversationId],
  );
}

/**
 * Reset the stored Claude session for every conversation the given user is
 * active in on `platform`, so a role change (grant_admin/revoke_admin) takes
 * effect on their very next message instead of being shadowed by the old-role
 * framing still in a live session's history until it rolls over
 * (SESSION_MAX_TURNS/AGE). Without this, a freshly-promoted admin keeps getting
 * refused, and — more importantly — a freshly-*revoked* admin's session could
 * keep treating them as admin for up to a full session's worth of turns.
 *
 * Non-destructive: only clears session *continuity* (nulls `claude_session_id`,
 * same primitive as `clearClaudeSessionId`); stored interactions/memory are
 * untouched and the next turn rebuilds context from them. Scoped to
 * conversations the user has actually participated in — in a group that means
 * the group's shared thread resets, which is the same fresh-start that happens
 * on normal rollover. Returns the number of sessions cleared.
 */
export async function clearUserSessions(platform: Platform, userId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE sessions
        SET claude_session_id = NULL, updated_at = now()
      WHERE platform = $1
        AND claude_session_id IS NOT NULL
        AND conversation_id IN (
          SELECT DISTINCT conversation_id FROM interactions
           WHERE platform = $1 AND user_id = $2
        )`,
    [platform, userId],
  );
  return rowCount ?? 0;
}

/**
 * True if the bot has previously seen this conversation on this platform.
 * Used to stop privileged tools from targeting arbitrary ids (e.g. messaging
 * any phone number on WhatsApp).
 */
export async function isKnownConversation(platform: Platform, conversationId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM interactions WHERE platform = $1 AND conversation_id = $2 LIMIT 1`,
    [platform, conversationId],
  );
  return rows.length > 0;
}

/**
 * Recent messages by a user, optionally restricted to a conversation set
 * (admin scoping: an admin only sees history from conversations they share).
 */
export async function userMessages(
  platform: Platform,
  userId: string,
  limit = 20,
  conversationIds?: readonly string[],
): Promise<Array<{ conversationId: string; direction: string; content: string; createdAt: Date }>> {
  const params: unknown[] = [platform, userId];
  let scope = '';
  if (conversationIds) {
    params.push([...conversationIds]);
    scope = `AND conversation_id = ANY($${params.length})`;
  }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT conversation_id, direction, content, created_at
       FROM interactions
      WHERE platform = $1 AND user_id = $2 ${scope}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    direction: r.direction,
    content: r.content,
    createdAt: r.created_at,
  }));
}

/** True if the bot has previously seen this user on this platform. */
export async function isKnownUser(platform: Platform, userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM interactions WHERE platform = $1 AND user_id = $2 LIMIT 1`,
    [platform, userId],
  );
  return rows.length > 0;
}

/**
 * True if the bot has stored this exact message id within this conversation
 * (issue #231: `react_to_message`'s target validation — same "the bot must
 * have actually seen it" discipline as `isKnownUser`/`isKnownConversation`,
 * scoped to one conversation since a member may only react within their own).
 */
export async function isKnownMessage(
  platform: Platform,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM interactions WHERE platform = $1 AND conversation_id = $2 AND message_id = $3 LIMIT 1`,
    [platform, conversationId, messageId],
  );
  return rows.length > 0;
}
