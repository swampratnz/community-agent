import { config } from './config.js';
import { logger } from './logger.js';
import {
  countAccessRequests,
  countKnowledgeGaps,
  countLowRatedKnowledge,
  countMaxTurnsFailures,
  countMutedMembers,
  countOpenReports,
  countPendingKnowledgeCandidates,
  countPendingSuggestions,
  countStaleKnowledge,
  listAdmins,
  recentQuestionClusters,
  recordAdminDigestSent,
  resolveLinkedIdentities,
  rosterCounts,
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
 * eligible. `pendingAccessRequests`, `openReports`, `pendingSuggestions`,
 * `staleKnowledgeCount`, `pendingKnowledgeCandidates`, and
 * `lowRatedKnowledgeCount` are exact counts (`countAccessRequests`/
 * `countOpenReports`/`countPendingSuggestions`/`countStaleKnowledge`/
 * `countPendingKnowledgeCandidates`/`countLowRatedKnowledge`, dedicated
 * `COUNT(*)` reads), never `.length` of a `LIMIT`-bounded list, so a backlog
 * larger than that limit is never understated. A persistently untriaged
 * queue re-appears on every subsequent weekly tick until it's cleared —
 * that nag is intended, not a bug (issue #133, extended by #193, #199,
 * #284, and #324). `joinedThisWeek`/`leftThisWeek` (issue #344) come from
 * the already-built `rosterCounts` — bare integers only, never a member
 * name/id, matching the same privacy convention as every other signal here.
 * `mutedMembersCount` (issue #357) comes from `countMutedMembers`, which
 * reuses `countActiveWarnings`'s exact strike-limit/window definition, so
 * the digest's "muted" can never drift from the actual mute trigger in
 * `moderator.ts` — bare integer only, never a `member_warnings.reason`/
 * `excerpt`/user id/name.
 * `maxTurnsFailuresCount` (issue #371) comes from `countMaxTurnsFailures`,
 * conversation-scoped and windowed identically to `knowledgeGapsCount` —
 * bare integer only, never message content, question text, user id, or
 * conversation id.
 */
export function buildAdminDigestMessage(
  clusters: readonly QuestionCluster[],
  pendingAccessRequests: number,
  openReports: number,
  pendingSuggestions: number,
  staleKnowledgeCount: number,
  knowledgeStaleDays: number,
  knowledgeGapsCount: number = 0,
  pendingKnowledgeCandidates: number = 0,
  lowRatedKnowledgeCount: number = 0,
  joinedThisWeek: number = 0,
  leftThisWeek: number = 0,
  mutedMembersCount: number = 0,
  maxTurnsFailuresCount: number = 0,
): string | null {
  if (
    clusters.length === 0 &&
    pendingAccessRequests === 0 &&
    openReports === 0 &&
    pendingSuggestions === 0 &&
    staleKnowledgeCount === 0 &&
    knowledgeGapsCount === 0 &&
    pendingKnowledgeCandidates === 0 &&
    lowRatedKnowledgeCount === 0 &&
    joinedThisWeek === 0 &&
    leftThisWeek === 0 &&
    mutedMembersCount === 0 &&
    maxTurnsFailuresCount === 0
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
  if (knowledgeGapsCount > 0) {
    // Bare integer only — no query_text / user_id ever reaches the DM (#246).
    sections.push(
      `🕳️ ${knowledgeGapsCount} unanswered question(s) in your conversations this week hit no ` +
        'knowledge — run `list_knowledge_gaps` to see what to document.',
    );
  }
  if (pendingKnowledgeCandidates > 0) {
    // Bare integer only — no candidate title/content/topic ever reaches the DM (#284).
    sections.push(
      `🧩 ${pendingKnowledgeCandidates} pending knowledge candidate(s) — run ` +
        '`list_knowledge_candidates`.',
    );
  }
  if (lowRatedKnowledgeCount > 0) {
    // Bare integer only — no entry title/rating content/rater identity ever reaches the DM (#324).
    sections.push(
      `👎 ${lowRatedKnowledgeCount} knowledge entr${lowRatedKnowledgeCount === 1 ? 'y' : 'ies'} with ` +
        'repeated unhelpful ratings — run `list_low_rated_knowledge` to review.',
    );
  }
  if (joinedThisWeek > 0 || leftThisWeek > 0) {
    // Bare integers only — no display name/user id/platform id ever reaches the DM (#344).
    const parts: string[] = [];
    if (joinedThisWeek > 0) parts.push(`${joinedThisWeek} joined`);
    if (leftThisWeek > 0) parts.push(`${leftThisWeek} left`);
    sections.push(`📈 ${parts.join(', ')} this week — run \`list_roster\` for detail.`);
  }
  if (mutedMembersCount > 0) {
    // Bare integer only — no member_warnings.reason/excerpt/user_id/name ever reaches the DM (#357).
    sections.push(
      `🔇 ${mutedMembersCount} member(s) currently muted — run \`moderation_history\` or ` +
        '`clear_warnings` to review.',
    );
  }
  if (maxTurnsFailuresCount > 0) {
    // Bare integer only — no message content, question text, user id, or conversation id ever reaches the DM (#371).
    sections.push(
      `⏱️ ${maxTurnsFailuresCount} repl${maxTurnsFailuresCount === 1 ? 'y' : 'ies'} in your conversations ` +
        'this week hit the step limit before finishing.',
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
 * `countLowRatedKnowledge` is likewise conversation-scoped by `scope`
 * (`answer_feedback` has a `conversation_id`), same as `countKnowledgeGaps`
 * (issue #324).
 * `countAccessRequests`, `countPendingSuggestions`,
 * `countStaleKnowledge`, and `countPendingKnowledgeCandidates` are guild-wide
 * by design (matching `list_access_requests`/`list_suggestions`/
 * `list_knowledge`/`list_knowledge_candidates`'s own unscoped behaviour —
 * none of those tables have a conversation/channel column), so every
 * enrolled admin sees the same pending-guest, pending-suggestion,
 * stale-knowledge, and pending-candidate counts. `countStaleKnowledge` only runs when
 * `KNOWLEDGE_STALE_DAYS` is configured (`> 0`) — otherwise the signal stays
 * `0` and the digest is byte-for-byte unchanged from before issue #199.
 * `rosterCounts(admin.platform)` is likewise guild-wide by platform — same
 * signal every enrolled admin on that platform sees (issue #344); `server_roster`
 * is Discord-only, so a WhatsApp admin's `rosterCounts('whatsapp')` is always
 * zeros, leaving the rest of their digest byte-for-byte unchanged.
 * `countMutedMembers(admin.platform, ...)` is likewise guild-wide by platform
 * (`member_warnings` has no conversation/channel column either), reusing
 * `config.moderation.strikeLimit`/`strikeWindowDays` verbatim so two admins on
 * the same platform always see the same muted-member count (issue #357).
 * `countMaxTurnsFailures(scope, ...)` is conversation-scoped by `scope`
 * (`interactions` has a `conversation_id`), same as `countKnowledgeGaps`
 * (issue #371). The freshness guard
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
      // Exclude reports filed against ANY of this admin's linked identities
      // from their own open-report count, matching list_reports (issue #197).
      const viewerIds = (await resolveLinkedIdentities(admin.platform, admin.platformUserId)).map(
        (i) => i.userId,
      );
      const knowledgeStaleDays = config.adminDigest.knowledgeStaleDays;
      const [
        clusters,
        pendingAccessRequests,
        openReports,
        pendingSuggestions,
        staleKnowledgeCount,
        knowledgeGapsCount,
        pendingKnowledgeCandidates,
        lowRatedKnowledgeCount,
        roster,
        mutedMembersCount,
        maxTurnsFailuresCount,
      ] = await Promise.all([
        recentQuestionClusters(scope, FRESHNESS_DAYS, CLUSTER_LIMIT),
        countAccessRequests(),
        countOpenReports(scope, viewerIds),
        countPendingSuggestions(),
        knowledgeStaleDays > 0 ? countStaleKnowledge(knowledgeStaleDays) : Promise.resolve(0),
        // Conversation-scoped like openReports (knowledge_gaps has a
        // conversation_id), over the same freshness window (#246).
        countKnowledgeGaps(scope, FRESHNESS_DAYS),
        countPendingKnowledgeCandidates(),
        // Conversation-scoped like knowledgeGapsCount (answer_feedback has a
        // conversation_id); cumulative, no freshness window — matches the
        // linked tool's own cumulative unhelpfulCount (#324).
        countLowRatedKnowledge(scope),
        // Guild-wide by platform, mirroring list_roster's own summary line
        // (#47, #344). server_roster is Discord-only, so a WhatsApp admin's
        // rosterCounts('whatsapp') is always zeros — quiet, no error.
        rosterCounts(admin.platform),
        // Guild-wide by platform like rosterCounts (member_warnings has no
        // conversation/channel column); reuses config.moderation.strikeLimit/
        // strikeWindowDays verbatim so "muted" here can never disagree with
        // the actual mute trigger in moderator.ts (issue #357).
        countMutedMembers(admin.platform, config.moderation.strikeLimit, config.moderation.strikeWindowDays),
        // Conversation-scoped like knowledgeGapsCount (interactions.conversation_id),
        // over the same freshness window (#371).
        countMaxTurnsFailures(scope, FRESHNESS_DAYS),
      ]);
      const message = buildAdminDigestMessage(
        clusters,
        pendingAccessRequests,
        openReports,
        pendingSuggestions,
        staleKnowledgeCount,
        knowledgeStaleDays,
        knowledgeGapsCount,
        pendingKnowledgeCandidates,
        lowRatedKnowledgeCount,
        roster.joinedThisWeek,
        roster.leftThisWeek,
        mutedMembersCount,
        maxTurnsFailuresCount,
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
 * plus pending access-request, open-report, pending-suggestion, (when
 * `KNOWLEDGE_STALE_DAYS` is configured) stale-knowledge, pending
 * knowledge-candidate, low-rated-knowledge, roster joined/left-this-week, and
 * currently-muted-member counts (issue #21's deferred proactive follow-up,
 * extended by issue #133, issue #193, issue #199, issue #284, issue #324,
 * issue #344, and issue #357) — the same signals
 * `question_digest`/`list_access_requests`/`list_reports`/
 * `list_suggestions`/`list_knowledge`/`list_knowledge_candidates`/
 * `list_low_rated_knowledge`/`list_roster`/`moderation_history` already
 * compute on demand.
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
