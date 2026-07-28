import type { Platform } from '../../platforms/types.js';
import { pool } from '../db.js';

/**
 * Member ratings of the bot's own answers (#118): the rate_answer signal, its
 * daily cap, unhelpful-answer clustering, and the low-rated-knowledge rollups
 * that feed the admin digest.
 *
 * 🔒 Carries conversation-scoped admin reads; the `conversationIds` filter and
 * its SQL moved verbatim.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

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
