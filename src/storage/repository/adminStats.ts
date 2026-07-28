import type { Platform, Tier } from '../../platforms/types.js';
import { pool } from '../db.js';
import { AUTO_ENROLL_ACTOR } from './members.js';
import { sumShortcutHits } from './shortcutHits.js';

/**
 * Super-admin observability: usage/cost aggregates, per-model and per-platform
 * breakdowns, admin-activity summaries, and the background-job cost rollup.
 *
 * The two sections move together because they are mutually coupled: usageStats
 * folds in sumBackgroundJobCosts, and the job-cost section reads usageStats'
 * window shape. Splitting them would need a cross-module import in both
 * directions — a cycle.
 *
 * 🔒 Carries conversation-scoped admin reads; the `conversationIds` filter and
 * its SQL moved verbatim.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

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
