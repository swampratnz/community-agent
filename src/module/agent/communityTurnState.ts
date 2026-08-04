import type { CrossedKnowledgeGapCluster } from '@swampratnz/agent-base/storage/repository.js';
import type { TurnStateFinalizer } from '@swampratnz/agent-base/agent/turnState.js';

/**
 * The NZ-community module's turn-state keys — the ONE community-owned file
 * (agent-base plan §3) that types every key the community tools write into
 * `ToolServerTurnState` and every key the router's post-turn handlers read
 * back off `AgentReply.turnState`. Loaded for its side effect (the finalizer
 * registration below) from `agent/tools.ts`, so anywhere a tool server can
 * be built, the augmentation is live too.
 */
declare module '@swampratnz/agent-base/agent/turnState.js' {
  /** Written by the community tool handlers during the turn (tools/knowledgeMember.ts, tools/feedback.ts). */
  interface ToolServerTurnState {
    /**
     * The top-scoring id of the most recent `knowledge_search` call that had
     * a hit clear `KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD` (issue #411).
     */
    lastKnowledgeHitId?: number | null;
    /**
     * Set `true` only when this turn's `rate_answer` call recorded a genuine
     * `helpful: false` rating (`createAnswerFeedback` returned `{ id }`, not
     * `'no_recent_answer'`/`'rate_limited'`) — never on a positive rating or
     * an unrecorded call (issue #598).
     */
    unhelpfulAnswerRated?: boolean;
    /**
     * Set when this turn's `knowledge_search` below-floor-miss
     * `recordKnowledgeGap` insert crossed `KNOWLEDGE_GAP_ALERT_THRESHOLD`
     * unresolved+unalerted rows in its conversation-scoped cluster for the
     * first time (issue #650).
     */
    knowledgeGapCluster?: CrossedKnowledgeGapCluster | null;
    /**
     * Ids of `knowledge_search` hits served this turn that were newly stale
     * (`isKnowledgeStale` true) at serve time, gated by
     * `KNOWLEDGE_STALE_ALERT_ENABLED` (issue #701). Appended to, never
     * overwritten, so multiple qualifying calls in one turn each alert.
     */
    staleKnowledgeAlertIds?: number[];
    /**
     * Set `true` only when this turn's `request_human_help` call recorded a
     * genuine ask (the caller was under `HUMAN_HELP_REQUEST_DAILY_LIMIT_
     * PER_USER`) — never on a declined-by-cap call (issue #808).
     */
    humanHelpRequested?: boolean;
  }

  /**
   * Read by the router's registered post-turn handlers (router.ts). Every
   * key keeps the exact contract it had as a hardcoded `AgentReply` field:
   * present only when the turn ended in genuine success (`ok === true`) and
   * the signal genuinely fired — never a stale value from a failed attempt,
   * and never read by, or acted on inside, any model-callable tool.
   */
  interface TurnStateBag {
    /**
     * Best-effort correlation with the most recent qualifying
     * `knowledge_search` hit (issue #411) — a correlation, not a guarantee:
     * it names the last qualifying call in the turn, not necessarily the
     * entry the model's final reply drew from. The router's outbound
     * recording stamps it into the same `meta.knowledgeEntryId` key the
     * deterministic knowledge-shortcut path writes, so both paths feed
     * `listKnowledgeFeedbackSummary`/`listAnswerFeedback` unchanged.
     */
    knowledgeEntryId?: number;
    /** `true` only for a genuine thumbs-down recorded this turn (issue #598) — consumed by the router's escalation handler. */
    unhelpfulAnswerRated?: boolean;
    /** `true` only for a genuine `request_human_help` ask this turn (issue #808) — consumed by the router's escalation handler. */
    humanHelpRequested?: boolean;
    /** First-crossing knowledge-gap cluster (issue #650) — consumed by the router's gap-alert handler. */
    knowledgeGapCluster?: CrossedKnowledgeGapCluster;
    /** Newly-stale served entry ids (issue #701) — consumed by the router's stale-knowledge handler. */
    staleKnowledgeAlertIds?: number[];
  }
}

// The community finalizer: byte-for-byte the five conditional spreads that
// used to sit at the bottom of `execTurn`'s genuine-success return —
// absent-not-zero discipline preserved exactly (a `false`, `null` or empty
// array writes NO key at all).
export const COMMUNITY_TURN_STATE_FINALIZER: TurnStateFinalizer = (turnState) => ({
  ...(turnState.lastKnowledgeHitId != null ? { knowledgeEntryId: turnState.lastKnowledgeHitId } : {}),
  ...(turnState.unhelpfulAnswerRated ? { unhelpfulAnswerRated: true } : {}),
  ...(turnState.humanHelpRequested ? { humanHelpRequested: true } : {}),
  ...(turnState.knowledgeGapCluster ? { knowledgeGapCluster: turnState.knowledgeGapCluster } : {}),
  ...(turnState.staleKnowledgeAlertIds && turnState.staleKnowledgeAlertIds.length > 0
    ? { staleKnowledgeAlertIds: turnState.staleKnowledgeAlertIds }
    : {}),
});
