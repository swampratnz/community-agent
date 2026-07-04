import { config } from './config.js';
import { logger } from './logger.js';
import {
  countAccessRequests,
  countOpenReports,
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
 * Pure: clusters + pending-queue counts -> DM text, or null to skip.
 * Returning null when all three signals are zero is the "silently re-arm,
 * no message when there's nothing to say" convention shared with the
 * disconnect/usage alerts — a quiet week produces no DM and (by the caller
 * not touching the freshness row) no change to when the admin is next
 * eligible. `pendingAccessRequests` and `openReports` are exact counts
 * (`countAccessRequests`/`countOpenReports`, dedicated `COUNT(*)` reads),
 * never `.length` of a `LIMIT`-bounded list, so a backlog larger than that
 * limit is never understated. A persistently untriaged queue re-appears on
 * every subsequent weekly tick until it's cleared — that nag is intended,
 * not a bug (issue #133).
 */
export function buildAdminDigestMessage(
  clusters: readonly QuestionCluster[],
  pendingAccessRequests: number,
  openReports: number,
): string | null {
  if (clusters.length === 0 && pendingAccessRequests === 0 && openReports === 0) return null;

  const sections: string[] = [];
  if (clusters.length > 0) {
    const lines = clusters
      .slice(0, CLUSTER_LIMIT)
      .map((c, i) => `${i + 1}. (${c.count}x) ${c.representative.slice(0, SNIPPET_MAX_CHARS)}`);
    sections.push(
      `🔔 ${clusters.length} recurring question(s) in your conversations this week:\n` +
        `${lines.join('\n')}\n` +
        'Run `question_digest` for full detail.',
    );
  }
  if (pendingAccessRequests > 0) {
    sections.push(`⏳ ${pendingAccessRequests} pending access request(s) — run \`list_access_requests\`.`);
  }
  if (openReports > 0) {
    sections.push(`🚩 ${openReports} open report(s) in your conversations — run \`list_reports\`.`);
  }
  return sections.join('\n');
}

/**
 * One pass over every `community_users` admin, DMing each at most once per
 * `FRESHNESS_DAYS` window. Exported (rather than inlined in the timer
 * closure) so tests can await a single run directly instead of racing a
 * fire-and-forget `setInterval` tick.
 *
 * Scoping mirrors the `question_digest` admin path exactly:
 * `adapter.conversationsForUser(admin.platformUserId)` feeds both
 * `recentQuestionClusters` and `countOpenReports`, so an admin never sees a
 * cluster or report sourced from a conversation outside their own
 * membership. `countAccessRequests` is guild-wide by design (matching
 * `list_access_requests`'s own unscoped behaviour), so every enrolled admin
 * sees the same pending-guest count. The freshness guard
 * (`admin_digest_sends`) is a durable per-admin timestamp, so a restart
 * mid-week cannot cause a duplicate send within the same window. Super
 * admins are not enrolled — `listAdmins` only returns `community_users`
 * admins; super admins keep the on-demand, unrestricted-scope
 * `question_digest`/`list_access_requests`/`list_reports` tools instead.
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
      const [clusters, pendingAccessRequests, openReports] = await Promise.all([
        recentQuestionClusters(scope, FRESHNESS_DAYS, CLUSTER_LIMIT),
        countAccessRequests(),
        countOpenReports(scope),
      ]);
      const message = buildAdminDigestMessage(clusters, pendingAccessRequests, openReports);
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
 * plus pending access-request and open-report counts (issue #21's deferred
 * proactive follow-up, extended by issue #133) — the same signals
 * `question_digest`/`list_access_requests`/`list_reports` already compute
 * on demand.
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
