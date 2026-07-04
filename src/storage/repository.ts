import pgvector from 'pgvector/pg';
import type { Platform, Tier } from '../platforms/types.js';
import { logger } from '../logger.js';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { embed } from './embeddings.js';
import { config } from '../config.js';

export interface InteractionInput {
  platform: Platform;
  conversationId: string;
  userId: string;
  userName?: string;
  role: Tier;
  direction: 'inbound' | 'outbound';
  content: string;
  addressedToBot?: boolean;
  isDirect?: boolean;
  costUsd?: number;
  meta?: Record<string, unknown>;
  /** Platform-native message id, for delete/edit honouring (issue #48). */
  messageId?: string;
  /** 'addressed' (to the bot / DM) vs 'ambient' channel chatter (issue #48). */
  kind?: 'addressed' | 'ambient';
}

/** Persist one interaction, embedding its content for later semantic recall. */
export async function recordInteraction(input: InteractionInput): Promise<void> {
  let embedding: number[] | null = null;
  try {
    embedding = await embed(input.content);
  } catch (err) {
    // Memory is best-effort; never drop the audit record because embedding failed.
    logger.warn({ err }, 'Embedding failed; storing interaction without vector');
  }

  const insert = (vec: number[] | null) =>
    pool.query(
      `INSERT INTO interactions
         (platform, conversation_id, user_id, user_name, role, direction,
          content, addressed_to_bot, is_direct, cost_usd, meta, embedding,
          message_id, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        input.platform,
        input.conversationId,
        input.userId,
        input.userName ?? null,
        input.role,
        input.direction,
        input.content,
        input.addressedToBot ?? false,
        input.isDirect ?? false,
        input.costUsd ?? null,
        JSON.stringify(input.meta ?? {}),
        vec ? pgvector.toSql(vec) : null,
        input.messageId ?? null,
        input.kind ?? 'addressed',
      ],
    );

  try {
    await insert(embedding);
  } catch (err) {
    if (!embedding) throw err;
    // A bad vector (e.g. dimension mismatch) must not lose the audit record:
    // retry without it.
    logger.warn({ err }, 'Insert with embedding failed; retrying without vector');
    await insert(null);
  }
}

/**
 * Fail fast if the live vector column dimension doesn't match config —
 * otherwise every embedded insert silently degrades. Changing models requires
 * migrating the column and re-embedding, not just editing .env.
 */
export async function verifyEmbeddingDim(expected: number): Promise<void> {
  const { rows } = await pool.query(
    `SELECT atttypmod AS dim
       FROM pg_attribute
      WHERE attrelid = 'interactions'::regclass AND attname = 'embedding'`,
  );
  const actual = rows[0]?.dim;
  if (typeof actual === 'number' && actual > 0 && actual !== expected) {
    throw new Error(
      `interactions.embedding is VECTOR(${actual}) but EMBEDDING_DIM=${expected}. ` +
        `Changing the embedding model requires migrating the column and re-embedding existing rows.`,
    );
  }
}

export interface MemoryHit {
  content: string;
  userName: string | null;
  role: string;
  direction: string;
  createdAt: Date;
  similarity: number;
  platform: Platform;
  /** Platform-native conversation/channel id (Discord jump links, issue #137). */
  conversationId: string;
  /** Platform-native message id, when it was captured (issue #48). Null for pre-archiving rows. */
  messageId: string | null;
  isDirect: boolean;
}

/**
 * Semantic search over past interactions. Returns the most relevant prior
 * messages to the given query, optionally scoped to one conversation.
 */
export async function searchMemory(
  query: string,
  opts: {
    platform?: Platform;
    conversationId?: string;
    /** Restrict to this set of conversations (admin scoping). */
    conversationIds?: readonly string[];
    topK?: number;
  } = {},
): Promise<MemoryHit[]> {
  const topK = opts.topK ?? config.behaviour.memoryTopK;
  if (topK <= 0) return [];

  let queryVec: number[];
  try {
    queryVec = await embed(query);
  } catch (err) {
    logger.warn({ err }, 'Embedding query failed; skipping memory search');
    return [];
  }

  const filters: string[] = ['embedding IS NOT NULL'];
  const params: unknown[] = [pgvector.toSql(queryVec)];
  if (opts.platform) {
    params.push(opts.platform);
    filters.push(`platform = $${params.length}`);
  }
  if (opts.conversationId) {
    params.push(opts.conversationId);
    filters.push(`conversation_id = $${params.length}`);
  }
  if (opts.conversationIds) {
    params.push([...opts.conversationIds]);
    filters.push(`conversation_id = ANY($${params.length})`);
  }
  params.push(topK);

  let rows: Array<{
    content: string;
    user_name: string | null;
    role: string;
    direction: string;
    created_at: Date;
    platform: Platform;
    conversation_id: string;
    message_id: string | null;
    is_direct: boolean;
    similarity: unknown;
  }>;
  try {
    ({ rows } = await pool.query(
      `SELECT content, user_name, role, direction, created_at,
            platform, conversation_id, message_id, is_direct,
            1 - (embedding <=> $1) AS similarity
       FROM interactions
      WHERE ${filters.join(' AND ')}
      ORDER BY embedding <=> $1
      LIMIT $${params.length}`,
      params,
    ));
  } catch (err) {
    // A transient DB failure must degrade to "no relevant memories", not kill
    // the whole turn (issue #52) — same treatment as the embed() catch above.
    logger.warn({ err }, 'Memory search query failed; proceeding without memory context');
    return [];
  }

  return rows.map((r) => ({
    content: r.content,
    userName: r.user_name,
    role: r.role,
    direction: r.direction,
    createdAt: r.created_at,
    similarity: Number(r.similarity),
    platform: r.platform,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    isDirect: r.is_direct,
  }));
}

/**
 * Honour a platform-level message deletion (issue #48): hard-delete the
 * stored copy. Returns the number of rows removed (0 when the message was
 * never stored, e.g. pre-archiving or a bot message).
 */
export async function deleteInteractionByMessageId(platform: Platform, messageId: string): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM interactions WHERE platform = $1 AND message_id = $2`, [
    platform,
    messageId,
  ]);
  return rowCount ?? 0;
}

/**
 * Honour a platform-level message edit (issue #48): replace the stored
 * content and re-embed it (NULL embedding on failure, same best-effort
 * fallback as recordInteraction). Returns false if no stored row matched.
 */
export async function updateInteractionByMessageId(
  platform: Platform,
  messageId: string,
  content: string,
): Promise<boolean> {
  let embedding: number[] | null = null;
  try {
    embedding = await embed(content);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for edited message; storing update without vector');
  }
  const { rowCount } = await pool.query(
    `UPDATE interactions SET content = $3, embedding = $4
      WHERE platform = $1 AND message_id = $2`,
    [platform, messageId, content, embedding ? pgvector.toSql(embedding) : null],
  );
  return (rowCount ?? 0) > 0;
}

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

// --- Knowledge -------------------------------------------------------------

/**
 * Higher than QUESTION_CLUSTER_SIMILARITY_THRESHOLD (0.85, used to cluster
 * interactions): a missed duplicate nudge here is only a minor inconvenience,
 * but a false one is noise on every admin save, so we require a tighter match.
 */
const KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD = 0.92;

export interface KnowledgeDuplicateMatch {
  id: number;
  title: string | null;
  content: string;
  similarity: number;
}

export async function saveKnowledge(input: {
  content: string;
  title?: string;
  scope?: string;
  sourceUserId?: string;
  createdByRole?: Tier;
}): Promise<{ id: number; similarEntry?: KnowledgeDuplicateMatch }> {
  const scope = input.scope ?? 'global';
  let embedding: number[] | null = null;
  try {
    embedding = await embed(input.title ? `${input.title}\n${input.content}` : input.content);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for knowledge entry');
  }

  let similarEntry: KnowledgeDuplicateMatch | undefined;
  if (embedding) {
    const vec = pgvector.toSql(embedding);
    const { rows: matches } = await pool.query(
      `SELECT id, title, content, 1 - (embedding <=> $1) AS similarity
         FROM knowledge
        WHERE scope = $2 AND embedding IS NOT NULL
        ORDER BY embedding <=> $1
        LIMIT 1`,
      [vec, scope],
    );
    const top = matches[0];
    if (top && Number(top.similarity) >= KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD) {
      similarEntry = {
        id: Number(top.id),
        title: top.title,
        content: top.content,
        similarity: Number(top.similarity),
      };
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO knowledge (scope, title, content, source_user_id, created_by_role, embedding)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      scope,
      input.title ?? null,
      input.content,
      input.sourceUserId ?? null,
      input.createdByRole ?? 'admin',
      embedding ? pgvector.toSql(embedding) : null,
    ],
  );
  return { id: Number(rows[0].id), similarEntry };
}

/**
 * Semantic search over curated knowledge, scoped to what `caller` may see:
 * `'global'` entries, entries scoped to the caller's platform, and entries
 * scoped to the caller's exact conversation (SECURITY: issue #106 — `scope`
 * used to be write-only metadata; an admin who saved a conversation-scoped
 * entry had it recite to every tier, everywhere). `list_knowledge` (admin
 * browse) deliberately keeps its own unrestricted-by-default behaviour —
 * that's a curation view, not member-facing recall.
 */
export async function searchKnowledge(
  query: string,
  caller: { platform: Platform; conversationId: string },
  topK = 5,
): Promise<Array<{ title: string | null; content: string; similarity: number; updatedAt: Date }>> {
  let queryVec: number[];
  try {
    queryVec = await embed(query);
  } catch {
    return [];
  }
  const { rows } = await pool.query(
    `SELECT title, content, updated_at, 1 - (embedding <=> $1) AS similarity
       FROM knowledge
      WHERE embedding IS NOT NULL
        AND scope IN ('global', $2, $3)
      ORDER BY embedding <=> $1
      LIMIT $4`,
    [pgvector.toSql(queryVec), caller.platform, caller.conversationId, topK],
  );
  return rows.map((r) => ({
    title: r.title,
    content: r.content,
    similarity: Number(r.similarity),
    updatedAt: r.updated_at,
  }));
}

export interface KnowledgeEntry {
  id: number;
  scope: string;
  title: string | null;
  content: string;
  createdByRole: string;
  updatedAt: Date;
}

/** Browse knowledge entries directly (as opposed to semantic search), optionally filtered by scope. */
export async function listKnowledge(
  input: { scope?: string; limit?: number; offset?: number } = {},
): Promise<KnowledgeEntry[]> {
  const params: unknown[] = [];
  let scopeClause = '';
  if (input.scope) {
    params.push(input.scope);
    scopeClause = `WHERE scope = $${params.length}`;
  }
  params.push(input.limit ?? 20);
  const limitParam = params.length;
  params.push(input.offset ?? 0);
  const { rows } = await pool.query(
    `SELECT id, scope, title, content, created_by_role, updated_at
       FROM knowledge
       ${scopeClause}
      ORDER BY updated_at DESC
      LIMIT $${limitParam} OFFSET $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    scope: r.scope,
    title: r.title,
    content: r.content,
    createdByRole: r.created_by_role,
    updatedAt: r.updated_at,
  }));
}

/** Update a knowledge entry's title/content/scope and re-embed. Returns false if no row matched. */
export async function updateKnowledge(input: {
  id: number;
  title?: string;
  content?: string;
  scope?: string;
}): Promise<boolean> {
  const { rows: existingRows } = await pool.query(`SELECT title, content FROM knowledge WHERE id = $1`, [
    input.id,
  ]);
  if (existingRows.length === 0) return false;

  const title = input.title !== undefined ? input.title : existingRows[0].title;
  const content = input.content !== undefined ? input.content : existingRows[0].content;

  let embedding: number[] | null = null;
  try {
    embedding = await embed(title ? `${title}\n${content}` : content);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for knowledge update');
  }

  const { rowCount } = await pool.query(
    `UPDATE knowledge
        SET title = $2, content = $3, scope = COALESCE($4, scope), embedding = COALESCE($5, embedding)
      WHERE id = $1`,
    [input.id, title ?? null, content, input.scope ?? null, embedding ? pgvector.toSql(embedding) : null],
  );
  return (rowCount ?? 0) > 0;
}

/** Delete a knowledge entry by id. Returns false if no row matched. */
export async function deleteKnowledge(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

// --- Membership (three-tier RBAC) -------------------------------------------

export type StoredRole = 'admin' | 'member';

export async function getMemberRole(platform: Platform, userId: string): Promise<StoredRole | null> {
  const { rows } = await pool.query(
    `SELECT role FROM community_users WHERE platform = $1 AND platform_user_id = $2`,
    [platform, userId],
  );
  const role = rows[0]?.role;
  return role === 'admin' || role === 'member' ? role : null;
}

/**
 * Upsert a membership grant. Never downgrades: adding an existing admin as a
 * member keeps them admin (downgrades go through revoke_admin explicitly).
 */
export async function upsertMember(input: {
  platform: Platform;
  userId: string;
  role: StoredRole;
  addedBy: string;
  displayName?: string;
}): Promise<StoredRole> {
  const { rows } = await pool.query(
    `INSERT INTO community_users (platform, platform_user_id, display_name, role, added_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (platform, platform_user_id)
     DO UPDATE SET
       role = CASE
         WHEN community_users.role = 'admin' AND EXCLUDED.role = 'member'
         THEN community_users.role ELSE EXCLUDED.role END,
       display_name = COALESCE(EXCLUDED.display_name, community_users.display_name)
     RETURNING role`,
    [input.platform, input.userId, input.displayName ?? null, input.role, input.addedBy],
  );
  return rows[0].role as StoredRole;
}

/** Explicit downgrade of an admin to member. Returns false if not an admin. */
export async function demoteAdmin(platform: Platform, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE community_users SET role = 'member'
      WHERE platform = $1 AND platform_user_id = $2 AND role = 'admin'`,
    [platform, userId],
  );
  return (rowCount ?? 0) > 0;
}

export interface AdminIdentity {
  platform: Platform;
  platformUserId: string;
}

/**
 * All admin-tier identities (`community_users.role = 'admin'`), for the
 * weekly admin digest (issue #97) to enumerate recipients. Super admins are
 * env-sourced (`superAdminIds`) and deliberately excluded here — they keep
 * the on-demand, all-conversation-scoped `question_digest` tool instead of
 * this per-admin scoped push.
 */
export async function listAdmins(): Promise<AdminIdentity[]> {
  const { rows } = await pool.query(
    `SELECT platform, platform_user_id FROM community_users WHERE role = 'admin'`,
  );
  return rows.map((r) => ({
    platform: r.platform as Platform,
    platformUserId: r.platform_user_id as string,
  }));
}

/** Remove a member row entirely. Refuses to remove admins (revoke first). */
/**
 * If a person group is left with fewer than two members, dissolve it: clear
 * any straggler's person_id and delete the persons row. Keeps the "no
 * singleton groups, no orphaned persons rows" invariant. Must run inside the
 * caller's open transaction.
 */
async function dissolveGroupIfUnderTwo(client: PoolClient, personId: number): Promise<void> {
  const { rows } = await client.query(`SELECT count(*) AS n FROM community_users WHERE person_id = $1`, [
    personId,
  ]);
  if (Number(rows[0].n) <= 1) {
    await client.query(`UPDATE community_users SET person_id = NULL WHERE person_id = $1`, [personId]);
    await client.query(`DELETE FROM persons WHERE id = $1`, [personId]);
  }
}

/**
 * Remove a member row. If the member was linked, dissolve a person group this
 * would leave with a single member — the same invariant `unlinkMember`
 * protects, so hard-removing a linked member never orphans a persons row or
 * leaves a co-member "still linked" to a now-empty group.
 */
export async function removeMember(platform: Platform, userId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT person_id FROM community_users
        WHERE platform = $1 AND platform_user_id = $2 AND role = 'member' FOR UPDATE`,
      [platform, userId],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `DELETE FROM community_users WHERE platform = $1 AND platform_user_id = $2 AND role = 'member'`,
      [platform, userId],
    );
    if (rows[0].person_id) await dissolveGroupIfUnderTwo(client, Number(rows[0].person_id));
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- Cross-platform identity linking ----------------------------------------

export interface PersonIdentity {
  platform: Platform;
  userId: string;
}

/**
 * All platform identities that are the same person as (platform, userId),
 * including itself. Unlinked users (person_id NULL, or no community_users
 * row at all) resolve to just themselves — callers never need to special-case
 * "not linked". This is the one place forget_me/purge and the reply budget
 * consult to decide whether to aggregate across identities.
 */
export async function resolveLinkedIdentities(platform: Platform, userId: string): Promise<PersonIdentity[]> {
  const { rows } = await pool.query(
    `SELECT platform, platform_user_id FROM community_users
      WHERE person_id = (
        SELECT person_id FROM community_users WHERE platform = $1 AND platform_user_id = $2
      )`,
    [platform, userId],
  );
  if (rows.length === 0) return [{ platform, userId }];
  return rows.map((r) => ({ platform: r.platform as Platform, userId: r.platform_user_id as string }));
}

/**
 * Link two platform identities as the same human. Both must already be known
 * community members (a community_users row exists) — this is a data-hygiene
 * link over verified members, not a way to grant membership. NEVER touches
 * `role`: tier stays per-platform-row by design, so linking a member to an
 * admin can never make the member resolve as admin (see docs/SECURITY.md).
 *
 * Idempotent: linking two identities already in the same group is a no-op
 * success. Linking across two existing (different) groups merges them. The
 * two named rows are locked FOR UPDATE; a concurrent link/unlink touching an
 * *unlocked* co-member of a merging group may deadlock, in which case Postgres
 * aborts one side and this rolls back cleanly (no partial merge) — safe, but
 * the loser sees a DB error rather than a serialized success. These are
 * admin-tier, CONFIRM-gated actions, so real contention is negligible.
 */
export async function linkMembers(
  platformA: Platform,
  userA: string,
  platformB: Platform,
  userB: string,
): Promise<{ personId: number }> {
  if (platformA === platformB && userA === userB) {
    throw new Error('Cannot link an identity to itself.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT platform, platform_user_id, person_id FROM community_users
        WHERE (platform = $1 AND platform_user_id = $2) OR (platform = $3 AND platform_user_id = $4)
        FOR UPDATE`,
      [platformA, userA, platformB, userB],
    );
    const rowA = rows.find((r) => r.platform === platformA && r.platform_user_id === userA);
    const rowB = rows.find((r) => r.platform === platformB && r.platform_user_id === userB);
    if (!rowA || !rowB) {
      throw new Error('Both identities must already be known community members.');
    }

    let personId: number;
    if (rowA.person_id && rowB.person_id) {
      const keep = Math.min(Number(rowA.person_id), Number(rowB.person_id));
      const drop = Math.max(Number(rowA.person_id), Number(rowB.person_id));
      if (keep !== drop) {
        await client.query(`UPDATE community_users SET person_id = $1 WHERE person_id = $2`, [keep, drop]);
        await client.query(`DELETE FROM persons WHERE id = $1`, [drop]);
      }
      personId = keep;
    } else if (rowA.person_id || rowB.person_id) {
      personId = Number(rowA.person_id ?? rowB.person_id);
      const unlinkedIsA = !rowA.person_id;
      await client.query(
        `UPDATE community_users SET person_id = $1 WHERE platform = $2 AND platform_user_id = $3`,
        [personId, unlinkedIsA ? platformA : platformB, unlinkedIsA ? userA : userB],
      );
    } else {
      const created = await client.query(`INSERT INTO persons DEFAULT VALUES RETURNING id`);
      personId = Number(created.rows[0].id);
      await client.query(
        `UPDATE community_users SET person_id = $1
          WHERE (platform = $2 AND platform_user_id = $3) OR (platform = $4 AND platform_user_id = $5)`,
        [personId, platformA, userA, platformB, userB],
      );
    }
    await client.query('COMMIT');
    return { personId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Remove one identity from its person group. If the group would be left with
 * fewer than two members, it's dissolved entirely (every remaining member's
 * person_id cleared, the persons row deleted) rather than left as a
 * one-member group — so no identity can be silently "still linked" to a
 * now-empty group and no persons row dangles for a future link to reattach
 * to unexpectedly. Returns false if the identity wasn't linked to anyone.
 */
export async function unlinkMember(platform: Platform, userId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT person_id FROM community_users WHERE platform = $1 AND platform_user_id = $2 FOR UPDATE`,
      [platform, userId],
    );
    const personId = rows[0]?.person_id;
    if (!personId) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `UPDATE community_users SET person_id = NULL WHERE platform = $1 AND platform_user_id = $2`,
      [platform, userId],
    );
    await dissolveGroupIfUnderTwo(client, Number(personId));
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- Policies ----------------------------------------------------------------

export async function getPolicyValue(key: string): Promise<unknown> {
  const { rows } = await pool.query(`SELECT value FROM policies WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

export async function setPolicyValue(key: string, value: unknown, updatedBy: string): Promise<void> {
  await pool.query(
    `INSERT INTO policies (key, value, updated_by)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), updatedBy],
  );
}

// --- Budgets / privacy --------------------------------------------------------

/**
 * Agent replies sent to this user in the last `sinceHours` hours, aggregated
 * across every identity linked to them via `link_member` (so the daily reply
 * budget can't be double-dipped by messaging from a linked Discord account
 * and WhatsApp number instead of one).
 */
export async function countRepliesToUser(
  platform: Platform,
  userId: string,
  sinceHours = 24,
): Promise<number> {
  const identities = await resolveLinkedIdentities(platform, userId);
  const params: unknown[] = [String(sinceHours)];
  const conditions = identities.map((id) => {
    params.push(id.platform, id.userId);
    return `(platform = $${params.length - 1} AND meta->>'replyToUserId' = $${params.length})`;
  });
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM interactions
      WHERE direction = 'outbound'
        AND created_at > now() - ($1 || ' hours')::interval
        AND (${conditions.join(' OR ')})`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Delete one identity's stored data — the single-identity core of `purgeUserData`. */
async function purgeSingleIdentity(platform: Platform, userId: string): Promise<number> {
  const { rows: deletedInteractions } = await pool.query(
    `DELETE FROM interactions
      WHERE platform = $1
        AND (user_id = $2 OR (direction = 'outbound' AND meta->>'replyToUserId' = $2))
      RETURNING id`,
    [platform, userId],
  );
  const messages = deletedInteractions.length;
  // Deletion coherence (issue #51): a context digest whose summary was built
  // over any purged interaction is invalidated outright — the next builder
  // run regenerates the topic without this person's signal. Digests store
  // interaction ids (never copied content) precisely so this is possible.
  if (messages > 0) {
    await pool.query(`DELETE FROM context_digests WHERE example_refs && $1::bigint[]`, [
      deletedInteractions.map((r) => Number(r.id)),
    ]);
  }
  // knowledge has no platform column, so this keys on source_user_id alone.
  // Safe because Discord snowflakes (17-20 digits) and WhatsApp E.164 numbers
  // (7-15 digits) can't collide as strings (enforced by normalizeMemberId), so
  // this never touches another platform's user. If that validation loosens, add
  // a platform column to knowledge and filter on it here.
  const { rowCount: knowledge } = await pool.query(`DELETE FROM knowledge WHERE source_user_id = $1`, [
    userId,
  ]);
  const { rowCount: reports } = await pool.query(
    `DELETE FROM content_reports WHERE platform = $1 AND reporter_user_id = $2`,
    [platform, userId],
  );
  const { rowCount: roster } = await pool.query(
    `DELETE FROM server_roster WHERE platform = $1 AND user_id = $2`,
    [platform, userId],
  );
  const { rowCount: notes } = await pool.query(
    `DELETE FROM member_notes WHERE platform = $1 AND user_id = $2`,
    [platform, userId],
  );
  const { rowCount: suggestions } = await pool.query(
    `DELETE FROM suggestions WHERE platform = $1 AND user_id = $2`,
    [platform, userId],
  );
  // admin_digest_sends (issue #97) is keyed on the same (platform, user id)
  // identity — purge coherence for an offboarded admin.
  const { rowCount: digestSends } = await pool.query(
    `DELETE FROM admin_digest_sends WHERE platform = $1 AND platform_user_id = $2`,
    [platform, userId],
  );
  // response_style_prefs (issue #126) is keyed the same way — purge coherence
  // for anyone who opted into the plain-language preference.
  const { rowCount: responseStyle } = await pool.query(
    `DELETE FROM response_style_prefs WHERE platform = $1 AND user_id = $2`,
    [platform, userId],
  );
  return (
    (messages ?? 0) +
    (knowledge ?? 0) +
    (reports ?? 0) +
    (roster ?? 0) +
    (notes ?? 0) +
    (suggestions ?? 0) +
    (digestSends ?? 0) +
    (responseStyle ?? 0)
  );
}

/**
 * Delete a user's stored data: their inbound messages, the bot's replies to
 * them, knowledge entries sourced from them, content reports *they
 * submitted* as reporter, their server_roster row, admin notes kept *about*
 * them (member_notes), suggestions they filed, their response-style
 * preference, and any context digest built over their purged interactions —
 * across every identity linked to them via
 * `link_member` (SECURITY: this is a deliberate blast-radius expansion —
 * linking two identities means forget_me/purge from *either* now erases
 * *both*, which is why `link_member` is CONFIRM-gated, audited, and
 * super-admin-alerted; see docs/SECURITY.md). Backs both the member-facing
 * `forget_me` and the super-admin `purge_user_data`. Membership, audit rows,
 * and reports where the user is only the *target* (not the reporter) are
 * intentionally kept (accountability data — documented in SECURITY.md).
 */
export async function purgeUserData(platform: Platform, userId: string): Promise<number> {
  const identities = await resolveLinkedIdentities(platform, userId);
  let total = 0;
  for (const identity of identities) {
    total += await purgeSingleIdentity(identity.platform, identity.userId);
  }
  return total;
}

/**
 * Age-based retention: delete raw `interactions` older than `days`. Never
 * touches `knowledge` (curated facts are meant to be durable), `sessions`
 * (governed separately by SESSION_MAX_TURNS/_AGE_HOURS), or `admin_audit`
 * (accountability trail, retained deliberately — see SECURITY.md). Returns
 * the number of rows deleted, for operator-visible logging.
 */
export async function purgeOldInteractions(days: number): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM interactions WHERE created_at < now() - ($1::text || ' days')::interval`,
    [days],
  );
  return rowCount ?? 0;
}

// --- Super-admin views ---------------------------------------------------------

export async function recentAuditEntries(limit = 20): Promise<
  Array<{
    createdAt: Date;
    platform: string;
    actorUserId: string;
    actionKind: string;
    targetUserId: string | null;
    success: boolean;
    result: string | null;
  }>
> {
  const { rows } = await pool.query(
    `SELECT created_at, platform, actor_user_id, action_kind, target_user_id, success, result
       FROM admin_audit ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    createdAt: r.created_at,
    platform: r.platform,
    actorUserId: r.actor_user_id,
    actionKind: r.action_kind,
    targetUserId: r.target_user_id,
    success: r.success,
    result: r.result,
  }));
}

/** action_kinds an admin-tier `moderation_history` read may surface — allow-list so a
 * future privileged kind (e.g. another `grant_*`) is excluded by default, not by omission. */
export const MODERATION_ACTION_KINDS = [
  'warn_user',
  'timeout_user',
  'kick_user',
  'delete_message',
  'announce',
] as const;

/**
 * Admin-tier view of moderation actions, scoped to `conversationIds` (null = super
 * admin, unrestricted — same convention as recentQuestionClusters). Mirrors
 * recentAuditEntries but additionally surfaces conversation_id (needed both for the
 * scoping filter and so an admin in multiple channels can attribute an entry) and
 * omits `params` (may carry free-text reasons with member PII beyond the target id).
 *
 * `targetUserId`/`actionKind`, when present, narrow the result further — same
 * one-predicate-append technique as listReports's `status` filter — and can never
 * widen it past the mandatory allow-list/scope predicates above.
 */
export async function recentModerationEntries(
  conversationIds: readonly string[] | null,
  limit = 20,
  targetUserId?: string,
  actionKind?: (typeof MODERATION_ACTION_KINDS)[number],
): Promise<
  Array<{
    createdAt: Date;
    platform: string;
    actorUserId: string;
    actionKind: string;
    targetUserId: string | null;
    conversationId: string | null;
    success: boolean;
    result: string | null;
  }>
> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);

  const params: unknown[] = [[...MODERATION_ACTION_KINDS]];
  let scope = '';
  if (conversationIds) {
    params.push([...conversationIds]);
    scope = `AND conversation_id = ANY($${params.length})`;
  }
  let targetFilter = '';
  if (targetUserId) {
    params.push(targetUserId);
    targetFilter = `AND target_user_id = $${params.length}`;
  }
  let actionKindFilter = '';
  if (actionKind) {
    params.push(actionKind);
    actionKindFilter = `AND action_kind = $${params.length}`;
  }
  params.push(clampedLimit);

  const { rows } = await pool.query(
    `SELECT created_at, platform, actor_user_id, action_kind, target_user_id, conversation_id, success, result
       FROM admin_audit
      WHERE action_kind = ANY($1)
        ${scope}
        ${targetFilter}
        ${actionKindFilter}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    createdAt: r.created_at,
    platform: r.platform,
    actorUserId: r.actor_user_id,
    actionKind: r.action_kind,
    targetUserId: r.target_user_id,
    conversationId: r.conversation_id,
    success: r.success,
    result: r.result,
  }));
}

export async function usageStats(days = 7): Promise<{
  inbound: number;
  outbound: number;
  costUsd: number;
  topUsers: Array<{ userId: string; userName: string | null; messages: number }>;
  costByRole: Array<{ role: Tier; costUsd: number; replies: number }>;
}> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 365);
  const interval = `${clampedDays} days`;
  const { rows: totals } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE direction = 'inbound') AS inbound,
       count(*) FILTER (WHERE direction = 'outbound') AS outbound,
       coalesce(sum(cost_usd), 0) AS cost
     FROM interactions WHERE created_at > now() - $1::interval`,
    [interval],
  );
  const { rows: top } = await pool.query(
    `SELECT user_id, max(user_name) AS user_name, count(*) AS n
       FROM interactions
      WHERE direction = 'inbound' AND created_at > now() - $1::interval
      GROUP BY user_id ORDER BY n DESC LIMIT 5`,
    [interval],
  );
  const { rows: byRole } = await pool.query(
    `SELECT role, coalesce(sum(cost_usd), 0) AS cost, count(*) AS n
       FROM interactions
      WHERE direction = 'outbound' AND created_at > now() - $1::interval
      GROUP BY role ORDER BY sum(cost_usd) DESC, role`,
    [interval],
  );
  return {
    inbound: Number(totals[0].inbound),
    outbound: Number(totals[0].outbound),
    costUsd: Number(totals[0].cost),
    topUsers: top.map((r) => ({ userId: r.user_id, userName: r.user_name, messages: Number(r.n) })),
    costByRole: byRole.map((r) => ({ role: r.role, costUsd: Number(r.cost), replies: Number(r.n) })),
  };
}

// --- Admin audit -----------------------------------------------------------

export async function recordAdminAction(input: {
  platform: Platform;
  actorUserId: string;
  actorName?: string;
  actionKind: string;
  targetUserId?: string;
  conversationId?: string;
  params?: Record<string, unknown>;
  result?: string;
  success: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO admin_audit
       (platform, actor_user_id, actor_name, action_kind, target_user_id,
        conversation_id, params, result, success)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.platform,
      input.actorUserId,
      input.actorName ?? null,
      input.actionKind,
      input.targetUserId ?? null,
      input.conversationId ?? null,
      JSON.stringify(input.params ?? {}),
      input.result ?? null,
      input.success,
    ],
  );
}

// --- Access requests (gated-mode pending queue) -----------------------------

/**
 * Record that a gated guest addressed the bot. Identity + counts only — the
 * caller must never pass message content. Upserts so repeat pings from the
 * same user dedup into one row instead of growing unbounded.
 */
export async function recordAccessRequest(input: {
  platform: Platform;
  userId: string;
  userName?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO access_requests (platform, user_id, user_name)
     VALUES ($1,$2,$3)
     ON CONFLICT (platform, user_id) DO UPDATE
       SET last_requested_at = now(),
           request_count = access_requests.request_count + 1,
           user_name = COALESCE(EXCLUDED.user_name, access_requests.user_name)`,
    [input.platform, input.userId, input.userName ?? null],
  );
}

export interface AccessRequest {
  platform: Platform;
  userId: string;
  userName: string | null;
  firstRequestedAt: Date;
  lastRequestedAt: Date;
  requestCount: number;
}

export async function listAccessRequests(limit = 50): Promise<AccessRequest[]> {
  const { rows } = await pool.query(
    `SELECT platform, user_id, user_name, first_requested_at, last_requested_at, request_count
       FROM access_requests
      ORDER BY last_requested_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    platform: r.platform,
    userId: r.user_id,
    userName: r.user_name,
    firstRequestedAt: r.first_requested_at,
    lastRequestedAt: r.last_requested_at,
    requestCount: Number(r.request_count),
  }));
}

/** Clear a resolved access request (e.g. after add_member succeeds for that user). */
export async function clearAccessRequest(platform: Platform, userId: string): Promise<void> {
  await pool.query(`DELETE FROM access_requests WHERE platform = $1 AND user_id = $2`, [platform, userId]);
}

/**
 * Exact pending-guest count — a dedicated `COUNT(*)` rather than
 * `(await listAccessRequests()).length`, which would silently understate a
 * backlog past that function's `limit` (default 50) cap.
 */
export async function countAccessRequests(): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*) AS n FROM access_requests`);
  return Number(rows[0].n);
}

// --- Context digests (offline builder output, issue #51) ---------------------

export interface ContextDigest {
  id: number;
  periodStart: Date;
  periodEnd: Date;
  platform: string | null;
  topic: string;
  summary: string;
  exampleRefs: number[];
  distinctUsers: number;
  questionCount: number;
  createdAt: Date;
}

export async function insertContextDigest(input: {
  periodStart: Date;
  periodEnd: Date;
  platform?: string;
  topic: string;
  summary: string;
  exampleRefs: number[];
  distinctUsers: number;
  questionCount: number;
}): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO context_digests
       (period_start, period_end, platform, topic, summary, example_refs, distinct_users, question_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      input.periodStart,
      input.periodEnd,
      input.platform ?? null,
      input.topic,
      input.summary,
      input.exampleRefs,
      input.distinctUsers,
      input.questionCount,
    ],
  );
  return Number(rows[0].id);
}

export async function listContextDigests(days = 30, limit = 20): Promise<ContextDigest[]> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const { rows } = await pool.query(
    `SELECT id, period_start, period_end, platform, topic, summary, example_refs,
            distinct_users, question_count, created_at
       FROM context_digests
      WHERE created_at > now() - $1::interval
      ORDER BY created_at DESC, question_count DESC
      LIMIT $2`,
    [`${clampedDays} days`, clampedLimit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    periodStart: r.period_start,
    periodEnd: r.period_end,
    platform: r.platform,
    topic: r.topic,
    summary: r.summary,
    exampleRefs: (r.example_refs as unknown[]).map(Number),
    distinctUsers: Number(r.distinct_users),
    questionCount: Number(r.question_count),
    createdAt: r.created_at,
  }));
}

/** When the builder last produced anything — backs the ~daily freshness guard. */
export async function latestContextDigestAt(): Promise<Date | null> {
  const { rows } = await pool.query(`SELECT max(created_at) AS at FROM context_digests`);
  return rows[0]?.at ?? null;
}

/**
 * Inbound rows (with embeddings) in the builder's window, oldest-first.
 * Bounded so a very busy window can't balloon builder memory.
 */
export async function recentInboundForClustering(
  days: number,
  limit = 5000,
): Promise<Array<{ id: number; userId: string; content: string; embedding: number[] }>> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 1, 1), 30);
  const { rows } = await pool.query(
    `SELECT id, user_id, content, embedding
       FROM interactions
      WHERE direction = 'inbound' AND embedding IS NOT NULL
        AND created_at > now() - $1::interval
      ORDER BY created_at ASC
      LIMIT $2`,
    [`${clampedDays} days`, limit],
  );
  return rows
    .filter((r) => Array.isArray(r.embedding))
    .map((r) => ({
      id: Number(r.id),
      userId: r.user_id,
      content: r.content,
      embedding: r.embedding as number[],
    }));
}

// --- Suggestions (member-submitted bot-improvement queue, issue #46) ---------

/** Per-user cap on new suggestions within a rolling 24h window (anti-spam on the admin queue). */
export const SUGGESTION_RATE_LIMIT_PER_DAY = 3;
export const SUGGESTION_MAX_CHARS = 1000;

export type SuggestionStatus = 'new' | 'reviewed' | 'declined' | 'done';

export interface Suggestion {
  id: number;
  platform: Platform;
  userId: string;
  displayName: string | null;
  content: string;
  status: SuggestionStatus;
  createdAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

/**
 * Record a member's suggestion, enforcing a DB-backed rolling-24h cap per
 * user (COUNT(*) inside the insert, same restart-proof pattern as
 * createContentReport — never an in-memory or model-supplied counter).
 * Returns null when the caller is at/over the cap; the tool layer turns
 * that into a polite refusal.
 */
export async function createSuggestion(input: {
  platform: Platform;
  userId: string;
  displayName?: string;
  content: string;
}): Promise<{ id: number } | null> {
  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT count(*) AS n FROM suggestions
        WHERE platform = $1 AND user_id = $2
          AND created_at > now() - interval '24 hours'
     )
     INSERT INTO suggestions (platform, user_id, display_name, content)
     SELECT $1, $2, $3, $4
      WHERE (SELECT n FROM recent) < $5
     RETURNING id`,
    [
      input.platform,
      input.userId,
      input.displayName ?? null,
      input.content.slice(0, SUGGESTION_MAX_CHARS),
      SUGGESTION_RATE_LIMIT_PER_DAY,
    ],
  );
  return rows[0] ? { id: Number(rows[0].id) } : null;
}

/** Admin-tier read of the suggestion queue (there is deliberately no member read path). */
export async function listSuggestions(status?: SuggestionStatus, limit = 50): Promise<Suggestion[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const params: unknown[] = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE status = $${params.length}`;
  }
  params.push(clampedLimit);
  const { rows } = await pool.query(
    `SELECT id, platform, user_id, display_name, content, status, created_at, reviewed_by, reviewed_at
       FROM suggestions
       ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    platform: r.platform as Platform,
    userId: r.user_id,
    displayName: r.display_name,
    content: r.content,
    status: r.status as SuggestionStatus,
    createdAt: r.created_at,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
  }));
}

/**
 * Flip a suggestion's status once triaged. Returns the resolved row's
 * platform/userId/content (so the caller can notify the submitter) or null
 * if no row matched — same "no match" signal the old boolean return gave.
 */
export async function resolveSuggestion(
  id: number,
  status: Exclude<SuggestionStatus, 'new'>,
  reviewedBy: string,
): Promise<{ platform: Platform; userId: string; content: string } | null> {
  const { rows } = await pool.query(
    `UPDATE suggestions SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1
     RETURNING platform, user_id, content`,
    [id, status, reviewedBy],
  );
  return rows[0]
    ? { platform: rows[0].platform as Platform, userId: rows[0].user_id, content: rows[0].content }
    : null;
}

// --- Member notes (admin-curated person-scoped context, issue #45) -----------

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

// --- Server roster (join/leave persistence) ----------------------------------

/**
 * Upsert a roster row for someone present in the server. Used by both the
 * join event and the startup backfill, so it must be idempotent for an
 * already-present user: display name refreshes, nothing else moves. A user
 * whose row is marked left re-activates as a rejoin (left_at cleared,
 * rejoined_count bumped, joined_at reset to now). Identity metadata only —
 * callers must never pass message content (SECURITY.md invariant).
 */
export async function upsertRosterMember(input: {
  platform: Platform;
  userId: string;
  displayName?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO server_roster (platform, user_id, display_name)
     VALUES ($1,$2,$3)
     ON CONFLICT (platform, user_id) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, server_roster.display_name),
       rejoined_count = CASE
         WHEN server_roster.left_at IS NOT NULL
         THEN server_roster.rejoined_count + 1 ELSE server_roster.rejoined_count END,
       joined_at = CASE
         WHEN server_roster.left_at IS NOT NULL THEN now() ELSE server_roster.joined_at END,
       left_at = NULL`,
    [input.platform, input.userId, input.displayName ?? null],
  );
}

/** Mark a roster row as left. No-op (false) if unknown or already marked left. */
export async function markRosterLeave(platform: Platform, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE server_roster SET left_at = now()
      WHERE platform = $1 AND user_id = $2 AND left_at IS NULL`,
    [platform, userId],
  );
  return (rowCount ?? 0) > 0;
}

export type RosterFilter = 'recent' | 'not_members' | 'left' | 'all';

export interface RosterEntry {
  userId: string;
  displayName: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  rejoinedCount: number;
  isMember: boolean;
}

/**
 * Roster view for admins. Deliberately guild-wide, not conversation-scoped —
 * the roster is the same member list every server member already sees
 * (documented in SECURITY.md alongside list_access_requests). 'not_members'
 * is the onboarding queue: present in the server but never added to
 * community_users.
 */
export async function listRoster(
  platform: Platform,
  filter: RosterFilter = 'recent',
  days = 7,
  limit = 50,
): Promise<RosterEntry[]> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 90);
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);

  const params: unknown[] = [platform];
  let where = 'r.platform = $1';
  if (filter === 'recent') {
    params.push(`${clampedDays} days`);
    where += ` AND r.left_at IS NULL AND r.joined_at > now() - $${params.length}::interval`;
  } else if (filter === 'left') {
    params.push(`${clampedDays} days`);
    where += ` AND r.left_at IS NOT NULL AND r.left_at > now() - $${params.length}::interval`;
  } else if (filter === 'not_members') {
    where += ' AND r.left_at IS NULL AND cu.id IS NULL';
  }
  params.push(clampedLimit);

  const { rows } = await pool.query(
    `SELECT r.user_id, r.display_name, r.joined_at, r.left_at, r.rejoined_count,
            (cu.id IS NOT NULL) AS is_member
       FROM server_roster r
       LEFT JOIN community_users cu
         ON cu.platform = r.platform AND cu.platform_user_id = r.user_id
      WHERE ${where}
      ORDER BY COALESCE(r.left_at, r.joined_at) DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    joinedAt: r.joined_at,
    leftAt: r.left_at,
    rejoinedCount: Number(r.rejoined_count),
    isMember: Boolean(r.is_member),
  }));
}

/** Growth-pulse counts for the roster summary line. */
export async function rosterCounts(
  platform: Platform,
): Promise<{ total: number; joinedThisWeek: number; leftThisWeek: number }> {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE left_at IS NULL) AS total,
       count(*) FILTER (WHERE left_at IS NULL AND joined_at > now() - interval '7 days') AS joined_week,
       count(*) FILTER (WHERE left_at IS NOT NULL AND left_at > now() - interval '7 days') AS left_week
     FROM server_roster WHERE platform = $1`,
    [platform],
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    joinedThisWeek: Number(rows[0]?.joined_week ?? 0),
    leftThisWeek: Number(rows[0]?.left_week ?? 0),
  };
}

/**
 * Age-based retention: delete `server_roster` rows for members who have
 * LEFT (left_at IS NOT NULL) more than `days` ago. Currently-present members
 * (left_at IS NULL) are never touched, regardless of `days`. Returns the
 * number of rows deleted, for operator-visible logging.
 */
export async function purgeDepartedRoster(days: number): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM server_roster WHERE left_at IS NOT NULL AND left_at < now() - ($1::text || ' days')::interval`,
    [days],
  );
  return rowCount ?? 0;
}

// --- Question digest ---------------------------------------------------------

export interface QuestionCluster {
  representative: string;
  count: number;
}

const QUESTION_CLUSTER_SIMILARITY_THRESHOLD = 0.85;

/** Dot product of two embed()-produced (L2-normalized) vectors equals cosine similarity. */
function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Greedily cluster recently-addressed inbound messages by embedding
 * similarity to surface recurring, un-curated questions — a signal for what
 * should become a `knowledge` entry. Clustering runs in application code over
 * an already time-bounded, conversation-scoped result set (no SQL self-join;
 * see #21 for why that's the right tradeoff at this scale).
 */
export async function recentQuestionClusters(
  conversationIds: readonly string[] | null,
  days = 7,
  limit = 10,
): Promise<QuestionCluster[]> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 30);
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);

  const params: unknown[] = [`${clampedDays} days`];
  let scope = '';
  if (conversationIds) {
    params.push([...conversationIds]);
    scope = `AND conversation_id = ANY($${params.length})`;
  }

  const { rows } = await pool.query(
    `SELECT content, embedding
       FROM interactions
      WHERE addressed_to_bot = true AND direction = 'inbound'
        AND embedding IS NOT NULL
        AND created_at > now() - $1::interval
        ${scope}
      ORDER BY created_at ASC`,
    params,
  );

  const clusters: Array<{ representative: string; embedding: number[]; count: number }> = [];
  for (const row of rows) {
    const vec = row.embedding as number[] | null;
    if (!vec) continue;
    const match = clusters.find((c) => cosineSim(c.embedding, vec) >= QUESTION_CLUSTER_SIMILARITY_THRESHOLD);
    if (match) {
      match.count += 1;
    } else {
      clusters.push({ representative: row.content, embedding: vec, count: 1 });
    }
  }

  return clusters
    .filter((c) => c.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, clampedLimit)
    .map((c) => ({ representative: c.representative, count: c.count }));
}

// --- Admin digest freshness guard (issue #97) --------------------------------

/**
 * True if this admin identity was already sent the weekly digest within the
 * last `days` — the restart-safe check `src/adminDigest.ts` uses so a
 * redeploy mid-week can't double-send.
 */
export async function wasAdminDigestSentRecently(
  platform: Platform,
  platformUserId: string,
  days: number,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM admin_digest_sends
      WHERE platform = $1 AND platform_user_id = $2
        AND sent_at > now() - ($3 || ' days')::interval`,
    [platform, platformUserId, days],
  );
  return rows.length > 0;
}

/** Record that the weekly admin digest was just sent to this identity. */
export async function recordAdminDigestSent(platform: Platform, platformUserId: string): Promise<void> {
  await pool.query(
    `INSERT INTO admin_digest_sends (platform, platform_user_id, sent_at)
     VALUES ($1, $2, now())
     ON CONFLICT (platform, platform_user_id) DO UPDATE SET sent_at = now()`,
    [platform, platformUserId],
  );
}

// --- Standing response-style preference (issue #126) ------------------------

export type ResponseStyle = 'standard' | 'plain';

/**
 * The caller's standing response-style preference, or 'standard' (today's
 * default behaviour) when they've never called `set_response_style`. A
 * single primary-key lookup, so this is a negligible per-turn cost.
 */
export async function getResponseStyle(platform: Platform, userId: string): Promise<ResponseStyle> {
  try {
    const { rows } = await pool.query(
      `SELECT style FROM response_style_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    return rows[0]?.style === 'plain' ? 'plain' : 'standard';
  } catch (err) {
    // Hot-path read on every turn: a DB hiccup must not fail the turn (issue
    // #52) — degrade to the default reply style, same as getCodeAnswersPolicy.
    logger.warn({ err, platform, userId }, 'Response-style read failed; using standard');
    return 'standard';
  }
}

/** Upsert the caller's response-style preference. */
export async function setResponseStyle(
  platform: Platform,
  userId: string,
  style: ResponseStyle,
): Promise<void> {
  await pool.query(
    `INSERT INTO response_style_prefs (platform, user_id, style, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (platform, user_id) DO UPDATE SET style = $3, updated_at = now()`,
    [platform, userId, style],
  );
}

// --- Content reports (member-facing abuse/spam intake) -----------------------

/** Per-reporter cap on new reports within a rolling window (anti-griefing on the admin queue). */
export const REPORT_RATE_LIMIT_PER_DAY = 5;

export type ContentReportStatus = 'open' | 'resolved' | 'dismissed';

export interface ContentReport {
  id: number;
  platform: Platform;
  reporterUserId: string;
  reporterName: string | null;
  conversationId: string;
  targetUserId: string | null;
  messageId: string | null;
  reason: string;
  status: ContentReportStatus;
  createdAt: Date;
  resolvedBy: string | null;
  resolvedAt: Date | null;
}

function mapContentReport(r: {
  id: number | string;
  platform: string;
  reporter_user_id: string;
  reporter_name: string | null;
  conversation_id: string;
  target_user_id: string | null;
  message_id: string | null;
  reason: string;
  status: string;
  created_at: Date;
  resolved_by: string | null;
  resolved_at: Date | null;
}): ContentReport {
  return {
    id: Number(r.id),
    platform: r.platform as Platform,
    reporterUserId: r.reporter_user_id,
    reporterName: r.reporter_name,
    conversationId: r.conversation_id,
    targetUserId: r.target_user_id,
    messageId: r.message_id,
    reason: r.reason,
    status: r.status as ContentReportStatus,
    createdAt: r.created_at,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
  };
}

/**
 * Record a member's report, enforcing a DB-backed rolling-24h cap per
 * reporter (COUNT(*) over content_reports, not an in-memory counter — the
 * only existing rate limiter, router.ts's per-message map, resets on
 * restart and would let a bounce bypass the cap). Returns null when the
 * caller is at/over the cap; the tool layer turns that into a polite refusal.
 */
export async function createContentReport(input: {
  platform: Platform;
  reporterUserId: string;
  reporterName?: string;
  conversationId: string;
  targetUserId?: string;
  messageId?: string;
  reason: string;
}): Promise<{ id: number } | null> {
  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT count(*) AS n FROM content_reports
        WHERE platform = $1 AND reporter_user_id = $2
          AND created_at > now() - interval '24 hours'
     )
     INSERT INTO content_reports
       (platform, reporter_user_id, reporter_name, conversation_id, target_user_id, message_id, reason)
     SELECT $1, $2, $3, $4, $5, $6, $7
      WHERE (SELECT n FROM recent) < $8
     RETURNING id`,
    [
      input.platform,
      input.reporterUserId,
      input.reporterName ?? null,
      input.conversationId,
      input.targetUserId ?? null,
      input.messageId ?? null,
      input.reason.slice(0, 500),
      REPORT_RATE_LIMIT_PER_DAY,
    ],
  );
  return rows[0] ? { id: Number(rows[0].id) } : null;
}

/**
 * Admin-tier view of reports, scoped to `conversationIds` (null = super
 * admin, unrestricted — same convention as recentModerationEntries). A
 * report from a conversation no ordinary admin participates in (e.g. a
 * WhatsApp/Discord-DM report) is therefore only reachable here with the
 * unrestricted (super admin) scope — a deliberate, documented limitation,
 * not a silent drop; see docs/SECURITY.md.
 */
export async function listReports(
  conversationIds: readonly string[] | null,
  status?: ContentReportStatus,
  limit = 50,
): Promise<ContentReport[]> {
  const params: unknown[] = [];
  const filters: string[] = [];
  if (conversationIds) {
    params.push([...conversationIds]);
    filters.push(`conversation_id = ANY($${params.length})`);
  }
  if (status) {
    params.push(status);
    filters.push(`status = $${params.length}`);
  }
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  params.push(clampedLimit);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT id, platform, reporter_user_id, reporter_name, conversation_id, target_user_id,
            message_id, reason, status, created_at, resolved_by, resolved_at
       FROM content_reports
       ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapContentReport);
}

/**
 * Exact open-report count, scoped like `listReports` (`conversationIds`
 * null = unrestricted/super admin) — a dedicated `COUNT(*)` rather than
 * `(await listReports(scope, 'open')).length`, which would silently
 * understate a backlog past that function's clamped (≤200) `limit`.
 */
export async function countOpenReports(conversationIds: readonly string[] | null): Promise<number> {
  const params: unknown[] = [];
  const filters: string[] = [`status = 'open'`];
  if (conversationIds) {
    params.push([...conversationIds]);
    filters.push(`conversation_id = ANY($${params.length})`);
  }
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM content_reports WHERE ${filters.join(' AND ')}`,
    params,
  );
  return Number(rows[0].n);
}

/**
 * Flip a report's status (resolve/dismiss) — non-destructive, no CONFIRM
 * needed (mirrors warn_user's low-blast-radius treatment). Optionally scoped
 * to `conversationIds` so an admin can only resolve reports from
 * conversations they actually participate in (same invariant as `moderate`/
 * `announce`). Returns the resolved row's platform/reporterUserId/reason (so
 * the caller can notify the reporter, issue #120 — same "RETURNING" shape as
 * `resolveSuggestion`) or null if no matching row was found (unknown id, or
 * the id exists but is outside the caller's scope) — same "no match" signal
 * the old boolean return gave.
 */
export async function resolveContentReport(
  id: number,
  status: 'resolved' | 'dismissed',
  resolvedBy: string,
  conversationIds?: readonly string[],
): Promise<{ platform: Platform; reporterUserId: string; reason: string } | null> {
  const params: unknown[] = [id, status, resolvedBy];
  let scope = '';
  if (conversationIds) {
    params.push([...conversationIds]);
    scope = `AND conversation_id = ANY($${params.length})`;
  }
  const { rows } = await pool.query(
    `UPDATE content_reports
        SET status = $2, resolved_by = $3, resolved_at = now()
      WHERE id = $1 ${scope}
      RETURNING platform, reporter_user_id, reason`,
    params,
  );
  return rows[0]
    ? {
        platform: rows[0].platform as Platform,
        reporterUserId: rows[0].reporter_user_id,
        reason: rows[0].reason,
      }
    : null;
}
