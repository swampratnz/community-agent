import { config } from './config.js';
import { logger } from './logger.js';
import { superAdminIds } from './auth/roles.js';
import { startTrackedJob } from './backgroundJobs.js';
import {
  getLastUsageCostDigestCacheHitRate,
  getLastUsageCostDigestTotal,
  recordUsageCostDigestSent,
  usageStats,
  wasUsageCostDigestSentRecently,
} from './storage/repository.js';
import type { PlatformAdapter } from './platforms/types.js';

/** Same weekly window as `adminDigest.ts`'s `FRESHNESS_DAYS` — this signal targets the same ~7-day cadence. */
const FRESHNESS_DAYS = 7;

/**
 * Pure DM text builder (issue #578) — this week's total
 * (`usageStats(7).costUsd + .backgroundCostUsd`) plus the signed delta
 * against `previousTotalUsd`, so the content is directly testable without a
 * DB or timer, same convention as `formatUsageAlertMessage`/
 * `formatDepartedAdminAlertMessage`. `previousTotalUsd === null` (no prior
 * persisted week — first-ever run) renders a defined no-comparison form
 * instead of `NaN`/`undefined`. Only ever two aggregate dollar figures —
 * never a user id, conversation id, or message excerpt.
 */
export function formatUsageCostDigestMessage(
  currentTotalUsd: number,
  previousTotalUsd: number | null,
  cacheUsage: { readTokens: number; creationTokens: number },
  previousCacheHitRate: number | null,
): string {
  const current = `~$${currentTotalUsd.toFixed(2)}`;
  const costLine =
    previousTotalUsd === null
      ? `💰 Weekly cost trend: ${current} this week (conversational + background). ` +
        'No prior week recorded yet to compare against.'
      : (() => {
          const diff = currentTotalUsd - previousTotalUsd;
          const trend =
            diff > 0
              ? `▲ $${diff.toFixed(2)} vs last week.`
              : diff < 0
                ? `▼ $${Math.abs(diff).toFixed(2)} vs last week.`
                : 'No change vs last week.';
          return `💰 Weekly cost trend: ${current} this week (conversational + background). ${trend}`;
        })();

  const totalCacheTokens = cacheUsage.readTokens + cacheUsage.creationTokens;
  if (totalCacheTokens === 0) return costLine; // no cache activity this week — omit rather than persist a corrupt 0%

  const currentHitRate = Math.round((cacheUsage.readTokens / totalCacheTokens) * 100);
  return `${costLine}\n${formatCacheHitRateTrendLine(currentHitRate, previousCacheHitRate)}`;
}

/**
 * Pure cache-hit-rate trend line (issue #608) — same `▲/▼/No change` shape
 * as the cost trend above and #597's `formatEngagementAlertMessage`, using
 * the identical `hitRate = round(read / (read + creation) * 100)` calc
 * `formatCacheUsageLine` (`src/agent/tools.ts`) already uses for the
 * pull-only `usage_stats` tool. `previousHitRate === null` (first-ever run,
 * or last week was quiet and skipped the persist) renders a defined
 * no-comparison clause — never `NaN`/`undefined`. Only ever a percentage and
 * a signed percentage-point delta — never a user id, conversation id, or
 * platform handle.
 */
export function formatCacheHitRateTrendLine(currentHitRate: number, previousHitRate: number | null): string {
  if (previousHitRate === null) {
    return `Prompt cache: ${currentHitRate}% hit rate this week. No prior week recorded yet to compare against.`;
  }
  const diff = currentHitRate - previousHitRate;
  const trend =
    diff > 0
      ? `▲ ${diff}pp vs last week.`
      : diff < 0
        ? `▼ ${Math.abs(diff)}pp vs last week.`
        : 'No change vs last week.';
  return `Prompt cache: ${currentHitRate}% hit rate this week. ${trend}`;
}

/**
 * Builds the default weekly `runOnce`, closing the freshness guard +
 * `usageStats(7)` read + persisted-total delta over one tick. Every
 * dependency is injectable (tests only) so the cadence/delta logic can be
 * exercised without a real DB — production always uses the already-exported
 * repository defaults.
 */
export function makeDefaultUsageCostDigestRun(
  adapters: readonly PlatformAdapter[],
  deps: {
    wasSentRecently?: (days: number) => Promise<boolean>;
    getLastTotal?: () => Promise<number | null>;
    getLastCacheHitRate?: () => Promise<number | null>;
    recordSent?: (totalCostUsd: number, cacheHitRate: number | null) => Promise<void>;
    getStats?: (days: number) => Promise<{
      costUsd: number;
      backgroundCostUsd: number;
      cacheUsage: { readTokens: number; creationTokens: number };
    }>;
  } = {},
): () => Promise<void> {
  const wasSentRecently = deps.wasSentRecently ?? wasUsageCostDigestSentRecently;
  const getLastTotal = deps.getLastTotal ?? getLastUsageCostDigestTotal;
  const getLastCacheHitRate = deps.getLastCacheHitRate ?? getLastUsageCostDigestCacheHitRate;
  const recordSent = deps.recordSent ?? recordUsageCostDigestSent;
  const getStats = deps.getStats ?? usageStats;

  return async () => {
    if (await wasSentRecently(FRESHNESS_DAYS)) return; // still inside this week's freshness window

    const stats = await getStats(FRESHNESS_DAYS);
    const currentTotal = stats.costUsd + stats.backgroundCostUsd;
    const previousTotal = await getLastTotal();
    const previousCacheHitRate = await getLastCacheHitRate();

    logger.info({ currentTotal, previousTotal }, 'Weekly cost-trend digest');
    void alertSuperAdmins(
      adapters,
      formatUsageCostDigestMessage(currentTotal, previousTotal, stats.cacheUsage, previousCacheHitRate),
    );

    // Zero cache activity this window persists `null` (see recordUsageCostDigestSent) rather than a corrupt 0%.
    const totalCacheTokens = stats.cacheUsage.readTokens + stats.cacheUsage.creationTokens;
    const currentHitRate =
      totalCacheTokens > 0 ? Math.round((stats.cacheUsage.readTokens / totalCacheTokens) * 100) : null;
    await recordSent(currentTotal, currentHitRate);
  };
}

/**
 * Weekly super-admin cost-trend DM (issue #578), off unless
 * `USAGE_COST_DIGEST_ENABLED`. Complementary to `usageAlert.ts`'s reactive
 * volume-threshold latch — this always reports this-week-vs-last-week
 * spend on cadence, reusing `usageStats(7)` (already computed on demand by
 * the `usage_stats` tool) and the same `alertSuperAdmins`/`superAdminIds`
 * delivery path every other super-admin alert in this codebase uses. No new
 * privileged tool, no new RBAC tier — reuses the existing super-admin-only
 * recipient set verbatim.
 *
 * Routed through the shared `startTrackedJob` (same 6h outer tick as every
 * other opt-in job) rather than a bespoke timer — a throwing `runOnce` (e.g.
 * a DB error) gets the existing consecutive-failure alerting for free. The
 * outer 6h tick is faster than the real ~weekly cadence; `runOnce`'s own
 * `wasUsageCostDigestSentRecently` freshness guard keeps actual sends at
 * the real cadence regardless, the same "faster outer tick, freshness-
 * guarded inner cadence" shape `startAdminDigest`/`startKnowledgeRefresh`
 * already use.
 */
export function startUsageCostDigest(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultUsageCostDigestRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('usage-cost-digest', adapters, config.usageCostDigest.enabled, runOnce);
}

async function alertSuperAdmins(adapters: readonly PlatformAdapter[], message: string): Promise<void> {
  for (const adapter of adapters) {
    if (!adapter.isConnected()) continue; // can't send through a dead connection
    for (const id of superAdminIds(adapter.platform)) {
      adapter
        .sendDirectMessage(id, message)
        .catch((err) => logger.warn({ err, platform: adapter.platform, id }, 'Cost-trend digest DM failed'));
    }
  }
}
