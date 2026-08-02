import pgvector from 'pgvector/pg';
import type { Platform } from '../../platforms/types.js';
import { logger } from '../../logger.js';
import { pool } from '../db.js';
import { embed } from '../embeddings.js';
import { QUESTION_CLUSTER_SIMILARITY_THRESHOLD, cosineSim } from './shared.js';
import { registerPurgeContributor } from '../lifecycle.js';

/**
 * Knowledge gaps (#208): questions whose knowledge_search fell below the
 * relevance floor, their clustering, and escalation state.
 *
 * 🔒 Carries conversation-scoped admin reads; the `conversationIds` filter and
 * its `= ANY($n)` SQL moved verbatim.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

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

// --- Lifecycle registration (storage/lifecycle.ts) ---------------------------

registerPurgeContributor({
  name: 'knowledge_gaps',
  order: 110,
  async purge({ platform, userId }, tx) {
    // knowledge_gaps (issue #208) is keyed the same way — purge coherence for
    // anyone whose below-floor searches were logged.
    const { rowCount: knowledgeGaps } = await tx.query(
      `DELETE FROM knowledge_gaps WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    return knowledgeGaps ?? 0;
  },
});
