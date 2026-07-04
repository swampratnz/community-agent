import { config } from './config.js';
import { logger } from './logger.js';
import {
  listAdmins,
  recentQuestionClusters,
  recordAdminDigestSent,
  wasAdminDigestSentRecently,
  type QuestionCluster,
} from './storage/repository.js';
import type { PlatformAdapter } from './platforms/types.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60_000; // daily tick; the freshness guard below makes it ~weekly per admin

/** Freshness window and cluster window/limit — mirrors `question_digest`'s own defaults (tools.ts). */
const FRESHNESS_DAYS = 7;
const CLUSTER_LIMIT = 5;
const SNIPPET_MAX_CHARS = 300;

/**
 * Pure: clusters -> DM text, or null to skip. Returning null on an empty
 * cluster list is the "silently re-arm, no message when there's nothing to
 * say" convention shared with the disconnect/usage alerts — a quiet week
 * produces no DM and (by the caller not touching the freshness row) no
 * change to when the admin is next eligible.
 */
export function buildAdminDigestMessage(clusters: readonly QuestionCluster[]): string | null {
  if (clusters.length === 0) return null;
  const lines = clusters
    .slice(0, CLUSTER_LIMIT)
    .map((c, i) => `${i + 1}. (${c.count}x) ${c.representative.slice(0, SNIPPET_MAX_CHARS)}`);
  return (
    `🔔 ${clusters.length} recurring question(s) in your conversations this week:\n` +
    `${lines.join('\n')}\n` +
    'Run `question_digest` for full detail.'
  );
}

/**
 * One pass over every `community_users` admin, DMing each at most once per
 * `FRESHNESS_DAYS` window. Exported (rather than inlined in the timer
 * closure) so tests can await a single run directly instead of racing a
 * fire-and-forget `setInterval` tick.
 *
 * Scoping mirrors the `question_digest` admin path exactly:
 * `adapter.conversationsForUser(admin.platformUserId)` feeds
 * `recentQuestionClusters`, so an admin never sees a cluster sourced from a
 * conversation outside their own membership. The freshness guard
 * (`admin_digest_sends`) is a durable per-admin timestamp, so a restart
 * mid-week cannot cause a duplicate send within the same window. Super
 * admins are not enrolled — `listAdmins` only returns `community_users`
 * admins; super admins keep the on-demand, unrestricted-scope
 * `question_digest` tool instead.
 */
export async function runAdminDigestOnce(adapters: readonly PlatformAdapter[]): Promise<void> {
  let admins;
  try {
    admins = await listAdmins();
  } catch (err) {
    logger.error({ err }, 'Admin digest: failed to list admins');
    return;
  }

  for (const admin of admins) {
    const adapter = adapters.find((a) => a.platform === admin.platform && a.isConnected());
    if (!adapter) continue;

    try {
      const alreadySent = await wasAdminDigestSentRecently(
        admin.platform,
        admin.platformUserId,
        FRESHNESS_DAYS,
      );
      if (alreadySent) continue;

      const scope = await adapter.conversationsForUser(admin.platformUserId);
      const clusters = await recentQuestionClusters(scope, FRESHNESS_DAYS, CLUSTER_LIMIT);
      const message = buildAdminDigestMessage(clusters);
      if (!message) continue; // quiet week — no send, freshness row untouched

      await adapter.sendDirectMessage(admin.platformUserId, message);
      await recordAdminDigestSent(admin.platform, admin.platformUserId);
    } catch (err) {
      logger.warn(
        { err, platform: admin.platform, id: admin.platformUserId },
        'Admin digest: per-admin run failed',
      );
    }
  }
}

/**
 * Daily timer (gated behind ADMIN_DIGEST_ENABLED, off by default — no timer
 * created when unset) that pushes each `community_users` admin a weekly DM
 * summarising recurring-question clusters in their own scoped conversations,
 * the same signal `question_digest` already computes on demand (issue #21's
 * deferred proactive follow-up).
 */
export function startAdminDigest(
  adapters: readonly PlatformAdapter[],
): ReturnType<typeof setInterval> | null {
  if (!config.adminDigest.enabled) return null;

  void runAdminDigestOnce(adapters);
  const timer = setInterval(() => void runAdminDigestOnce(adapters), CHECK_INTERVAL_MS);
  timer.unref();
  return timer;
}
