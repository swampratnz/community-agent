import { pool } from '../db.js';

/**
 * Response-latency aggregation (issue #877): VISION's "time-to-first-answer"
 * north-star metric, derived entirely from `interactions` timestamps and
 * `meta` fields already written on every turn — no new column or tracking.
 *
 * 🔒 Carries conversation-scoped admin reads; `conversationIds === null`
 * means unrestricted (super admin) scope, the same convention every sibling
 * admin-insight aggregate (`recentQuestionClusters`, `adminActivitySummary`,
 * …) uses.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing
 * import site is unchanged.
 */

export interface ResponseLatencyStats {
  count: number;
  medianSeconds: number;
  p90Seconds: number;
}

/**
 * `'auto_answer'` = only outbound rows carrying `meta.autoAnswer` (ambient
 * replies in `AUTO_ANSWER_CHANNEL_IDS`, issue #477); `'mention'` = every
 * other qualifying reply (mention-mode, DMs, text-command replies — anything
 * that sets `meta.replyToUserId` without `autoAnswer`). Partitions `'all'`
 * with no overlap and no gap.
 */
export type ResponseLatencyScope = 'all' | 'auto_answer' | 'mention';

/**
 * Pairs each qualifying OUTBOUND reply (`meta.replyToUserId` set — a real
 * reply to a member; proactive digest/alert pushes never set that key, so
 * they're excluded from pairing entirely) with the most recent prior INBOUND
 * row in the SAME `(platform, conversation_id)` from that member at or
 * before the outbound's `created_at`, and aggregates the delta (seconds)
 * across the window to a count/median/p90. Only the OUTBOUND row's
 * `created_at` is required to fall inside the window — the paired inbound
 * row may be older.
 *
 * The inbound row must have `addressed_to_bot = true` — UNLESS the outbound
 * row carries `meta.autoAnswer` (an auto-answer reply, issue #477), whose
 * triggering inbound post is by definition an ambient, non-addressed
 * message (`router.ts`'s `isAutoAnswerCandidate` requires
 * `!msg.addressedToBot`). Without this carve-out the LATERAL join either
 * drops the auto-answer row entirely (no `addressed_to_bot = true` row
 * exists) or mispairs it with an unrelated older addressed message —
 * silently miscounting VISION's own named "time-to-first-answer in
 * auto-answer channels" metric.
 *
 * Returns `null` when there are zero qualifying pairs, so callers render a
 * fixed "not enough data" message rather than `NaN`/`Infinity`.
 */
export async function responseLatencyStats(
  conversationIds: readonly string[] | null,
  days = 7,
  scope: ResponseLatencyScope = 'all',
): Promise<ResponseLatencyStats | null> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 30);

  const params: unknown[] = [`${clampedDays} days`];
  let conversationScope = '';
  if (conversationIds) {
    params.push([...conversationIds]);
    conversationScope = `AND o.conversation_id = ANY($${params.length})`;
  }
  const scopeClause =
    scope === 'auto_answer'
      ? `AND o.meta ? 'autoAnswer'`
      : scope === 'mention'
        ? `AND NOT (o.meta ? 'autoAnswer')`
        : '';

  const { rows } = await pool.query(
    `WITH paired AS (
       SELECT EXTRACT(EPOCH FROM (o.created_at - i.created_at)) AS delta_seconds
         FROM interactions o
         JOIN LATERAL (
           SELECT created_at
             FROM interactions
            WHERE platform = o.platform
              AND conversation_id = o.conversation_id
              AND direction = 'inbound'
              AND (o.meta ? 'autoAnswer' OR addressed_to_bot = true)
              AND user_id = o.meta->>'replyToUserId'
              AND created_at <= o.created_at
            ORDER BY created_at DESC
            LIMIT 1
         ) i ON true
        WHERE o.direction = 'outbound'
          AND o.meta ? 'replyToUserId'
          AND o.created_at > now() - $1::interval
          ${conversationScope}
          ${scopeClause}
     )
     SELECT
       count(*)::int AS count,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY delta_seconds) AS median,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY delta_seconds) AS p90
     FROM paired`,
    params,
  );

  const row = rows[0];
  const count = Number(row?.count ?? 0);
  if (count === 0) return null;
  return {
    count,
    medianSeconds: Number(row.median),
    p90Seconds: Number(row.p90),
  };
}
