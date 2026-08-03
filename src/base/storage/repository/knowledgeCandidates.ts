import pgvector from 'pgvector/pg';
import type { Platform } from '../../platforms/types.js';
import { logger } from '../../logger.js';
import { pool } from '../db.js';
import { embed } from '../embeddings.js';
import { KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD } from './shared.js';
import {
  KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD,
  saveKnowledge,
  type KnowledgeDuplicateMatch,
} from './knowledge.js';
import { registerPurgeContributor } from '../lifecycle.js';

/**
 * The knowledge_candidates queue (#102): machine- and member-drafted entries
 * awaiting admin review, their dedup guards, and promotion into the knowledge
 * base proper.
 *
 * Imports `saveKnowledge` from ./knowledge.js — a domain-to-domain import, not a
 * cycle: knowledge.ts calls nothing here. Accepting a candidate is literally a
 * knowledge write, so this direction is the honest one.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Knowledge candidates (issue #102, the knowledge_candidates half of #51
// its adversarial review deferred) --------------------------------------------

export type KnowledgeCandidateStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn';

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
  /** Provenance (issue #633): non-null together for a member's own suggest_knowledge submission, null/null for a machine-drafted (context-builder) row. */
  sourcePlatform: Platform | null;
  sourceUserId: string | null;
  /**
   * The linked `knowledge` entry's `retrieval_count` (issue #880) — only ever
   * non-null when the caller's query joins it in (see
   * `listOwnKnowledgeCandidates`); every other reader of this row leaves it
   * `null`, not "0 uses", so the two can never be confused.
   */
  retrievalCount: number | null;
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
  source_platform?: string | null;
  source_user_id?: string | null;
  retrieval_count?: number | string | null;
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
    sourcePlatform: (r.source_platform as Platform | null) ?? null,
    sourceUserId: r.source_user_id ?? null,
    retrievalCount:
      r.retrieval_count === null || r.retrieval_count === undefined ? null : Number(r.retrieval_count),
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

/** Per-member cap on new suggest_knowledge tips within a rolling 24h window — same shape/purpose as SUGGESTION_RATE_LIMIT_PER_DAY. */
export const KNOWLEDGE_TIP_RATE_LIMIT_PER_DAY = 3;
/** Mirrors the drafted-candidate title truncation in context/builder.ts's summarizeCluster. */
export const KNOWLEDGE_TIP_TITLE_MAX_CHARS = 120;
/** Mirrors SUGGESTION_MAX_CHARS / the drafted-candidate content truncation in summarizeCluster. */
export const KNOWLEDGE_TIP_CONTENT_MAX_CHARS = 1000;

/**
 * Record a member's own knowledge tip via `suggest_knowledge` (issue #633):
 * always `digest_id NULL` (there is no context_digests row underneath a
 * member's deliberate contribution, unlike a builder-drafted candidate) and
 * always `status = 'pending'`, landing in the exact same admin-reviewed queue
 * machine candidates use. `topicEmbedding` is threaded through from the
 * caller's own pre-insert dedup guard (`candidateTopicAlreadyReviewed` +
 * `findKnowledgeCoveringTopic`), same reuse-not-recompute discipline as
 * `insertKnowledgeCandidate` above.
 *
 * Enforces a DB-backed rolling-24h cap per (platform, user) — same restart-
 * proof `COUNT(*)`-inside-the-insert pattern as `createSuggestion`, never an
 * in-memory counter. Returns null when the caller is at/over the cap; the
 * tool layer turns that into a polite refusal.
 */
export async function createKnowledgeTip(input: {
  platform: Platform;
  userId: string;
  topic: string;
  title: string;
  content: string;
  topicEmbedding?: number[] | null;
}): Promise<{ id: number } | null> {
  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT count(*) AS n FROM knowledge_candidates
        WHERE source_platform = $1 AND source_user_id = $2
          AND created_at > now() - interval '24 hours'
     )
     INSERT INTO knowledge_candidates
       (digest_id, topic, title, content, topic_embedding, source_platform, source_user_id)
     SELECT NULL, $3, $4, $5, $6, $1, $2
      WHERE (SELECT n FROM recent) < $7
     RETURNING id`,
    [
      input.platform,
      input.userId,
      // Mirrors title's truncation: suggest_knowledge's topic is always
      // args.title (already zod-capped at KNOWLEDGE_TIP_TITLE_MAX_CHARS), but
      // the rate_answer implicit-drafting path (issue #726) passes the raw
      // recovered question as topic, which is only platform-message-length
      // bounded — without this it could land longer than the title holding
      // the same text and get embedded via candidateTopicAlreadyReviewed at
      // full length.
      input.topic.slice(0, KNOWLEDGE_TIP_TITLE_MAX_CHARS),
      input.title.slice(0, KNOWLEDGE_TIP_TITLE_MAX_CHARS),
      input.content.slice(0, KNOWLEDGE_TIP_CONTENT_MAX_CHARS),
      input.topicEmbedding ? pgvector.toSql(input.topicEmbedding) : null,
      KNOWLEDGE_TIP_RATE_LIMIT_PER_DAY,
    ],
  );
  return rows[0] ? { id: Number(rows[0].id) } : null;
}

/**
 * Let a member withdraw their OWN still-pending suggest_knowledge tip(s)
 * (issue #895) — the one member content-submission flow that previously had
 * no self-service retraction, unlike its sibling `withdrawOwnReports`
 * (content_reports). Strictly scoped to the caller's own identity via
 * `source_platform = $1 AND source_user_id = $2`: a machine-drafted
 * candidate (`source_user_id IS NULL`) can never match, and neither can
 * another member's tip. Only ever flips a `'pending'` row — an already-
 * `'accepted'`/`'declined'` tip is a finished review and is left untouched,
 * matching `withdrawOwnReports`'s own "still-open" scoping. Non-destructive:
 * the row is kept as `'withdrawn'`, never deleted, `reviewed_by` set to the
 * withdrawer's own id. Returns the withdrawn ids (empty array if the caller
 * had no pending tips).
 */
export async function withdrawOwnKnowledgeTips(platform: Platform, userId: string): Promise<number[]> {
  const { rows } = await pool.query(
    `UPDATE knowledge_candidates
        SET status = 'withdrawn', reviewed_by = $2, reviewed_at = now()
      WHERE source_platform = $1 AND source_user_id = $2 AND status = 'pending'
      RETURNING id`,
    [platform, userId],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Self-scoped read of a member's OWN knowledge tips (issue #830) — the
 * `my_submissions` pull-based fallback for `suggest_knowledge`'s resolution
 * DM (issue #703), matching `listOwnSuggestions`'s exact shape and clamp.
 * `source_platform`/`source_user_id` are NULL together on a machine-drafted
 * (context-builder) candidate, so `NULL = $1` never matches and such a row
 * can never appear here for any real caller.
 *
 * LEFT JOINs the linked `knowledge` entry (issue #880) to surface its
 * `retrieval_count` — the impact signal for an already-accepted tip. The
 * join is only ever non-null for an accepted, linked candidate; a pending or
 * declined row (whose `knowledge_id` is always NULL) reads back `null`, not
 * `0`, matching `retrievalCount`'s own doc comment.
 */
export async function listOwnKnowledgeCandidates(
  platform: Platform,
  userId: string,
  limit = 10,
): Promise<KnowledgeCandidate[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
  const { rows } = await pool.query(
    `SELECT kc.id, kc.digest_id, kc.topic, kc.title, kc.content, kc.status, kc.created_at,
            kc.reviewed_by, kc.reviewed_at, kc.source_platform, kc.source_user_id, k.retrieval_count
       FROM knowledge_candidates kc
       LEFT JOIN knowledge k ON k.id = kc.knowledge_id
      WHERE kc.source_platform = $1 AND kc.source_user_id = $2
      ORDER BY kc.created_at DESC
      LIMIT $3`,
    [platform, userId, clampedLimit],
  );
  return rows.map(toKnowledgeCandidate);
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
 * The `knowledge` entry (if any) that already covers this topic above the
 * #95 relevance floor (`KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD`) — the other
 * half of the builder's dedup guard, so the candidate queue doesn't refill
 * with a suggestion an admin already answered. Takes the topic's already-
 * computed embedding (issue #503 — reused from `candidateTopicAlreadyReviewed`
 * rather than re-embedded) instead of embedding it again; a null vector
 * (exact-match short circuit upstream, or a failed embed) fails open to
 * `null` ("not covered") so a transient embedding outage can only ever
 * produce an extra candidate for an admin to decline, never silently
 * suppress a genuinely new one. Returns `title` too (issue #633) so
 * `suggest_knowledge` can name the covering entry in its refusal —
 * `knowledgeCoversTopic` below stays the plain boolean the context builder
 * (and its own dedicated tests) already depend on.
 */
export async function findKnowledgeCoveringTopic(
  vec: number[] | null,
): Promise<{ id: number; title: string | null } | null> {
  if (!vec) return null;
  const { rows } = await pool.query(
    `SELECT id, title, 1 - (embedding <=> $1) AS similarity
       FROM knowledge
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1
      LIMIT 1`,
    [pgvector.toSql(vec)],
  );
  const top = rows[0];
  if (!top || Number(top.similarity) < KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD) return null;
  return { id: Number(top.id), title: top.title ?? null };
}

/**
 * True if an existing `knowledge` entry already covers this topic — see
 * `findKnowledgeCoveringTopic` above, which this wraps.
 */
export async function knowledgeCoversTopic(vec: number[] | null): Promise<boolean> {
  return (await findKnowledgeCoveringTopic(vec)) !== null;
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
    `SELECT id, digest_id, topic, title, content, status, created_at, reviewed_by, reviewed_at, source_platform, source_user_id
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
 * Count of accepted candidates that were specifically a member's own
 * `suggest_knowledge` (or `rate_answer` implicit-draft, issue #726)
 * contribution, reviewed since `since` — issue #837's public member-digest
 * flywheel signal, the community-facing counterpart to
 * `countAcceptedKnowledgeCandidatesSince` (#797, admin-digest throughput).
 * Same shape, plus `source_user_id IS NOT NULL`, which is non-null only for
 * a member's own submission (never a machine-drafted context-builder row —
 * see `KnowledgeCandidate.sourceUserId`'s docstring above).
 */
export async function countAcceptedMemberKnowledgeTipsSince(since: Date): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM knowledge_candidates
      WHERE status = 'accepted' AND reviewed_at > $1 AND source_user_id IS NOT NULL`,
    [since],
  );
  return Number(rows[0].n);
}

/**
 * Whole-day age of the oldest still-pending knowledge candidate — the same
 * `MIN(created_at)` oldest-age mechanic `oldestOpenAppealAgeDays` (#787)
 * applies to appeals, over exactly the `status = 'pending'` row set
 * `countPendingKnowledgeCandidates` counts (issues #743/#787 both named this
 * as the deferred growth path, built here in #801). Guild-wide, unscoped —
 * `knowledge_candidates` has no conversation/channel column, matching
 * `countPendingKnowledgeCandidates`'s own unscoped behaviour. `MIN` over an
 * empty (all-reviewed) set is `null`, never `0`, and is returned as-is so a
 * digest/tool reader can never mistake "no pending candidates" for "one that
 * just arrived".
 */
export async function oldestPendingCandidateAgeDays(): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT EXTRACT(DAY FROM now() - MIN(created_at))::int AS age_days FROM knowledge_candidates WHERE status = 'pending'`,
  );
  const ageDays = rows[0]?.age_days;
  return ageDays === null || ageDays === undefined ? null : Number(ageDays);
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
}): Promise<{
  candidateId: number;
  knowledgeId: number;
  similarEntry?: KnowledgeDuplicateMatch;
  title: string;
  sourcePlatform: Platform | null;
  sourceUserId: string | null;
} | null> {
  const { rows } = await pool.query(
    `SELECT id, digest_id, topic, title, content, status, created_at, reviewed_by, reviewed_at, source_platform, source_user_id
       FROM knowledge_candidates WHERE id = $1 AND status = 'pending'`,
    [input.id],
  );
  const candidate = rows[0] ? toKnowledgeCandidate(rows[0]) : null;
  if (!candidate) return null;

  const title = input.title ?? candidate.title;
  const { id: knowledgeId, similarEntry } = await saveKnowledge({
    title,
    content: input.content ?? candidate.content,
    createdByRole: 'admin',
    sourceUrl: input.sourceUrl,
    sourceTitle: input.sourceTitle,
  });

  // Persists the link (issue #880) in the SAME UPDATE that flips status, so
  // the two can never drift apart (e.g. a crash between two separate writes).
  await pool.query(
    `UPDATE knowledge_candidates SET status = 'accepted', reviewed_by = $2, reviewed_at = now(), knowledge_id = $3 WHERE id = $1`,
    [input.id, input.reviewedBy, knowledgeId],
  );

  return {
    candidateId: candidate.id,
    knowledgeId,
    similarEntry,
    title,
    sourcePlatform: candidate.sourcePlatform,
    sourceUserId: candidate.sourceUserId,
  };
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
      RETURNING id, digest_id, topic, title, content, status, created_at, reviewed_by, reviewed_at, source_platform, source_user_id`,
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

// --- Lifecycle registration (storage/lifecycle.ts) ---------------------------

registerPurgeContributor({
  name: 'knowledge_candidates',
  order: 160,
  async purge({ platform, userId }, tx) {
    // Member-sourced knowledge_candidates rows (issue #633, suggest_knowledge)
    // — matched on source_platform/source_user_id, in EVERY status (pending
    // AND accepted/declined), unlike the digest-invalidation delete the purge
    // prologue runs (which only removes a still-pending MACHINE row and leaves
    // an accepted one's accountability trail intact). A member's own attributed
    // submission is their data to erase regardless of review status; rows
    // with source_user_id IS NULL (machine-drafted) never match this
    // predicate, so they're untouched.
    const { rowCount: knowledgeTips } = await tx.query(
      `DELETE FROM knowledge_candidates WHERE source_platform = $1 AND source_user_id = $2`,
      [platform, userId],
    );
    return knowledgeTips ?? 0;
  },
});
