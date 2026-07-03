import pgvector from 'pgvector/pg';
import type { Platform, Tier } from '../platforms/types.js';
import { logger } from '../logger.js';
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

export interface StoredSession {
  sessionId: string;
  turnCount: number;
  updatedAt: Date;
}

export async function getClaudeSession(
  platform: Platform,
  conversationId: string,
): Promise<StoredSession | null> {
  const { rows } = await pool.query(
    `SELECT claude_session_id, turn_count, updated_at
       FROM sessions WHERE platform = $1 AND conversation_id = $2`,
    [platform, conversationId],
  );
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

export async function saveKnowledge(input: {
  content: string;
  title?: string;
  scope?: string;
  sourceUserId?: string;
  createdByRole?: Tier;
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

export async function searchKnowledge(
  query: string,
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
      ORDER BY embedding <=> $1
      LIMIT $2`,
    [pgvector.toSql(queryVec), topK],
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

/** Remove a member row entirely. Refuses to remove admins (revoke first). */
export async function removeMember(platform: Platform, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM community_users
      WHERE platform = $1 AND platform_user_id = $2 AND role = 'member'`,
    [platform, userId],
  );
  return (rowCount ?? 0) > 0;
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

/** Agent replies sent to this user in the last `sinceHours` hours. */
export async function countRepliesToUser(
  platform: Platform,
  userId: string,
  sinceHours = 24,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM interactions
      WHERE platform = $1 AND direction = 'outbound'
        AND meta->>'replyToUserId' = $2
        AND created_at > now() - ($3 || ' hours')::interval`,
    [platform, userId, String(sinceHours)],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Delete a user's stored data: their inbound messages, the bot's replies to
 * them, and knowledge entries sourced from them. Backs both the member-facing
 * forget_me and the super-admin purge_user_data. Membership and audit rows
 * are intentionally kept (documented in SECURITY.md).
 */
export async function purgeUserData(platform: Platform, userId: string): Promise<number> {
  const { rowCount: messages } = await pool.query(
    `DELETE FROM interactions
      WHERE platform = $1
        AND (user_id = $2 OR (direction = 'outbound' AND meta->>'replyToUserId' = $2))`,
    [platform, userId],
  );
  const { rowCount: knowledge } = await pool.query(`DELETE FROM knowledge WHERE source_user_id = $1`, [
    userId,
  ]);
  return (messages ?? 0) + (knowledge ?? 0);
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
const MODERATION_ACTION_KINDS = [
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
 */
export async function recentModerationEntries(
  conversationIds: readonly string[] | null,
  limit = 20,
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
  params.push(clampedLimit);

  const { rows } = await pool.query(
    `SELECT created_at, platform, actor_user_id, action_kind, target_user_id, conversation_id, success, result
       FROM admin_audit
      WHERE action_kind = ANY($1)
        ${scope}
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
}> {
  const interval = `${days} days`;
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
  return {
    inbound: Number(totals[0].inbound),
    outbound: Number(totals[0].outbound),
    costUsd: Number(totals[0].cost),
    topUsers: top.map((r) => ({ userId: r.user_id, userName: r.user_name, messages: Number(r.n) })),
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
