import pgvector from 'pgvector/pg';
import type { Platform, Tier } from '../../platforms/types.js';
import { logger } from '../../logger.js';
import { pool } from '../db.js';
import { embed } from '../embeddings.js';
import { config } from '../../config.js';
import { invalidateDigestsForInteractions } from './shared.js';

/**
 * The raw interaction archive: recording every message (with its embedding),
 * semantic memory search, conversation recaps/tails, and the platform
 * delete/edit honouring paths. The last domain carved out of repository.ts
 * (audit L14) — what remained in that file after the per-domain split.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

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
    /**
     * Cosine-similarity floor (issue #474). Defaults to
     * config.behaviour.memoryRelevanceThreshold (0 = no floor, byte-identical
     * to pre-#474 behaviour) so every call site inherits the operator's
     * configured value with no per-site plumbing.
     */
    relevanceThreshold?: number;
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
  const relevanceThreshold = opts.relevanceThreshold ?? config.behaviour.memoryRelevanceThreshold;
  // A `0` threshold must be a true no-op (AC2) — a `>= 0` clause would
  // exclude exactly-zero/negative-similarity rows that today's unfiltered
  // query returns, so only add the clause when a real floor is active.
  if (relevanceThreshold > 0) {
    params.push(relevanceThreshold);
    filters.push(`1 - (embedding <=> $1) >= $${params.length}`);
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

export interface ConversationHistoryEntry {
  content: string;
  userName: string | null;
  direction: string;
  createdAt: Date;
  platform: Platform;
  /** Platform-native conversation/channel id (Discord jump links, issue #137). */
  conversationId: string;
  /** Platform-native message id, when it was captured (issue #48). Null for pre-archiving rows. */
  messageId: string | null;
  isDirect: boolean;
}

/**
 * Recap query for the `catch_up` tool (issue #167): the MOST RECENT `limit`
 * interactions in one conversation since `since`, returned oldest→newest for
 * chronological display. Ordering matters here — `ORDER BY created_at ASC
 * LIMIT n` would return the OLDEST n rows in the window (the opposite of a
 * recap), so this orders DESC to pick the most recent n and reverses in JS.
 * Always scoped to the exact (platform, conversationId) the caller passes —
 * callers (agent/tools.ts) must pass only `caller.platform`/
 * `caller.conversationId`, never a model-supplied id.
 */
export async function recentConversationHistory(
  platform: Platform,
  conversationId: string,
  since: Date,
  limit: number,
): Promise<ConversationHistoryEntry[]> {
  const { rows } = await pool.query(
    `SELECT content, user_name, direction, created_at, platform,
            conversation_id, message_id, is_direct
       FROM interactions
      WHERE platform = $1 AND conversation_id = $2 AND created_at >= $3
      ORDER BY created_at DESC
      LIMIT $4`,
    [platform, conversationId, since, limit],
  );
  return rows
    .map((r) => ({
      content: r.content,
      userName: r.user_name,
      direction: r.direction,
      createdAt: r.created_at,
      platform: r.platform,
      conversationId: r.conversation_id,
      messageId: r.message_id,
      isDirect: r.is_direct,
    }))
    .reverse();
}

/** The subset of a ConversationHistoryEntry the session-rollover backfill renders (renderConversationTail). */
export type ConversationTailRow = Pick<
  ConversationHistoryEntry,
  'content' | 'userName' | 'direction' | 'createdAt'
>;

/**
 * Fail-open tail fetch for the fresh-session backfill (core.ts): the most
 * recent `limit` messages in this conversation within the last
 * SESSION_MAX_AGE_HOURS, oldest→newest. Same query (and same
 * exact-conversation scoping contract) as `catch_up`'s
 * recentConversationHistory above, but degrading to [] on any DB failure —
 * losing the backfill must never fail the turn (issue #52's fail-open
 * invariant), exactly like searchMemory. The window is deliberately tied to
 * the session age cap: a fresh session should inherit at most what a live
 * session could still have held, not week-old history.
 */
export async function recentConversationTail(
  platform: Platform,
  conversationId: string,
  limit: number,
): Promise<ConversationTailRow[]> {
  if (limit <= 0) return [];
  const since = new Date(Date.now() - config.behaviour.sessionMaxAgeHours * 3_600_000);
  try {
    return await recentConversationHistory(platform, conversationId, since, limit);
  } catch (err) {
    logger.warn({ err }, 'Conversation-tail lookup failed; starting the fresh session without backfill');
    return [];
  }
}

/**
 * Honour a platform-level message deletion (issue #48): hard-delete the
 * stored copy. Scoped to `(platform, conversationId, messageId)` — message
 * ids are only unique *within* a conversation on some platforms (WhatsApp
 * stanza ids are visible to every group member and a modified client can echo
 * another chat's id), so omitting the conversation would let a revoke in one
 * group delete a same-id row stored for another. Invalidates any context
 * digest built over the deleted row (same deletion coherence as the purge
 * path). Returns the number of rows removed (0 when the message was never
 * stored, e.g. pre-archiving or a bot message).
 */
export async function deleteInteractionByMessageId(
  platform: Platform,
  conversationId: string,
  messageId: string,
): Promise<number> {
  const { rows } = await pool.query(
    `DELETE FROM interactions
      WHERE platform = $1 AND conversation_id = $2 AND message_id = $3
      RETURNING id`,
    [platform, conversationId, messageId],
  );
  if (rows.length > 0) {
    await invalidateDigestsForInteractions(rows.map((r) => Number(r.id))).catch((err) =>
      logger.warn({ err }, 'Digest invalidation after message delete failed'),
    );
  }
  return rows.length;
}

/**
 * Honour a platform-level message edit (issue #48): replace the stored
 * content and re-embed it (NULL embedding on failure, same best-effort
 * fallback as recordInteraction). Scoped to `(platform, conversationId,
 * messageId)` for the same cross-conversation-tamper reason as
 * `deleteInteractionByMessageId`. Invalidates any context digest built over
 * the row, since its summary was distilled from the pre-edit content. Returns
 * false if no stored row matched.
 */
export async function updateInteractionByMessageId(
  platform: Platform,
  conversationId: string,
  messageId: string,
  content: string,
): Promise<boolean> {
  let embedding: number[] | null = null;
  try {
    embedding = await embed(content);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for edited message; storing update without vector');
  }
  const { rows } = await pool.query(
    `UPDATE interactions SET content = $4, embedding = $5
      WHERE platform = $1 AND conversation_id = $2 AND message_id = $3
      RETURNING id`,
    [platform, conversationId, messageId, content, embedding ? pgvector.toSql(embedding) : null],
  );
  if (rows.length > 0) {
    await invalidateDigestsForInteractions(rows.map((r) => Number(r.id))).catch((err) =>
      logger.warn({ err }, 'Digest invalidation after message edit failed'),
    );
  }
  return rows.length > 0;
}

/**
 * The stored author (`user_id`) of an archived message, or null if the bot
 * never stored it. Lets the WhatsApp revoke/edit path verify the revoker
 * actually authored the target message before honouring a "delete/edit for
 * everyone" — WhatsApp servers don't validate revoke/edit authorship, so
 * without this any group member with a modified client could tamper with
 * another user's archived message (memory poisoning / evidence destruction).
 */
export async function getInteractionAuthorByMessageId(
  platform: Platform,
  conversationId: string,
  messageId: string,
): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT user_id FROM interactions
      WHERE platform = $1 AND conversation_id = $2 AND message_id = $3
      ORDER BY created_at ASC
      LIMIT 1`,
    [platform, conversationId, messageId],
  );
  return rows[0]?.user_id ?? null;
}

/**
 * The stored content of an archived message, or null if the bot never stored
 * it (issue #312). Read-only, `SELECT`-only variant of
 * `getInteractionAuthorByMessageId`, scoped the same way — lets `moderate`'s
 * `delete_message` show the admin a truncated preview of what they're
 * actually confirming, sourced only from a row the bot already archived
 * (never a live platform fetch, never model-composed text).
 */
export async function getInteractionContentByMessageId(
  platform: Platform,
  conversationId: string,
  messageId: string,
): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT content FROM interactions
      WHERE platform = $1 AND conversation_id = $2 AND message_id = $3
      ORDER BY created_at ASC
      LIMIT 1`,
    [platform, conversationId, messageId],
  );
  return rows[0]?.content ?? null;
}
