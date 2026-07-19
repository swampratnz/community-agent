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

/** A pooled connection or a transaction client — both expose `query`. */
type Queryable = Pick<PoolClient, 'query'>;

/**
 * Invalidate every context digest whose provenance refs include any of
 * `interactionIds`, deleting its still-*pending* knowledge candidates first
 * (the same deletion-coherence logic `purgeSingleIdentity` applies, issues
 * #51/#102). Shared so the delete/edit-honouring path (issue #48) invalidates
 * digests built over a message the same way a privacy purge does — otherwise a
 * deleted/edited message's content lives on inside a digest summary. Returns
 * the number of pending candidates removed. No-op on an empty id list.
 */
async function invalidateDigestsForInteractions(
  interactionIds: number[],
  db: Queryable = pool,
): Promise<number> {
  if (interactionIds.length === 0) return 0;
  const { rows: invalidatedDigests } = await db.query(
    `SELECT id FROM context_digests WHERE example_refs && $1::bigint[]`,
    [interactionIds],
  );
  const digestIds = invalidatedDigests.map((r) => Number(r.id));
  if (digestIds.length === 0) return 0;
  const { rowCount: deletedCandidates } = await db.query(
    `DELETE FROM knowledge_candidates WHERE digest_id = ANY($1::bigint[]) AND status = 'pending'`,
    [digestIds],
  );
  await db.query(`DELETE FROM context_digests WHERE id = ANY($1::bigint[])`, [digestIds]);
  return deletedCandidates ?? 0;
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

/**
 * Machine-ingestion provenance stored in `knowledge.created_by_role` alongside
 * the human RBAC tiers. 'auto' = daily web-research (quarantined untrusted at
 * retrieval); 'docs' = official Anthropic docs backfill (trusted, verbatim).
 * No model-facing tool can set these — `save_knowledge` always passes the
 * caller's `Tier`, so only internal ingestion code writes them.
 */
export type KnowledgeProvenance = 'auto' | 'docs';

export async function saveKnowledge(input: {
  content: string;
  title?: string;
  scope?: string;
  sourceUserId?: string;
  // Machine-ingested provenance markers on top of the human RBAC tiers:
  //  - 'auto': daily web-research (quarantined as untrusted at retrieval).
  //  - 'docs': official Anthropic docs backfill (trusted — served verbatim).
  // See searchKnowledge / knowledge_search for how these are treated.
  createdByRole?: Tier | KnowledgeProvenance;
  // Optional citation (issue #214): docs-ingest passes the page it ingested;
  // admin-tier save_knowledge/accept_knowledge_candidate calls may set these
  // explicitly. Only ever reached through those two paths — never derived
  // from message content. verified_at is set to now() whenever sourceUrl is
  // given, otherwise left null.
  sourceUrl?: string;
  sourceTitle?: string;
  // The saving admin's own platform (issue #422) — used only to scope
  // automatic knowledge-gap resolution below when `scope` is a conversation
  // id (see resolveKnowledgeGaps); never stored on the knowledge row itself.
  callerPlatform?: Platform;
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

  const createdByRole = input.createdByRole ?? 'admin';
  const { rows } = await pool.query(
    `INSERT INTO knowledge (scope, title, content, source_user_id, created_by_role, embedding, source_url, source_title, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $7::text IS NOT NULL THEN now() ELSE NULL END) RETURNING id`,
    [
      scope,
      input.title ?? null,
      input.content,
      input.sourceUserId ?? null,
      createdByRole,
      embedding ? pgvector.toSql(embedding) : null,
      input.sourceUrl ?? null,
      input.sourceTitle ?? null,
    ],
  );

  // SECURITY: never resolve gaps off unreviewed 'auto' web-research content
  // (quarantined/untrusted at retrieval) — only a human-authored entry or a
  // trusted 'docs' backfill may silently clear the "never confidently
  // answered" signal. See resolveKnowledgeGaps.
  if (embedding && createdByRole !== 'auto') {
    try {
      await resolveKnowledgeGaps(scope, embedding, input.callerPlatform ?? null);
    } catch (err) {
      logger.warn({ err }, 'Knowledge-gap resolution failed for new entry');
    }
  }

  return { id: Number(rows[0].id), similarEntry };
}

/**
 * Relevance floor for `knowledge_search` hits, in cosine similarity
 * (`1 - (embedding <=> query)`, same units as `searchKnowledge`'s returned
 * `similarity`). This is a *relevance* floor ("is this topically usable at
 * all"), not a *duplicate* floor like `QUESTION_CLUSTER_SIMILARITY_THRESHOLD`
 * below (0.85, "is this the same question") — it is deliberately much lower.
 *
 * The value is a function of the current embedding model
 * (`config.db.embeddingModel`, currently Xenova/all-MiniLM-L6-v2) and query
 * distribution, not a universal constant. It was derived empirically against
 * `tests/fixtures/knowledgeEval.json` (see the `negativeQueries` case in
 * knowledgeEval.test.ts): with this model, unambiguously off-topic queries
 * (e.g. "what's the best coffee place near the venue") score ~0.15-0.22
 * against every fixture entry, and a topically-adjacent near-miss (asking how
 * long admin applications take to hear back — same topic as "Requesting admin
 * role", but a question that entry doesn't answer) tops out at ~0.33, while
 * all but a couple of the weakest genuine paraphrase matches score 0.36+. A
 * small minority of very loosely-worded genuine matches score below this
 * floor too (e.g. "what are the guidelines for behaving in this server" vs.
 * the actual "Discord server rules" entry, ~0.30) — that's an intentional
 * precision-over-recall trade-off: this feature exists specifically so a
 * low-confidence hit results in "no confident match" (which the system
 * prompt turns into an honest hedge) rather than a shaky answer stated as
 * fact. If `EMBEDDING_MODEL` ever changes, this constant must be re-derived
 * the same way — a model swap will otherwise silently degrade filtering with
 * no test failure.
 *
 * Defined here (not in agent/tools.ts, which re-exports it for
 * `knowledge_search`'s own filtering) so `knowledgeCoversTopic` below — the
 * issue #102 candidate dedup guard — can share the exact same floor without
 * agent/tools.ts and storage/repository.ts importing each other.
 */
export const KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD = 0.35;

/**
 * Mark unresolved `knowledge_gaps` rows resolved when `embedding` (the
 * vector `saveKnowledge`/`updateKnowledge` already computed for their write)
 * now clears `KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD` against a gap's stored
 * query embedding — the accept-gap curation loop issue #422 closes (#213's
 * review named this sliver; #246 shipped the other one). This is the exact
 * inverse of `recordKnowledgeGap`'s recording rule, so it's internally
 * consistent by construction: a future identical query would no longer
 * record a gap, so it's safe to mark the standing one resolved now.
 *
 * Scope filter mirrors `searchKnowledge`'s visibility model, but inverted
 * (which gaps can *this entry* now answer, vs. which entries can *this
 * caller* see) and, for the conversation-scoped case, deliberately
 * *narrower*: `searchKnowledge` matches `scope = conversationId` alone
 * (SECURITY: cross-platform conversation-id collisions are already
 * mitigated in practice by non-overlapping id shapes there, but the resolve
 * path can't rely on "probably fine" for an automatic write). So here a
 * conversation-scoped entry (`scope` not `'global'` and not a `Platform`
 * literal) only resolves gaps on `callerPlatform` — never cross-platform,
 * even if a conversation id string happened to collide across platforms.
 * `callerPlatform` is unused (and the conversation-scoped branch matches
 * nothing) for a `'global'`- or platform-scoped entry.
 *
 * SECURITY: callers gate this on `createdByRole !== 'auto'` before invoking
 * it (see saveKnowledge/updateKnowledge) — unreviewed 'auto' web-research
 * content is quarantined/untrusted at retrieval and must never silently
 * clear the "never confidently (human-)answered" signal `list_knowledge_gaps`
 * / the digest count depend on. A trusted 'docs' backfill or a human-authored
 * entry (any RBAC `Tier`) may resolve gaps; this function itself has no
 * opinion on provenance, so that check MUST happen before it is called.
 *
 * Known conservative approximation: this checks raw cosine similarity against
 * the gap's floor, not whether the new/edited entry would actually rank in
 * `searchKnowledge`'s top-`topK` (default 5) for that historical query. If
 * 5+ other entries already outscore it, a real future search still wouldn't
 * surface this entry, yet the gap is marked resolved here anyway. Low
 * severity at typical KB sizes; not worth the extra query per gap to fix.
 *
 * Non-blocking: callers must swallow failures themselves — a resolution
 * error must never block the save/update it rides on, same convention
 * `recordKnowledgeGap` already uses for the record side.
 */
async function resolveKnowledgeGaps(
  scope: string,
  embedding: number[],
  callerPlatform: Platform | null,
): Promise<void> {
  await pool.query(
    `UPDATE knowledge_gaps
        SET resolved_at = now()
      WHERE resolved_at IS NULL
        AND embedding IS NOT NULL
        AND (
          $1 = 'global'
          OR platform = $1
          OR (platform = $2 AND conversation_id = $1)
        )
        AND 1 - (embedding <=> $3) >= $4`,
    [scope, callerPlatform, pgvector.toSql(embedding), KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD],
  );
}

/**
 * Semantic search over curated knowledge, scoped to what `caller` may see:
 * `'global'` entries, entries scoped to the caller's platform, and entries
 * scoped to the caller's exact conversation (SECURITY: issue #106 — `scope`
 * used to be write-only metadata; an admin who saved a conversation-scoped
 * entry had it recite to every tier, everywhere). `list_knowledge` (admin
 * browse) deliberately keeps its own unrestricted-by-default behaviour —
 * that's a curation view, not member-facing recall.
 *
 * `opts.scopeRestriction: 'global-only'` (issue #165) narrows the filter to
 * `scope = 'global'` only, ignoring `caller` entirely — for the gated-guest
 * knowledge shortcut, where a guest has no meaningful conversation scope and
 * must never be served a platform- or conversation-scoped entry that may
 * assume member context.
 */
export interface KnowledgeSearchHit {
  id: number;
  title: string | null;
  content: string;
  similarity: number;
  updatedAt: Date;
  /** True for machine-researched entries (created_by_role='auto') — quarantined at retrieval. */
  autoGenerated: boolean;
  /** Optional citation (issue #214) — null unless docs-ingest or an admin save/update set one. */
  sourceUrl: string | null;
  sourceTitle: string | null;
  /** When the citation was (re-)confirmed; null if no source_url has ever been set. */
  verifiedAt: Date | null;
  lastRetrievedAt: Date | null;
  /** Weekly link-rot checker's verdict (issue #448); null means never checked. */
  sourceUnreachable: boolean | null;
  sourceCheckedAt: Date | null;
}

export async function searchKnowledge(
  query: string,
  caller: { platform: Platform; conversationId: string },
  topK = 5,
  opts: { scopeRestriction?: 'global-only' } = {},
): Promise<KnowledgeSearchHit[]> {
  let queryVec: number[];
  try {
    queryVec = await embed(query);
  } catch (err) {
    logger.warn({ err }, 'Embedding query failed; skipping knowledge search');
    return [];
  }
  const globalOnly = opts.scopeRestriction === 'global-only';
  const { rows } = await pool.query(
    globalOnly
      ? `SELECT id, title, content, created_by_role, updated_at, source_url, source_title, verified_at, last_retrieved_at,
                source_unreachable, source_checked_at,
                1 - (embedding <=> $1) AS similarity
           FROM knowledge
          WHERE embedding IS NOT NULL
            AND scope = 'global'
          ORDER BY embedding <=> $1
          LIMIT $2`
      : `SELECT id, title, content, created_by_role, updated_at, source_url, source_title, verified_at, last_retrieved_at,
                source_unreachable, source_checked_at,
                1 - (embedding <=> $1) AS similarity
           FROM knowledge
          WHERE embedding IS NOT NULL
            AND scope IN ('global', $2, $3)
          ORDER BY embedding <=> $1
          LIMIT $4`,
    globalOnly
      ? [pgvector.toSql(queryVec), topK]
      : [pgvector.toSql(queryVec), caller.platform, caller.conversationId, topK],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    content: r.content,
    similarity: Number(r.similarity),
    updatedAt: r.updated_at,
    autoGenerated: r.created_by_role === 'auto',
    sourceUrl: r.source_url,
    sourceTitle: r.source_title,
    verifiedAt: r.verified_at,
    lastRetrievedAt: r.last_retrieved_at,
    sourceUnreachable: r.source_unreachable,
    sourceCheckedAt: r.source_checked_at,
  }));
}

/**
 * Threshold for `searchKnowledgeLexical`'s `word_similarity()` score (0-1,
 * pg_trgm's own conventional default). A code constant, not env-configurable,
 * matching how `KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD` /
 * `KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD` / `KNOWLEDGE_TIE_MARGIN` are
 * already done in this codebase. This is a distinct similarity space from
 * `KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD` (cosine similarity of dense sentence
 * embeddings) — the two are never compared against each other.
 */
export const KNOWLEDGE_TRIGRAM_THRESHOLD = 0.3;

/**
 * Lexical fallback for `knowledge_search`'s semantic-miss path (issue #362):
 * a zero-model-cost, SQL-only substring match for the input class dense
 * sentence embeddings represent least reliably — short, rare,
 * SNAKE_CASE/camelCase identifiers and error codes copied verbatim from a
 * doc, log, or another member's message. Reuses `searchKnowledge`'s exact
 * scope filtering (SECURITY: same `scope IN ('global', platform,
 * conversationId)` / `global-only` behaviour, same params) so it can never
 * surface an entry the semantic path couldn't already return to the same
 * caller — only the ranking function differs.
 *
 * Uses `word_similarity(query, text)` rather than symmetric `similarity()`:
 * `similarity()` scores the two strings' *overall* trigram overlap, which
 * collapses toward zero for a short query against a realistic multi-sentence
 * entry (the intersection is tiny relative to the union); `word_similarity`
 * instead finds the best-matching *extent* of words within `text` and scores
 * that against `query`, which is what "does this literal string appear
 * inside this longer text" actually needs. `title` is nullable, so both the
 * query here and the `knowledge_trgm_idx` index expression it can use must
 * `COALESCE(title, '')` — a raw `title || ' ' || content` is NULL (and so
 * silently never matches) for every null-titled entry.
 */
export async function searchKnowledgeLexical(
  query: string,
  caller: { platform: Platform; conversationId: string },
  topK = 5,
  opts: { scopeRestriction?: 'global-only' } = {},
): Promise<KnowledgeSearchHit[]> {
  const globalOnly = opts.scopeRestriction === 'global-only';
  const { rows } = await pool.query(
    globalOnly
      ? `SELECT id, title, content, created_by_role, updated_at, source_url, source_title, verified_at, last_retrieved_at,
                source_unreachable, source_checked_at,
                word_similarity($1, COALESCE(title, '') || ' ' || content) AS similarity
           FROM knowledge
          WHERE scope = 'global'
            AND word_similarity($1, COALESCE(title, '') || ' ' || content) >= $2
          ORDER BY similarity DESC
          LIMIT $3`
      : `SELECT id, title, content, created_by_role, updated_at, source_url, source_title, verified_at, last_retrieved_at,
                source_unreachable, source_checked_at,
                word_similarity($1, COALESCE(title, '') || ' ' || content) AS similarity
           FROM knowledge
          WHERE scope IN ('global', $2, $3)
            AND word_similarity($1, COALESCE(title, '') || ' ' || content) >= $4
          ORDER BY similarity DESC
          LIMIT $5`,
    globalOnly
      ? [query, KNOWLEDGE_TRIGRAM_THRESHOLD, topK]
      : [query, caller.platform, caller.conversationId, KNOWLEDGE_TRIGRAM_THRESHOLD, topK],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    content: r.content,
    similarity: Number(r.similarity),
    updatedAt: r.updated_at,
    autoGenerated: r.created_by_role === 'auto',
    sourceUrl: r.source_url,
    sourceTitle: r.source_title,
    verifiedAt: r.verified_at,
    lastRetrievedAt: r.last_retrieved_at,
    sourceUnreachable: r.source_unreachable,
    sourceCheckedAt: r.source_checked_at,
  }));
}

/**
 * Whether a knowledge entry counts as stale for the member-facing "may be
 * outdated" nudge (issue #214) — reuses `countStaleKnowledge`'s exact
 * "neither edited nor retrieved recently" definition so the codebase has one
 * staleness concept, not two. `staleDays` is `config.adminDigest
 * .knowledgeStaleDays`; 0 means the feature is off (never stale).
 *
 * `maxAgeDays` (issue #380, `config.adminDigest.knowledgeStaleMaxAgeDays`) is
 * an additive, OR-ed absolute content-age ceiling that fires off `updatedAt`
 * alone, deliberately ignoring `lastRetrievedAt` — a popular entry's
 * `last_retrieved_at` otherwise resets `staleDays`'s clock on every hit,
 * making the entries with the most reach the ones this predicate is
 * structurally blindest to. 0 means the ceiling is off (never fires),
 * matching `staleDays`'s own convention, so with both 0 this is
 * byte-identical to the pre-#380 behaviour.
 */
export function isKnowledgeStale(
  entry: { updatedAt: Date; lastRetrievedAt: Date | null },
  staleDays: number,
  maxAgeDays = 0,
): boolean {
  if (staleDays > 0) {
    const lastTouched = Math.max(entry.updatedAt.getTime(), entry.lastRetrievedAt?.getTime() ?? 0);
    if (Date.now() - lastTouched >= staleDays * 86_400_000) return true;
  }
  return maxAgeDays > 0 && Date.now() - entry.updatedAt.getTime() >= maxAgeDays * 86_400_000;
}

/**
 * Record that `ids` were surfaced as relevant `knowledge_search` hits.
 * Fire-and-forget from the tool handler (issue #134) — callers must swallow
 * failures themselves, same as `notifySuggestionResolved`, so a counter-write
 * error never delays or fails a member's search. Deliberately only touches
 * retrieval_count/last_retrieved_at: see the schema comment on those columns
 * for why this must not bump `updated_at`.
 */
export async function recordKnowledgeRetrieval(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE knowledge
        SET retrieval_count = retrieval_count + 1, last_retrieved_at = now()
      WHERE id = ANY($1::bigint[])`,
    [ids],
  );
}

export interface KnowledgeEntry {
  id: number;
  scope: string;
  title: string | null;
  content: string;
  createdByRole: string;
  updatedAt: Date;
  retrievalCount: number;
  lastRetrievedAt: Date | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  verifiedAt: Date | null;
  /** Link-rot check result (issue #448) — null means never checked (or no sourceUrl). */
  sourceUnreachable: boolean | null;
  sourceCheckedAt: Date | null;
}

/**
 * Browse knowledge entries directly (as opposed to semantic search),
 * optionally filtered by scope. `staleOnly` (issue #280) reuses
 * `countStaleKnowledge`'s exact `GREATEST(updated_at,
 * COALESCE(last_retrieved_at, updated_at))` predicate against `staleDays`
 * (the caller passes `config.adminDigest.knowledgeStaleDays` — 0 means the
 * feature is off, and callers are expected to short-circuit before reaching
 * here in that case, same as `countStaleKnowledge`'s callers do), composed
 * with `scope` via AND, and orders by that same expression ASC (most-overdue
 * first) instead of the default `updated_at DESC` — the point of the filter
 * is triaging a backlog, so the worst offender comes first.
 * `provenance` (issue #294) filters to entries whose `created_by_role`
 * equals the given value, composed with `scope`/`staleOnly` via AND, same
 * combinable-filter pattern as `staleOnly`.
 *
 * `staleMaxAgeDays` (issue #380) is the same additive, OR-ed absolute
 * content-age ceiling as `isKnowledgeStale`'s `maxAgeDays` — composed with
 * `staleDays` inside `staleOnly`'s own predicate, not a separate filter.
 * Unset/0 = disabled, so `staleOnly` alone is byte-identical to pre-#380.
 *
 * `sourceUnreachable` (issue #448) filters to entries the weekly link-rot
 * checker flagged `source_unreachable = true`, composed with the other
 * filters via AND, same combinable-filter pattern as `staleOnly`/
 * `provenance`. Structurally admin-gated the same way as `staleOnly` — this
 * function has no caller/tier concept of its own; `list_knowledge` (the only
 * caller) is admin-tier gated in full via `assertAtLeast`.
 */
export async function listKnowledge(
  input: {
    scope?: string;
    limit?: number;
    offset?: number;
    staleOnly?: boolean;
    staleDays?: number;
    staleMaxAgeDays?: number;
    provenance?: string;
    sourceUnreachable?: boolean;
  } = {},
): Promise<KnowledgeEntry[]> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (input.scope) {
    params.push(input.scope);
    clauses.push(`scope = $${params.length}`);
  }
  if (input.provenance) {
    params.push(input.provenance);
    clauses.push(`created_by_role = $${params.length}`);
  }
  if (input.sourceUnreachable) {
    clauses.push(`source_unreachable = true`);
  }
  if (input.staleOnly) {
    params.push(input.staleDays ?? 0);
    const staleDaysParam = params.length;
    params.push(input.staleMaxAgeDays ?? 0);
    const maxAgeDaysParam = params.length;
    clauses.push(
      `(($${staleDaysParam} > 0 AND GREATEST(updated_at, COALESCE(last_retrieved_at, updated_at)) < now() - ($${staleDaysParam} || ' days')::interval)` +
        ` OR ($${maxAgeDaysParam} > 0 AND updated_at < now() - ($${maxAgeDaysParam} || ' days')::interval))`,
    );
  }
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  // "Most overdue first" must track whichever staleness criterion is active. When
  // the content-age ceiling is on (#380), rank by `updated_at` (content age) so a
  // genuinely-old entry surfaces first even if it's popular — sorting by
  // GREATEST(updated_at, last_retrieved_at) would push a frequently-served but
  // stale-content entry to "least urgent", the exact blind spot the ceiling
  // exists to close. Window-only (`staleDays` alone) keeps longest-untouched
  // (edit OR retrieval) first.
  const orderClause = !input.staleOnly
    ? `ORDER BY updated_at DESC`
    : (input.staleMaxAgeDays ?? 0) > 0
      ? `ORDER BY updated_at ASC`
      : `ORDER BY GREATEST(updated_at, COALESCE(last_retrieved_at, updated_at)) ASC`;
  params.push(input.limit ?? 20);
  const limitParam = params.length;
  params.push(input.offset ?? 0);
  const { rows } = await pool.query(
    `SELECT id, scope, title, content, created_by_role, updated_at, retrieval_count, last_retrieved_at,
            source_url, source_title, verified_at, source_unreachable, source_checked_at
       FROM knowledge
       ${whereClause}
      ${orderClause}
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
    retrievalCount: Number(r.retrieval_count),
    lastRetrievedAt: r.last_retrieved_at,
    sourceUrl: r.source_url,
    sourceTitle: r.source_title,
    verifiedAt: r.verified_at,
    sourceUnreachable: r.source_unreachable,
    sourceCheckedAt: r.source_checked_at,
  }));
}

export interface KnowledgeTopicsResult {
  titles: string[];
  totalCount: number;
}

/**
 * Titles-only browse of the knowledge base for the member-facing
 * `list_knowledge_topics` tool (issue #437) — the missing proactive "what's
 * covered" counterpart to `knowledge_search`'s reactive search. Reuses
 * `searchKnowledge`/`searchKnowledgeLexical`'s exact scope predicate
 * (`scope IN ('global', platform, conversationId)`) so a member never sees a
 * title from a scope they couldn't already reach via `knowledge_search`, plus
 * the issue #214 apparent-authority boundary (`created_by_role != 'auto'`) —
 * a quarantined auto-researched entry can't gain apparent authority by
 * appearing in an official-looking topic index. Null and blank titles are
 * excluded (some conversation-scoped entries have none, same
 * `COALESCE(title, '')` case `searchKnowledgeLexical` already works around).
 *
 * `COUNT(*) OVER()` returns the full match count alongside the `LIMIT`ed page
 * in one round trip, so a caller can render an exact "+N more" truncation
 * note without a second query — keeping this the single deterministic SELECT
 * the proposal's cost story promises.
 */
export async function listKnowledgeTopics(
  caller: { platform: Platform; conversationId: string },
  limit: number,
): Promise<KnowledgeTopicsResult> {
  const { rows } = await pool.query(
    `SELECT title, COUNT(*) OVER() AS total_count
       FROM knowledge
      WHERE scope IN ('global', $1, $2)
        AND created_by_role != 'auto'
        AND title IS NOT NULL
        AND trim(title) != ''
      ORDER BY title
      LIMIT $3`,
    [caller.platform, caller.conversationId, limit],
  );
  return {
    titles: rows.map((r) => r.title as string),
    totalCount: rows.length > 0 ? Number(rows[0].total_count) : 0,
  };
}

/**
 * Exact count of knowledge entries untouched — neither edited nor retrieved —
 * in the last `days` (issue #199). `GREATEST(updated_at,
 * COALESCE(last_retrieved_at, updated_at))` takes whichever of the two
 * signals is more recent: an entry never retrieved falls back to its edit
 * time, and one edited after its last retrieval is judged by that edit, not
 * a stale `last_retrieved_at`. A plain `COALESCE` alone would get this
 * second case backwards (it'd prefer a non-null but older
 * `last_retrieved_at` over a fresh edit). Guild-wide, matching
 * `countAccessRequests`/`countPendingSuggestions` — knowledge entries carry
 * no conversation scope for `list_knowledge` to restrict by either.
 *
 * `maxAgeDays` (issue #380) is the same additive, OR-ed absolute content-age
 * ceiling as `isKnowledgeStale`'s — an entry whose `updated_at` alone exceeds
 * it counts as stale regardless of `days`/`last_retrieved_at`. Unset/0 =
 * disabled, so with the default this is byte-identical to pre-#380.
 */
export async function countStaleKnowledge(days: number, maxAgeDays = 0): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*) AS n
       FROM knowledge
      WHERE ($1 > 0 AND GREATEST(updated_at, COALESCE(last_retrieved_at, updated_at)) < now() - ($1 || ' days')::interval)
         OR ($2 > 0 AND updated_at < now() - ($2 || ' days')::interval)`,
    [days, maxAgeDays],
  );
  return Number(rows[0].n);
}

/**
 * Every knowledge entry carrying a `sourceUrl`, for the weekly link-rot
 * checker (issue #448) to sweep. `sourceUrl` is admin-authored only (set via
 * save_knowledge/update_knowledge/docs-ingest) — not a new untrusted-input
 * surface. Guild-wide, unscoped, matching the checker's own job scope.
 */
export async function listKnowledgeSourceUrls(): Promise<Array<{ id: number; sourceUrl: string }>> {
  const { rows } = await pool.query(
    `SELECT id, source_url FROM knowledge WHERE source_url IS NOT NULL ORDER BY id`,
  );
  return rows.map((r) => ({ id: Number(r.id), sourceUrl: r.source_url }));
}

/**
 * Persist one entry's link-rot check result (issue #448). Deliberately NOT
 * routed through the `knowledge_set_updated_at` trigger's column list (see
 * the schema comment on `source_unreachable`/`source_checked_at`) — a
 * reachability check is not a content edit.
 */
export async function recordKnowledgeSourceCheck(id: number, unreachable: boolean): Promise<void> {
  await pool.query(`UPDATE knowledge SET source_unreachable = $2, source_checked_at = now() WHERE id = $1`, [
    id,
    unreachable,
  ]);
}

/** Freshness watermark for the checker's ~weekly scheduler guard (issue #448). */
export async function latestKnowledgeSourceCheckAt(): Promise<Date | null> {
  const { rows } = await pool.query(`SELECT max(source_checked_at) AS latest FROM knowledge`);
  return rows[0]?.latest ?? null;
}

/**
 * Update a knowledge entry's title/content/scope and re-embed. Returns false
 * if no row matched. `sourceUrl`/`sourceTitle` (issue #214) follow the same
 * "undefined = leave unchanged" convention as title/content; supplying
 * either one re-verifies the citation (`verified_at` bumped to now()).
 */
export async function updateKnowledge(input: {
  id: number;
  title?: string;
  content?: string;
  scope?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  // The editing admin's own platform (issue #422) — same use as
  // saveKnowledge's callerPlatform, only for scoping automatic
  // knowledge-gap resolution below; never stored on the knowledge row.
  callerPlatform?: Platform;
}): Promise<boolean> {
  const { rows: existingRows } = await pool.query(
    `SELECT title, content, scope, source_url, source_title, created_by_role FROM knowledge WHERE id = $1`,
    [input.id],
  );
  if (existingRows.length === 0) return false;

  const title = input.title !== undefined ? input.title : existingRows[0].title;
  const content = input.content !== undefined ? input.content : existingRows[0].content;
  const scope = input.scope !== undefined ? input.scope : existingRows[0].scope;
  const sourceUrl = input.sourceUrl !== undefined ? input.sourceUrl : existingRows[0].source_url;
  const sourceTitle = input.sourceTitle !== undefined ? input.sourceTitle : existingRows[0].source_title;
  const reVerify = input.sourceUrl !== undefined || input.sourceTitle !== undefined;

  let embedding: number[] | null = null;
  try {
    embedding = await embed(title ? `${title}\n${content}` : content);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for knowledge update');
  }

  const { rowCount } = await pool.query(
    `UPDATE knowledge
        SET title = $2, content = $3, scope = COALESCE($4, scope), embedding = COALESCE($5, embedding),
            source_url = $6, source_title = $7,
            verified_at = CASE WHEN $8 THEN now() ELSE verified_at END
      WHERE id = $1`,
    [
      input.id,
      title ?? null,
      content,
      input.scope ?? null,
      embedding ? pgvector.toSql(embedding) : null,
      sourceUrl ?? null,
      sourceTitle ?? null,
      reVerify,
    ],
  );

  // SECURITY: same 'auto'-provenance exclusion as saveKnowledge — an entry's
  // created_by_role never changes here, so the pre-edit row's value is the
  // authoritative check.
  if (embedding && existingRows[0].created_by_role !== 'auto') {
    try {
      await resolveKnowledgeGaps(scope, embedding, input.callerPlatform ?? null);
    } catch (err) {
      logger.warn({ err }, 'Knowledge-gap resolution failed for edited entry');
    }
  }

  return (rowCount ?? 0) > 0;
}

/**
 * The current title/content of a knowledge entry (or null if none), so
 * `update_knowledge` can record the pre-edit text in its audit row — an
 * in-place overwrite otherwise leaves no way to see (or recover) what an
 * injected admin turn replaced.
 */
export async function getKnowledgeContentById(
  id: number,
): Promise<{ title: string | null; content: string } | null> {
  const { rows } = await pool.query(`SELECT title, content FROM knowledge WHERE id = $1`, [id]);
  return rows[0] ? { title: rows[0].title, content: rows[0].content } : null;
}

/** Delete a knowledge entry by id. Returns false if no row matched. */
export async function deleteKnowledge(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

export interface KnowledgeDuplicatePair {
  aId: number;
  aTitle: string | null;
  bId: number;
  bTitle: string | null;
  similarity: number;
}

/**
 * Retroactive audit (issue #316) for near-duplicate knowledge pairs that
 * `saveKnowledge`'s write-time nudge (KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD
 * above) never caught: entries that predate that check, or that converged
 * later via independent `updateKnowledge` edits. Same-scope only, same
 * threshold, same `<=>` operator — deliberately reuses #93's established
 * technique rather than inventing a new one. `a.id < b.id` both dedups each
 * pair to a single row (never A↔B and B↔A) and gives the self-join a stable
 * ordering to join on.
 */
export async function listDuplicateKnowledge(scope?: string, limit = 20): Promise<KnowledgeDuplicatePair[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const params: unknown[] = [scope ?? null, KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD];
  params.push(clampedLimit);
  const { rows } = await pool.query(
    `SELECT a.id AS a_id, a.title AS a_title,
            b.id AS b_id, b.title AS b_title,
            1 - (a.embedding <=> b.embedding) AS similarity
       FROM knowledge a
       JOIN knowledge b ON a.id < b.id AND a.scope = b.scope
      WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND ($1::text IS NULL OR a.scope = $1)
        AND 1 - (a.embedding <=> b.embedding) >= $2
      ORDER BY similarity DESC
      LIMIT $3`,
    params,
  );
  return rows.map((r) => ({
    aId: Number(r.a_id),
    aTitle: r.a_title,
    bId: Number(r.b_id),
    bTitle: r.b_title,
    similarity: Number(r.similarity),
  }));
}

/**
 * Exact near-duplicate pair count (issue #378), for the weekly admin digest
 * — the growth path #316 itself named ("fold a 'N duplicate pairs pending
 * review' count into the weekly admin digest once the pull tool proves
 * useful"). A true `SELECT count(*)` over the identical self-join
 * `listDuplicateKnowledge` uses (same `a.id < b.id` same-scope join, same
 * `KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD` floor), never `.length` of that
 * function's `LIMIT`-bounded list, so a backlog past its default limit of 20
 * is not understated. Guild-wide when `scope` is omitted, matching
 * `listDuplicateKnowledge`'s own unscoped behaviour.
 */
export async function countDuplicateKnowledge(scope?: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*) AS n
       FROM knowledge a
       JOIN knowledge b ON a.id < b.id AND a.scope = b.scope
      WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND ($1::text IS NULL OR a.scope = $1)
        AND 1 - (a.embedding <=> b.embedding) >= $2`,
    [scope ?? null, KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD],
  );
  return Number(rows[0].n);
}

/**
 * Half-open "conflict candidate" band (issue #330), sitting between the
 * retrieval relevance floor (KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD, 0.35) and
 * the near-duplicate threshold (KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD,
 * 0.92): two entries this similar are about the same topic but worded
 * differently enough that they might disagree, rather than being the same
 * fact said twice. MAX is bound to the near-duplicate threshold itself
 * (half-open, `< MAX`) so the two bands abut without overlap — a pair is
 * either a near-duplicate (>= MAX) or a conflict candidate ([MIN, MAX)),
 * never both.
 */
export const KNOWLEDGE_CONFLICT_SIMILARITY_MIN = 0.55;
export const KNOWLEDGE_CONFLICT_SIMILARITY_MAX = KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD;

export interface KnowledgeConflictPair {
  aId: number;
  aTitle: string | null;
  bId: number;
  bTitle: string | null;
  similarity: number;
}

/**
 * Read-only audit (issue #330) for "conflict candidate" pairs: same-scope
 * knowledge entries that both clear the relevance floor for some query but
 * sit well under the near-duplicate threshold — worded differently enough
 * that they might quietly disagree (e.g. one entry states a fact a newer,
 * unrelated-looking entry has since corrected). Mirrors listDuplicateKnowledge's
 * exact shape (same-scope `a.id < b.id` self-join, NULL-embedding rows
 * excluded, same limit clamp) but bounds similarity to the half-open
 * conflict band instead of the near-duplicate floor. Output is framed to
 * admins as *candidates to review*, not confirmed contradictions — the query
 * itself makes no judgement beyond relatedness.
 */
export async function listKnowledgeConflictCandidates(
  scope?: string,
  limit = 20,
): Promise<KnowledgeConflictPair[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const params: unknown[] = [
    scope ?? null,
    KNOWLEDGE_CONFLICT_SIMILARITY_MIN,
    KNOWLEDGE_CONFLICT_SIMILARITY_MAX,
    clampedLimit,
  ];
  const { rows } = await pool.query(
    `SELECT a.id AS a_id, a.title AS a_title,
            b.id AS b_id, b.title AS b_title,
            1 - (a.embedding <=> b.embedding) AS similarity
       FROM knowledge a
       JOIN knowledge b ON a.id < b.id AND a.scope = b.scope
      WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND ($1::text IS NULL OR a.scope = $1)
        AND 1 - (a.embedding <=> b.embedding) >= $2
        AND 1 - (a.embedding <=> b.embedding) < $3
      ORDER BY similarity DESC
      LIMIT $4`,
    params,
  );
  return rows.map((r) => ({
    aId: Number(r.a_id),
    aTitle: r.a_title,
    bId: Number(r.b_id),
    bTitle: r.b_title,
    similarity: Number(r.similarity),
  }));
}

/**
 * Exact conflict-candidate pair count (issue #378), for the weekly admin
 * digest — the growth path #330 itself named ("fold a 'top conflict
 * candidate' line into the weekly admin digest... deliberately deferred so
 * this PR stays small and the band is proven useful via manual admin
 * invocation first"). A true `SELECT count(*)` over the identical self-join
 * `listKnowledgeConflictCandidates` uses (same `a.id < b.id` same-scope
 * join, same half-open `[KNOWLEDGE_CONFLICT_SIMILARITY_MIN,
 * KNOWLEDGE_CONFLICT_SIMILARITY_MAX)` band), never `.length` of that
 * function's `LIMIT`-bounded list, so a backlog past its default limit of 20
 * is not understated. Guild-wide when `scope` is omitted, matching
 * `listKnowledgeConflictCandidates`'s own unscoped behaviour.
 */
export async function countKnowledgeConflictCandidates(scope?: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*) AS n
       FROM knowledge a
       JOIN knowledge b ON a.id < b.id AND a.scope = b.scope
      WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND ($1::text IS NULL OR a.scope = $1)
        AND 1 - (a.embedding <=> b.embedding) >= $2
        AND 1 - (a.embedding <=> b.embedding) < $3`,
    [scope ?? null, KNOWLEDGE_CONFLICT_SIMILARITY_MIN, KNOWLEDGE_CONFLICT_SIMILARITY_MAX],
  );
  return Number(rows[0].n);
}

/**
 * Live-path conflict check (issue #389) for the exact set of ids
 * `knowledge_search` is about to serve in one answer — the real-time
 * backstop for the gap #330 (pull-only admin audit) and #378 (weekly digest
 * count) both leave open between an entry being saved and an admin's next
 * audit pass. Same technique, band, NULL-embedding exclusion, AND same-scope
 * join predicate as `listKnowledgeConflictCandidates`/
 * `countKnowledgeConflictCandidates` (same `[KNOWLEDGE_CONFLICT_SIMILARITY_MIN,
 * KNOWLEDGE_CONFLICT_SIMILARITY_MAX)` half-open band, `1 - (a.embedding <=>
 * b.embedding)` measure, `a.id < b.id AND a.scope = b.scope` pairing), but
 * restricted to `a.id = ANY($1) AND b.id = ANY($1)` instead of a full-table
 * self-join, and `LIMIT 1` since the caller only needs a boolean, not the
 * pair(s) themselves.
 *
 * The `a.scope = b.scope` predicate is required here, not redundant:
 * `searchKnowledge` queries `WHERE scope IN ('global', platform,
 * conversationId)` in one call, so `ids` can span multiple scopes. A
 * conversation-specific override of a global/platform entry (an intended,
 * supported pattern per `save_knowledge`'s own scope docs) is typically
 * topically similar to the entry it supersedes and would otherwise be
 * misflagged as a conflict rather than recognised as a deliberate override
 * (review on #393).
 *
 * Short-circuits to `false` with zero SQL queries when `ids.length < 2` —
 * there is nothing to compare, and the caller (`knowledgeSearch` in
 * tools.ts) already gates on this, but the guard lives here too so this
 * function is safe to call directly without relying on that.
 */
export async function hasConflictAmongIds(ids: number[]): Promise<boolean> {
  if (ids.length < 2) return false;
  const { rows } = await pool.query(
    `SELECT 1
       FROM knowledge a
       JOIN knowledge b ON a.id < b.id AND a.scope = b.scope
      WHERE a.id = ANY($1) AND b.id = ANY($1)
        AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND 1 - (a.embedding <=> b.embedding) >= $2
        AND 1 - (a.embedding <=> b.embedding) < $3
      LIMIT 1`,
    [ids, KNOWLEDGE_CONFLICT_SIMILARITY_MIN, KNOWLEDGE_CONFLICT_SIMILARITY_MAX],
  );
  return rows.length > 0;
}

/**
 * Upsert a `global`-scoped knowledge entry keyed by exact title. Used by the
 * daily knowledge refresh (src/context/knowledgeRefresh.ts): each fixed topic
 * has a stable title, so this refreshes the SAME row every run rather than
 * accumulating duplicates. Updates the existing row's content (re-embedding via
 * `updateKnowledge`) or inserts a new one. Returns the id and whether it was
 * created. Deliberately global-scope only — the refresh never writes anywhere
 * else.
 */
export async function upsertGlobalKnowledgeByTitle(
  title: string,
  content: string,
): Promise<{ id: number; created: boolean } | 'title-taken-by-human'> {
  // Look at whatever already owns this (title, global) — including its
  // provenance. The quarantine model downstream (knowledge_search wrapping,
  // shortcut exclusion) keys off created_by_role='auto', so this write must
  // NEVER splice unreviewed research into a human-owned row, nor create a
  // colliding duplicate. The fixed titles are printed in docs/CHANGELOG and
  // visible via list_knowledge, so a human recreating one is a real path.
  const { rows } = await pool.query(
    `SELECT id, created_by_role FROM knowledge WHERE title = $1 AND scope = 'global' ORDER BY id LIMIT 1`,
    [title],
  );
  if (rows[0]) {
    if (rows[0].created_by_role !== 'auto') return 'title-taken-by-human';
    const id = Number(rows[0].id);
    await updateKnowledge({ id, content });
    return { id, created: false };
  }
  // 'auto' provenance flows to knowledge_search so the content is quarantined
  // (untrusted-wrapped) at retrieval — this is unreviewed, web-derived text.
  const saved = await saveKnowledge({ title, content, scope: 'global', createdByRole: 'auto' });
  return { id: saved.id, created: true };
}

/**
 * Most recent `updated_at` across knowledge entries whose title is in `titles`
 * — the daily knowledge refresh's freshness guard, so a redeploy (which
 * restarts the process) can't re-run the research within the same day. Null
 * when none of those entries exist yet (first ever run).
 */
export async function latestKnowledgeUpdateAt(titles: readonly string[]): Promise<Date | null> {
  if (titles.length === 0) return null;
  const { rows } = await pool.query(
    `SELECT max(updated_at) AS latest FROM knowledge WHERE scope = 'global' AND title = ANY($1)`,
    [[...titles]],
  );
  return rows[0]?.latest ?? null;
}

export type KnowledgeSyncOutcome = 'created' | 'updated' | 'unchanged' | 'title-taken-by-other';

/**
 * Idempotent, content-diffing upsert of one `global` knowledge chunk under a
 * machine-ingestion `provenance` (src/context/docsIngest.ts). Keyed by title:
 *  - existing row of the SAME provenance, identical content -> 'unchanged'
 *    (NO re-embed — this is what makes the ~weekly docs refresh cheap: only
 *    genuinely changed sections pay the embedding cost).
 *  - existing row of the SAME provenance, different content -> re-embed,'updated'.
 *  - existing row of a DIFFERENT provenance (human/other) -> 'title-taken-by-other',
 *    never overwritten (a human entry always wins its title).
 *  - no row -> insert with this provenance, 'created'.
 */
/**
 * `source` (issue #214) is the page docs-ingest derived the chunk from —
 * `url` populates `source_url` automatically; `title` (a human-readable label
 * distinct from the storage `title` dedup key) populates `source_title`.
 * Optional so other provenances/callers are unaffected.
 */
export async function syncGlobalKnowledgeByProvenance(
  title: string,
  content: string,
  provenance: KnowledgeProvenance,
  source?: { url: string; title?: string },
): Promise<KnowledgeSyncOutcome> {
  const { rows } = await pool.query(
    `SELECT id, content, created_by_role, source_url FROM knowledge WHERE title = $1 AND scope = 'global' ORDER BY id LIMIT 1`,
    [title],
  );
  if (rows[0]) {
    if (rows[0].created_by_role !== provenance) return 'title-taken-by-other';
    if (rows[0].content === content) {
      // Backfill the citation on a pre-existing row that predates this
      // feature (or was ingested before source became available) — metadata
      // only, so it deliberately bypasses updateKnowledge's re-embed and
      // never touches updated_at (source_url isn't a tracked column on the
      // update trigger, same exclusion as retrieval_count).
      if (source?.url && !rows[0].source_url) {
        await pool.query(
          `UPDATE knowledge SET source_url = $2, source_title = $3, verified_at = now() WHERE id = $1`,
          [rows[0].id, source.url, source.title ?? null],
        );
      }
      return 'unchanged';
    }
    await updateKnowledge({
      id: Number(rows[0].id),
      content,
      sourceUrl: source?.url,
      sourceTitle: source?.title,
    });
    return 'updated';
  }
  await saveKnowledge({
    title,
    content,
    scope: 'global',
    createdByRole: provenance,
    sourceUrl: source?.url,
    sourceTitle: source?.title,
  });
  return 'created';
}

/** Most recent `updated_at` across all `global` entries of a machine provenance — the ingest freshness guard (redeploy-safe). Null if none exist yet. */
export async function latestKnowledgeUpdateAtByProvenance(
  provenance: KnowledgeProvenance,
): Promise<Date | null> {
  const { rows } = await pool.query(
    `SELECT max(updated_at) AS latest FROM knowledge WHERE scope = 'global' AND created_by_role = $1`,
    [provenance],
  );
  return rows[0]?.latest ?? null;
}

/** All `global` knowledge titles written under a given machine provenance. */
export async function listGlobalKnowledgeTitlesByProvenance(
  provenance: KnowledgeProvenance,
): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT title FROM knowledge WHERE scope = 'global' AND created_by_role = $1 AND title IS NOT NULL`,
    [provenance],
  );
  return rows.map((r) => r.title as string);
}

/**
 * Delete the named `global` entries of the given provenance. Scoped by
 * provenance so it can never touch a human- or other-provenance row even if a
 * title collides. Returns the number removed. Used by docs ingest to prune the
 * chunks of pages that vanished from the upstream index (the caller computes the
 * doomed titles from the index, so a transient fetch failure can't cause a
 * deletion). No-op on an empty list.
 */
export async function deleteProvenancedKnowledgeByTitles(
  provenance: KnowledgeProvenance,
  titles: readonly string[],
): Promise<number> {
  if (titles.length === 0) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM knowledge WHERE scope = 'global' AND created_by_role = $1 AND title = ANY($2)`,
    [provenance, [...titles]],
  );
  return rowCount ?? 0;
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
 * Best-known human-readable name for a platform user — the membership row's
 * display name first, then the server roster — so tool replies can name the
 * member instead of echoing a raw platform id. Returns null when nothing is
 * stored (the caller decides on a fallback).
 */
export async function resolveDisplayName(platform: Platform, userId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT display_name FROM (
       SELECT display_name, 0 AS pref FROM community_users
         WHERE platform = $1 AND platform_user_id = $2
       UNION ALL
       SELECT display_name, 1 AS pref FROM server_roster
         WHERE platform = $1 AND user_id = $2
     ) names
     WHERE display_name IS NOT NULL AND display_name <> ''
     ORDER BY pref
     LIMIT 1`,
    [platform, userId],
  );
  return rows[0]?.display_name ?? null;
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

/**
 * Resolved display names of every `role = 'admin'` community_users row for a
 * platform (issue #360) — the same community_users→server_roster
 * name-resolution precedence as `resolveDisplayName`, applied across every
 * admin row instead of one caller. An admin with no resolvable name anywhere
 * (neither table has a non-empty display_name) is omitted entirely, never
 * rendered as a blank/empty name. Deterministically ordered by
 * `community_users.id` so repeat calls (and the gated notice built from
 * them) are stable. Env-sourced super admins are never in `community_users`,
 * so — like `listAdmins()` above — they are excluded here for the same
 * reason: they're operator-level, not a member's first point of contact.
 * Query is parameterised on `platform` alone; nothing here is influenced by
 * caller-supplied message content.
 */
export async function listAdminDisplayNames(platform: Platform): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(cu.display_name, ''), NULLIF(sr.display_name, '')) AS display_name
       FROM community_users cu
       LEFT JOIN server_roster sr ON sr.platform = cu.platform AND sr.user_id = cu.platform_user_id
      WHERE cu.platform = $1 AND cu.role = 'admin'
      ORDER BY cu.id ASC`,
    [platform],
  );
  return rows
    .map((r) => r.display_name as string | null)
    .filter((name): name is string => name != null && name.trim() !== '');
}

export interface AdminRosterEntry {
  platform: Platform;
  platformUserId: string;
  displayName: string | null;
  leftServer: boolean;
}

/**
 * Every `role = 'admin'` community_users row across both platforms, for the
 * `list_admins` super-admin tool (issue #428) to answer "who currently holds
 * bot-admin privilege?" as a direct query instead of a mental replay of
 * `audit_view`'s grant/revoke log. Reuses the exact community_users→
 * server_roster display-name precedence `listAdminDisplayNames` already
 * uses. `leftServer` is `true` only when a matching `server_roster` row has
 * `left_at IS NOT NULL`; a missing roster row (never seen leaving) or one
 * with `left_at IS NULL` both read as "not known to have left" — this is
 * the signal that surfaces a departed-but-still-admin account
 * (`onGuildMemberRemove` clears roster/membership state but never touches
 * `community_users.role`). Deterministically ordered by `community_users.id`
 * like `listAdminDisplayNames`. Env-sourced super admins are never rows in
 * `community_users`, so — like `listAdmins`/`listAdminDisplayNames` — they
 * are excluded here too.
 */
export async function listAdminRoster(): Promise<AdminRosterEntry[]> {
  const { rows } = await pool.query(
    `SELECT cu.platform, cu.platform_user_id,
            COALESCE(NULLIF(cu.display_name, ''), NULLIF(sr.display_name, '')) AS display_name,
            sr.left_at IS NOT NULL AS left_server
       FROM community_users cu
       LEFT JOIN server_roster sr ON sr.platform = cu.platform AND sr.user_id = cu.platform_user_id
      WHERE cu.role = 'admin'
      ORDER BY cu.id ASC`,
  );
  return rows.map((r) => ({
    platform: r.platform as Platform,
    platformUserId: r.platform_user_id as string,
    displayName: r.display_name as string | null,
    leftServer: r.left_server as boolean,
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

/**
 * Delete one identity's stored data — the single-identity core of
 * `purgeUserData`. Runs every delete inside ONE transaction (issue: a crash
 * partway used to leave, e.g., digests alive over already-deleted interactions
 * that a retry could never re-find), mirroring the sibling `linkMembers`/
 * `unlinkMember` pattern.
 */
async function purgeSingleIdentity(platform: Platform, userId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clear session continuity FIRST, while the user's interactions still
    // exist for the subquery to find the conversations they were active in.
    // Without this the `sessions` row keeps mapping the conversation to a live
    // Claude transcript that still contains the purged messages, so another
    // member could ask the bot to recall them for up to
    // SESSION_MAX_TURNS/AGE_HOURS. Same primitive as `clearUserSessions`, run
    // in-transaction and before the interactions delete below.
    await client.query(
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

    const { rows: deletedInteractions } = await client.query(
      `DELETE FROM interactions
        WHERE platform = $1
          AND (user_id = $2 OR (direction = 'outbound' AND meta->>'replyToUserId' = $2))
        RETURNING id`,
      [platform, userId],
    );
    const messages = deletedInteractions.length;
    // Deletion coherence (issues #51/#102): a context digest whose summary was
    // built over any purged interaction is invalidated outright — the next
    // builder run regenerates the topic without this person's signal. Shared
    // with the delete/edit-honouring path via `invalidateDigestsForInteractions`.
    const candidates = await invalidateDigestsForInteractions(
      deletedInteractions.map((r) => Number(r.id)),
      client,
    );
    // knowledge has no platform column, so this keys on source_user_id alone.
    // Safe because Discord snowflakes (17-20 digits) and WhatsApp E.164 numbers
    // (7-15 digits) can't collide as strings (enforced by normalizeMemberId), so
    // this never touches another platform's user. If that validation loosens, add
    // a platform column to knowledge and filter on it here.
    const { rowCount: knowledge } = await client.query(`DELETE FROM knowledge WHERE source_user_id = $1`, [
      userId,
    ]);
    const { rowCount: reports } = await client.query(
      `DELETE FROM content_reports WHERE platform = $1 AND reporter_user_id = $2`,
      [platform, userId],
    );
    const { rowCount: roster } = await client.query(
      `DELETE FROM server_roster WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    const { rowCount: notes } = await client.query(
      `DELETE FROM member_notes WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    const { rowCount: suggestions } = await client.query(
      `DELETE FROM suggestions WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // admin_digest_sends (issue #97) is keyed on the same (platform, user id)
    // identity — purge coherence for an offboarded admin.
    const { rowCount: digestSends } = await client.query(
      `DELETE FROM admin_digest_sends WHERE platform = $1 AND platform_user_id = $2`,
      [platform, userId],
    );
    // response_style_prefs (issue #126) is keyed the same way — purge coherence
    // for anyone who opted into the plain-language preference.
    const { rowCount: responseStyle } = await client.query(
      `DELETE FROM response_style_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // language_prefs (issue #189) is keyed the same way — purge coherence for
    // anyone who opted into a standing language preference.
    const { rowCount: languagePreference } = await client.query(
      `DELETE FROM language_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // member_warnings (auto-moderation strikes) are keyed on raw (platform,
    // user_id) too — a purged user's warning history goes with them.
    const { rowCount: warnings } = await client.query(
      `DELETE FROM member_warnings WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // answer_feedback (issue #118) rows this identity submitted AS RATER go
    // with them, same as suggestions/reports above. A row where this identity
    // was only the RECIPIENT of the rated answer is not deleted here — its
    // interaction_id is nulled automatically by the interactions delete above
    // via the table's ON DELETE SET NULL foreign key, leaving the rater's own
    // helpful/unhelpful signal intact.
    const { rowCount: answerFeedback } = await client.query(
      `DELETE FROM answer_feedback WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // knowledge_gaps (issue #208) is keyed the same way — purge coherence for
    // anyone whose below-floor searches were logged.
    const { rowCount: knowledgeGaps } = await client.query(
      `DELETE FROM knowledge_gaps WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // dev_team_watches (super-admin dev-team dispatches) is keyed on the same
    // (platform, user id) identity — purge coherence for a requester's
    // job-watch rows (which record the repo/mode/job id they dispatched).
    const { rowCount: devTeamWatches } = await client.query(
      `DELETE FROM dev_team_watches WHERE requester_platform = $1 AND requester_user_id = $2`,
      [platform, userId],
    );

    await client.query('COMMIT');
    return (
      (messages ?? 0) +
      (knowledge ?? 0) +
      (reports ?? 0) +
      (roster ?? 0) +
      (notes ?? 0) +
      (suggestions ?? 0) +
      (digestSends ?? 0) +
      (responseStyle ?? 0) +
      (languagePreference ?? 0) +
      (warnings ?? 0) +
      candidates +
      (answerFeedback ?? 0) +
      (knowledgeGaps ?? 0) +
      (devTeamWatches ?? 0)
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delete a user's stored data: their inbound messages, the bot's replies to
 * them, knowledge entries sourced from them, content reports *they
 * submitted* as reporter, their server_roster row, admin notes kept *about*
 * them (member_notes), suggestions they filed, their response-style and
 * language preferences, answer ratings *they submitted* (issue #118), any context
 * digest built over their purged interactions, and any still-pending
 * knowledge_candidates drafted from an invalidated digest (issue #102) —
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

export interface MyDataSummary {
  ownMessages: number;
  repliesToThem: number;
  knowledgeEntries: number;
  reportsFiled: number;
  suggestionsFiled: number;
  responseStyle: ResponseStyle;
}

/**
 * Read-only counterpart to `purgeSingleIdentity` — counts, rather than
 * deletes, exactly the per-table rows `forget_me`/`purge_user_data` would
 * erase for this identity (issue #188, the IPP6 access-right counterpart to
 * that deletion path), aggregated across every identity linked via
 * `link_member` the same way `purgeSingleIdentity`/`resolveLinkedIdentities`
 * already aggregate for `forget_me`. Interactions are split into the
 * caller's own messages (`user_id = $2`) and the bot's replies to them
 * (`direction = 'outbound' AND meta->>'replyToUserId' = $2`) — the same two
 * halves of `purgeSingleIdentity`'s WHERE clause, reported separately rather
 * than as one confusing lump.
 *
 * Deliberately excludes `member_notes` (issue #45: members have no
 * self-access to notes about themselves, even though `forget_me` deletes
 * them), `server_roster`, `admin_digest_sends`, `member_warnings` (already
 * self-serve via `my_warnings`), and `answer_feedback` — those stay
 * purge-only. Never add a count for any of them here to "reconcile" the
 * total with `purgeSingleIdentity`; the asymmetry is intentional.
 */
export async function getMyDataSummary(platform: Platform, userId: string): Promise<MyDataSummary> {
  const identities = await resolveLinkedIdentities(platform, userId);
  let ownMessages = 0;
  let repliesToThem = 0;
  let knowledgeEntries = 0;
  let reportsFiled = 0;
  let suggestionsFiled = 0;
  for (const identity of identities) {
    const { rows: interactionRows } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE user_id = $2) AS own_messages,
         count(*) FILTER (WHERE direction = 'outbound' AND meta->>'replyToUserId' = $2) AS replies_to_them
       FROM interactions WHERE platform = $1`,
      [identity.platform, identity.userId],
    );
    ownMessages += Number(interactionRows[0]?.own_messages ?? 0);
    repliesToThem += Number(interactionRows[0]?.replies_to_them ?? 0);

    // knowledge has no platform column (see purgeSingleIdentity above), so
    // this keys on source_user_id alone, same as the DELETE it reconciles with.
    const { rows: knowledgeRows } = await pool.query(
      `SELECT count(*) AS n FROM knowledge WHERE source_user_id = $1`,
      [identity.userId],
    );
    knowledgeEntries += Number(knowledgeRows[0]?.n ?? 0);

    const { rows: reportRows } = await pool.query(
      `SELECT count(*) AS n FROM content_reports WHERE platform = $1 AND reporter_user_id = $2`,
      [identity.platform, identity.userId],
    );
    reportsFiled += Number(reportRows[0]?.n ?? 0);

    const { rows: suggestionRows } = await pool.query(
      `SELECT count(*) AS n FROM suggestions WHERE platform = $1 AND user_id = $2`,
      [identity.platform, identity.userId],
    );
    suggestionsFiled += Number(suggestionRows[0]?.n ?? 0);
  }

  return {
    ownMessages,
    repliesToThem,
    knowledgeEntries,
    reportsFiled,
    suggestionsFiled,
    // The standing style preference isn't purge-scope data — it's a single
    // per-identity row, so this reports the caller's own invoking identity
    // only (same scoping set_response_style itself uses), not aggregated.
    responseStyle: await getResponseStyle(platform, userId),
  };
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
  'ban_user',
  'unban_user',
  'delete_message',
  'clear_warnings',
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

/**
 * Per-actor rollup of `admin_audit` over a trailing window (issue #488), the
 * aggregated complement to `recentAuditEntries`'s flat log — answers "who is
 * actually doing moderation/curation work" instead of requiring a super admin
 * to hand-tally raw log lines. Global/unscoped, same as `recentAuditEntries`
 * (a super admin can already read every row via `audit_view`). Reuses
 * `admin_audit_actor_idx (platform, actor_user_id, created_at DESC)` for the
 * `GROUP BY`. Never selects `params` (may carry free-text reasons) — only
 * counts and timestamps. Days clamp mirrors `usageStats`' own shape.
 */
export async function adminActivitySummary(days = 30): Promise<
  Array<{
    platform: Platform;
    actorUserId: string;
    actionCount: number;
    successCount: number;
    failureCount: number;
    lastActionAt: Date;
  }>
> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
  const { rows } = await pool.query(
    `SELECT platform, actor_user_id,
            count(*) AS action_count,
            count(*) FILTER (WHERE success) AS success_count,
            count(*) FILTER (WHERE NOT success) AS failure_count,
            max(created_at) AS last_action_at
       FROM admin_audit
      WHERE created_at >= now() - $1::interval
      GROUP BY platform, actor_user_id
      ORDER BY count(*) DESC`,
    [`${clampedDays} days`],
  );
  return rows.map((r) => ({
    platform: r.platform as Platform,
    actorUserId: r.actor_user_id as string,
    actionCount: Number(r.action_count),
    successCount: Number(r.success_count),
    failureCount: Number(r.failure_count),
    lastActionAt: r.last_action_at as Date,
  }));
}

export async function usageStats(days = 7): Promise<{
  inbound: number;
  outbound: number;
  costUsd: number;
  topUsers: Array<{ userId: string; userName: string | null; messages: number }>;
  costByRole: Array<{ role: Tier; costUsd: number; replies: number }>;
  backgroundCostUsd: number;
  shortcutHits: { total: number; byKind: Array<{ kind: string; count: number }> };
  backgroundCostByJob: Array<{ job: string; costUsd: number }>;
  cacheUsage: { readTokens: number; creationTokens: number };
  autoAnswerUsage: { count: number; costUsd: number };
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
  // Cache-hit/-write token telemetry (issue #522): sums the `meta` JSONB
  // keys `core.ts`/`router.ts` write per outbound row (issue #508's read,
  // threaded through). Same table/window/direction filter as `byRole` above,
  // just one more SUM() aggregate over it — same cost class as the existing
  // `backgroundCostByJob`/`shortcutHits` aggregates it sits beside. Rows that
  // never got either key (pre-#522, or a turn with no/zero usage) contribute
  // 0 via `coalesce`, not null.
  const { rows: cache } = await pool.query(
    `SELECT
       coalesce(sum((meta->>'cacheReadTokens')::bigint), 0) AS read_tokens,
       coalesce(sum((meta->>'cacheCreationTokens')::bigint), 0) AS creation_tokens
     FROM interactions
     WHERE direction = 'outbound' AND created_at > now() - $1::interval`,
    [interval],
  );
  // Auto-answer cost visibility (issue #552): mirrors the cache-usage
  // aggregate immediately above — same table/window/direction filter, one
  // more pair of SUM()/COUNT() over the `meta->>'autoAnswer'` key
  // `router.ts`'s `respond()` now stamps. Rows predating this change (or any
  // non-auto-answer reply) carry no such key and contribute 0 via `coalesce`.
  const { rows: autoAnswer } = await pool.query(
    `SELECT
       coalesce(count(*) FILTER (WHERE meta->>'autoAnswer' = 'true'), 0) AS count,
       coalesce(sum(cost_usd) FILTER (WHERE meta->>'autoAnswer' = 'true'), 0) AS cost
     FROM interactions
     WHERE direction = 'outbound' AND created_at > now() - $1::interval`,
    [interval],
  );
  const background = await sumBackgroundJobCosts(clampedDays);
  const shortcuts = await sumShortcutHits(clampedDays);
  return {
    inbound: Number(totals[0].inbound),
    outbound: Number(totals[0].outbound),
    costUsd: Number(totals[0].cost),
    topUsers: top.map((r) => ({ userId: r.user_id, userName: r.user_name, messages: Number(r.n) })),
    costByRole: byRole.map((r) => ({ role: r.role, costUsd: Number(r.cost), replies: Number(r.n) })),
    backgroundCostUsd: background.total,
    shortcutHits: shortcuts,
    backgroundCostByJob: background.byJob,
    cacheUsage: {
      readTokens: Number(cache[0].read_tokens),
      creationTokens: Number(cache[0].creation_tokens),
    },
    autoAnswerUsage: {
      count: Number(autoAnswer[0].count),
      costUsd: Number(autoAnswer[0].cost),
    },
  };
}

// --- Background job costs ---------------------------------------------------

export type BackgroundJob = 'moderation_llm' | 'context_builder' | 'knowledge_refresh';

/**
 * Records the cost of a standalone background `query()` call (issue #401) —
 * one of the three that spend from the shared Max pool but write no
 * `interactions` row, so `usageStats()` would otherwise never see them.
 * Callers are expected to fire this without awaiting and swallow rejections
 * (see `classifyAbuseWithLlm`/`summarizeCluster`/`researchTopic`), matching
 * this codebase's non-blocking-telemetry convention — a failed write must
 * never block or fail the underlying job.
 */
export async function recordBackgroundJobCost(job: BackgroundJob, costUsd: number): Promise<void> {
  await pool.query(`INSERT INTO background_job_costs (job, cost_usd) VALUES ($1, $2)`, [job, costUsd]);
}

export async function sumBackgroundJobCosts(
  days = 7,
): Promise<{ total: number; byJob: Array<{ job: string; costUsd: number }> }> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 365);
  const { rows } = await pool.query(
    `SELECT job, coalesce(sum(cost_usd), 0) AS cost
       FROM background_job_costs
      WHERE created_at > now() - $1::interval
      GROUP BY job ORDER BY job`,
    [`${clampedDays} days`],
  );
  const byJob = rows.map((r) => ({ job: r.job as string, costUsd: Number(r.cost) }));
  return { total: byJob.reduce((sum, r) => sum + r.costUsd, 0), byJob };
}

// --- Shortcut hits -----------------------------------------------------------

export type ShortcutKind = 'ack' | 'knowledge' | 'repeat_question' | 'repeat_max_turns';

/**
 * Records a hit of one of the four env-gated turn-skipping shortcuts (issue
 * #440) — each avoids a `query()` call against the shared Max pool but was
 * previously visible only via a single `logger.debug`/`.info` line. Callers
 * are expected to fire this without awaiting and swallow rejections (mirrors
 * `recordBackgroundJobCost`'s convention) — a failed write must never block
 * or delay the shortcut's own reply.
 */
export async function recordShortcutHit(kind: ShortcutKind): Promise<void> {
  await pool.query(`INSERT INTO shortcut_hits (kind) VALUES ($1)`, [kind]);
}

export async function sumShortcutHits(
  days = 7,
): Promise<{ total: number; byKind: Array<{ kind: string; count: number }> }> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 365);
  const { rows } = await pool.query(
    `SELECT kind, count(*) AS n
       FROM shortcut_hits
      WHERE created_at > now() - $1::interval
      GROUP BY kind ORDER BY kind`,
    [`${clampedDays} days`],
  );
  const byKind = rows.map((r) => ({ kind: r.kind as string, count: Number(r.n) }));
  return { total: byKind.reduce((sum, r) => sum + r.count, 0), byKind };
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
 *
 * Returns whether this call created a FRESH row (`true`) or updated an
 * existing still-pending one (`false`), via Postgres's own `xmax = 0` trick
 * on `RETURNING` — distinguishing "first insert" from "repeat upsert" needs
 * no extra query or column, just reading what the upsert already tells us
 * (issue #480). This is the debounce signal `notifyAccessRequest`'s
 * first-time-only real-time alert relies on: a repeat ping from the same
 * still-pending guest returns `false` and must not notify again.
 */
export async function recordAccessRequest(input: {
  platform: Platform;
  userId: string;
  userName?: string;
}): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO access_requests (platform, user_id, user_name)
     VALUES ($1,$2,$3)
     ON CONFLICT (platform, user_id) DO UPDATE
       SET last_requested_at = now(),
           request_count = access_requests.request_count + 1,
           user_name = COALESCE(EXCLUDED.user_name, access_requests.user_name)
     RETURNING (xmax = 0) AS inserted`,
    [input.platform, input.userId, input.userName ?? null],
  );
  return rows[0]?.inserted === true;
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

/**
 * Whole-day age of the oldest still-pending access request — the same
 * `MIN(first_requested_at)` oldest-age mechanic issue #450 applies to
 * reports/suggestions, applied here to `access_requests` (issue #515).
 * `first_requested_at` is set once at insert and never updated
 * (`recordAccessRequest`), and `clearAccessRequest` deletes the row on
 * `add_member`, so by construction every remaining row is unresolved
 * backlog and `MIN` over an empty table is `null`, never `0` — returned
 * as-is rather than coerced, so an admin/digest reader can never mistake
 * "no pending requests" for "a request that just arrived".
 */
export async function oldestAccessRequestAgeDays(): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT EXTRACT(DAY FROM now() - MIN(first_requested_at))::int AS age_days FROM access_requests`,
  );
  const ageDays = rows[0]?.age_days;
  return ageDays === null || ageDays === undefined ? null : Number(ageDays);
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

// --- Knowledge candidates (issue #102, the knowledge_candidates half of #51
// its adversarial review deferred) --------------------------------------------

export type KnowledgeCandidateStatus = 'pending' | 'accepted' | 'declined';

export interface KnowledgeCandidate {
  id: number;
  digestId: number | null;
  topic: string;
  title: string;
  content: string;
  status: KnowledgeCandidateStatus;
  createdAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

function toKnowledgeCandidate(r: {
  id: number | string;
  digest_id: number | string | null;
  topic: string;
  title: string;
  content: string;
  status: string;
  created_at: Date;
  reviewed_by: string | null;
  reviewed_at: Date | null;
}): KnowledgeCandidate {
  return {
    id: Number(r.id),
    digestId: r.digest_id === null ? null : Number(r.digest_id),
    topic: r.topic,
    title: r.title,
    content: r.content,
    status: r.status as KnowledgeCandidateStatus,
    createdAt: r.created_at,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
  };
}

/**
 * Draft a candidate from the context builder — always 'pending'. `topic` is
 * copied from the source digest at insert time (not just reachable via
 * `digestId`) so dedup/display survive the digest being nulled out by a
 * later purge (see `purgeSingleIdentity` below). `topicEmbedding` (issue
 * #503) is the SAME vector `candidateTopicAlreadyReviewed` already computed
 * for the dedup check below — passed through rather than re-embedded, and
 * null whenever that check short-circuited on an exact match or the
 * embedding itself failed (fail-open; never blocks the insert).
 */
export async function insertKnowledgeCandidate(input: {
  digestId: number;
  topic: string;
  title: string;
  content: string;
  topicEmbedding?: number[] | null;
}): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO knowledge_candidates (digest_id, topic, title, content, topic_embedding)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [
      input.digestId,
      input.topic,
      input.title,
      input.content,
      input.topicEmbedding ? pgvector.toSql(input.topicEmbedding) : null,
    ],
  );
  return Number(rows[0].id);
}

/**
 * Exact-match half of the builder's dedup guard: true if `topic` already has
 * a `knowledge_candidates` row, in ANY status, matched case-insensitively
 * (the summariser is free-text). Cheap short-circuit — no embedding call —
 * used by `candidateTopicAlreadyReviewed` below before it falls back to the
 * semantic check for a paraphrased topic label (issue #503).
 */
export async function hasQueuedCandidateForTopic(topic: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM knowledge_candidates WHERE lower(topic) = lower($1) LIMIT 1`,
    [topic],
  );
  return rows.length > 0;
}

/**
 * The builder's full candidate dedup guard (issue #503): exact match (any
 * status, via `hasQueuedCandidateForTopic` — no embedding needed, a true
 * short circuit) OR semantic similarity of `topic`'s embedding against any
 * existing `knowledge_candidates.topic_embedding`, any status, at or above
 * `KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD` (the same 0.92 bar
 * `saveKnowledge`'s near-duplicate nudge already established for "same
 * topic, worded differently"). Closes the gap where
 * `hasQueuedCandidateForTopic`'s own docstring promises "an admin's decline
 * sticks" but a reworded topic label (a fresh free-text `TOPIC:` summary
 * every builder run) slipped past exact matching.
 *
 * Also returns the computed embedding (or null when the exact match short-
 * circuited, or embedding failed) so the caller can thread the SAME vector
 * into `knowledgeCoversTopic` and `insertKnowledgeCandidate` — at most one
 * `embed()` call per attempted cluster, same cost profile as before this
 * change. Fails open (`blocked: false`) on an embedding error, matching
 * `knowledgeCoversTopic`'s existing posture: worst case is one extra
 * candidate for an admin to decline, never a silently-dropped genuinely new
 * topic.
 */
export async function candidateTopicAlreadyReviewed(
  topic: string,
): Promise<{ blocked: boolean; embedding: number[] | null }> {
  if (await hasQueuedCandidateForTopic(topic)) {
    return { blocked: true, embedding: null };
  }
  let vec: number[];
  try {
    vec = await embed(topic);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for knowledge-candidate dedup check');
    return { blocked: false, embedding: null };
  }
  const { rows } = await pool.query(
    `SELECT 1 - (topic_embedding <=> $1) AS similarity
       FROM knowledge_candidates
      WHERE topic_embedding IS NOT NULL
      ORDER BY topic_embedding <=> $1
      LIMIT 1`,
    [pgvector.toSql(vec)],
  );
  const top = rows[0];
  const blocked = !!top && Number(top.similarity) >= KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD;
  return { blocked, embedding: vec };
}

/**
 * True if an existing `knowledge` entry already covers this topic above the
 * #95 relevance floor (`KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD`) — the other
 * half of the builder's dedup guard, so the candidate queue doesn't refill
 * with a suggestion an admin already answered. Takes the topic's already-
 * computed embedding (issue #503 — reused from `candidateTopicAlreadyReviewed`
 * rather than re-embedded) instead of embedding it again; a null vector
 * (exact-match short circuit upstream, or a failed embed) fails open to
 * false ("not covered") so a transient embedding outage can only ever
 * produce an extra candidate for an admin to decline, never silently
 * suppress a genuinely new one.
 */
export async function knowledgeCoversTopic(vec: number[] | null): Promise<boolean> {
  if (!vec) return false;
  const { rows } = await pool.query(
    `SELECT 1 - (embedding <=> $1) AS similarity
       FROM knowledge
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1
      LIMIT 1`,
    [pgvector.toSql(vec)],
  );
  const top = rows[0];
  return !!top && Number(top.similarity) >= KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD;
}

/**
 * Admin-tier read of the candidate queue (`list_knowledge_candidates`).
 * `oldestFirst` (issue #398) flips the default `created_at DESC` to `ASC` so
 * an admin can ask "what's been sitting the longest?" — the existing
 * `knowledge_candidates_status_idx (status, created_at DESC)` serves the
 * ascending scan via a backward index scan, so no new index is needed.
 * Default (unset/false) is byte-identical to pre-#398 behaviour.
 */
export async function listKnowledgeCandidates(
  status?: KnowledgeCandidateStatus,
  limit = 50,
  oldestFirst = false,
): Promise<KnowledgeCandidate[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const params: unknown[] = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE status = $${params.length}`;
  }
  params.push(clampedLimit);
  const { rows } = await pool.query(
    `SELECT id, digest_id, topic, title, content, status, created_at, reviewed_by, reviewed_at
       FROM knowledge_candidates
       ${where}
      ORDER BY created_at ${oldestFirst ? 'ASC' : 'DESC'}
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(toKnowledgeCandidate);
}

/**
 * Exact pending-candidate count — a dedicated `COUNT(*)` rather than
 * `(await listKnowledgeCandidates('pending')).length`, which would silently
 * understate a backlog past that function's `limit` (default 50) cap, same
 * reasoning as `countPendingSuggestions`/`countAccessRequests` (issue #133,
 * #284). Guild-wide by design — `knowledge_candidates` has no
 * conversation/channel column, matching `list_knowledge_candidates`'s own
 * unscoped behaviour.
 */
export async function countPendingKnowledgeCandidates(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM knowledge_candidates WHERE status = 'pending'`,
  );
  return Number(rows[0].n);
}

/**
 * Exact count of `pending` candidates older than `days` (issue #398) — the
 * review-queue analogue of `countStaleKnowledge`, but for
 * `knowledge_candidates`'s own age-of-review concern rather than
 * content-freshness. Only `pending` rows count: an `accepted`/`declined`
 * candidate has already been reviewed, so it can never inflate this count
 * regardless of age. Gated behind `KNOWLEDGE_CANDIDATE_STALE_DAYS` (unset/0 =
 * never called) by its callers, same convention as `countStaleKnowledge`.
 */
export async function countStalePendingKnowledgeCandidates(days: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*) AS n
       FROM knowledge_candidates
      WHERE status = 'pending'
        AND created_at < now() - make_interval(days => $1)`,
    [days],
  );
  return Number(rows[0].n);
}

/**
 * Accept a pending candidate: writes exactly one `knowledge` entry via the
 * existing `saveKnowledge` (so the #93 near-duplicate nudge and embedding
 * path apply unchanged) and marks the candidate accepted. Optional
 * title/content let the admin fix wording at accept time without a separate
 * update_knowledge round-trip. Returns null if `id` isn't a *pending*
 * candidate (unknown id, or already accepted/declined) — the tool layer
 * turns that into a refusal rather than silently double-accepting.
 */
export async function acceptKnowledgeCandidate(input: {
  id: number;
  title?: string;
  content?: string;
  reviewedBy: string;
  sourceUrl?: string;
  sourceTitle?: string;
}): Promise<{ candidateId: number; knowledgeId: number; similarEntry?: KnowledgeDuplicateMatch } | null> {
  const { rows } = await pool.query(
    `SELECT id, digest_id, topic, title, content, status, created_at, reviewed_by, reviewed_at
       FROM knowledge_candidates WHERE id = $1 AND status = 'pending'`,
    [input.id],
  );
  const candidate = rows[0] ? toKnowledgeCandidate(rows[0]) : null;
  if (!candidate) return null;

  const { id: knowledgeId, similarEntry } = await saveKnowledge({
    title: input.title ?? candidate.title,
    content: input.content ?? candidate.content,
    createdByRole: 'admin',
    sourceUrl: input.sourceUrl,
    sourceTitle: input.sourceTitle,
  });

  await pool.query(
    `UPDATE knowledge_candidates SET status = 'accepted', reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
    [input.id, input.reviewedBy],
  );

  return { candidateId: candidate.id, knowledgeId, similarEntry };
}

/**
 * Decline a pending candidate: a non-destructive status flip (no CONFIRM),
 * audited by the tool layer. The row is retained as 'declined' (never
 * deleted) so the builder's dedup guard can see it was already reviewed and
 * `list_knowledge_candidates` keeps a record of what was rejected. Returns
 * null if `id` isn't a pending candidate.
 */
export async function declineKnowledgeCandidate(
  id: number,
  reviewedBy: string,
): Promise<KnowledgeCandidate | null> {
  const { rows } = await pool.query(
    `UPDATE knowledge_candidates SET status = 'declined', reviewed_by = $2, reviewed_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING id, digest_id, topic, title, content, status, created_at, reviewed_by, reviewed_at`,
    [id, reviewedBy],
  );
  return rows[0] ? toKnowledgeCandidate(rows[0]) : null;
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

/**
 * Admin-tier read of the shared suggestion queue, unscoped by submitter — a
 * member's own-only view is `listOwnSuggestions` below, not this function.
 */
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
 * Exact pending-suggestion count — a dedicated `COUNT(*)` rather than
 * `(await listSuggestions('new')).length`, which would silently understate a
 * backlog past that function's `limit` (default 50) cap, same reasoning as
 * `countAccessRequests`/`countOpenReports` (issue #133).
 */
export async function countPendingSuggestions(): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*) AS n FROM suggestions WHERE status = 'new'`);
  return Number(rows[0].n);
}

/**
 * Whole-day age of the oldest still-pending suggestion — the same
 * `MIN(created_at)` oldest-age mechanic `oldestAccessRequestAgeDays` (#515)
 * applies to access requests, over exactly the `status = 'new'` row set
 * `countPendingSuggestions` counts (issue #450). Guild-wide, unscoped, matching
 * its sibling count. `MIN` over an empty (all-reviewed) set is `null`, never
 * `0`, and is returned as-is so a digest reader can never mistake "no pending
 * suggestions" for "one that just arrived".
 */
export async function oldestPendingSuggestionAgeDays(): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT EXTRACT(DAY FROM now() - MIN(created_at))::int AS age_days FROM suggestions WHERE status = 'new'`,
  );
  const ageDays = rows[0]?.age_days;
  return ageDays === null || ageDays === undefined ? null : Number(ageDays);
}

/**
 * Self-scoped read of a member's OWN suggestions — the only member-reachable
 * read of this table (the shared queue itself stays admin-only; see the doc
 * comment on listSuggestions above). Same query shape as listSuggestions with
 * `user_id = $2` appended, the same one-predicate-append technique
 * withdrawOwnReports uses to narrow listReports's admin-scoped query down to
 * the caller's own identity.
 */
export async function listOwnSuggestions(
  platform: Platform,
  userId: string,
  limit = 10,
): Promise<Suggestion[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
  const { rows } = await pool.query(
    `SELECT id, platform, user_id, display_name, content, status, created_at, reviewed_by, reviewed_at
       FROM suggestions
      WHERE platform = $1 AND user_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [platform, userId, clampedLimit],
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

/**
 * Growth-pulse counts for the roster summary line. `notMembers` (issue #460)
 * is the standing size of the onboarding queue — the same `left_at IS NULL
 * AND cu.id IS NULL` predicate `listRoster`'s `'not_members'` filter uses
 * (repository.ts's `listRoster`) — added as one more `FILTER` on this same
 * single-table scan via a `LEFT JOIN community_users`, reusing that table's
 * existing `UNIQUE (platform, platform_user_id)` index. Unlike
 * `joinedThisWeek`, it carries no rolling window: a guest who joined months
 * ago and was never added stays counted here indefinitely.
 */
export async function rosterCounts(
  platform: Platform,
): Promise<{ total: number; joinedThisWeek: number; leftThisWeek: number; notMembers: number }> {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE r.left_at IS NULL) AS total,
       count(*) FILTER (WHERE r.left_at IS NULL AND r.joined_at > now() - interval '7 days') AS joined_week,
       count(*) FILTER (WHERE r.left_at IS NOT NULL AND r.left_at > now() - interval '7 days') AS left_week,
       count(*) FILTER (WHERE r.left_at IS NULL AND cu.id IS NULL) AS not_members
     FROM server_roster r
     LEFT JOIN community_users cu
       ON cu.platform = r.platform AND cu.platform_user_id = r.user_id
     WHERE r.platform = $1`,
    [platform],
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    joinedThisWeek: Number(rows[0]?.joined_week ?? 0),
    leftThisWeek: Number(rows[0]?.left_week ?? 0),
    notMembers: Number(rows[0]?.not_members ?? 0),
  };
}

export interface EngagementBreakdown {
  platform: Platform;
  total: number;
  engaged: number;
  /** Percentage rounded to one decimal place; 0 when total is 0 (issue #419). */
  percentage: number;
}

/**
 * Guild-wide engagement %: what fraction of currently-present roster members
 * (issue #419) have ever sent an inbound message. Denominator is
 * `server_roster` where `left_at IS NULL` (durable, Discord-complete /
 * WhatsApp-partial); numerator is the subset of those rows matched by
 * distinct `(platform, user_id)` on an inbound `interactions` row —
 * `interactions` is age-purged per `INTERACTION_RETENTION_DAYS`, so this is a
 * "within the retention window" figure, not a lifetime one. Aggregate-only by
 * design (super-admin `engagement_stats` tool, adversarial review #419): no
 * per-member identity is ever returned, only counts and a percentage.
 */
export async function engagementStats(platform?: Platform): Promise<{
  total: number;
  engaged: number;
  percentage: number;
  byPlatform: EngagementBreakdown[];
}> {
  const params: unknown[] = [];
  let where = 'r.left_at IS NULL';
  if (platform) {
    params.push(platform);
    where += ` AND r.platform = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT r.platform,
            count(*) AS total,
            count(e.user_id) AS engaged
       FROM server_roster r
       LEFT JOIN (
         SELECT DISTINCT platform, user_id FROM interactions WHERE direction = 'inbound'
       ) e ON e.platform = r.platform AND e.user_id = r.user_id
      WHERE ${where}
      GROUP BY r.platform
      ORDER BY r.platform`,
    params,
  );
  const pct = (engaged: number, total: number) => (total > 0 ? Math.round((engaged / total) * 1000) / 10 : 0);
  const byPlatform: EngagementBreakdown[] = rows.map((r) => {
    const total = Number(r.total);
    const engaged = Number(r.engaged);
    return { platform: r.platform as Platform, total, engaged, percentage: pct(engaged, total) };
  });
  const total = byPlatform.reduce((sum, p) => sum + p.total, 0);
  const engaged = byPlatform.reduce((sum, p) => sum + p.engaged, 0);
  return { total, engaged, percentage: pct(engaged, total), byPlatform };
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

// --- Knowledge gaps (below-floor knowledge_search misses, issue #208) -------

/** Per-user cap on new gap rows within a rolling 24h window — same anti-flood shape as RATE_ANSWER_DAILY_LIMIT. */
export const KNOWLEDGE_GAP_DAILY_LIMIT = 20;
export const KNOWLEDGE_GAP_QUERY_MAX_CHARS = 500;

/**
 * Record one `knowledge_search` call that came back with hits but none
 * cleared `KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD` — the caller (the
 * `knowledge_search` tool handler) must only invoke this when
 * `hits.length > 0 && relevantIds.length === 0`, never on a plain empty
 * result set, so a `searchKnowledge` embed() failure (which also returns
 * `[]`) can't masquerade as a genuine miss. `query` is the model's
 * reformulated search string, not necessarily the member's verbatim
 * message — callers/docs must describe entries as "searches with no
 * confident answer", not "member questions".
 *
 * Enforces the same DB-backed rolling-24h cap per `(platform, user_id)` as
 * `createAnswerFeedback`/`createSuggestion` (COUNT(*) inside the insert,
 * never an in-memory counter) so a chatty or adversarial member can't flood
 * `list_knowledge_gaps` with junk. Fire-and-forget from the tool handler —
 * callers must swallow failures themselves (never block or delay the reply).
 */
export async function recordKnowledgeGap(
  platform: Platform,
  conversationId: string,
  userId: string,
  query: string,
): Promise<{ id: number } | 'rate_limited'> {
  let embedding: number[] | null = null;
  try {
    embedding = await embed(query);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for knowledge gap');
  }

  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT count(*) AS n FROM knowledge_gaps
        WHERE platform = $1 AND user_id = $2
          AND created_at > now() - interval '24 hours'
     )
     INSERT INTO knowledge_gaps (platform, conversation_id, user_id, query_text, embedding)
     SELECT $1, $3, $2, $4, $5
      WHERE (SELECT n FROM recent) < $6
     RETURNING id`,
    [
      platform,
      userId,
      conversationId,
      query.slice(0, KNOWLEDGE_GAP_QUERY_MAX_CHARS),
      embedding ? pgvector.toSql(embedding) : null,
      KNOWLEDGE_GAP_DAILY_LIMIT,
    ],
  );
  return rows[0] ? { id: Number(rows[0].id) } : 'rate_limited';
}

/**
 * Record a CONFIRMED escalation (issue #479's escalation-confirmation
 * intercept) into `knowledge_gaps` with `escalated = true` — the strongest
 * curation-priority signal available: a member asked a human directly,
 * rather than a passive below-floor `knowledge_search` miss (issue #514).
 * Deliberately an unconditional insert, NOT gated by `KNOWLEDGE_GAP_DAILY_LIMIT`
 * — that per-user cap exists to bound passive per-message noise, and reusing
 * it here would risk silently dropping the highest-value data point. The
 * caller (router.ts) only ever invokes this inside the
 * `reserveEscalationSlot` success branch, so volume is already independently
 * bounded by the guild-wide `ESCALATION_RATE_LIMIT_PER_HOUR`. Fire-and-forget
 * from the router — callers must swallow failures themselves (never block or
 * delay the confirmation reply), matching the sibling `notifyAdminsFn` call.
 */
export async function recordEscalatedKnowledgeGap(
  platform: Platform,
  conversationId: string,
  userId: string,
  query: string,
): Promise<{ id: number }> {
  let embedding: number[] | null = null;
  try {
    embedding = await embed(query);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for escalated knowledge gap');
  }

  const { rows } = await pool.query(
    `INSERT INTO knowledge_gaps (platform, conversation_id, user_id, query_text, embedding, escalated)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING id`,
    [
      platform,
      conversationId,
      userId,
      query.slice(0, KNOWLEDGE_GAP_QUERY_MAX_CHARS),
      embedding ? pgvector.toSql(embedding) : null,
    ],
  );
  return { id: Number(rows[0].id) };
}

export interface KnowledgeGapCluster {
  representative: string;
  count: number;
}

/**
 * Greedily cluster recent knowledge-search misses by embedding similarity —
 * the `list_knowledge_gaps` signal, mirroring `recentQuestionClusters` exactly
 * (same clustering code, same `QUESTION_CLUSTER_SIMILARITY_THRESHOLD`,
 * same conversation-scoping convention) but sourced from `knowledge_gaps`
 * instead of `interactions`. Excludes `resolved_at IS NOT NULL` rows (issue
 * #422) — a gap `save_knowledge`/`update_knowledge` already resolved
 * disappears immediately, not only once `created_at` ages past `days`.
 */
export async function recentKnowledgeGapClusters(
  conversationIds: readonly string[] | null,
  days = 7,
  limit = 10,
): Promise<KnowledgeGapCluster[]> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 30);
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);

  const params: unknown[] = [`${clampedDays} days`];
  let scope = '';
  if (conversationIds) {
    params.push([...conversationIds]);
    scope = `AND conversation_id = ANY($${params.length})`;
  }

  const { rows } = await pool.query(
    `SELECT query_text, embedding
       FROM knowledge_gaps
      WHERE embedding IS NOT NULL
        AND resolved_at IS NULL
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
      clusters.push({ representative: row.query_text, embedding: vec, count: 1 });
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

// --- Admin digest trend snapshot (issue #497) -------------------------------

/**
 * The only signal names ever allowed into `last_counts` — every one of
 * `buildAdminDigestMessage`'s bare-count parameters (see adminDigest.ts),
 * nothing else. `sanitizeDigestCounts` enforces this at the write boundary
 * so a future call site can never smuggle PII-shaped data (a user id, a
 * title) into the snapshot via an unexpected field name.
 */
const ADMIN_DIGEST_SIGNAL_KEYS = new Set([
  'pendingAccessRequests',
  'openReports',
  'pendingSuggestions',
  'staleKnowledgeCount',
  'knowledgeGapsCount',
  'pendingKnowledgeCandidates',
  'lowRatedKnowledgeCount',
  'joinedThisWeek',
  'leftThisWeek',
  'mutedMembersCount',
  'maxTurnsFailuresCount',
  'duplicateKnowledgeCount',
  'conflictCandidateCount',
  'staleMutedMembersCount',
  'notMembersCount',
]);

/** Strips any key outside `ADMIN_DIGEST_SIGNAL_KEYS` and any non-integer value. */
function sanitizeDigestCounts(counts: Record<string, number>): Record<string, number> {
  const sanitized: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (ADMIN_DIGEST_SIGNAL_KEYS.has(key) && Number.isInteger(value)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Record that the weekly admin digest was just sent to this identity.
 * `counts`, when passed, is sanitized (see above) and persisted as this
 * admin's `last_counts` trend snapshot alongside the freshness timestamp —
 * existing call sites that omit it leave `last_counts` untouched, matching
 * pre-#497 behaviour exactly.
 */
export async function recordAdminDigestSent(
  platform: Platform,
  platformUserId: string,
  counts?: Record<string, number>,
): Promise<void> {
  const sanitized = counts ? JSON.stringify(sanitizeDigestCounts(counts)) : null;
  await pool.query(
    `INSERT INTO admin_digest_sends (platform, platform_user_id, sent_at, last_counts)
     VALUES ($1, $2, now(), COALESCE($3::jsonb, '{}'::jsonb))
     ON CONFLICT (platform, platform_user_id) DO UPDATE SET
       sent_at = now(),
       last_counts = COALESCE($3::jsonb, admin_digest_sends.last_counts)`,
    [platform, platformUserId, sanitized],
  );
}

/**
 * Snapshot-only write for a "quiet week" (`buildAdminDigestMessage` returned
 * null, nothing sent) — updates `last_counts` so next week's trend delta is
 * still accurate, WITHOUT touching `sent_at`/the freshness-guard eligibility
 * window (issue #497 acceptance criterion 6). A brand-new row (this admin's
 * very first quiet week) is inserted with `sent_at` pinned to `-infinity` so
 * it can never register as "sent recently" — only a real
 * `recordAdminDigestSent` call may advance that clock.
 */
export async function recordAdminDigestSnapshot(
  platform: Platform,
  platformUserId: string,
  counts: Record<string, number>,
): Promise<void> {
  const sanitized = JSON.stringify(sanitizeDigestCounts(counts));
  await pool.query(
    `INSERT INTO admin_digest_sends (platform, platform_user_id, sent_at, last_counts)
     VALUES ($1, $2, TIMESTAMPTZ '-infinity', $3::jsonb)
     ON CONFLICT (platform, platform_user_id) DO UPDATE SET last_counts = EXCLUDED.last_counts`,
    [platform, platformUserId, sanitized],
  );
}

/**
 * Last week's digest signal counts for this admin, or null when they have no
 * prior `admin_digest_sends` row at all (first-ever digest) — the read half
 * of the trend snapshot (issue #497). Only called when
 * `config.adminDigest.trendsEnabled`; see `runAdminDigestOnce`.
 */
export async function getLastDigestCounts(
  platform: Platform,
  platformUserId: string,
): Promise<Record<string, number> | null> {
  const { rows } = await pool.query<{ last_counts: Record<string, number> }>(
    `SELECT last_counts FROM admin_digest_sends WHERE platform = $1 AND platform_user_id = $2`,
    [platform, platformUserId],
  );
  return rows.length > 0 ? rows[0].last_counts : null;
}

// --- Weekly cost-trend digest state (issue #578) ----------------------------

/**
 * True if the weekly cost-trend DM was already sent within the last `days`
 * — the restart-safe check `src/usageCostDigest.ts` uses so a redeploy mid-
 * week can't double-send, same shape as `wasAdminDigestSentRecently` but
 * over the single global `usage_cost_digest_state` row rather than a
 * per-admin one.
 */
export async function wasUsageCostDigestSentRecently(days: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM usage_cost_digest_state
      WHERE sent_at > now() - ($1 || ' days')::interval`,
    [days],
  );
  return rows.length > 0;
}

/**
 * Last week's persisted total (`costUsd + backgroundCostUsd`), or `null`
 * when no row exists yet (first-ever run) — the read half of the trend
 * delta `formatUsageCostDigestMessage` renders.
 */
export async function getLastUsageCostDigestTotal(): Promise<number | null> {
  const { rows } = await pool.query<{ total_cost_usd: string }>(
    `SELECT total_cost_usd FROM usage_cost_digest_state WHERE id = true`,
  );
  return rows.length > 0 ? Number(rows[0].total_cost_usd) : null;
}

/**
 * Record that the weekly cost-trend DM was just sent, persisting this
 * week's total for next week's delta and advancing the freshness guard.
 * Upserts the single global row (`id = true`) rather than inserting a new
 * one, matching the "one aggregate figure" shape documented on the table.
 */
export async function recordUsageCostDigestSent(totalCostUsd: number): Promise<void> {
  await pool.query(
    `INSERT INTO usage_cost_digest_state (id, total_cost_usd, sent_at)
     VALUES (true, $1, now())
     ON CONFLICT (id) DO UPDATE SET total_cost_usd = EXCLUDED.total_cost_usd, sent_at = now()`,
    [totalCostUsd],
  );
}

// --- Engagement-alert freshness guard (issue #568) --------------------------

/**
 * True if the single-row, guild-wide `engagement_alert_sends` guard was
 * stamped within the last `days` — the restart-safe check `src/engagement
 * Alert.ts` uses so a redeploy mid-week can't double-send, mirroring
 * `wasAdminDigestSentRecently`'s shape but with no identity to key on.
 */
export async function wasEngagementAlertSentRecently(days: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM engagement_alert_sends
      WHERE id = 1 AND sent_at > now() - ($1 || ' days')::interval`,
    [days],
  );
  return rows.length > 0;
}

/**
 * Record that the engagement alert was just sent, stamping the freshness
 * guard and this run's percentage (forward-compat only — see schema.sql;
 * nothing in this PR reads `last_percentage` back). Always the same `id = 1`
 * row, so this is an upsert, not an insert.
 */
export async function recordEngagementAlertSent(percentage: number): Promise<void> {
  await pool.query(
    `INSERT INTO engagement_alert_sends (id, sent_at, last_percentage)
     VALUES (1, now(), $1)
     ON CONFLICT (id) DO UPDATE SET sent_at = now(), last_percentage = EXCLUDED.last_percentage`,
    [percentage],
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

// --- Standing language preference (issue #189) -------------------------------

export type LanguagePreference = 'auto' | 'en' | 'mi';

/**
 * The caller's standing language preference, or 'auto' (today's per-message
 * mirroring default, issue #68) when they've never called
 * `set_language_preference`. A single primary-key lookup, same cost shape as
 * getResponseStyle.
 */
export async function getLanguagePreference(platform: Platform, userId: string): Promise<LanguagePreference> {
  try {
    const { rows } = await pool.query(
      `SELECT language FROM language_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    const language = rows[0]?.language;
    return language === 'en' || language === 'mi' ? language : 'auto';
  } catch (err) {
    // Hot-path read on every turn: a DB hiccup must not fail the turn (issue
    // #52) — degrade to 'auto', same as getResponseStyle.
    logger.warn({ err, platform, userId }, 'Language-preference read failed; using auto');
    return 'auto';
  }
}

/** Upsert the caller's standing language preference. */
export async function setLanguagePreference(
  platform: Platform,
  userId: string,
  language: LanguagePreference,
): Promise<void> {
  await pool.query(
    `INSERT INTO language_prefs (platform, user_id, language, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (platform, user_id) DO UPDATE SET language = $3, updated_at = now()`,
    [platform, userId, language],
  );
}

// --- Auto-moderation strikes -------------------------------------------------

export interface NewWarning {
  platform: string;
  userId: string;
  reason: string;
  excerpt: string | null;
  source: 'auto' | 'admin';
  issuedBy: string | null;
}

/** Record one warning against a member. */
export async function addWarning(w: NewWarning): Promise<void> {
  await pool.query(
    `INSERT INTO member_warnings (platform, user_id, reason, excerpt, source, issued_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [w.platform, w.userId, w.reason, w.excerpt, w.source, w.issuedBy],
  );
}

/**
 * Active (uncleared) strike count for a member — the block trigger. When
 * `windowDays` is given, strikes older than that rolling window no longer
 * count (MODERATION_STRIKE_WINDOW_DAYS); omitted, behaviour is unbounded
 * (every uncleared strike counts, regardless of age — today's default). The
 * window is always a bound parameter passed through `make_interval`, never
 * interpolated into the query text, so the query shape can't be altered by a
 * hostile/config value.
 */
export async function countActiveWarnings(
  platform: string,
  userId: string,
  windowDays?: number,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM member_warnings
      WHERE platform = $1 AND user_id = $2 AND cleared_at IS NULL
        AND ($3::int IS NULL OR created_at >= now() - make_interval(days => $3::int))`,
    [platform, userId, windowDays ?? null],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Count of distinct members on `platform` who are CURRENTLY muted — their
 * active (uncleared) strike count is `>= strikeLimit` — honouring the same
 * optional rolling `windowDays` bound `countActiveWarnings` uses, so the
 * digest's definition of "muted" can never drift from the actual mute
 * trigger in `moderator.ts` (issue #357). Bound parameters only, never
 * interpolated, same injection posture as `countActiveWarnings`.
 */
export async function countMutedMembers(
  platform: string,
  strikeLimit: number,
  windowDays?: number,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT user_id FROM member_warnings
        WHERE platform = $1 AND cleared_at IS NULL
          AND ($3::int IS NULL OR created_at >= now() - make_interval(days => $3::int))
        GROUP BY user_id
       HAVING COUNT(*) >= $2
     ) t`,
    [platform, strikeLimit, windowDays ?? null],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Count of distinct members on `platform` whose UNWINDOWED active-strike
 * count is `>= strikeLimit` but whose WINDOWED active-strike count (the same
 * `windowDays` bound `countMutedMembers`/`countActiveWarnings` use) is
 * `< strikeLimit` — the cohort `countMutedMembers`'s windowed definition
 * necessarily and correctly excludes (issue #357) once enough of a member's
 * strikes age out of the window that they stop being counted "currently
 * muted", even though nothing ever unmuted them — there is no auto-unmute;
 * `clear_warnings` is the only path (docs/SECURITY.md). Mutually exclusive
 * with `countMutedMembers`'s windowed `>= strikeLimit` set by construction
 * (issue #403).
 *
 * This is an OVER-APPROXIMATION, not a precise "is this member still muted"
 * signal: mute state is never persisted (there is no `muted_members` table,
 * only `member_warnings`), and an actual mute only ever fired when a past
 * scan's WINDOWED count crossed `strikeLimit`. A member whose strikes
 * accrued slowly enough that the windowed count never crossed the limit at
 * any scan can still satisfy unwindowed `>= strikeLimit` here despite never
 * having been muted. Callers must hedge this as "may still be muted", never
 * assert it as exact.
 *
 * Short-circuits to `0` with NO query at all when `windowDays` is
 * `undefined` — the windowed and unwindowed counts are then always
 * identical by construction, so this cohort is provably empty, and the
 * signal is fully inert unless MODERATION_STRIKE_WINDOW_DAYS is configured.
 * Bound parameters only, same injection posture as `countMutedMembers`.
 */
export async function countStaleMutedMembers(
  platform: string,
  strikeLimit: number,
  windowDays?: number,
): Promise<number> {
  if (windowDays === undefined) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT user_id FROM member_warnings
        WHERE platform = $1 AND cleared_at IS NULL
        GROUP BY user_id
       HAVING COUNT(*) >= $2
          AND COUNT(*) FILTER (WHERE created_at >= now() - make_interval(days => $3::int)) < $2
     ) t`,
    [platform, strikeLimit, windowDays],
  );
  return rows[0]?.n ?? 0;
}

export interface MutedMemberRow {
  userId: string;
  status: 'active' | 'stale';
  strikeCount: number;
  lastWarningAt: Date;
}

/**
 * Enumerate the members `countMutedMembers` and `countStaleMutedMembers`
 * would each count, by identity rather than a bare number (issue #487, the
 * growth path #403 explicitly named and deferred) — the "who" a digest's
 * `🔇 N member(s) currently muted` count can't answer on its own.
 *
 * One query computes both the windowed and unwindowed active-strike count
 * per user with the exact same predicates those two count functions use, and
 * a row is tagged `'active'` when the windowed count (or the unwindowed
 * count, when `windowDays` is `undefined` — identical by construction, same
 * short-circuit `countStaleMutedMembers` relies on) is `>= strikeLimit`,
 * else `'stale'` when only the unwindowed count is. Because `'active'` is
 * decided first and `'stale'` only applies to rows the HAVING clause let
 * through on the unwindowed branch, the two tags are mutually exclusive by
 * construction — never both, never neither, for a row that appears at all.
 *
 * `strikeCount` reports whichever count decided the tag (windowed for
 * `'active'`, unwindowed for `'stale'`), so an admin sees the number that
 * actually explains why the row is here. Ordered newest-warning-first,
 * capped at `limit`. Bound parameters only, same injection posture as
 * `countMutedMembers`/`countStaleMutedMembers`.
 *
 * Deliberately excludes `reason`/`excerpt` (message content) — those stay
 * behind `listMemberWarnings`, one level deeper, same boundary `clear_warnings`/
 * `list_member_warnings` already draw.
 */
export async function listMutedMembers(
  platform: string,
  strikeLimit: number,
  windowDays?: number,
  limit = 50,
): Promise<MutedMemberRow[]> {
  const { rows } = await pool.query(
    `SELECT user_id,
            MAX(created_at) AS last_warning_at,
            COUNT(*) FILTER (
              WHERE $3::int IS NULL OR created_at >= now() - make_interval(days => $3::int)
            ) AS windowed_count,
            COUNT(*) AS unwindowed_count
       FROM member_warnings
      WHERE platform = $1 AND cleared_at IS NULL
      GROUP BY user_id
     HAVING COUNT(*) FILTER (
              WHERE $3::int IS NULL OR created_at >= now() - make_interval(days => $3::int)
            ) >= $2
         OR COUNT(*) >= $2
      ORDER BY MAX(created_at) DESC
      LIMIT $4`,
    [platform, strikeLimit, windowDays ?? null, limit],
  );
  return rows.map((r) => {
    const windowedCount = Number(r.windowed_count);
    const unwindowedCount = Number(r.unwindowed_count);
    const active = windowedCount >= strikeLimit;
    return {
      userId: r.user_id,
      status: active ? ('active' as const) : ('stale' as const),
      strikeCount: active ? windowedCount : unwindowedCount,
      lastWarningAt: r.last_warning_at,
    };
  });
}

/**
 * Clear all of a member's active warnings (an admin action), stamping who
 * cleared them and when. Returns the number of strikes cleared, so the caller
 * can tell "actually unblocked them" from "they had nothing to clear".
 */
export async function clearWarnings(platform: string, userId: string, clearedBy: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE member_warnings
        SET cleared_at = now(), cleared_by = $3
      WHERE platform = $1 AND user_id = $2 AND cleared_at IS NULL`,
    [platform, userId, clearedBy],
  );
  return rowCount ?? 0;
}

export interface MemberWarningRow {
  createdAt: Date;
  source: 'auto' | 'admin';
  reason: string;
  excerpt: string | null;
  issuedBy: string | null;
  clearedAt: Date | null;
  clearedBy: string | null;
}

/**
 * Full warning history (both `source: 'auto'` and `source: 'admin'` rows,
 * reason/excerpt included) for one member — the `list_member_warnings` read
 * `moderation_history` structurally can't provide, since it reads only
 * `admin_audit`, never `member_warnings` (issue #410). Scoped by
 * `(platform, userId)` only, matching `clearWarnings`' own scope — the table
 * has no `conversation_id` column (docs/SECURITY.md: "any admin may clear
 * anyone's [warnings]").
 */
export async function listMemberWarnings(
  platform: string,
  userId: string,
  limit = 20,
): Promise<MemberWarningRow[]> {
  const { rows } = await pool.query(
    `SELECT created_at, source, reason, excerpt, issued_by, cleared_at, cleared_by
       FROM member_warnings
      WHERE platform = $1 AND user_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [platform, userId, limit],
  );
  return rows.map((r) => ({
    createdAt: r.created_at,
    source: r.source,
    reason: r.reason,
    excerpt: r.excerpt,
    issuedBy: r.issued_by,
    clearedAt: r.cleared_at,
    clearedBy: r.cleared_by,
  }));
}

// --- Content reports (member-facing abuse/spam intake) -----------------------

/** Per-reporter cap on new reports within a rolling window (anti-griefing on the admin queue). */
export const REPORT_RATE_LIMIT_PER_DAY = 5;

export type ContentReportStatus = 'open' | 'resolved' | 'dismissed' | 'withdrawn';

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
  /** Filed from a 1:1 DM? Defaults to false (matching the column default) for callers that don't track it. */
  isDirect?: boolean;
}): Promise<{ id: number } | null> {
  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT count(*) AS n FROM content_reports
        WHERE platform = $1 AND reporter_user_id = $2
          AND created_at > now() - interval '24 hours'
     )
     INSERT INTO content_reports
       (platform, reporter_user_id, reporter_name, conversation_id, target_user_id, message_id, reason, is_dm)
     SELECT $1, $2, $3, $4, $5, $6, $7, $9
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
      input.isDirect ?? false,
    ],
  );
  return rows[0] ? { id: Number(rows[0].id) } : null;
}

/**
 * Count of DM reports the given reporter has filed naming the given target
 * within the last `windowDays` — narrows the SECURITY.md-documented residual
 * risk that a member who knows an admin's platform id (e.g. from an
 * @-mention) can repeatedly name them in unrelated DM reports, quietly
 * blinding that admin via the accused-admin exclusion in `listReports`/
 * `countOpenReports`/`resolveContentReport` (issue #197), with nothing
 * surfacing the pattern (issue #305). Scoped exactly to `(platform,
 * reporter_user_id, target_user_id, is_dm = true)` — a different platform,
 * reporter, target, or a non-DM report never contributes. Served by the
 * existing `content_reports_reporter_rate_idx (platform, reporter_user_id,
 * created_at DESC)` for its `(platform, reporter_user_id)` prefix; report
 * volume is already capped at `REPORT_RATE_LIMIT_PER_DAY` per reporter per
 * rolling 24h, so this stays cheap regardless of call frequency.
 */
export async function countRecentDmReportsByReporterAndTarget(
  platform: Platform,
  reporterUserId: string,
  targetUserId: string,
  windowDays = 30,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM content_reports
      WHERE platform = $1 AND reporter_user_id = $2 AND target_user_id = $3
        AND is_dm = true AND created_at > now() - ($4 || ' days')::interval`,
    [platform, reporterUserId, targetUserId, String(windowDays)],
  );
  return Number(rows[0].n);
}

/**
 * Admin-tier view of reports, scoped to `conversationIds` (null = super
 * admin, unrestricted — same convention as recentModerationEntries). A
 * report filed from a 1:1 DM (`is_dm`) has no conversation any ordinary
 * admin can naturally be scoped to (each DM is unique per member), so it is
 * additionally surfaced to a scoped admin via `OR is_dm` — except one filed
 * against that very admin (`target_user_id`), which stays reachable only by
 * a super admin so an accused admin can't see or dismiss a report about
 * themselves (issue #197). `viewerUserIds` is the calling admin's own id
 * PLUS every identity linked to them via `link_member` — a single raw id
 * would let a dual-presence admin (Discord + WhatsApp, exactly the case
 * `link_member` exists for) see a DM report filed against their *other*
 * platform identity, since that id `IS DISTINCT FROM` their current-platform
 * id. Omitting it leaves DM-originated reports invisible to a scoped admin,
 * same as before #197 — never widen scope without it.
 *
 * `targetUserId`, when present, narrows the result further — same
 * one-predicate-append technique as recentModerationEntries's `targetUserId`
 * filter — and is appended AFTER the accused-admin exclusion above, so it can
 * only intersect an already-scoped result set, never widen it (issue #463).
 */
export async function listReports(
  conversationIds: readonly string[] | null,
  status?: ContentReportStatus,
  limit = 50,
  viewerUserIds?: readonly string[],
  targetUserId?: string,
): Promise<ContentReport[]> {
  const params: unknown[] = [];
  const filters: string[] = [];
  if (conversationIds) {
    params.push([...conversationIds]);
    const convoIdx = params.length;
    if (viewerUserIds && viewerUserIds.length > 0) {
      params.push([...viewerUserIds]);
      filters.push(
        `(conversation_id = ANY($${convoIdx}) OR (is_dm AND (target_user_id IS NULL OR target_user_id <> ALL($${params.length}))))`,
      );
    } else {
      filters.push(`conversation_id = ANY($${convoIdx})`);
    }
  }
  if (status) {
    params.push(status);
    filters.push(`status = $${params.length}`);
  }
  if (targetUserId) {
    params.push(targetUserId);
    filters.push(`target_user_id = $${params.length}`);
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
 * null = unrestricted/super admin, `viewerUserIds` drives the same
 * linked-identity-aware accused-admin exclusion on the `OR is_dm` broadening
 * — see `listReports`) — a dedicated `COUNT(*)` rather than `(await
 * listReports(scope, 'open')).length`, which would silently understate a
 * backlog past that function's clamped (≤200) `limit`.
 */
export async function countOpenReports(
  conversationIds: readonly string[] | null,
  viewerUserIds?: readonly string[],
): Promise<number> {
  const params: unknown[] = [];
  const filters: string[] = [`status = 'open'`];
  if (conversationIds) {
    params.push([...conversationIds]);
    const convoIdx = params.length;
    if (viewerUserIds && viewerUserIds.length > 0) {
      params.push([...viewerUserIds]);
      filters.push(
        `(conversation_id = ANY($${convoIdx}) OR (is_dm AND (target_user_id IS NULL OR target_user_id <> ALL($${params.length}))))`,
      );
    } else {
      filters.push(`conversation_id = ANY($${convoIdx})`);
    }
  }
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM content_reports WHERE ${filters.join(' AND ')}`,
    params,
  );
  return Number(rows[0].n);
}

/**
 * Whole-day age of the oldest still-open report visible to this admin — the
 * same `MIN(created_at)` oldest-age mechanic `oldestAccessRequestAgeDays`
 * (#515) applies to access requests, over exactly the scoped row set
 * `countOpenReports` counts (issue #450). Builds the identical
 * `status = 'open'` + conversation/DM scoping predicate `countOpenReports`
 * does — so a report filed in a conversation this admin doesn't participate
 * in (or a DM report against the admin themselves) can never influence the
 * age they see, same as it can't influence their count. `MIN` over an empty
 * scoped set is `null`, never `0`, and is returned as-is so a digest reader
 * can never mistake "no open reports" for "one that just arrived".
 */
export async function oldestOpenReportAgeDays(
  conversationIds: readonly string[] | null,
  viewerUserIds?: readonly string[],
): Promise<number | null> {
  const params: unknown[] = [];
  const filters: string[] = [`status = 'open'`];
  if (conversationIds) {
    params.push([...conversationIds]);
    const convoIdx = params.length;
    if (viewerUserIds && viewerUserIds.length > 0) {
      params.push([...viewerUserIds]);
      filters.push(
        `(conversation_id = ANY($${convoIdx}) OR (is_dm AND (target_user_id IS NULL OR target_user_id <> ALL($${params.length}))))`,
      );
    } else {
      filters.push(`conversation_id = ANY($${convoIdx})`);
    }
  }
  const { rows } = await pool.query(
    `SELECT EXTRACT(DAY FROM now() - MIN(created_at))::int AS age_days FROM content_reports WHERE ${filters.join(' AND ')}`,
    params,
  );
  const ageDays = rows[0]?.age_days;
  return ageDays === null || ageDays === undefined ? null : Number(ageDays);
}

/**
 * Count knowledge-search gaps (#208) recorded in the given conversations within
 * the last `days`, for the weekly admin digest (#246). **Conversation-scoped**
 * — unlike the guild-wide stale/access/suggestion counts — because
 * `knowledge_gaps` has a `conversation_id`, so an admin never sees gap volume
 * from a conversation they don't participate in (mirrors `countOpenReports`'s
 * scoping). A true `COUNT(*)`, never `.length` of a `LIMIT`-bounded list, so a
 * backlog larger than `list_knowledge_gaps`' own limit is not understated.
 * Excludes `resolved_at IS NOT NULL` rows (issue #422), same as
 * `recentKnowledgeGapClusters` — a resolved gap drops out of the digest
 * count immediately.
 */
export async function countKnowledgeGaps(conversationIds: readonly string[], days: number): Promise<number> {
  if (conversationIds.length === 0) return 0;
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM knowledge_gaps
      WHERE conversation_id = ANY($1)
        AND resolved_at IS NULL
        AND created_at >= now() - ($2 || ' days')::interval`,
    [[...conversationIds], String(days)],
  );
  return Number(rows[0].n);
}

/**
 * Count ESCALATED knowledge gaps (issue #514) recorded in the given
 * conversations within the last `days`, for the weekly admin digest — the
 * subset of `countKnowledgeGaps` written by `recordEscalatedKnowledgeGap`
 * (a confirmed, member-initiated escalation rather than a passive miss).
 * Mirrors `countKnowledgeGaps` exactly (conversation-scoped, day-windowed,
 * `resolved_at IS NULL`, a true `COUNT(*)`) plus `AND escalated = true`.
 */
export async function countEscalatedKnowledgeGaps(
  conversationIds: readonly string[],
  days: number,
): Promise<number> {
  if (conversationIds.length === 0) return 0;
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM knowledge_gaps
      WHERE conversation_id = ANY($1)
        AND resolved_at IS NULL
        AND escalated = true
        AND created_at >= now() - ($2 || ' days')::interval`,
    [[...conversationIds], String(days)],
  );
  return Number(rows[0].n);
}

/**
 * Count outbound replies in `conversationIds` over the last `days` that hit
 * `AGENT_MAX_TURNS`/`AGENT_MAX_TURNS_MEMBER` before finishing, for the weekly
 * admin digest (#371). Counts both the primary `maxTurnsExceeded: true` stamp
 * (router.ts's outbound-record call) and the `repeatMaxTurnsShortcut: true`
 * stamp (#306) — each is a distinct member-facing wall-hit. **Conversation-
 * scoped** and a true `COUNT(*)`, mirroring `countKnowledgeGaps` exactly.
 */
export async function countMaxTurnsFailures(
  conversationIds: readonly string[],
  days: number,
): Promise<number> {
  if (conversationIds.length === 0) return 0;
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM interactions
      WHERE direction = 'outbound'
        AND conversation_id = ANY($1)
        AND created_at >= now() - ($2 || ' days')::interval
        AND (meta->>'maxTurnsExceeded' = 'true' OR meta->>'repeatMaxTurnsShortcut' = 'true')`,
    [[...conversationIds], String(days)],
  );
  return Number(rows[0].n);
}

/**
 * Count unhelpful ratings on GENERAL-KNOWLEDGE answers (issue #563) — the
 * `meta->>'knowledgeEntryId' IS NULL` complement `countLowRatedKnowledge`/
 * `listKnowledgeFeedbackSummary` deliberately exclude (their own doc
 * comments: "Ratings on interactions with no `knowledgeEntryId` are still
 * excluded"). A general-knowledge answer has no community-curated grounding
 * to re-check, unlike a KB-attributed one — the highest accuracy-risk bucket
 * per VISION's answer-quality theme — so this is the missing push signal for
 * it. Modelled on `countMaxTurnsFailures`'s rolling-window, conversation-
 * scoped, true-`COUNT(*)` shape rather than `countLowRatedKnowledge`'s
 * per-entity backlog shape: free-text general-knowledge answers have no
 * stable grouping key to bucket repeated ratings against.
 *
 * The JOIN to `interactions` (rather than a `meta` subquery) means a row
 * whose `interaction_id` is NULL — e.g. after the rated reply was purged via
 * `forget_me`/`purge_user_data`, which sets `answer_feedback.interaction_id`
 * to NULL on delete (schema.sql) — is excluded: with no interaction left to
 * join, there's nothing to classify as grounded or ungrounded.
 */
export async function countGeneralUnhelpfulAnswers(
  conversationIds: readonly string[],
  days: number,
): Promise<number> {
  if (conversationIds.length === 0) return 0;
  const { rows } = await pool.query(
    `SELECT count(*) AS n
       FROM answer_feedback
       JOIN interactions ON interactions.id = answer_feedback.interaction_id
      WHERE answer_feedback.helpful = false
        AND answer_feedback.conversation_id = ANY($1)
        AND answer_feedback.created_at >= now() - ($2 || ' days')::interval
        AND (interactions.meta->>'knowledgeEntryId') IS NULL`,
    [[...conversationIds], String(days)],
  );
  return Number(rows[0].n);
}

/**
 * Flip a report's status (resolve/dismiss) — non-destructive, no CONFIRM
 * needed (mirrors warn_user's low-blast-radius treatment). Optionally scoped
 * to `conversationIds` so an admin can only resolve reports from
 * conversations they actually participate in (same invariant as `moderate`/
 * `announce`) — broadened by `OR is_dm` for the same reason as `listReports`
 * (a DM report has no conversation an ordinary admin is ever scoped to), with
 * the same accused-admin exclusion: the acting admin (and every identity
 * linked to them via `link_member`, passed as `viewerUserIds`) can never
 * resolve a DM report filed against itself — that stays super-admin-only, so
 * an accused admin can't dismiss a report about themselves, and can't slip
 * past the exclusion by resolving from a linked other-platform identity
 * (issue #197). `resolvedBy` still records the single acting id.
 * `viewerUserIds` defaults to `[resolvedBy]` when omitted. Returns the
 * resolved row's platform/reporterUserId/reason (so the caller can notify the
 * reporter, issue #120 — same "RETURNING" shape as `resolveSuggestion`) or
 * null if no matching row was found (unknown id, or the id exists but is
 * outside the caller's scope) — same "no match" signal the old boolean return
 * gave.
 */
export async function resolveContentReport(
  id: number,
  status: 'resolved' | 'dismissed',
  resolvedBy: string,
  conversationIds?: readonly string[],
  viewerUserIds?: readonly string[],
): Promise<{ platform: Platform; reporterUserId: string; reason: string } | null> {
  const params: unknown[] = [id, status, resolvedBy];
  let scope = '';
  if (conversationIds) {
    params.push([...conversationIds]);
    const convoIdx = params.length;
    params.push([...(viewerUserIds && viewerUserIds.length > 0 ? viewerUserIds : [resolvedBy])]);
    scope = `AND (conversation_id = ANY($${convoIdx}) OR (is_dm AND (target_user_id IS NULL OR target_user_id <> ALL($${params.length}))))`;
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

/**
 * Let a reporter withdraw their OWN still-open report(s). Members had no
 * self-service way to retract a report (e.g. one filed as a joke) — they had
 * to ask an admin, who then dismisses it, which is awkward when the report is
 * *about* an admin. Strictly scoped to the caller's own identity: the
 * `reporter_user_id = $2` predicate means a member can only ever touch reports
 * they themselves filed, never anyone else's. Non-destructive — the row is
 * marked `'withdrawn'` (distinct from an admin-initiated `'dismissed'`) and
 * kept on record for accountability, never deleted. `resolved_by` is set to
 * the reporter's own id (they did it). Returns the withdrawn ids (empty array
 * if the caller had no open reports).
 */
export async function withdrawOwnReports(platform: Platform, reporterUserId: string): Promise<number[]> {
  const { rows } = await pool.query(
    `UPDATE content_reports
        SET status = 'withdrawn', resolved_by = $2, resolved_at = now()
      WHERE platform = $1 AND reporter_user_id = $2 AND status = 'open'
      RETURNING id`,
    [platform, reporterUserId],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Self-scoped read of a member's OWN content reports — mirrors
 * listOwnSuggestions above and reuses withdrawOwnReports's
 * `reporter_user_id = $2` scoping, so a member can only ever see reports they
 * themselves filed, never anyone else's.
 */
export async function listOwnReports(
  platform: Platform,
  reporterUserId: string,
  limit = 10,
): Promise<ContentReport[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
  const { rows } = await pool.query(
    `SELECT id, platform, reporter_user_id, reporter_name, conversation_id, target_user_id,
            message_id, reason, status, created_at, resolved_by, resolved_at
       FROM content_reports
      WHERE platform = $1 AND reporter_user_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [platform, reporterUserId, clampedLimit],
  );
  return rows.map(mapContentReport);
}

// --- Answer feedback (member rating of the bot's own answers, issue #118) ---

/** Per-rater cap on new ratings within a rolling 24h window (DB-backed, same pattern as reports/suggestions). */
export const RATE_ANSWER_DAILY_LIMIT = 20;

export interface AnswerFeedback {
  id: number;
  platform: Platform;
  conversationId: string;
  userId: string;
  interactionId: number | null;
  helpful: boolean;
  createdAt: Date;
  /** The rated answer's text, or `null` when the interaction was since purged. */
  content: string | null;
  /** Knowledge entry id the answer was served from, when sent via the deterministic knowledge shortcut. */
  knowledgeEntryId: number | null;
  /** Optional free-text reason the rater gave alongside the boolean (issue #354), or `null` if none. */
  comment: string | null;
}

function mapAnswerFeedback(r: {
  id: number | string;
  platform: string;
  conversation_id: string;
  user_id: string;
  interaction_id: number | string | null;
  helpful: boolean;
  created_at: Date;
  content: string | null;
  knowledge_entry_id: number | string | null;
  comment: string | null;
}): AnswerFeedback {
  return {
    id: Number(r.id),
    platform: r.platform as Platform,
    conversationId: r.conversation_id,
    userId: r.user_id,
    interactionId: r.interaction_id != null ? Number(r.interaction_id) : null,
    helpful: r.helpful,
    createdAt: r.created_at,
    content: r.content,
    knowledgeEntryId: r.knowledge_entry_id != null ? Number(r.knowledge_entry_id) : null,
    comment: r.comment,
  };
}

/** Max stored length of a `rate_answer` comment (issue #354) — matches the tool's `z.string().max(200)`. */
export const ANSWER_FEEDBACK_COMMENT_MAX_CHARS = 200;

/**
 * Normalize a `rate_answer` comment before it reaches storage: strip C0
 * control characters (including bare `\r`/`\n`, which `untrusted()` also
 * neutralizes at render time — this is defense in depth, not a substitute)
 * and DEL, trim, then cap length. An empty/whitespace-only or omitted
 * comment stores SQL NULL rather than an empty string.
 */
function normalizeAnswerFeedbackComment(comment?: string): string | null {
  if (!comment) return null;
  // eslint-disable-next-line no-control-regex
  const stripped = comment.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!stripped) return null;
  return stripped.slice(0, ANSWER_FEEDBACK_COMMENT_MAX_CHARS);
}

/**
 * Resolve the interaction a `rate_answer` call should bind to. Prefers the
 * caller's OWN most-recent outbound reply in this conversation
 * (`meta->>'replyToUserId' = userId`, stamped by router.ts on every send),
 * falling back to the conversation's most-recent outbound reply only when no
 * caller-scoped match exists (e.g. a row that predates that meta field).
 * Without the caller-scoped preference, a busy multi-member channel could
 * bind member A's "thanks, that helped" to the answer the bot just gave
 * member B — silently corrupting the signal this feature exists to produce.
 */
async function resolveAnswerFeedbackTarget(
  platform: Platform,
  conversationId: string,
  userId: string,
): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT COALESCE(
       (SELECT id FROM interactions
         WHERE platform = $1 AND conversation_id = $2 AND direction = 'outbound'
           AND meta->>'replyToUserId' = $3
         ORDER BY created_at DESC LIMIT 1),
       (SELECT id FROM interactions
         WHERE platform = $1 AND conversation_id = $2 AND direction = 'outbound'
         ORDER BY created_at DESC LIMIT 1)
     ) AS id`,
    [platform, conversationId, userId],
  );
  return rows[0]?.id != null ? Number(rows[0].id) : null;
}

/**
 * Record a member's helpful/unhelpful rating of the bot's most recent answer
 * to them in this conversation. Enforces a DB-backed rolling-24h cap per
 * rater (`RATE_ANSWER_DAILY_LIMIT`), the same restart-proof
 * COUNT(*)-inside-the-insert pattern as createSuggestion/createContentReport
 * (never an in-memory counter). Returns:
 *  - `{ id }` on success
 *  - `'no_recent_answer'` when there is no outbound interaction to bind to
 *    yet (e.g. the member has not been answered in this conversation)
 *  - `'rate_limited'` when the caller is at/over the cap
 */
export async function createAnswerFeedback(input: {
  platform: Platform;
  conversationId: string;
  userId: string;
  helpful: boolean;
  /** Optional free-text reason (issue #354); normalized (control-char-stripped, ≤200 chars) before storage. */
  comment?: string;
}): Promise<{ id: number } | 'no_recent_answer' | 'rate_limited'> {
  const interactionId = await resolveAnswerFeedbackTarget(input.platform, input.conversationId, input.userId);
  if (interactionId === null) return 'no_recent_answer';

  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT count(*) AS n FROM answer_feedback
        WHERE platform = $1 AND user_id = $2
          AND created_at > now() - interval '24 hours'
     )
     INSERT INTO answer_feedback (platform, conversation_id, user_id, interaction_id, helpful, comment)
     SELECT $1, $3, $2, $4, $5, $7
      WHERE (SELECT n FROM recent) < $6
     RETURNING id`,
    [
      input.platform,
      input.userId,
      input.conversationId,
      interactionId,
      input.helpful,
      RATE_ANSWER_DAILY_LIMIT,
      normalizeAnswerFeedbackComment(input.comment),
    ],
  );
  return rows[0] ? { id: Number(rows[0].id) } : 'rate_limited';
}

/**
 * Admin-tier view of answer feedback, scoped to `conversationIds` (null =
 * super admin, unrestricted — same convention as `listReports`). A rating
 * from a conversation no ordinary admin participates in is therefore only
 * reachable here with the unrestricted (super admin) scope.
 */
export async function listAnswerFeedback(
  conversationIds: readonly string[] | null,
  unhelpfulOnly = false,
  limit = 50,
): Promise<AnswerFeedback[]> {
  const params: unknown[] = [];
  const filters: string[] = [];
  if (conversationIds) {
    params.push([...conversationIds]);
    filters.push(`answer_feedback.conversation_id = ANY($${params.length})`);
  }
  if (unhelpfulOnly) {
    filters.push(`answer_feedback.helpful = false`);
  }
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  params.push(clampedLimit);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  // LEFT JOIN interactions to surface the rated answer's text and (when
  // served via the deterministic knowledge shortcut) which knowledge entry
  // produced it (issue #269) — both read through the SAME conversation_id
  // scope filter above, so an admin outside the rated conversation never
  // sees the enrichment either.
  const { rows } = await pool.query(
    `SELECT answer_feedback.id, answer_feedback.platform, answer_feedback.conversation_id,
            answer_feedback.user_id, answer_feedback.interaction_id, answer_feedback.helpful,
            answer_feedback.created_at, answer_feedback.comment, interactions.content,
            (interactions.meta->>'knowledgeEntryId')::bigint AS knowledge_entry_id
       FROM answer_feedback
       LEFT JOIN interactions ON interactions.id = answer_feedback.interaction_id
       ${where}
      ORDER BY answer_feedback.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapAnswerFeedback);
}

export interface KnowledgeFeedbackSummary {
  knowledgeEntryId: number;
  title: string | null;
  helpfulCount: number;
  unhelpfulCount: number;
  updatedAt: Date;
  sampleComment: string | null;
}

function mapKnowledgeFeedbackSummary(r: {
  id: number | string;
  title: string | null;
  updated_at: Date;
  helpful_count: number | string;
  unhelpful_count: number | string;
  sample_comment: string | null;
}): KnowledgeFeedbackSummary {
  return {
    knowledgeEntryId: Number(r.id),
    title: r.title,
    helpfulCount: Number(r.helpful_count),
    unhelpfulCount: Number(r.unhelpful_count),
    updatedAt: r.updated_at,
    sampleComment: r.sample_comment,
  };
}

/**
 * Admin-tier aggregation of `answer_feedback` per knowledge entry (issue
 * #287), the grouped complement to `listAnswerFeedback`'s flat per-row view.
 * Reuses the SAME `answer_feedback` → `interactions` join and
 * `conversation_id = ANY($1)` scope filter (null = super admin, unrestricted)
 * `listAnswerFeedback` already uses, so an admin never counts a rating from a
 * conversation they don't participate in. Ratings on interactions with no
 * `knowledgeEntryId` never join to a `knowledge` row and are therefore never
 * counted. `knowledgeEntryId` is written both by the deterministic knowledge
 * shortcut (exact match) and, since issue #411, best-effort by the normal
 * model-mediated `knowledge_search` path — a correlation with the most
 * recent qualifying hit in the turn, not a guarantee the model's reply
 * actually drew from that entry (see `AgentReply.knowledgeEntryId` in
 * `agent/core.ts`). Only entries with `unhelpfulCount >= minUnhelpful` are
 * returned, sorted by `unhelpfulCount` descending. `sampleComment` (issue
 * #409) is the most recent non-null `comment` (#355) from an *unhelpful*
 * rating on that entry, or null when none exists — comments on helpful
 * ratings are never selected, since they aren't signal for what's wrong with
 * the entry. Drawn from the same scope-filtered rows as the counts above, so
 * a comment from a conversation outside `conversationIds` can never surface.
 *
 * `interactions.created_at >= knowledge.updated_at` (issue #540) excludes
 * ratings on interactions that predate the entry's most recent
 * `update_knowledge` edit, so fixing a flagged entry resets its counts here
 * instead of the pre-edit unhelpful ratings counting against the new
 * content forever.
 */
export async function listKnowledgeFeedbackSummary(
  conversationIds: readonly string[] | null,
  minUnhelpful = 2,
  limit = 20,
): Promise<KnowledgeFeedbackSummary[]> {
  const params: unknown[] = [];
  const filters: string[] = [
    `(interactions.meta->>'knowledgeEntryId') IS NOT NULL`,
    `interactions.created_at >= knowledge.updated_at`,
  ];
  if (conversationIds) {
    params.push([...conversationIds]);
    filters.push(`answer_feedback.conversation_id = ANY($${params.length})`);
  }
  params.push(Math.max(Math.trunc(minUnhelpful) || 2, 1));
  const minUnhelpfulParam = params.length;
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  params.push(clampedLimit);

  const { rows } = await pool.query(
    `SELECT knowledge.id, knowledge.title, knowledge.updated_at,
            count(*) FILTER (WHERE answer_feedback.helpful) AS helpful_count,
            count(*) FILTER (WHERE NOT answer_feedback.helpful) AS unhelpful_count,
            (array_agg(answer_feedback.comment ORDER BY answer_feedback.created_at DESC)
              FILTER (WHERE answer_feedback.comment IS NOT NULL AND NOT answer_feedback.helpful))[1]
              AS sample_comment
       FROM answer_feedback
       JOIN interactions ON interactions.id = answer_feedback.interaction_id
       JOIN knowledge ON knowledge.id = (interactions.meta->>'knowledgeEntryId')::bigint
      WHERE ${filters.join(' AND ')}
      GROUP BY knowledge.id, knowledge.title, knowledge.updated_at
     HAVING count(*) FILTER (WHERE NOT answer_feedback.helpful) >= $${minUnhelpfulParam}
      ORDER BY unhelpful_count DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapKnowledgeFeedbackSummary);
}

/**
 * Entry-scoped low-rated check for the member knowledge-shortcut serve path
 * (issue #337) — the same `answer_feedback` -> `interactions` join
 * `listKnowledgeFeedbackSummary` uses, narrowed to one entry id, but
 * deliberately UNSCOPED by conversation: there is no admin identity to scope
 * to at serve time (the caller is the member being served, not an admin
 * viewing their own conversations).
 *
 * SECURITY: returns only the threshold decision the SQL itself computes
 * (`>= $2`), never the raw unhelpful count or any per-rating row — the
 * caller-side render path must never see a number derived from the
 * aggregate, since `minUnhelpful` is enforced to be >= 2 specifically so no
 * single identifiable rater can be inferred from it (config.ts).
 *
 * `interactions.created_at >= knowledge.updated_at` (issue #540) excludes
 * ratings from before the entry's most recent `update_knowledge` edit, so a
 * fixed entry stops being reported low-rated once its pre-edit ratings are
 * the only ones on record.
 */
export async function isKnowledgeLowRated(entryId: number, minUnhelpful: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE NOT answer_feedback.helpful) >= $2 AS is_low_rated
       FROM answer_feedback
       JOIN interactions ON interactions.id = answer_feedback.interaction_id
       JOIN knowledge ON knowledge.id = (interactions.meta->>'knowledgeEntryId')::bigint
      WHERE (interactions.meta->>'knowledgeEntryId')::bigint = $1
        AND interactions.created_at >= knowledge.updated_at`,
    [entryId, minUnhelpful],
  );
  return rows[0]?.is_low_rated === true;
}

/**
 * Batched sibling of `isKnowledgeLowRated` (issue #432) — the normal
 * `knowledge_search` path checks many hits per call, so this exists to avoid
 * one query per hit; same join and `>= $2` threshold, but `ANY($1)` +
 * `GROUP BY` over a whole id list at once, returning only the subset that
 * crosses the threshold.
 *
 * SECURITY: same aggregate-only posture as `isKnowledgeLowRated` — the
 * returned `Set<number>` carries only which ids cleared the threshold, never
 * a raw unhelpful count or any per-rating row, preserving the "no single
 * identifiable rater can be inferred" property `minUnhelpful`'s `>= 2` floor
 * (config.ts) exists to protect.
 *
 * Short-circuits to an empty set for an empty `entryIds` array without
 * issuing a query — mirrors `hasConflictAmongIds`'s own zero-query
 * short-circuit for a too-small input.
 *
 * `interactions.created_at >= knowledge.updated_at` (issue #540) — same
 * post-edit reset as `isKnowledgeLowRated`.
 */
export async function areKnowledgeEntriesLowRated(
  entryIds: readonly number[],
  minUnhelpful: number,
): Promise<Set<number>> {
  if (entryIds.length === 0) return new Set();
  const { rows } = await pool.query(
    `SELECT knowledge.id
       FROM answer_feedback
       JOIN interactions ON interactions.id = answer_feedback.interaction_id
       JOIN knowledge ON knowledge.id = (interactions.meta->>'knowledgeEntryId')::bigint
      WHERE knowledge.id = ANY($1)
        AND interactions.created_at >= knowledge.updated_at
      GROUP BY knowledge.id
     HAVING count(*) FILTER (WHERE NOT answer_feedback.helpful) >= $2`,
    [entryIds, minUnhelpful],
  );
  return new Set(rows.map((r) => Number(r.id)));
}

/**
 * Count distinct knowledge entries with `unhelpfulCount >= minUnhelpful`
 * (issue #324), for the weekly admin digest — the growth path #287 itself
 * named. Reuses the SAME `answer_feedback` → `interactions` → `knowledge`
 * join, scope filter, and `HAVING` clause as `listKnowledgeFeedbackSummary`,
 * but a true `SELECT count(DISTINCT ...)`, never `.length` of that
 * function's `LIMIT`-bounded list, so a backlog past its default `limit` of
 * 20 is not understated. **Conversation-scoped** like `countKnowledgeGaps`/
 * `countOpenReports` (null = super admin, unrestricted) — an admin never
 * counts a rating from a conversation they don't participate in. Ratings on
 * interactions with no `knowledgeEntryId` never join to a `knowledge` row
 * and are therefore never counted, matching `listKnowledgeFeedbackSummary`'s
 * existing boundary.
 *
 * `interactions.created_at >= knowledge.updated_at` (issue #540) — same
 * post-edit reset as `listKnowledgeFeedbackSummary`, so this count and that
 * list agree after an admin fixes an entry.
 */
export async function countLowRatedKnowledge(
  conversationIds: readonly string[] | null,
  minUnhelpful = 2,
): Promise<number> {
  const params: unknown[] = [];
  const filters: string[] = [
    `(interactions.meta->>'knowledgeEntryId') IS NOT NULL`,
    `interactions.created_at >= knowledge.updated_at`,
  ];
  if (conversationIds) {
    params.push([...conversationIds]);
    filters.push(`answer_feedback.conversation_id = ANY($${params.length})`);
  }
  params.push(Math.max(Math.trunc(minUnhelpful) || 2, 1));
  const minUnhelpfulParam = params.length;

  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM (
       SELECT knowledge.id
         FROM answer_feedback
         JOIN interactions ON interactions.id = answer_feedback.interaction_id
         JOIN knowledge ON knowledge.id = (interactions.meta->>'knowledgeEntryId')::bigint
        WHERE ${filters.join(' AND ')}
        GROUP BY knowledge.id
       HAVING count(*) FILTER (WHERE NOT answer_feedback.helpful) >= $${minUnhelpfulParam}
     ) low_rated`,
    params,
  );
  return Number(rows[0].n);
}

// --- Dev-team completion-DM watches (super-admin dev_team_dispatch) ----------

export interface DevTeamWatchInput {
  jobId: string;
  requesterPlatform: Platform;
  requesterUserId: string;
  mode: string;
  repo: string;
}

export interface DevTeamWatch {
  jobId: string;
  requesterPlatform: Platform;
  requesterUserId: string;
  mode: string;
  repo: string;
}

/**
 * Record a durable watch so the requester gets a completion DM once the
 * dispatched job reaches a terminal state (see the poller in
 * src/backgroundJobs.ts). `ON CONFLICT (job_id) DO NOTHING` makes a repeated
 * dispatch of the same id idempotent rather than an error.
 */
export async function insertDevTeamWatch(input: DevTeamWatchInput): Promise<void> {
  await pool.query(
    `INSERT INTO dev_team_watches (job_id, requester_platform, requester_user_id, mode, repo)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_id) DO NOTHING`,
    [input.jobId, input.requesterPlatform, input.requesterUserId, input.mode, input.repo],
  );
}

/** Watches whose job has not yet had its completion DM sent, oldest first. */
export async function listUnnotifiedDevTeamWatches(): Promise<DevTeamWatch[]> {
  const { rows } = await pool.query(
    `SELECT job_id, requester_platform, requester_user_id, mode, repo
       FROM dev_team_watches
      WHERE notified_at IS NULL
      ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    jobId: r.job_id,
    requesterPlatform: r.requester_platform as Platform,
    requesterUserId: r.requester_user_id,
    mode: r.mode,
    repo: r.repo,
  }));
}

/**
 * Stamp a watch as notified so its completion DM is never sent twice — the
 * poller calls this only AFTER a successful `sendDirectMessage`, so a failed
 * send leaves the row unnotified for the next tick to retry.
 */
export async function markDevTeamWatchNotified(jobId: string): Promise<void> {
  await pool.query(`UPDATE dev_team_watches SET notified_at = now() WHERE job_id = $1`, [jobId]);
}
