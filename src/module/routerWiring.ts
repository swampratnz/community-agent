import { runAgentTurn } from '../base/agent/core.js';
import {
  formatKnowledgeCitationNote,
  formatRelativeAge,
  KNOWLEDGE_CONFLICT_CAVEAT_TEXT,
  notifyAdmins,
  truncateForEcho,
} from './agent/tools.js';
import { buildMemberDigestContent } from './memberDigest.js';
import { isPaused } from '../base/storage/policyStore.js';
import { getCommunityGuidelines, getCommunityGuidelinesMi } from './storage/policies.js';
import {
  countRepliesToUser,
  getLanguagePreference,
  getResponseStyle,
  hasKnowledgeConflictForId,
  isKnowledgeLowRated,
  listOwnProjects,
  listRecentInterests,
  listRecentProjects,
  markKnowledgeGapsAlerted,
  markStaleKnowledgeAlerted,
  recentQuestionClusters,
  recordAccessRequest,
  recordEscalatedKnowledgeGap,
  recordKnowledgeRetrieval,
  recordShortcutHit as recordShortcutHitDefault,
  searchKnowledge,
  searchMemberInterests,
  searchMemberInterestsForSelf,
  searchProjects,
} from '../base/storage/repository.js';
import { FRESHNESS_DAYS, CLUSTER_LIMIT } from './adminDigest.js';
import { buildGatedNotice } from '../base/gatedNotice.js';
import { notifyAccessRequest, type RouterDeps } from '../base/router.js';

// The router's production wiring (agent-base plan §Phase-2 Stage 3a): the ONE
// place the real implementations behind every `RouterDeps` field are named.
// It lives here — not in router.ts — so the router mechanism itself never
// imports the community content its defaults point at; `src/index.ts` (and
// every test building deps) composes `new Router(makeRouterDeps(...))`.

/**
 * Build a COMPLETE `RouterDeps` — the real production wiring overlaid with
 * `overrides`. This is the one sanctioned way to construct a partial-looking
 * deps object: the result is always full (so `RouterDeps` needs no optional
 * fields), and any field a test doesn't override keeps today's behaviour of
 * falling through to the real implementation — exactly the semantics the old
 * positional-parameter defaults had, made explicit at the call site. An
 * override whose VALUE is `undefined` is skipped too, for the same reason:
 * test helpers forward their own optional parameters straight through
 * (`getLangPref: maybeUndefined`), and under the old positional defaults an
 * `undefined` argument meant "use the real implementation", never "inject
 * undefined".
 */
export function makeRouterDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<RouterDeps>;
  return {
    runTurn: runAgentTurn,
    typingRefireMs: 8_000,
    checkPaused: isPaused,
    searchKnowledgeForShortcut: searchKnowledge,
    recordShortcutRetrieval: recordKnowledgeRetrieval,
    countReplies: countRepliesToUser,
    getLangPref: getLanguagePreference,
    checkLowRatedKnowledge: isKnowledgeLowRated,
    getGatedNotice: buildGatedNotice,
    getRespStyle: getResponseStyle,
    recordShortcutHit: recordShortcutHitDefault,
    recordAccessRequestFn: recordAccessRequest,
    notifyAccessRequestFn: notifyAccessRequest,
    notifyAdminsFn: notifyAdmins,
    recordEscalatedGapFn: recordEscalatedKnowledgeGap,
    markKnowledgeGapsAlertedFn: markKnowledgeGapsAlerted,
    markStaleKnowledgeAlertedFn: markStaleKnowledgeAlerted,
    getCommunityGuidelinesFn: getCommunityGuidelines,
    getCommunityGuidelinesMiFn: getCommunityGuidelinesMi,
    searchMemberInterestsFn: searchMemberInterests,
    searchProjectsFn: searchProjects,
    listRecentProjectsFn: listRecentProjects,
    buildMemberDigestContentFn: buildMemberDigestContent,
    recentQuestionClustersFn: recentQuestionClusters,
    searchMemberInterestsForSelfFn: searchMemberInterestsForSelf,
    checkKnowledgeConflict: hasKnowledgeConflictForId,
    listOwnProjectsFn: listOwnProjects,
    listRecentInterestsFn: listRecentInterests,
    formatKnowledgeCitationNoteFn: formatKnowledgeCitationNote,
    formatRelativeAgeFn: formatRelativeAge,
    knowledgeConflictCaveatText: KNOWLEDGE_CONFLICT_CAVEAT_TEXT,
    truncateForEchoFn: truncateForEcho,
    repeatQuestionFreshnessDays: FRESHNESS_DAYS,
    repeatQuestionClusterLimit: CLUSTER_LIMIT,
    ...defined,
  };
}
