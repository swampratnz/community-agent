import pgvector from 'pgvector/pg';
import type { Platform, Tier } from '../platforms/types.js';
import { logger } from '../logger.js';
import { pool } from './db.js';
import { embed } from './embeddings.js';
import { config } from '../config.js';
import { pageKeyOf } from '../context/docsIngest.js';

/**
 * THIS FILE IS BEING SPLIT, ONE DOMAIN AT A TIME (audit 2026-07-28 L14).
 *
 * It was ~7,100 lines — every SQL query in the product in one module — which
 * made it both hard to navigate and the repo's worst merge-conflict hotspot,
 * since nearly every feature PR appends to it. Per-domain modules now live in
 * `./repository/` and are RE-EXPORTED from here, deliberately, so that all ~42
 * import sites and `tests/repository.test.ts` keep working unchanged: callers
 * still `import { … } from '.../repository.js'` and neither know nor care which
 * file a function lives in. That is what lets the split proceed incrementally
 * instead of as one unreviewable big-bang diff.
 *
 * WHEN YOU ADD A QUERY: put it in the matching `./repository/<domain>.ts` (or
 * add a new domain module + `export *` line here, plus its
 * `docs/agents/module-map.md` entry — `npm run context:check` enforces that).
 * Only add to the body of THIS file if its domain has not been extracted yet.
 *
 * The extracted modules are verbatim moves — no behaviour change — and the
 * security invariant is unchanged wherever it applies: admin-facing reads are
 * conversation-scoped IN SQL (`AND conversation_id = ANY($n)`, `null` meaning
 * super-admin/unrestricted), never by the caller. Keep that in the query.
 */
export * from './repository/preferences.js';
export * from './repository/memberNotes.js';
export * from './repository/shared.js';
export * from './repository/devTeamWatches.js';
// `export *` does not bind names into this module's own scope, so anything
// still living here that uses an extracted symbol must import it explicitly.
import { invalidateDigestsForInteractions } from './repository/shared.js';
import { AUTO_ENROLL_ACTOR } from './repository/members.js';
import { sumShortcutHits } from './repository/shortcutHits.js';
export * from './repository/accessRequests.js';
export * from './repository/contextDigests.js';
export * from './repository/memberDiscovery.js';
export * from './repository/docsIngestFailures.js';
export * from './repository/policies.js';
export * from './repository/roster.js';
export * from './repository/adminAudit.js';
export * from './repository/shortcutHits.js';
export * from './repository/digestAlerts.js';
export * from './repository/moderation.js';
export * from './repository/memberProjects.js';
export * from './repository/members.js';
export * from './repository/knowledge.js';
export * from './repository/knowledgeCandidates.js';
export * from './repository/suggestions.js';
export * from './repository/budgetsPrivacy.js';

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
  'block_user',
  'unblock_user',
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
  // Exclude the auto-enroll sentinel (issue #606 review): this rollup exists to
  // rank HUMAN moderation/curation work by volume, but with
  // DISCORD_AUTO_ENROLL_MEMBERS on, every join writes a system-actor audit row.
  // On an active server that actor would dominate the top of the report and
  // bury real admin activity — the opposite of what the tool is for. The rows
  // stay in admin_audit (still visible via audit_view); they're only kept out
  // of this ranking.
  const { rows } = await pool.query(
    `SELECT platform, actor_user_id,
            count(*) AS action_count,
            count(*) FILTER (WHERE success) AS success_count,
            count(*) FILTER (WHERE NOT success) AS failure_count,
            max(created_at) AS last_action_at
       FROM admin_audit
      WHERE created_at >= now() - $1::interval
        AND actor_user_id <> $2
      GROUP BY platform, actor_user_id
      ORDER BY count(*) DESC`,
    [`${clampedDays} days`, AUTO_ENROLL_ACTOR],
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

export async function usageStats(
  days = 7,
  platform?: Platform,
): Promise<{
  inbound: number;
  outbound: number;
  costUsd: number;
  byPlatform: Array<{ platform: Platform; inbound: number; outbound: number; costUsd: number }>;
  topUsers: Array<{ userId: string; userName: string | null; messages: number }>;
  costByRole: Array<{ role: Tier; costUsd: number; replies: number }>;
  backgroundCostUsd: number;
  shortcutHits: { total: number; byKind: Array<{ kind: string; count: number }> };
  backgroundCostByJob: Array<{ job: string; costUsd: number }>;
  cacheUsage: { readTokens: number; creationTokens: number };
  autoAnswerUsage: { count: number; costUsd: number };
  costByModel: Array<{ model: string; costUsd: number; replies: number }>;
}> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 365);
  const interval = `${clampedDays} days`;
  // Optional platform scoping (issue #647), mirroring `engagementStats`'s
  // dynamic-placeholder pattern: only `totals`/`top`/`byRole` — the three
  // fields named by #580's growth path — take the filter. `byPlatform` and
  // the background/cache/shortcut/auto-answer aggregates below stay
  // global-only by design (they aren't platform-attributed, or scoping them
  // is out of scope per the approved proposal).
  const scopeParams: unknown[] = [interval];
  let scopeFilter = '';
  if (platform) {
    scopeParams.push(platform);
    scopeFilter = ` AND platform = $${scopeParams.length}`;
  }
  const { rows: totals } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE direction = 'inbound') AS inbound,
       count(*) FILTER (WHERE direction = 'outbound') AS outbound,
       coalesce(sum(cost_usd), 0) AS cost
     FROM interactions WHERE created_at > now() - $1::interval${scopeFilter}`,
    scopeParams,
  );
  // Per-platform split of the same `totals` query above (issue #580) — same
  // table/window/direction semantics, differing only by `GROUP BY platform`,
  // so summed rows equal `totals` by construction. Ordered by volume desc
  // (then platform name) so the tool's output line is deterministic. Always
  // computed unfiltered — `formatUsageStats` omits rendering it when a
  // `platform` filter is active (issue #647), since a single-platform view
  // makes the breakdown line redundant.
  const { rows: byPlatform } = await pool.query(
    `SELECT platform,
       count(*) FILTER (WHERE direction = 'inbound') AS inbound,
       count(*) FILTER (WHERE direction = 'outbound') AS outbound,
       coalesce(sum(cost_usd), 0) AS cost
     FROM interactions WHERE created_at > now() - $1::interval
     GROUP BY platform
     ORDER BY count(*) DESC, platform`,
    [interval],
  );
  const { rows: top } = await pool.query(
    `SELECT user_id, max(user_name) AS user_name, count(*) AS n
       FROM interactions
      WHERE direction = 'inbound' AND created_at > now() - $1::interval${scopeFilter}
      GROUP BY user_id ORDER BY n DESC LIMIT 5`,
    scopeParams,
  );
  const { rows: byRole } = await pool.query(
    `SELECT role, coalesce(sum(cost_usd), 0) AS cost, count(*) AS n
       FROM interactions
      WHERE direction = 'outbound' AND created_at > now() - $1::interval${scopeFilter}
      GROUP BY role ORDER BY sum(cost_usd) DESC, role`,
    scopeParams,
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
  // Per-model cost telemetry (issue #792): sums the `meta->'modelUsage'`
  // JSONB object `core.ts`/`router.ts` write per outbound row, keyed by
  // canonical model id. `jsonb_each_text` is a strict set-returning
  // function, so a row with no `modelUsage` key (meta->'modelUsage' is SQL
  // NULL) contributes zero expanded rows rather than needing an explicit
  // `meta ? 'modelUsage'` filter — same table/window/direction filter as the
  // cache/auto-answer aggregates above, one more LATERAL aggregate over it.
  const { rows: costByModelRows } = await pool.query(
    `SELECT mu.key AS model, coalesce(sum(mu.value::numeric), 0) AS cost, count(*) AS n
     FROM interactions
     CROSS JOIN LATERAL jsonb_each_text(meta->'modelUsage') AS mu(key, value)
     WHERE direction = 'outbound' AND created_at > now() - $1::interval
     GROUP BY mu.key
     ORDER BY cost DESC, mu.key`,
    [interval],
  );
  const background = await sumBackgroundJobCosts(clampedDays);
  const shortcuts = await sumShortcutHits(clampedDays);
  return {
    inbound: Number(totals[0].inbound),
    outbound: Number(totals[0].outbound),
    costUsd: Number(totals[0].cost),
    byPlatform: byPlatform.map((r) => ({
      platform: r.platform as Platform,
      inbound: Number(r.inbound),
      outbound: Number(r.outbound),
      costUsd: Number(r.cost),
    })),
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
    costByModel: costByModelRows.map((r) => ({
      model: r.model as string,
      costUsd: Number(r.cost),
      replies: Number(r.n),
    })),
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

export interface CrossedKnowledgeGapCluster extends KnowledgeGapCluster {
  /** ids of every row in the crossed cluster, for `markKnowledgeGapsAlerted`. */
  rowIds: number[];
}

/**
 * Real-time counterpart to `recentKnowledgeGapClusters` above (issue #650):
 * identical greedy embedding-similarity clustering, scoped to `newGapId`'s
 * own conversation, but restricted to `alerted_at IS NULL` rows so a cluster
 * already promoted to an alert (its rows stamped by `markKnowledgeGapsAlerted`)
 * can't re-trigger on a later gap — only fresh, not-yet-alerted rows count
 * toward a new crossing. Called synchronously right after `recordKnowledgeGap`'s
 * insert, scoped to that one gap's own conversation (never guild-wide),
 * matching `recentKnowledgeGapClusters`'s own scoping convention.
 *
 * Returns the crossed cluster's `representative`/`count` (same shape as
 * `recentKnowledgeGapClusters`) plus every member row's `id`, so the caller
 * can stamp them all alerted in one `markKnowledgeGapsAlerted` call.
 * `recentKnowledgeGapClusters` itself is left untouched — still backs
 * `list_knowledge_gaps`, never returns row ids, since exposing ids there
 * would be unused surface for that read-only listing path.
 *
 * Returns null when `newGapId`'s own cluster (identified by embedding
 * similarity) hasn't yet reached `threshold` unalerted rows, or when the new
 * row has no embedding (an `embed()` failure at insert time — no signal to
 * cluster on) or isn't found among the unresolved/unalerted rows (already
 * resolved or alerted by a race with another turn).
 */
export async function findCrossedKnowledgeGapCluster(
  conversationId: string,
  newGapId: number,
  threshold: number,
  days = 7,
): Promise<CrossedKnowledgeGapCluster | null> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 30);

  const { rows } = await pool.query(
    `SELECT id, query_text, embedding
       FROM knowledge_gaps
      WHERE conversation_id = $1
        AND resolved_at IS NULL
        AND alerted_at IS NULL
        AND embedding IS NOT NULL
        AND created_at > now() - $2::interval
      ORDER BY created_at ASC`,
    [conversationId, `${clampedDays} days`],
  );

  const clusters: Array<{ representative: string; embedding: number[]; count: number; ids: number[] }> = [];
  for (const row of rows) {
    const vec = row.embedding as number[] | null;
    if (!vec) continue;
    const match = clusters.find((c) => cosineSim(c.embedding, vec) >= QUESTION_CLUSTER_SIMILARITY_THRESHOLD);
    if (match) {
      match.count += 1;
      match.ids.push(Number(row.id));
    } else {
      clusters.push({ representative: row.query_text, embedding: vec, count: 1, ids: [Number(row.id)] });
    }
  }

  const crossed = clusters.find((c) => c.ids.includes(newGapId) && c.count >= threshold);
  if (!crossed) return null;
  return { representative: crossed.representative, count: crossed.count, rowIds: crossed.ids };
}

/**
 * Stamps `alerted_at = now()` on every row of a just-crossed cluster (issue
 * #650), returned by `findCrossedKnowledgeGapCluster` — single-shot per
 * cluster: that function's `alerted_at IS NULL` filter means none of these
 * rows can contribute to a future crossing again. Called unconditionally once
 * the caller has reserved a real-time-alert rate-limit slot, regardless of
 * whether the subsequent admin DM itself succeeds — same "the slot is
 * consumed the moment we decide to alert" precedent as
 * `reserveEscalationSlot`/`reserveAccessRequestAlertSlot`.
 */
export async function markKnowledgeGapsAlerted(ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(`UPDATE knowledge_gaps SET alerted_at = now() WHERE id = ANY($1)`, [[...ids]]);
}

/**
 * Real-time stale-knowledge admin nudge (issue #701): atomically checks the
 * re-arm gate — `stale_alerted_at IS NULL OR stale_alerted_at < updated_at` —
 * and, if it passes, stamps `stale_alerted_at = now()` in the SAME statement,
 * so two concurrent calls for the same row (e.g. two knowledge_search hits in
 * one turn) can't both pass the gate. Returns the row's `title`/`content`/
 * `updatedAt` (enough for the caller to build the DM body via
 * `formatRelativeAge`/`truncateForEcho`) only when the stamp happened; `null`
 * when the row was already alerted since its last edit — an admin edit via
 * `update_knowledge`/`accept_knowledge_candidate` bumps `updated_at` (the
 * `knowledge_set_updated_at` trigger) and so re-arms the gate automatically,
 * no separate reset needed.
 *
 * Called unconditionally by the caller whenever a served hit is stale,
 * REGARDLESS of whether the guild-wide rate limit has a free slot — the
 * opposite of `markKnowledgeGapsAlerted`'s "only stamp once the alert is
 * actually reserved" precedent. This must always stamp so a rate-limited
 * entry doesn't retry-storm on every subsequent serve for as long as it stays
 * stale (acceptance criterion 5c); the rate limit only ever gates the
 * `notifyAdmins` call itself, never this stamp.
 */
export async function markStaleKnowledgeAlerted(
  id: number,
): Promise<{ title: string | null; content: string; updatedAt: Date } | null> {
  const { rows } = await pool.query(
    `UPDATE knowledge
        SET stale_alerted_at = now()
      WHERE id = $1
        AND (stale_alerted_at IS NULL OR stale_alerted_at < updated_at)
      RETURNING title, content, updated_at`,
    [id],
  );
  if (rows.length === 0) return null;
  return { title: rows[0].title, content: rows[0].content, updatedAt: rows[0].updated_at };
}

// --- Member-facing weekly digest freshness guard (issue #645) --------------

/**
 * True if the single-row, guild-wide `member_digest_sends` guard was
 * stamped within the last `days` — the restart-safe check `src/memberDigest.ts`
 * uses so a redeploy mid-week can't double-post, mirroring
 * `wasEngagementAlertSentRecently`'s shape exactly (no identity to key on;
 * one post to one configured channel).
 */
export async function wasMemberDigestSentRecently(days: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM member_digest_sends
      WHERE id = 1 AND sent_at > now() - ($1 || ' days')::interval`,
    [days],
  );
  return rows.length > 0;
}

/** Record that the weekly member digest was just posted. Always the same `id = 1` row, so this is an upsert. */
export async function recordMemberDigestSent(): Promise<void> {
  await pool.query(
    `INSERT INTO member_digest_sends (id, sent_at) VALUES (1, now())
     ON CONFLICT (id) DO UPDATE SET sent_at = now()`,
  );
}

/**
 * Titles of curated (non-`auto`-provenance) knowledge entries created since
 * `since` — the "new in the knowledge base" line of the weekly member
 * digest. Reuses `listKnowledgeTopics`'s exact `created_by_role != 'auto'`
 * apparent-authority boundary (issue #214) so an unreviewed, machine-
 * researched entry can never appear in a member-facing surface either —
 * only an admin-accepted `save_knowledge`/`accept_knowledge_candidate`/
 * `update_knowledge` entry, or a trusted `'docs'` backfill, ever qualifies.
 *
 * `scope = 'global'` ONLY (PR #651 review) — this is a single public,
 * guild-wide Discord post with no caller conversation to scope by, so
 * unlike `listKnowledgeTopics`'s `scope IN ('global', $platform,
 * $conversationId)` there is no caller-specific scope to widen into. An
 * admin who scoped a curated entry to a specific channel or a WhatsApp-only
 * conversation to keep it out of general circulation must never have its
 * title broadcast here — the same reasoning the gated-guest knowledge
 * shortcut's `scopeRestriction: 'global-only'` (issue #165) already applies
 * when there's no meaningful caller scope. Null and blank titles are
 * excluded, same as `listKnowledgeTopics`.
 */
export async function listCuratedKnowledgeCreatedSince(since: Date, limit: number): Promise<string[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
  const { rows } = await pool.query<{ title: string }>(
    `SELECT title FROM knowledge
      WHERE created_at > $1
        AND created_by_role != 'auto'
        AND scope = 'global'
        AND title IS NOT NULL
        AND trim(title) != ''
      ORDER BY created_at ASC
      LIMIT $2`,
    [since, clampedLimit],
  );
  return rows.map((r) => r.title);
}

/**
 * Release/deprecation watcher (issue #733): docsIngest already fetches,
 * diffs, and stores Anthropic's release-notes/model-deprecation pages
 * weekly under `created_by_role = 'docs'`, but discards the "which page
 * changed" signal after the run. This surfaces it for the member digest
 * without a new fetch, source, or provenance value — purely a read over
 * rows docsIngest already wrote.
 *
 * Filters on `updated_at` (not `created_at` like `listCuratedKnowledgeCreatedSince`
 * above) so an EXISTING page edited in place — docsIngest's `updated` outcome,
 * e.g. `release-notes/overview` gaining a new entry — is caught, not just
 * brand-new pages.
 *
 * `created_by_role != 'auto'` reuses the exact same quarantine-exclusion
 * filter as `listCuratedKnowledgeCreatedSince` above (never `= 'docs'`
 * specifically) so a future auto-refresh path can never reach this surface
 * even via a colliding title — the quarantine boundary, not a narrower
 * docs-only allowlist, is what's load-bearing here.
 *
 * `pathPrefixes` are matched against the same `docs: <path>` title prefix
 * `docsIngest.ts`'s `titleForUrl` already produces (config-fixed values,
 * never chat/user-derived — same trust level `docsIngest`'s own
 * `excludePaths` already has). One page can produce several changed chunks
 * in a week (e.g. `release-notes/overview › section`); grouping by
 * `pageKeyOf` (docsIngest's own page-grouping helper, reused verbatim so the
 * two stay in lockstep) reports each page once, keeping its most-recently
 * updated chunk's `source_url`.
 */
export async function listReleaseWatchUpdatesSince(
  since: Date,
  pathPrefixes: readonly string[],
  limit: number,
): Promise<Array<{ pageTitle: string; sourceUrl: string | null }>> {
  if (pathPrefixes.length === 0) return [];
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
  const likePatterns = pathPrefixes.map((p) => `docs: ${p}%`);
  const { rows } = await pool.query<{ title: string; source_url: string | null }>(
    `SELECT title, source_url FROM knowledge
      WHERE updated_at > $1
        AND created_by_role != 'auto'
        AND scope = 'global'
        AND title IS NOT NULL
        AND trim(title) != ''
        AND title LIKE ANY($2)
      ORDER BY updated_at DESC`,
    [since, likePatterns],
  );
  const byPage = new Map<string, { pageTitle: string; sourceUrl: string | null }>();
  for (const row of rows) {
    const page = pageKeyOf(row.title);
    if (!byPage.has(page)) byPage.set(page, { pageTitle: page, sourceUrl: row.source_url });
  }
  return [...byPage.values()].slice(0, clampedLimit);
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

export interface AnswerFeedbackWeeklySummary {
  helpful: number;
  total: number;
}

/**
 * Overall this-week helpful-rate across EVERY rated answer (issue #653) —
 * VISION's own named answer-quality north star, currently invisible: neither
 * `countGeneralUnhelpfulAnswers` (#563, ungrounded-only unhelpful COUNT) nor
 * `answerFeedbackOriginSummary` (#592, cumulative origin split) answers "what
 * fraction of all rated answers this week were helpful?" — a knowledge-
 * grounded answer rated unhelpful lands in neither one's numerator or
 * denominator. This read is deliberately **unfiltered** by
 * `knowledgeEntryId`/origin/`autoAnswer` — every rated answer this week,
 * counted once — the distinct, all-answer-types denominator neither sibling
 * signal covers.
 *
 * Same rolling-window, conversation-scoped, true-`COUNT(*)` shape as
 * `countGeneralUnhelpfulAnswers`/`countMaxTurnsFailures`, including the same
 * JOIN-to-`interactions` exclusion of a purged rating (`interaction_id` set
 * NULL by `forget_me`/`purge_user_data`) and the same empty-`conversationIds`
 * early return (zero-counts, no query issued).
 */
export async function answerFeedbackWeeklySummary(
  conversationIds: readonly string[],
  days: number,
): Promise<AnswerFeedbackWeeklySummary> {
  if (conversationIds.length === 0) return { helpful: 0, total: 0 };
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE answer_feedback.helpful) AS helpful,
       count(*) AS total
       FROM answer_feedback
       JOIN interactions ON interactions.id = answer_feedback.interaction_id
      WHERE answer_feedback.conversation_id = ANY($1)
        AND answer_feedback.created_at >= now() - ($2 || ' days')::interval`,
    [[...conversationIds], String(days)],
  );
  return { helpful: Number(rows[0].helpful), total: Number(rows[0].total) };
}

export interface UnhelpfulFeedbackCluster {
  representative: string;
  count: number;
}

/**
 * Greedily cluster recent unhelpful `answer_feedback` comments by embedding
 * similarity — the second, still-missing half of VISION's answer-quality
 * north star ("thumbs-down themes shrinking in the digests", issue #724).
 * Mirrors `recentQuestionClusters`/`recentKnowledgeGapClusters` exactly (same
 * greedy clustering code, same `QUESTION_CLUSTER_SIMILARITY_THRESHOLD`, same
 * `count >= 2` theme floor, same conversation-scoping convention — null =
 * super admin, unrestricted), but sourced from `answer_feedback` instead of
 * `interactions`/`knowledge_gaps`.
 *
 * Deliberately NOT filtered by `knowledgeEntryId` — both grounded and
 * ungrounded unhelpful answers are included, closing the exact gap
 * `listKnowledgeFeedbackSummary` (grounded-only) and
 * `countGeneralUnhelpfulAnswers` (ungrounded-only, no comment text) each
 * leave open on their own.
 *
 * `answer_feedback` has no persisted `embedding` column (issue #706's
 * call-time-embed precedent, not a schema change): each qualifying comment is
 * embedded here, at read time, via the same local/offline `embed()`. Volume
 * is already double-bounded by `RATE_ANSWER_DAILY_LIMIT` and the
 * `helpful = false AND comment IS NOT NULL` filter, so this is realistically
 * a handful of rows per admin scope per digest window — never a bulk
 * backfill. A row whose `embed()` call fails is skipped (logged, not
 * thrown) exactly like `recordKnowledgeGap`'s embed-failure handling, so a
 * transient embedding-model outage degrades to fewer clusters, never a
 * crash.
 */
export async function recentUnhelpfulFeedbackClusters(
  conversationIds: readonly string[] | null,
  days = 7,
  limit = 10,
): Promise<UnhelpfulFeedbackCluster[]> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 30);
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);

  const params: unknown[] = [`${clampedDays} days`];
  let scope = '';
  if (conversationIds) {
    params.push([...conversationIds]);
    scope = `AND conversation_id = ANY($${params.length})`;
  }

  const { rows } = await pool.query(
    `SELECT comment
       FROM answer_feedback
      WHERE helpful = false
        AND comment IS NOT NULL
        AND created_at > now() - $1::interval
        ${scope}
      ORDER BY created_at ASC`,
    params,
  );

  const clusters: Array<{ representative: string; embedding: number[]; count: number }> = [];
  for (const row of rows) {
    const comment = row.comment as string;
    let vec: number[] | null = null;
    try {
      vec = await embed(comment);
    } catch (err) {
      logger.warn({ err }, 'Embedding failed for unhelpful-feedback clustering');
    }
    if (!vec) continue;
    const match = clusters.find((c) => cosineSim(c.embedding, vec) >= QUESTION_CLUSTER_SIMILARITY_THRESHOLD);
    if (match) {
      match.count += 1;
    } else {
      clusters.push({ representative: comment, embedding: vec, count: 1 });
    }
  }

  return clusters
    .filter((c) => c.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, clampedLimit)
    .map((c) => ({ representative: c.representative, count: c.count }));
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
 * (never an in-memory counter). A second rating from the same rater on the
 * same interaction (no new bot reply in between) is not a second vote: the
 * `ON CONFLICT` on `answer_feedback_interaction_rater_idx` (issue #619)
 * updates the existing row's helpful/comment/created_at in place instead of
 * inserting a duplicate — preserving "member changed their mind" while
 * keeping every downstream count (usage_stats, the weekly digest, and the
 * >= 2-rater low-rated-caveat floor) to at most one vote per (rater,
 * answer). The `WHERE interaction_id IS NOT NULL` predicate on the conflict
 * target must match the partial index exactly, or Postgres can't infer it.
 * Returns:
 *  - `{ id }` on success (insert OR update-in-place)
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
}): Promise<{ id: number; interactionId: number } | 'no_recent_answer' | 'rate_limited'> {
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
     ON CONFLICT (interaction_id, user_id) WHERE interaction_id IS NOT NULL
     DO UPDATE SET helpful = EXCLUDED.helpful, comment = EXCLUDED.comment, created_at = now()
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
  return rows[0] ? { id: Number(rows[0].id), interactionId } : 'rate_limited';
}

/**
 * Grounding lookup for the answered-question -> knowledge-base loop (issue
 * #726): given the `interactions.id` of a rated OUTBOUND reply, recovers
 * whether it was knowledge-grounded and, when not, the preceding question it
 * answered. Two reads, no new index: the outbound row's own `content`/
 * `meta->>'knowledgeEntryId'`/`meta->>'replyToUserId'` (the caller `rate_answer`
 * itself bound to via `resolveAnswerFeedbackTarget` above), then — only when a
 * `replyToUserId` exists — the most recent INBOUND row from that SAME member
 * in the SAME conversation at or before the reply's `created_at`, served by
 * `interactions_user_idx (platform, user_id, created_at DESC)`.
 *
 * `questionUserId` deliberately names the addressed member (`replyToUserId`),
 * NOT the `rate_answer` caller — `resolveAnswerFeedbackTarget` can bind a
 * rating to a reply addressed to someone else (the "rater observed, didn't
 * ask" case), so attribution must track the row this returns, never the
 * caller blindly (SECURITY, issue #726 AC10). Returns `null` when
 * `interactionId` doesn't name an outbound row at all; `questionContent`/
 * `questionUserId` are independently `null` (fail closed for the caller) when
 * there is no `replyToUserId` or no qualifying preceding inbound row.
 */
export async function answerFeedbackGrounding(interactionId: number): Promise<{
  knowledgeEntryId: number | null;
  answerContent: string;
  questionContent: string | null;
  questionUserId: string | null;
} | null> {
  const { rows: outboundRows } = await pool.query(
    `SELECT platform, conversation_id, content, created_at,
            (meta->>'knowledgeEntryId')::bigint AS knowledge_entry_id,
            meta->>'replyToUserId' AS reply_to_user_id
       FROM interactions
      WHERE id = $1 AND direction = 'outbound'`,
    [interactionId],
  );
  const outbound = outboundRows[0];
  if (!outbound) return null;

  let questionContent: string | null = null;
  let questionUserId: string | null = null;
  if (outbound.reply_to_user_id) {
    const { rows: inboundRows } = await pool.query(
      `SELECT content, user_id FROM interactions
        WHERE platform = $1 AND conversation_id = $2 AND direction = 'inbound'
          AND user_id = $3 AND created_at <= $4
        ORDER BY created_at DESC LIMIT 1`,
      [outbound.platform, outbound.conversation_id, outbound.reply_to_user_id, outbound.created_at],
    );
    if (inboundRows[0]) {
      questionContent = inboundRows[0].content;
      questionUserId = inboundRows[0].user_id;
    }
  }

  return {
    knowledgeEntryId: outbound.knowledge_entry_id != null ? Number(outbound.knowledge_entry_id) : null,
    answerContent: outbound.content,
    questionContent,
    questionUserId,
  };
}

/**
 * SECURITY (issue #726 follow-up): rater-scoped counterpart to
 * `createKnowledgeTip`'s per-question-author cap. That cap alone bounds how
 * many candidates a single VICTIM's quota can absorb, but not how many
 * DIFFERENT victims one rater can draft against — `resolveAnswerFeedbackTarget`
 * can bind a rating to a reply addressed to someone else (the "rater
 * observed, didn't ask" fallback, see `answerFeedbackGrounding` above and its
 * AC10 test), and `rate_answer`'s own daily cap (`RATE_ANSWER_DAILY_LIMIT`,
 * 20/day) is far looser than any one victim's 3/day quota. Without this, a
 * rater who has never personally been answered could silently drain several
 * other members' entire daily `suggest_knowledge` quota in one busy channel.
 *
 * Counts this rater's OWN `helpful: true` `answer_feedback` rows in the last
 * 24h whose bound interaction was addressed to someone else — i.e., every
 * attempt (successful or not) at the mismatched-attribution drafting path.
 * A matched self-rating (rater === addressed member) is deliberately
 * excluded: that case is already bounded by `createKnowledgeTip`'s own
 * per-source-user cap, same as a member's own `suggest_knowledge` calls.
 * Backed by the existing `answer_feedback_user_rate_idx (platform, user_id,
 * created_at DESC)`; the join to `interactions` is on its primary key and
 * scans at most `RATE_ANSWER_DAILY_LIMIT` rows.
 */
export async function countMismatchedHelpfulRatings(
  platform: Platform,
  raterUserId: string,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM answer_feedback af
       JOIN interactions i ON i.id = af.interaction_id
      WHERE af.platform = $1 AND af.user_id = $2 AND af.helpful = true
        AND af.created_at > now() - interval '24 hours'
        AND i.meta->>'replyToUserId' IS NOT NULL
        AND i.meta->>'replyToUserId' <> $2`,
    [platform, raterUserId],
  );
  return rows[0]?.n ?? 0;
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

export interface AnswerFeedbackOriginSummary {
  autoAnswer: { helpful: number; unhelpful: number };
  addressed: { helpful: number; unhelpful: number };
}

/**
 * Guild-wide (by `conversationIds` scope) split of `answer_feedback` ratings
 * by delivery origin — auto-answered (issue #477, unsummoned) vs addressed
 * (@mention/DM/thread-reply) — the answer-**quality** counterpart to
 * `usageStats`'s `autoAnswerUsage` **cost** split (issue #552), which reads
 * the SAME `meta.autoAnswer` flag from the opposite side (a plain SUM/COUNT
 * over `interactions` alone, vs this one joining through `answer_feedback`).
 * Reuses the identical `answer_feedback JOIN interactions` join and
 * `count(*) FILTER (WHERE ...)` aggregate shape `listKnowledgeFeedbackSummary`/
 * `countLowRatedKnowledge` already use — no schema change, no migration.
 *
 * Cumulative (no freshness window), matching `countLowRatedKnowledge`'s own
 * cumulative-backlog shape rather than a rolling-window count — a helpful
 * ratio is more meaningful over the whole history than reset weekly against a
 * handful of ratings.
 *
 * `conversationIds` scoping mirrors every other admin-tier aggregate here
 * (`listAnswerFeedback`/`listKnowledgeFeedbackSummary`/`countLowRatedKnowledge`):
 * `null` means unrestricted (super admin); otherwise only ratings whose
 * `answer_feedback.conversation_id` is in the given list are counted, so an
 * admin never counts a rating from a conversation they don't participate in.
 *
 * SECURITY: bucketing is driven SOLELY by `interactions.meta->>'autoAnswer'`
 * — router-internal state set only from `replyConversationId !== undefined`
 * (issue #552/#553), never from message content — so a rated reply whose
 * text happens to resemble the flag can never move it between buckets. A
 * rating whose `interaction_id` was cleared (`ON DELETE SET NULL`, e.g. after
 * `forget_me`/`purge_user_data`) has no interaction row left to join against
 * and is excluded from BOTH buckets, matching `listKnowledgeFeedbackSummary`'s
 * own INNER JOIN exclusion of a purged interaction.
 */
export async function answerFeedbackOriginSummary(
  conversationIds: readonly string[] | null,
): Promise<AnswerFeedbackOriginSummary> {
  const params: unknown[] = [];
  const filters: string[] = [];
  if (conversationIds) {
    params.push([...conversationIds]);
    filters.push(`answer_feedback.conversation_id = ANY($${params.length})`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE (interactions.meta->>'autoAnswer') IS NOT NULL AND answer_feedback.helpful)
         AS auto_helpful,
       count(*) FILTER (WHERE (interactions.meta->>'autoAnswer') IS NOT NULL AND NOT answer_feedback.helpful)
         AS auto_unhelpful,
       count(*) FILTER (WHERE (interactions.meta->>'autoAnswer') IS NULL AND answer_feedback.helpful)
         AS addressed_helpful,
       count(*) FILTER (WHERE (interactions.meta->>'autoAnswer') IS NULL AND NOT answer_feedback.helpful)
         AS addressed_unhelpful
       FROM answer_feedback
       JOIN interactions ON interactions.id = answer_feedback.interaction_id
       ${where}`,
    params,
  );
  const r = rows[0];
  return {
    autoAnswer: { helpful: Number(r.auto_helpful), unhelpful: Number(r.auto_unhelpful) },
    addressed: { helpful: Number(r.addressed_helpful), unhelpful: Number(r.addressed_unhelpful) },
  };
}
