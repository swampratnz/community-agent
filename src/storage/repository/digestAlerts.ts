import type { Platform } from '../../platforms/types.js';
import { pool } from '../db.js';

/**
 * Digest and alert bookkeeping: the freshness guards and trend snapshots that
 * keep each periodic admin digest/alert idempotent (send once per window) and
 * let it report movement since the previous send. One module because these
 * sections are the same mechanism repeated per digest/alert, not independent
 * domains.
 *
 * The member-facing weekly digest guard is deliberately NOT here: it contains a
 * function using `pageKeyOf` from context/docsIngest.ts, which itself imports
 * from repository.ts — routing that through a submodule would deepen an
 * existing import cycle, so it stays put until that is addressed on purpose.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

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
 * `buildAdminDigestMessage`'s bare-count parameters, plus a handful of
 * trend-only derived values that never round-trip as their own function
 * parameter (e.g. `autoAnswerHelpfulPct`, issue #629, derived from
 * `autoAnswerHelpful`/`autoAnswerUnhelpful` purely for the week-over-week
 * comparison) — see adminDigest.ts. Nothing else. `sanitizeDigestCounts`
 * enforces this at the write boundary so a future call site can never
 * smuggle PII-shaped data (a user id, a title) into the snapshot via an
 * unexpected field name.
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
  'autoAnswerHelpfulPct',
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
 * Last week's persisted prompt-cache hit rate (issue #608), or `null` when
 * no row exists yet OR the last write was a quiet week that deliberately
 * skipped the column (see `recordUsageCostDigestSent`) — the read half of
 * the cache-trend delta `formatUsageCostDigestMessage` renders, sibling to
 * `getLastUsageCostDigestTotal`.
 */
export async function getLastUsageCostDigestCacheHitRate(): Promise<number | null> {
  const { rows } = await pool.query<{ last_cache_hit_rate: string | null }>(
    `SELECT last_cache_hit_rate FROM usage_cost_digest_state WHERE id = true`,
  );
  return rows.length > 0 && rows[0].last_cache_hit_rate !== null ? Number(rows[0].last_cache_hit_rate) : null;
}

/**
 * Record that the weekly cost-trend DM was just sent, persisting this
 * week's total for next week's delta and advancing the freshness guard.
 * Upserts the single global row (`id = true`) rather than inserting a new
 * one, matching the "one aggregate figure" shape documented on the table.
 *
 * `cacheHitRate` is `null` on a quiet week (zero cache activity in the
 * window, issue #608) — the `COALESCE` in the `ON CONFLICT` clause keeps
 * the previously-persisted rate in that case rather than overwriting it
 * with `null`, so a quiet week can't corrupt the next real comparison. On
 * a genuine first-ever insert this has no prior value to preserve, so a
 * quiet first week simply persists `null`, same as never having a rate yet.
 */
export async function recordUsageCostDigestSent(
  totalCostUsd: number,
  cacheHitRate: number | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO usage_cost_digest_state (id, total_cost_usd, last_cache_hit_rate, sent_at)
     VALUES (true, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET
       total_cost_usd = EXCLUDED.total_cost_usd,
       last_cache_hit_rate = COALESCE(EXCLUDED.last_cache_hit_rate, usage_cost_digest_state.last_cache_hit_rate),
       sent_at = now()`,
    [totalCostUsd, cacheHitRate],
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
 * guard and this run's percentage for next week's delta (issue #597 reads
 * this back via `getLastEngagementAlertPercentage`). Always the same `id = 1`
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

/**
 * Last week's persisted engagement percentage, or `null` when no row exists
 * yet (first-ever run) — the read half of the trend delta issue #597's
 * `formatEngagementAlertMessage` renders, mirroring
 * `getLastUsageCostDigestTotal`'s shape.
 */
export async function getLastEngagementAlertPercentage(): Promise<number | null> {
  const { rows } = await pool.query<{ last_percentage: string | null }>(
    `SELECT last_percentage FROM engagement_alert_sends WHERE id = 1`,
  );
  return rows.length > 0 && rows[0].last_percentage !== null ? Number(rows[0].last_percentage) : null;
}

// --- Admin-leverage-alert freshness guard (issue #785) ----------------------

/**
 * True if the single-row, guild-wide `admin_leverage_alert_sends` guard was
 * stamped within the last `days` — the restart-safe check
 * `src/adminLeverageAlert.ts` uses so a redeploy mid-week can't double-send,
 * mirroring `wasEngagementAlertSentRecently`'s shape exactly.
 */
export async function wasAdminLeverageAlertSentRecently(days: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM admin_leverage_alert_sends
      WHERE id = 1 AND sent_at > now() - ($1 || ' days')::interval`,
    [days],
  );
  return rows.length > 0;
}

/**
 * Record that the admin-leverage alert was just sent, stamping the
 * freshness guard and this run's rate for next week's delta.
 * `rate === null` (zero current admins — no meaningful rate to trend
 * against) persists `NULL`, so a later run's `getLastAdminLeverageAlertRate`
 * correctly reports "no prior rate" rather than a stale, misleading number.
 * Always the same `id = 1` row, so this is an upsert, not an insert.
 */
export async function recordAdminLeverageAlertSent(rate: number | null): Promise<void> {
  await pool.query(
    `INSERT INTO admin_leverage_alert_sends (id, sent_at, last_rate)
     VALUES (1, now(), $1)
     ON CONFLICT (id) DO UPDATE SET sent_at = now(), last_rate = EXCLUDED.last_rate`,
    [rate],
  );
}

/**
 * Last week's persisted admin-leverage rate, or `null` when no row exists
 * yet (first-ever run) or the last run had zero admins — the read half of
 * the trend delta `formatAdminLeverageAlertMessage` renders, mirroring
 * `getLastEngagementAlertPercentage`'s shape.
 */
export async function getLastAdminLeverageAlertRate(): Promise<number | null> {
  const { rows } = await pool.query<{ last_rate: string | null }>(
    `SELECT last_rate FROM admin_leverage_alert_sends WHERE id = 1`,
  );
  return rows.length > 0 && rows[0].last_rate !== null ? Number(rows[0].last_rate) : null;
}
