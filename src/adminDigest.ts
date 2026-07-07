import { config } from './config.js';
import { logger } from './logger.js';
import {
  countAccessRequests,
  countOpenReports,
  countPendingSuggestions,
  countStaleKnowledge,
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
 * Returning null when all five signals are zero is the "silently re-arm,
 * no message when there's nothing to say" convention shared with the
 * disconnect/usage alerts — a quiet week produces no DM and (by the caller
 * not touching the freshness row) no change to when the admin is next
 * eligible. `pendingAccessRequests`, `openReports`, `pendingSuggestions`, and
 * `staleKnowledgeCount` are exact counts (`countAccessRequests`/
 * `countOpenReports`/`countPendingSuggestions`/`countStaleKnowledge`,
 * dedicated `COUNT(*)` reads), never `.length` of a `LIMIT`-bounded list, so
 * a backlog larger than that limit is never understated. A persistently
 * untriaged queue re-appears on every subsequent weekly tick until it's
 * cleared — that nag is intended, not a bug (issue #133, extended by #193
 * and #199).
 */
export function buildAdminDigestMessage(
  clusters: readonly QuestionCluster[],
  pendingAccessRequests: number,
  openReports: number,
  pendingSuggestions: number,
  staleKnowledgeCount: number,
  knowledgeStaleDays: number,
): string | null {
  if (
    clusters.length === 0 &&
    pendingAccessRequests === 0 &&
    openReports === 0 &&
    pendingSuggestions === 0 &&
    staleKnowledgeCount === 0
  )
    return null;

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
  if (pendingSuggestions > 0) {
    sections.push(`💡 ${pendingSuggestions} pending suggestion(s) — run \`list_suggestions\`.`);
  }
  if (staleKnowledgeCount > 0) {
    sections.push(
      `📚 ${staleKnowledgeCount} knowledge entr${staleKnowledgeCount === 1 ? 'y' : 'ies'} untouched for ` +
        `${knowledgeStaleDays}d+ — run \`list_knowledge\` to review.`,
    );
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
 * cluster sourced from a conversation outside their own membership. Reports
 * additionally include any DM-originated report (`is_dm`) except one filed
 * against the admin themselves (`countOpenReports`'s `viewerUserId` —
 * `admin.platformUserId` here — drives that exclusion; see issue #197).
 * `countAccessRequests`, `countPendingSuggestions`, and
 * `countStaleKnowledge` are guild-wide by design (matching
 * `list_access_requests`/`list_suggestions`/`list_knowledge`'s own unscoped
 * behaviour — none of those tables have a conversation/channel column), so
 * every enrolled admin sees the same pending-guest, pending-suggestion, and
 * stale-knowledge counts. `countStaleKnowledge` only runs when
 * `KNOWLEDGE_STALE_DAYS` is configured (`> 0`) — otherwise the signal stays
 * `0` and the digest is byte-for-byte unchanged from before issue #199. The
 * freshness guard
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
      const knowledgeStaleDays = config.adminDigest.knowledgeStaleDays;
      const [clusters, pendingAccessRequests, openReports, pendingSuggestions, staleKnowledgeCount] =
        await Promise.all([
          recentQuestionClusters(scope, FRESHNESS_DAYS, CLUSTER_LIMIT),
          countAccessRequests(),
          countOpenReports(scope, admin.platformUserId),
          countPendingSuggestions(),
          knowledgeStaleDays > 0 ? countStaleKnowledge(knowledgeStaleDays) : Promise.resolve(0),
        ]);
      const message = buildAdminDigestMessage(
        clusters,
        pendingAccessRequests,
        openReports,
        pendingSuggestions,
        staleKnowledgeCount,
        knowledgeStaleDays,
      );
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
 * plus pending access-request, open-report, pending-suggestion, and (when
 * `KNOWLEDGE_STALE_DAYS` is configured) stale-knowledge counts (issue #21's
 * deferred proactive follow-up, extended by issue #133, issue #193, and
 * issue #199) — the same signals
 * `question_digest`/`list_access_requests`/`list_reports`/`list_suggestions`/
 * `list_knowledge` already compute on demand.
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
