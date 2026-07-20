import { config } from './config.js';
import { logger } from './logger.js';
import { startTrackedJob } from './backgroundJobs.js';
import {
  answerFeedbackOriginSummary,
  countAccessRequests,
  countDuplicateKnowledge,
  countEscalatedKnowledgeGaps,
  countGeneralUnhelpfulAnswers,
  countKnowledgeConflictCandidates,
  countKnowledgeGaps,
  countLowRatedKnowledge,
  countMaxTurnsFailures,
  countMutedMembers,
  countOpenAppeals,
  countOpenReports,
  countPendingKnowledgeCandidates,
  countPendingSuggestions,
  countStaleKnowledge,
  countStaleMutedMembers,
  countStalePendingKnowledgeCandidates,
  countUnreachableSourceKnowledge,
  getLastDigestCounts,
  listAdmins,
  oldestAccessRequestAgeDays,
  oldestOpenReportAgeDays,
  oldestPendingSuggestionAgeDays,
  recentQuestionClusters,
  recordAdminDigestSent,
  recordAdminDigestSnapshot,
  resolveLinkedIdentities,
  rosterCounts,
  wasAdminDigestSentRecently,
  type QuestionCluster,
} from './storage/repository.js';
import type { Platform, PlatformAdapter } from './platforms/types.js';

/** Freshness window and cluster window/limit — mirrors `question_digest`'s own defaults (tools.ts). */
const FRESHNESS_DAYS = 7;
const CLUSTER_LIMIT = 5;
const SNIPPET_MAX_CHARS = 300;

/**
 * Week-over-week delta suffix for one digest signal (issue #497). Empty
 * string — never rendered — unless `previous` both exists and has an entry
 * for `key`; a signal with no prior snapshot value or no change is silent,
 * so a stable week produces no clutter and a first-ever digest produces no
 * suffix anywhere. `previous` is `undefined` whenever
 * `ADMIN_DIGEST_TRENDS_ENABLED` is unset, making the entire mechanism inert
 * by default (see `runAdminDigestOnce`).
 */
function trendSuffix(key: string, current: number, previous: Record<string, number> | undefined): string {
  if (!previous || !(key in previous)) return '';
  const diff = current - previous[key];
  if (diff === 0) return '';
  return diff > 0 ? ` (▲+${diff} since last week)` : ` (▼${diff} since last week)`;
}

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
 * `staleMutedMembersCount` (issue #403) comes from `countStaleMutedMembers`
 * — members whose UNWINDOWED strike count is still over the limit but whose
 * WINDOWED count (the same one `mutedMembersCount` uses) has fallen below
 * it, i.e. `mutedMembersCount`'s own deliberate exclusion once a muted
 * member's strikes age out of the window. It is an OVER-APPROXIMATION (a
 * member may satisfy this without ever having actually been muted — see
 * `countStaleMutedMembers`'s doc comment) so the line hedges with "may still
 * be muted" and is only appended when it's `> 0`; at `0` (the default
 * unset-window case, or a window with nothing stale) the muted-members line
 * is byte-identical to its pre-#403 form. Bare integer only, same privacy
 * shape as `mutedMembersCount`.
 * `maxTurnsFailuresCount` (issue #371) comes from `countMaxTurnsFailures`,
 * conversation-scoped and windowed identically to `knowledgeGapsCount` —
 * bare integer only, never message content, question text, user id, or
 * conversation id.
 * `duplicateKnowledgeCount`/`conflictCandidateCount` (issue #378) come from
 * `countDuplicateKnowledge`/`countKnowledgeConflictCandidates`, the exact
 * `COUNT(*)` complements to the existing `list_duplicate_knowledge`/
 * `list_knowledge_conflicts` admin tools (#316, #330) — guild-wide, matching
 * `countStaleKnowledge`'s own unscoped precedent (the pair self-joins carry
 * no conversation scope either). Bare integer only, never a pair's id,
 * title, or content.
 * `pendingKnowledgeCandidatesStaleCount` (issue #398) is the
 * `countStalePendingKnowledgeCandidates` sub-count of `pendingKnowledgeCandidates`
 * that have sat unreviewed past `KNOWLEDGE_CANDIDATE_STALE_DAYS` — it only
 * ever appears alongside the existing pending-candidates line (never its own
 * section), and only when the knob is set and the sub-count is nonzero, so
 * the default (knob unset) output is byte-identical to the pre-#398 (#284)
 * wording. Bare integer only, same privacy convention as every signal above.
 * `notMembersCount` (issue #460) is the standing size of the onboarding
 * queue — `rosterCounts().notMembers`, unwindowed unlike `joinedThisWeek`/
 * `leftThisWeek` — passed as `0` by the caller for an `'open'`-access-mode
 * platform (see `runAdminDigestOnce`), since a `not_members` row there
 * already has full member-tool access and the count would be a meaningless
 * nag. Bare integer only, same privacy convention as every signal above.
 * `escalatedKnowledgeGapsCount` (issue #514) comes from
 * `countEscalatedKnowledgeGaps`, conversation-scoped and windowed
 * identically to `knowledgeGapsCount` — the subset of it written by a
 * CONFIRMED member escalation (issue #479) rather than a passive
 * below-floor `knowledge_search` miss. Only rendered (as a second line
 * nested under the existing gap line) when `> 0`; bare integer only, same
 * privacy convention as every signal above.
 * `previousCounts` (issue #497, behind `ADMIN_DIGEST_TRENDS_ENABLED`, off by
 * default) is last week's snapshot of every signal above, keyed by the same
 * parameter names — `trendSuffix` appends a ` (▲+N since last week)` /
 * ` (▼-N since last week)` fragment to a render site's line for a signal
 * whose count moved since that snapshot, and nothing when it's unchanged, has
 * no snapshot entry, or `previousCounts` itself is `undefined` (flag off, or
 * this admin's first-ever digest). Purely additive string concatenation onto
 * each existing template literal — with the flag unset, `previousCounts` is
 * never even fetched (see `runAdminDigestOnce`) and every `trendSuffix` call
 * short-circuits to `''`, so output is byte-identical to the pre-#497 form.
 * `oldestAccessRequestAgeDays` (issue #515) is the whole-day age of the
 * OLDEST pending row in `access_requests` (`MIN(first_requested_at)`,
 * `repository.ts`'s `oldestAccessRequestAgeDays`) — the same oldest-age
 * mechanic issue #450 uses for reports/suggestions. It only ever appends to
 * the existing `pendingAccessRequests > 0` line above, and only when it
 * resolved to a real day count (never when `null`, the empty-table case), so
 * the quiet case (`pendingAccessRequests === 0`) and every caller that
 * hasn't wired the new trailing param through are byte-identical to the
 * pre-#515 form. Bare integer only, same privacy convention as every signal
 * above.
 * `oldestOpenReportAgeDays`/`oldestPendingSuggestionAgeDays` (issue #450) are
 * the same oldest-age refinement applied to the open-report and pending-
 * suggestion lines — each from a `MIN(created_at)` aggregate over exactly the
 * scoped row set its sibling count (`countOpenReports`/`countPendingSuggestions`)
 * already returns, so the report age inherits `countOpenReports`'s conversation
 * scoping and can never surface an out-of-scope report's age. Each only ever
 * appends to its already-nonzero count line and only when non-null, so the
 * quiet case is byte-identical to the pre-#450 form. Bare integers only.
 * `generalUnhelpfulCount` (issue #563) comes from `countGeneralUnhelpfulAnswers`,
 * conversation-scoped and windowed identically to `maxTurnsFailuresCount` — the
 * `meta->>'knowledgeEntryId' IS NULL` complement `lowRatedKnowledgeCount`
 * deliberately excludes, i.e. unhelpful ratings on general-knowledge (ungrounded)
 * answers rather than KB-attributed ones. Only rendered when `> 0`; a trailing,
 * append-only param, so every existing call site is unaffected and the quiet
 * case (count 0, or a caller that hasn't wired it through) is byte-identical to
 * the pre-#563 form. Bare integer only, same privacy convention as every signal
 * above.
 * `autoAnswerHelpful`/`autoAnswerUnhelpful`/`addressedHelpful`/`addressedUnhelpful`
 * (issue #592) come from `answerFeedbackOriginSummary`, the origin-split
 * (auto-answered vs addressed) complement to `generalUnhelpfulCount`'s
 * grounded-vs-ungrounded axis — #477's own named success metric, never wired
 * up until now. Cumulative, not freshness-windowed, matching
 * `lowRatedKnowledgeCount`'s own cumulative shape. Rendered only when
 * `autoAnswerHelpful + autoAnswerUnhelpful > 0` (i.e. only once a guild both
 * runs auto-answer AND has received at least one rating on it), as bare
 * ratios/counts only — no message content, no rater identity. Four
 * append-only trailing params, default 0, so every existing call site is
 * unaffected and the quiet case is byte-identical to the pre-#592 form.
 * `openAppealsCount` (issue #631) comes from `countOpenAppeals`, a dedicated
 * `COUNT(*)` read guild-wide by platform, same shape as `mutedMembersCount`
 * — the digest line #554 and #622 both named and deferred as a follow-up.
 * Rendered only when `> 0`; bare integer only, never an appellant's
 * `user_name`/`reason`/`user_id`. Append-only trailing param, default 0, so
 * every existing call site is unaffected and the quiet case is
 * byte-identical to the pre-#631 form.
 * `unreachableSourceKnowledgeCount` (issue #624) comes from
 * `countUnreachableSourceKnowledge`, a dedicated `COUNT(*)` of
 * `source_unreachable = true` rows — the digest fold-in #448 itself deferred
 * for the weekly link-rot checker, same shape as `staleKnowledgeCount`.
 * `buildAdminDigestForAdmin` resolves this to `0` (line omitted) without
 * issuing the query whenever `config.knowledgeLinkCheck.enabled` is false, so
 * a deployment that hasn't opted into the underlying check is byte-identical
 * to today regardless of stray `source_unreachable` rows. Rendered only when
 * `> 0`; bare integer only, never a URL, title, or entry id — the pointer
 * text directs the admin to the existing `list_knowledge({ sourceUnreachable:
 * true })` filter. Append-only trailing param, default 0, so every existing
 * call site is unaffected and the quiet case is byte-identical to the
 * pre-#624 form.
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
  duplicateKnowledgeCount: number = 0,
  conflictCandidateCount: number = 0,
  // The content-age ceiling (KNOWLEDGE_STALE_MAX_AGE_DAYS, #380). Passed so the
  // stale-knowledge line names the threshold that ACTUALLY produced the count —
  // in ceiling-only mode (KNOWLEDGE_STALE_DAYS=0) the count comes from this
  // ceiling, not a 0-day window, so rendering the raw `knowledgeStaleDays`
  // would read "untouched for 0d+".
  knowledgeStaleMaxAgeDays: number = 0,
  // Sub-count of `pendingKnowledgeCandidates` that have sat unreviewed past
  // `KNOWLEDGE_CANDIDATE_STALE_DAYS` (issue #398). Always a subset of
  // `pendingKnowledgeCandidates`, so it never needs its own entry in the
  // all-signals-zero gate below — when the knob is unset/0 this stays 0 and
  // the pending-candidates line is byte-identical to its pre-#398 form.
  pendingKnowledgeCandidatesStaleCount: number = 0,
  knowledgeCandidateStaleDays: number = 0,
  // Upper-bound count of members who may still be muted despite aging out of
  // countMutedMembers's windowed definition — reuses that same count's
  // strikeLimit/windowDays, appended last (not grouped with mutedMembersCount
  // above) so every existing positional call site is unaffected (issue #403).
  staleMutedMembersCount: number = 0,
  // Standing size of the onboarding queue — `server_roster` rows with
  // `left_at IS NULL` and no matching `community_users` row (issue #460).
  // Unlike `joinedThisWeek`/`leftThisWeek`, this carries no rolling window,
  // so it's the still-missing proactive half of the queue #47's `list_roster
  // filter: not_members` already exposes pull-only. The caller passes `0`
  // (line omitted) for an `'open'`-access-mode platform, where every
  // not_members row already has full member-tool access and the count would
  // be a structurally meaningless nag — see `runAdminDigestOnce`.
  notMembersCount: number = 0,
  // Sub-count of `knowledgeGapsCount` written by a CONFIRMED member
  // escalation (issue #479) rather than a passive below-floor
  // `knowledge_search` miss — the strongest curation-priority signal
  // (issue #514). Always a subset of `knowledgeGapsCount`, so — like
  // `pendingKnowledgeCandidatesStaleCount` above — it never needs its own
  // entry in the all-signals-zero gate below; at `0` the digest is
  // byte-identical to its pre-#514 form.
  escalatedKnowledgeGapsCount: number = 0,
  // Last week's signal counts, keyed by the same names as the params above
  // (issue #497) — `undefined` when trends are disabled or this is the
  // admin's first-ever digest, in which case `trendSuffix` renders nothing
  // and output is byte-identical to the pre-#497 form. Never fetched unless
  // `config.adminDigest.trendsEnabled` (see `runAdminDigestOnce`).
  previousCounts?: Record<string, number>,
  // Whole-day age of the oldest pending access request
  // (`oldestAccessRequestAgeDays`, issue #515) — append-only trailing param,
  // `null` by default so every existing call site is unaffected. Only ever
  // rendered alongside the existing `pendingAccessRequests > 0` line below,
  // and only when non-null (an empty `access_requests` table has no
  // meaningful age), so the quiet case (`pendingAccessRequests === 0`) is
  // byte-identical to its pre-#515 form regardless of what's passed here.
  oldestAccessRequestAgeDays: number | null = null,
  // Whole-day age of the oldest open report / oldest pending suggestion
  // (`oldestOpenReportAgeDays`/`oldestPendingSuggestionAgeDays`, issue #450) —
  // the same append-only trailing-param, non-null-only, refine-an-existing-
  // line shape as `oldestAccessRequestAgeDays` (#515) above. Each only ever
  // decorates its already-nonzero count line (`openReports`/`pendingSuggestions
  // > 0`) and only when non-null (an empty scoped set has no meaningful age),
  // so the quiet case and every caller that hasn't wired these through are
  // byte-identical to the pre-#450 form. Bare integer only, same privacy
  // convention as every signal above.
  oldestOpenReportAgeDays: number | null = null,
  oldestPendingSuggestionAgeDays: number | null = null,
  // Unhelpful ratings on general-knowledge (ungrounded) answers — the
  // `knowledgeEntryId IS NULL` complement of `lowRatedKnowledgeCount`
  // (issue #563). Append-only trailing param, default 0, so every existing
  // call site is unaffected.
  generalUnhelpfulCount: number = 0,
  // Origin-split (auto-answered vs addressed) `answer_feedback` counts from
  // `answerFeedbackOriginSummary` (issue #592) — #477's own named
  // helpful-ratio-vs-mention-mode success metric. Four append-only trailing
  // params, default 0, so every existing call site is unaffected.
  autoAnswerHelpful: number = 0,
  autoAnswerUnhelpful: number = 0,
  addressedHelpful: number = 0,
  addressedUnhelpful: number = 0,
  // Guild-wide-by-platform count of open moderation appeals
  // (`countOpenAppeals`, issue #631) — the digest line #554 and #622 both
  // named and deferred as a follow-up. Append-only trailing param, default
  // 0, so every existing call site is unaffected.
  openAppealsCount: number = 0,
  // Guild-wide count of knowledge entries flagged `source_unreachable = true`
  // by the weekly link-rot checker (`countUnreachableSourceKnowledge`, issue
  // #624) — #448's own named, deferred digest fold-in. Append-only trailing
  // param, default 0, so every existing call site is unaffected.
  unreachableSourceKnowledgeCount: number = 0,
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
    maxTurnsFailuresCount === 0 &&
    duplicateKnowledgeCount === 0 &&
    conflictCandidateCount === 0 &&
    staleMutedMembersCount === 0 &&
    notMembersCount === 0 &&
    generalUnhelpfulCount === 0 &&
    autoAnswerHelpful === 0 &&
    autoAnswerUnhelpful === 0 &&
    openAppealsCount === 0 &&
    unreachableSourceKnowledgeCount === 0
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
    // Oldest-age fragment only when the aggregate resolved to a real day
    // count — an empty table (or a caller that hasn't wired the new param
    // through) renders the line exactly as before #515 (issue #515).
    const ageFragment =
      oldestAccessRequestAgeDays !== null ? `, oldest waiting ${oldestAccessRequestAgeDays}d` : '';
    sections.push(
      `⏳ ${pendingAccessRequests} pending access request(s)${ageFragment} — run \`list_access_requests\`.` +
        trendSuffix('pendingAccessRequests', pendingAccessRequests, previousCounts),
    );
  }
  if (openReports > 0) {
    // Oldest-age fragment only when the scoped aggregate resolved to a real
    // day count — an empty scoped set (or a caller that hasn't wired the new
    // param through) renders the line exactly as before #450 (issue #450).
    const ageFragment = oldestOpenReportAgeDays !== null ? `, oldest ${oldestOpenReportAgeDays}d old` : '';
    sections.push(
      `🚩 ${openReports} open report(s) in your conversations${ageFragment} — run \`list_reports\`.` +
        trendSuffix('openReports', openReports, previousCounts),
    );
  }
  if (pendingSuggestions > 0) {
    // Same oldest-age refinement as the report line above (issue #450).
    const ageFragment =
      oldestPendingSuggestionAgeDays !== null ? `, oldest ${oldestPendingSuggestionAgeDays}d old` : '';
    sections.push(
      `💡 ${pendingSuggestions} pending suggestion(s)${ageFragment} — run \`list_suggestions\`.` +
        trendSuffix('pendingSuggestions', pendingSuggestions, previousCounts),
    );
  }
  if (staleKnowledgeCount > 0) {
    // Name whichever threshold(s) actually produced the count. `countStaleKnowledge`
    // marks an entry stale if it's been untouched for `knowledgeStaleDays` OR its
    // content is older than `knowledgeStaleMaxAgeDays` (#380), and either knob can
    // be on alone — so in ceiling-only mode this reads "with content older than
    // 90d", never "untouched for 0d+".
    const thresholds: string[] = [];
    if (knowledgeStaleDays > 0) thresholds.push(`untouched for ${knowledgeStaleDays}d+`);
    if (knowledgeStaleMaxAgeDays > 0) thresholds.push(`with content older than ${knowledgeStaleMaxAgeDays}d`);
    sections.push(
      `📚 ${staleKnowledgeCount} knowledge entr${staleKnowledgeCount === 1 ? 'y' : 'ies'} ` +
        `${thresholds.join(' or ')} — run \`list_knowledge\` to review.` +
        trendSuffix('staleKnowledgeCount', staleKnowledgeCount, previousCounts),
    );
  }
  if (knowledgeGapsCount > 0) {
    // Bare integer only — no query_text / user_id ever reaches the DM (#246).
    sections.push(
      `🕳️ ${knowledgeGapsCount} unanswered question(s) in your conversations this week hit no ` +
        'knowledge — run `list_knowledge_gaps` to see what to document.' +
        trendSuffix('knowledgeGapsCount', knowledgeGapsCount, previousCounts),
    );
    if (escalatedKnowledgeGapsCount > 0) {
      // Bare integer only — no query_text / user_id ever reaches the DM,
      // same privacy shape as the line above (#514).
      sections.push(
        `🆘 ${escalatedKnowledgeGapsCount} of those were member-flagged (asked a human directly) — start here.` +
          trendSuffix('escalatedKnowledgeGapsCount', escalatedKnowledgeGapsCount, previousCounts),
      );
    }
  }
  if (pendingKnowledgeCandidates > 0) {
    // Bare integers only — no candidate title/content/topic ever reaches the
    // DM (#284, extended by #398). The stale sub-count only appears when
    // KNOWLEDGE_CANDIDATE_STALE_DAYS is set AND at least one pending
    // candidate has crossed it — with the knob unset or the sub-count at 0,
    // this line stays byte-identical to the pre-#398 (#284) wording.
    const staleFragment =
      knowledgeCandidateStaleDays > 0 && pendingKnowledgeCandidatesStaleCount > 0
        ? `, ${pendingKnowledgeCandidatesStaleCount} unreviewed for ${knowledgeCandidateStaleDays}d+`
        : '';
    sections.push(
      `🧩 ${pendingKnowledgeCandidates} pending knowledge candidate(s)${staleFragment} — run ` +
        '`list_knowledge_candidates`.' +
        trendSuffix('pendingKnowledgeCandidates', pendingKnowledgeCandidates, previousCounts),
    );
  }
  if (lowRatedKnowledgeCount > 0) {
    // Bare integer only — no entry title/rating content/rater identity ever reaches the DM (#324).
    sections.push(
      `👎 ${lowRatedKnowledgeCount} knowledge entr${lowRatedKnowledgeCount === 1 ? 'y' : 'ies'} with ` +
        'repeated unhelpful ratings — run `list_low_rated_knowledge` to review.' +
        trendSuffix('lowRatedKnowledgeCount', lowRatedKnowledgeCount, previousCounts),
    );
  }
  if (joinedThisWeek > 0 || leftThisWeek > 0) {
    // Bare integers only — no display name/user id/platform id ever reaches the DM (#344).
    // One trendSuffix call per underlying signal (issue #497) — joined and
    // left move independently, so each gets its own delta appended right
    // after its own number.
    const parts: string[] = [];
    if (joinedThisWeek > 0) {
      parts.push(`${joinedThisWeek} joined${trendSuffix('joinedThisWeek', joinedThisWeek, previousCounts)}`);
    }
    if (leftThisWeek > 0) {
      parts.push(`${leftThisWeek} left${trendSuffix('leftThisWeek', leftThisWeek, previousCounts)}`);
    }
    sections.push(`📈 ${parts.join(', ')} this week — run \`list_roster\` for detail.`);
  }
  if (notMembersCount > 0) {
    // Bare integer only — no display name, user id, or joined_at ever reaches the DM (#460).
    sections.push(
      `🆕 ${notMembersCount} guest(s) joined but haven't been added as a member yet — run ` +
        '`list_roster` (filter: not_members) to review.' +
        trendSuffix('notMembersCount', notMembersCount, previousCounts),
    );
  }
  if (mutedMembersCount > 0 || staleMutedMembersCount > 0) {
    // Bare integers only — no member_warnings.reason/excerpt/user_id/name ever reaches the DM (#357, #403).
    // Each of the two independent signals gets its own trendSuffix (#497),
    // same one-call-per-signal convention as the roster-growth line above.
    const staleClause =
      staleMutedMembersCount > 0
        ? ` (${staleMutedMembersCount} more may still be muted from an earlier strike that's since aged ` +
          'out — check moderation_history' +
          trendSuffix('staleMutedMembersCount', staleMutedMembersCount, previousCounts) +
          ')'
        : '';
    sections.push(
      `🔇 ${mutedMembersCount} member(s) currently muted` +
        trendSuffix('mutedMembersCount', mutedMembersCount, previousCounts) +
        `${staleClause} — run \`moderation_history\` or ` +
        '`clear_warnings` to review.',
    );
  }
  if (maxTurnsFailuresCount > 0) {
    // Bare integer only — no message content, question text, user id, or conversation id ever reaches the DM (#371).
    sections.push(
      `⏱️ ${maxTurnsFailuresCount} repl${maxTurnsFailuresCount === 1 ? 'y' : 'ies'} in your conversations ` +
        'this week hit the step limit before finishing.' +
        trendSuffix('maxTurnsFailuresCount', maxTurnsFailuresCount, previousCounts),
    );
  }
  if (generalUnhelpfulCount > 0) {
    // Bare integer only — no question text, answer content, comment, or
    // user id ever reaches the DM (#563), same privacy convention as every
    // other digest line.
    sections.push(
      `⚠️ ${generalUnhelpfulCount} general-knowledge answer${generalUnhelpfulCount === 1 ? '' : 's'} rated ` +
        'unhelpful this week (no knowledge-base grounding) — run `list_answer_feedback` (unhelpfulOnly) to review.' +
        trendSuffix('generalUnhelpfulCount', generalUnhelpfulCount, previousCounts),
    );
  }
  if (autoAnswerHelpful + autoAnswerUnhelpful > 0) {
    // Bare ratios/counts only — no message content, question text, or rater
    // identity ever reaches the DM, same privacy convention as every other
    // digest line (issue #592). The "vs ... addressed" comparison is only
    // appended when there's at least one addressed-mode rating to compare
    // against, so a guild with auto-answer ratings but none yet on addressed
    // replies still gets a well-formed line.
    const autoTotal = autoAnswerHelpful + autoAnswerUnhelpful;
    const autoPct = Math.round((autoAnswerHelpful / autoTotal) * 100);
    const addressedTotal = addressedHelpful + addressedUnhelpful;
    const comparisonFragment =
      addressedTotal > 0
        ? ` vs ${Math.round((addressedHelpful / addressedTotal) * 100)}% helpful ` +
          `(${addressedHelpful}/${addressedTotal}) addressed`
        : '';
    sections.push(
      `📊 Auto-answer ratings: ${autoPct}% helpful (${autoAnswerHelpful}/${autoTotal})${comparisonFragment}.`,
    );
  }
  if (duplicateKnowledgeCount > 0) {
    // Bare integer only — no pair id, title, or content ever reaches the DM (#378).
    sections.push(
      `🔀 ${duplicateKnowledgeCount} near-duplicate knowledge pair(s) — run \`list_duplicate_knowledge\` ` +
        'to review.' +
        trendSuffix('duplicateKnowledgeCount', duplicateKnowledgeCount, previousCounts),
    );
  }
  if (conflictCandidateCount > 0) {
    // Bare integer only — no pair id, title, or content ever reaches the DM (#378).
    sections.push(
      `⚖️ ${conflictCandidateCount} conflict-candidate knowledge pair(s) that may disagree — run ` +
        '`list_knowledge_conflicts` to review.' +
        trendSuffix('conflictCandidateCount', conflictCandidateCount, previousCounts),
    );
  }
  if (openAppealsCount > 0) {
    // Bare integer only — no appellant user_name/reason/user_id ever reaches the DM (#631).
    sections.push(
      `📋 ${openAppealsCount} open moderation appeal(s) awaiting review — run \`list_appeals\` to review.` +
        trendSuffix('openAppealsCount', openAppealsCount, previousCounts),
    );
  }
  if (unreachableSourceKnowledgeCount > 0) {
    // Bare integer only — no source URL, entry title, or entry id ever reaches the DM (#624).
    sections.push(
      `🔗 ${unreachableSourceKnowledgeCount} knowledge entr${unreachableSourceKnowledgeCount === 1 ? 'y' : 'ies'} ` +
        'with an unreachable source link — run `list_knowledge` (filter: sourceUnreachable) to review.' +
        trendSuffix('unreachableSourceKnowledgeCount', unreachableSourceKnowledgeCount, previousCounts),
    );
  }
  return sections.join('\n');
}

/**
 * Gathers every digest signal for ONE admin and renders them via
 * {@link buildAdminDigestMessage}. Returns both `message` — the exact text
 * `runAdminDigestOnce` would DM that admin at this instant, or `null` on a
 * quiet week — and `currentCounts`, the trend-snapshot signal map (issue #497),
 * which is populated on every path (quiet week included) so the scheduled push
 * can persist it via `recordAdminDigestSnapshot`/`recordAdminDigestSent`
 * regardless of the send outcome. The week-over-week trend suffixes are only
 * READ (and only when `config.adminDigest.trendsEnabled`), never written, here.
 * Extracted (issue #499) so the weekly push and an on-demand pull (the
 * `admin_digest` tool) share one gathering implementation instead of a second,
 * driftable copy — every scoping/exclusion comment on the inlined block this
 * replaced (see `runAdminDigestOnce`'s own doc comment below) still applies
 * verbatim.
 *
 * Deliberately excludes the freshness/cadence bookkeeping
 * (`wasAdminDigestSentRecently`/`recordAdminDigestSent`) and the actual
 * `sendDirectMessage` — those stay exclusive to `runAdminDigestOnce`'s
 * per-admin loop, so a caller of this helper (the on-demand pull) can never
 * suppress or reset the next scheduled weekly push.
 */
export async function buildAdminDigestForAdmin(
  platform: Platform,
  platformUserId: string,
  adapter: PlatformAdapter,
): Promise<{ message: string | null; currentCounts: Record<string, number> }> {
  const scope = await adapter.conversationsForUser(platformUserId);
  // Exclude reports filed against ANY of this admin's linked identities from
  // their own open-report count, matching list_reports (issue #197).
  const viewerIds = (await resolveLinkedIdentities(platform, platformUserId)).map((i) => i.userId);
  const knowledgeStaleDays = config.adminDigest.knowledgeStaleDays;
  const knowledgeStaleMaxAgeDays = config.adminDigest.knowledgeStaleMaxAgeDays;
  const knowledgeCandidateStaleDays = config.adminDigest.knowledgeCandidateStaleDays;
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
    staleMutedMembersCount,
    maxTurnsFailuresCount,
    duplicateKnowledgeCount,
    conflictCandidateCount,
    pendingKnowledgeCandidatesStaleCount,
    oldestAccessRequestAge,
    escalatedKnowledgeGapsCount,
    oldestOpenReportAge,
    oldestPendingSuggestionAge,
    generalUnhelpfulCount,
    answerOriginSummary,
    openAppealsCount,
    unreachableSourceKnowledgeCount,
  ] = await Promise.all([
    recentQuestionClusters(scope, FRESHNESS_DAYS, CLUSTER_LIMIT),
    countAccessRequests(),
    countOpenReports(scope, viewerIds),
    countPendingSuggestions(),
    // The ceiling can be set on its own (KNOWLEDGE_STALE_DAYS=0,
    // KNOWLEDGE_STALE_MAX_AGE_DAYS>0 is a valid config combo) — gate on
    // either being on, so an operator running ceiling-only mode isn't
    // silently skipped here the way this whole issue is about (#380).
    knowledgeStaleDays > 0 || knowledgeStaleMaxAgeDays > 0
      ? countStaleKnowledge(knowledgeStaleDays, knowledgeStaleMaxAgeDays)
      : Promise.resolve(0),
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
    rosterCounts(platform),
    // Guild-wide by platform like rosterCounts (member_warnings has no
    // conversation/channel column); reuses config.moderation.strikeLimit/
    // strikeWindowDays verbatim so "muted" here can never disagree with
    // the actual mute trigger in moderator.ts (issue #357).
    countMutedMembers(platform, config.moderation.strikeLimit, config.moderation.strikeWindowDays),
    // Same platform/strikeLimit/strikeWindowDays as countMutedMembers just
    // above — the disjoint, aged-out-but-still-over-the-unwindowed-limit
    // cohort that count's windowed definition necessarily excludes (#403).
    countStaleMutedMembers(platform, config.moderation.strikeLimit, config.moderation.strikeWindowDays),
    // Conversation-scoped like knowledgeGapsCount (interactions.conversation_id),
    // over the same freshness window (#371).
    countMaxTurnsFailures(scope, FRESHNESS_DAYS),
    // Guild-wide, unscoped — matching countStaleKnowledge/
    // countPendingKnowledgeCandidates (issue #378).
    countDuplicateKnowledge(),
    countKnowledgeConflictCandidates(),
    // Guild-wide, unscoped like countPendingKnowledgeCandidates (issue
    // #398); only runs the extra COUNT(*) when the knob is configured,
    // matching countStaleKnowledge's own opt-in gating above.
    knowledgeCandidateStaleDays > 0
      ? countStalePendingKnowledgeCandidates(knowledgeCandidateStaleDays)
      : Promise.resolve(0),
    // Guild-wide, unscoped like countAccessRequests above — the same
    // MIN(first_requested_at) oldest-age mechanic issue #450 applies to
    // reports/suggestions, applied to access_requests (issue #515).
    oldestAccessRequestAgeDays(),
    // Conversation-scoped like knowledgeGapsCount (same table/column), over
    // the same freshness window — the confirmed-escalation subset of that
    // count (issue #514).
    countEscalatedKnowledgeGaps(scope, FRESHNESS_DAYS),
    // Oldest-age companions to openReports/pendingSuggestions above — each
    // over exactly its sibling count's scoped row set (openReport age inherits
    // countOpenReports's conversation+viewer scoping; suggestion age is
    // guild-wide like its count), so neither can surface an age for a row the
    // paired count wouldn't include (issue #450).
    oldestOpenReportAgeDays(scope, viewerIds),
    oldestPendingSuggestionAgeDays(),
    // Conversation-scoped like maxTurnsFailuresCount (answer_feedback has a
    // conversation_id), over the same freshness window — the
    // `knowledgeEntryId IS NULL` complement of lowRatedKnowledgeCount
    // (issue #563).
    countGeneralUnhelpfulAnswers(scope, FRESHNESS_DAYS),
    // Conversation-scoped like lowRatedKnowledgeCount (answer_feedback has a
    // conversation_id); cumulative, no freshness window, same rationale as
    // that count — the auto-answer-vs-addressed origin split #477 named as
    // its own success metric but never wired up (issue #592).
    answerFeedbackOriginSummary(scope),
    // Guild-wide by platform like countMutedMembers/rosterCounts
    // (moderation_appeals has no conversation_id) — the digest backlog line
    // #554 and #622 both named and deferred (issue #631).
    countOpenAppeals(platform),
    // Guild-wide, unscoped like countStaleKnowledge — only runs the extra
    // COUNT(*) when the underlying weekly link-rot checker is enabled,
    // matching countStaleKnowledge's own opt-in gating above. With the flag
    // off, source_unreachable is never set true on any row, so resolving to
    // 0 here (rather than issuing the query) keeps the digest byte-identical
    // to today regardless of stray rows (issue #624).
    config.knowledgeLinkCheck.enabled ? countUnreachableSourceKnowledge() : Promise.resolve(0),
  ]);
  // Onboarding-queue count only means anything in 'gated' mode — an
  // 'open'-mode not_members row already has full member-tool access
  // (router.ts's guest-vs-member gate), so it's suppressed to 0 (line
  // omitted) rather than nagged (issue #460).
  const notMembersCount = config.rbac.accessMode[platform] === 'gated' ? roster.notMembers : 0;
  // Every signal that can carry a trend suffix (issue #497) — the exact same
  // values just computed above, nothing re-derived. Returned to the caller on
  // every code path (including a quiet week where `message` is null) so the
  // scheduled `runAdminDigestOnce` can persist them regardless of `trendsEnabled`;
  // only the READ side (fetching `previousCounts` here and passing it into
  // `buildAdminDigestMessage`) is flag-gated.
  const currentCounts: Record<string, number> = {
    pendingAccessRequests,
    openReports,
    pendingSuggestions,
    staleKnowledgeCount,
    knowledgeGapsCount,
    pendingKnowledgeCandidates,
    lowRatedKnowledgeCount,
    joinedThisWeek: roster.joinedThisWeek,
    leftThisWeek: roster.leftThisWeek,
    mutedMembersCount,
    maxTurnsFailuresCount,
    duplicateKnowledgeCount,
    conflictCandidateCount,
    staleMutedMembersCount,
    notMembersCount,
    escalatedKnowledgeGapsCount,
    generalUnhelpfulCount,
    openAppealsCount,
    unreachableSourceKnowledgeCount,
  };
  const previousCounts = config.adminDigest.trendsEnabled
    ? ((await getLastDigestCounts(platform, platformUserId)) ?? undefined)
    : undefined;
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
    duplicateKnowledgeCount,
    conflictCandidateCount,
    knowledgeStaleMaxAgeDays,
    pendingKnowledgeCandidatesStaleCount,
    knowledgeCandidateStaleDays,
    staleMutedMembersCount,
    notMembersCount,
    escalatedKnowledgeGapsCount,
    previousCounts,
    oldestAccessRequestAge,
    oldestOpenReportAge,
    oldestPendingSuggestionAge,
    generalUnhelpfulCount,
    answerOriginSummary.autoAnswer.helpful,
    answerOriginSummary.autoAnswer.unhelpful,
    answerOriginSummary.addressed.helpful,
    answerOriginSummary.addressed.unhelpful,
    openAppealsCount,
    unreachableSourceKnowledgeCount,
  );
  return { message, currentCounts };
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
 * stale-knowledge, and pending-candidate counts. `oldestAccessRequestAgeDays`
 * (issue #515) is fetched alongside `countAccessRequests` and is guild-wide
 * for the same reason, so every enrolled admin sees the same
 * oldest-pending-request age too. `oldestPendingSuggestionAgeDays` (issue #450)
 * is likewise fetched alongside `countPendingSuggestions` and guild-wide, while
 * `oldestOpenReportAgeDays` (issue #450) is fetched alongside `countOpenReports`
 * with the SAME `scope`+`viewerIds` arguments — so a report's age inherits the
 * exact conversation/DM scoping and self-report exclusion its count already
 * has, and an admin can never see the age of a report outside their scope.
 * `countStaleKnowledge` only runs when
 * `KNOWLEDGE_STALE_DAYS` is configured (`> 0`) — otherwise the signal stays
 * `0` and the digest is byte-for-byte unchanged from before issue #199.
 * `rosterCounts(admin.platform)` is likewise guild-wide by platform — same
 * signal every enrolled admin on that platform sees (issue #344); `server_roster`
 * is Discord-only, so a WhatsApp admin's `rosterCounts('whatsapp')` is always
 * zeros, leaving the rest of their digest byte-for-byte unchanged. Its
 * `notMembers` field (issue #460) is only forwarded to the digest when
 * `config.rbac.accessMode[admin.platform] === 'gated'` — an `'open'`-mode
 * not_members row already has full member-tool access, so the count would be
 * a structurally meaningless nag there; it is suppressed to `0` instead.
 * `countMutedMembers(admin.platform, ...)` is likewise guild-wide by platform
 * (`member_warnings` has no conversation/channel column either), reusing
 * `config.moderation.strikeLimit`/`strikeWindowDays` verbatim so two admins on
 * the same platform always see the same muted-member count (issue #357).
 * `countStaleMutedMembers(admin.platform, ...)` reuses the identical
 * `strikeLimit`/`strikeWindowDays` pair alongside it (issue #403) — same
 * guild-wide-by-platform scoping, and provably a no-op query when
 * `strikeWindowDays` is unset (the default).
 * `countMaxTurnsFailures(scope, ...)` is conversation-scoped by `scope`
 * (`interactions` has a `conversation_id`), same as `countKnowledgeGaps`
 * (issue #371). `countEscalatedKnowledgeGaps(scope, ...)` is likewise
 * conversation-scoped and windowed identically to `countKnowledgeGaps` — the
 * confirmed-escalation subset of that same count (issue #514).
 * `countDuplicateKnowledge()`/`countKnowledgeConflictCandidates()`
 * are guild-wide, unscoped calls (issue #378) — matching `countStaleKnowledge`/
 * `countPendingKnowledgeCandidates`, since the pair self-joins carry no
 * conversation scope either. `answerFeedbackOriginSummary(scope)` is
 * conversation-scoped like `countLowRatedKnowledge` (`answer_feedback` has a
 * conversation_id); cumulative, no freshness window — the origin split #477
 * named as its own success metric and issue #592 finally wires up.
 * `countOpenAppeals(admin.platform)` is guild-wide by platform like
 * `countMutedMembers` (`moderation_appeals` has no conversation_id) — the
 * digest backlog line #554 and #622 both named and deferred (issue #631).
 * The freshness guard
 * (`admin_digest_sends`) is a durable per-admin timestamp, so a restart
 * mid-week cannot cause a duplicate send within the same window. Super
 * admins are not enrolled — `listAdmins` only returns `community_users`
 * admins; super admins keep the on-demand, unrestricted-scope
 * `question_digest`/`list_access_requests`/`list_reports` tools instead.
 *
 * Total-failure signal for `startTrackedJob` (issue #385, applying #335's
 * fix at the outset): a `listAdmins()` rejection propagates directly — that
 * is unambiguously a total failure, never a "zero admins" success. Within
 * the per-admin loop, an admin counts as `attempted` once a connected
 * adapter is found for it, and as `succeeded` if its try block completes
 * without throwing — a freshness-guard skip and a quiet-week no-send both
 * count as success (nothing went wrong), only a caught error does not. If
 * at least one admin was attempted and every attempted admin failed, the
 * function throws after the loop; a partial failure (some succeed, some
 * fail) or a legitimate zero-attempt run (no admins, or no connected
 * adapter for any of them) never throws, matching #335's
 * partial-failure-must-never-throw convention.
 */
export async function runAdminDigestOnce(adapters: readonly PlatformAdapter[]): Promise<void> {
  const admins = await listAdmins();

  let attempted = 0;
  let succeeded = 0;

  for (const admin of admins) {
    const adapter = adapters.find((a) => a.platform === admin.platform && a.isConnected());
    if (!adapter) continue;

    attempted++;
    let ok = false;
    try {
      const alreadySent = await wasAdminDigestSentRecently(
        admin.platform,
        admin.platformUserId,
        FRESHNESS_DAYS,
      );
      if (alreadySent) {
        ok = true;
        continue;
      }

      const { message, currentCounts } = await buildAdminDigestForAdmin(
        admin.platform,
        admin.platformUserId,
        adapter,
      );
      if (!message) {
        // Quiet week — no send, so the freshness row/eligibility window must
        // stay untouched. `recordAdminDigestSnapshot` writes ONLY
        // `last_counts`, never `sent_at` (issue #497), so next week's trend
        // delta is still accurate against real data.
        await recordAdminDigestSnapshot(admin.platform, admin.platformUserId, currentCounts);
        ok = true;
        continue; // quiet week — no send, freshness row untouched
      }

      await adapter.sendDirectMessage(admin.platformUserId, message);
      await recordAdminDigestSent(admin.platform, admin.platformUserId, currentCounts);
      ok = true;
    } catch (err) {
      logger.warn(
        { err, platform: admin.platform, id: admin.platformUserId },
        'Admin digest: per-admin run failed',
      );
    } finally {
      if (ok) succeeded++;
    }
  }

  if (attempted > 0 && succeeded === 0) {
    throw new Error(`Admin digest: all ${attempted} admin runs failed`);
  }
}

/**
 * Timer (gated behind ADMIN_DIGEST_ENABLED, off by default — no timer
 * created when unset) that pushes each `community_users` admin a weekly DM
 * summarising recurring-question clusters in their own scoped conversations,
 * plus pending access-request, open-report, pending-suggestion, (when
 * `KNOWLEDGE_STALE_DAYS` is configured) stale-knowledge, pending
 * knowledge-candidate, low-rated-knowledge, roster joined/left-this-week,
 * currently-muted-member, upper-bound stale-muted-member, near-duplicate-
 * knowledge-pair, conflict-candidate-knowledge-pair, general-knowledge-
 * unhelpful-rating, auto-answer-vs-addressed helpful-ratio, open-moderation-
 * appeal, and (in `'gated'`
 * access mode) onboarding-queue counts, plus (when at least one request is
 * pending) the oldest pending access request's age in days (issue #21's
 * deferred proactive follow-up, extended by issue #133, issue #193, issue
 * #199, issue #284, issue #324, issue #344, issue #357, issue #378, issue
 * #403, issue #460, issue #515, issue #563, issue #592, and issue #631) — the
 * same signals
 * `question_digest`/`list_access_requests`/`list_reports`/
 * `list_suggestions`/`list_knowledge`/`list_knowledge_candidates`/
 * `list_low_rated_knowledge`/`list_roster`/`moderation_history`/
 * `list_duplicate_knowledge`/`list_knowledge_conflicts`/`list_appeals`
 * already compute on demand.
 *
 * Routed through `startTrackedJob` (issue #385) rather than a hand-rolled
 * `setInterval`, wiring this job into the same consecutive-scheduled-failure
 * alerting `startContextBuilder`/`startKnowledgeRefresh`/`startDocsIngest`/
 * both retention purges/the status poller already have. `startTrackedJob`
 * ticks every 6h rather than the previous 24h, but each admin's own
 * `wasAdminDigestSentRecently(..., FRESHNESS_DAYS)` guard already makes
 * actual DM sends idempotent at the ~weekly cadence regardless of how often
 * the outer tick fires — the same "outer tick faster than the real
 * cadence, inner freshness guard keeps behaviour unchanged" shape
 * `startKnowledgeRefresh`/`startDocsIngest` already use. `runOnce` is
 * injectable (tests only) so the alerting can be exercised without a real
 * DB/adapters, same convention as every other tracked job.
 */
export function startAdminDigest(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = () => runAdminDigestOnce(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('admin-digest', adapters, config.adminDigest.enabled, runOnce);
}
