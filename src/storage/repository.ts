import pgvector from 'pgvector/pg';
import type { Platform, Role } from '../platforms/types.js';
import { logger } from '../logger.js';
import { pool } from './db.js';
import { embed } from './embeddings.js';
import { config } from '../config.js';

export interface InteractionInput {
  platform: Platform;
  conversationId: string;
  userId: string;
  userName?: string;
  role: Role;
  direction: 'inbound' | 'outbound';
  content: string;
  addressedToBot?: boolean;
  isDirect?: boolean;
  costUsd?: number;
  meta?: Record<string, unknown>;
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
          content, addressed_to_bot, is_direct, cost_usd, meta, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
}

/**
 * Semantic search over past interactions. Returns the most relevant prior
 * messages to the given query, optionally scoped to one conversation.
 */
export async function searchMemory(
  query: string,
  opts: { platform?: Platform; conversationId?: string; topK?: number } = {},
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
  params.push(topK);

  const { rows } = await pool.query(
    `SELECT content, user_name, role, direction, created_at,
            1 - (embedding <=> $1) AS similarity
       FROM interactions
      WHERE ${filters.join(' AND ')}
      ORDER BY embedding <=> $1
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    content: r.content,
    userName: r.user_name,
    role: r.role,
    direction: r.direction,
    createdAt: r.created_at,
    similarity: Number(r.similarity),
  }));
}

/** Recent turns in a conversation, oldest-first, for short-term context. */
export async function recentTurns(
  platform: Platform,
  conversationId: string,
  limit = 10,
): Promise<Array<{ userName: string | null; direction: string; content: string }>> {
  const { rows } = await pool.query(
    `SELECT user_name, direction, content
       FROM interactions
      WHERE platform = $1 AND conversation_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [platform, conversationId, limit],
  );
  return rows.reverse();
}

// --- Sessions --------------------------------------------------------------

export async function getClaudeSessionId(
  platform: Platform,
  conversationId: string,
): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT claude_session_id FROM sessions WHERE platform = $1 AND conversation_id = $2`,
    [platform, conversationId],
  );
  return rows[0]?.claude_session_id ?? null;
}

export async function setClaudeSessionId(
  platform: Platform,
  conversationId: string,
  sessionId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (platform, conversation_id, claude_session_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (platform, conversation_id)
     DO UPDATE SET claude_session_id = EXCLUDED.claude_session_id, updated_at = now()`,
    [platform, conversationId, sessionId],
  );
}

/** Drop a stored session id (e.g. after a failed resume) so the next turn starts fresh. */
export async function clearClaudeSessionId(
  platform: Platform,
  conversationId: string,
): Promise<void> {
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
export async function isKnownConversation(
  platform: Platform,
  conversationId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM interactions WHERE platform = $1 AND conversation_id = $2 LIMIT 1`,
    [platform, conversationId],
  );
  return rows.length > 0;
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

export async function saveKnowledge(input: {
  content: string;
  title?: string;
  scope?: string;
  sourceUserId?: string;
  createdByRole?: Role;
}): Promise<number> {
  let embedding: number[] | null = null;
  try {
    embedding = await embed(input.title ? `${input.title}\n${input.content}` : input.content);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for knowledge entry');
  }
  const { rows } = await pool.query(
    `INSERT INTO knowledge (scope, title, content, source_user_id, created_by_role, embedding)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      input.scope ?? 'global',
      input.title ?? null,
      input.content,
      input.sourceUserId ?? null,
      input.createdByRole ?? 'admin',
      embedding ? pgvector.toSql(embedding) : null,
    ],
  );
  return Number(rows[0].id);
}

export async function searchKnowledge(query: string, topK = 5): Promise<Array<{ title: string | null; content: string; similarity: number }>> {
  let queryVec: number[];
  try {
    queryVec = await embed(query);
  } catch {
    return [];
  }
  const { rows } = await pool.query(
    `SELECT title, content, 1 - (embedding <=> $1) AS similarity
       FROM knowledge
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1
      LIMIT $2`,
    [pgvector.toSql(queryVec), topK],
  );
  return rows.map((r) => ({ title: r.title, content: r.content, similarity: Number(r.similarity) }));
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
