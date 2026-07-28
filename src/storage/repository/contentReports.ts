import type { Platform } from '../../platforms/types.js';
import { logger } from '../../logger.js';
import { pool } from '../db.js';
import { embed } from '../embeddings.js';
import { QUESTION_CLUSTER_SIMILARITY_THRESHOLD, cosineSim } from './shared.js';

/**
 * Member-facing abuse/spam reports: intake, admin triage views, resolution, and
 * the repeat-target warning.
 *
 * 🔒 The most scoping-dense domain in the repository — an admin only ever sees
 * reports from conversations they are in, enforced by the `conversationIds`
 * filter in SQL here (null = super_admin, unrestricted), never by callers.
 * Every predicate moved verbatim.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

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
