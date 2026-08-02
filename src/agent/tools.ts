import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterLookup, PlatformAdapter } from '../platforms/types.js';
import type { CallerContext } from '../auth/rbac.js';
import { makeCalendarDayReserver, makeSlidingWindowReserver } from '../util/rateReservation.js';
import {
  KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD,
  type CrossedKnowledgeGapCluster,
  getLanguagePreference,
} from '../storage/repository.js';
import { makeToolContext } from './tools/context.js';
import { TOOL_REGISTRY } from './tools/index.js';

// This file is the BARREL for the tool registry split (docs/
// TOOL-REGISTRY-DESIGN.md §3): every symbol that moved into src/agent/tools/
// is re-exported here so the 20+ existing import sites (tests especially)
// keep working unchanged. Every tool now lives in a ToolDef domain file
// under src/agent/tools/ — buildToolServer below is just the per-turn
// context plus the registry.
export {
  resolveSanitizedLabel,
  formatRelativeAge,
  type KnowledgeCitationInfo,
  KNOWLEDGE_LOW_RATED_CAVEAT_TEXT,
  KNOWLEDGE_LOW_RATED_CAVEAT_TEXT_MI,
  KNOWLEDGE_STALE_NOTE_MI,
  KNOWLEDGE_CONFLICT_CAVEAT_TEXT,
  formatKnowledgeCitationNote,
  KNOWLEDGE_TIE_MARGIN,
  formatKnowledgeSearchResults,
  formatKnowledgeTopics,
  formatInterestResults,
  formatProjectResults,
  parseIsoInstant,
  formatUsageStats,
  formatAdminActivity,
  formatEngagementStats,
  type FeatureFlagEntry,
  FEATURE_FLAG_MAP,
  formatFeatureFlags,
  type OtherConfiguredKnobEntry,
  OTHER_CONFIGURED_KNOBS,
  formatOtherConfiguredKnobs,
  truncateForEcho,
  DEV_TEAM_CHAT_CAP,
  devTeamScrub,
  formatDevTeamJobStatus,
  formatDevTeamJobListEntry,
  formatDevTeamJobResult,
  PROJECT_NOTE_RETENTION_NOTICE,
} from './tools/helpers.js';
export {
  notifyAdmins,
  notifyMemberApproved,
  notifyAdminApproved,
  notifySuggestionResolved,
  notifyReportResolved,
  notifyReportFiled,
  notifyReportWithdrawn,
  notifyAppealFiled,
  notifyAppealResolved,
  notifyKnowledgeTipResolved,
  notifyWarningsCleared,
} from './tools/notify.js';
export { reserveDevTeamDispatchDaily } from './tools/devTeam.js';
export { EVENTS_LIST_LIMIT } from './tools/info.js';
export { CATCH_UP_DEFAULT_HOURS, CATCH_UP_MAX_HOURS, CATCH_UP_MAX_MESSAGES } from './tools/memory.js';
export { APPEAL_MODERATION_REASON_MAX_CHARS } from './tools/reportsMember.js';
export { HUMAN_HELP_REQUEST_DAILY_LIMIT_PER_USER } from './tools/feedback.js';
export { ALLOWED_REACTION_EMOJI, REACTION_RATE_LIMIT_PER_DAY } from './tools/reactions.js';
export { LIST_PROJECTS_DEFAULT_LIMIT } from './tools/social.js';
export { WARN_USER_RATE_LIMIT_PER_HOUR } from './tools/moderation.js';
export {
  ANNOUNCE_RATE_LIMIT_PER_HOUR,
  POLL_MIN_OPTIONS,
  POLL_MAX_OPTIONS,
  POLL_QUESTION_MAX_CHARS,
  POLL_OPTION_MAX_CHARS,
  POLL_MIN_DURATION_HOURS,
  POLL_MAX_DURATION_HOURS,
  POLL_DEFAULT_DURATION_HOURS,
  POLL_RATE_LIMIT_PER_HOUR,
  POLL_END_RATE_LIMIT_PER_HOUR,
  THREAD_NAME_MAX_CHARS,
  THREAD_CREATE_RATE_LIMIT_PER_HOUR,
} from './tools/broadcast.js';
export {
  EVENT_NAME_MAX_CHARS,
  EVENT_DESCRIPTION_MAX_CHARS,
  EVENT_LOCATION_MAX_CHARS,
  EVENT_CANCEL_REASON_MAX_CHARS,
} from './tools/events.js';
export { COMMUNITY_GUIDELINES_MAX_CHARS, WELCOME_MESSAGE_MAX_CHARS } from './tools/policyText.js';

// Re-exported (not defined here — see the import above) so storage/
// repository.ts's own `knowledgeCoversTopic` dedup guard (issue #102) can
// share the exact same floor without a repository.ts <-> agent/tools.ts
// import cycle. See the full derivation comment on the definition in
// repository.ts.
export { KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD };

/**
 * Discord image-attachment fetches per platform-qualified sender, for the
 * rolling calendar-day cap (IMAGE_INPUT_DAILY_LIMIT_PER_USER, issue #783) —
 * same calendar-day shape as reserveImageGenDaily/reserveDevTeamDispatchDaily,
 * bounding the real per-image multimodal token cost a single caller could run
 * up. Checked in the adapter BEFORE the MIME/byte check and any fetch, per
 * the acceptance criteria, so an at-cap sender never has their attachment
 * inspected further. `key` MUST be platform-qualified (`` `discord:${senderId}` ``)
 * even though only Discord implements image input today, matching the
 * defensive convention `reserveVoiceTranscriptionSlot` already established.
 */
export const reserveImageInputDaily = makeCalendarDayReserver();

/**
 * The WebSearch guard itself (volume cap, query dedup, per-conversation
 * lock) lives in `webSearchGuard.ts` — WebSearch is a built-in SDK tool
 * gated by `core.ts`'s PreToolUse hook, not one of this file's MCP tools.
 * Re-exported here so existing import sites (tests especially) keep
 * working unchanged.
 */
export {
  reserveWebSearchSlot,
  withWebSearchDedupLock,
  isDuplicateWebSearchQuery,
  recordWebSearchQuery,
} from './webSearchGuard.js';

/**
 * Reserve one voice-transcription slot for `key` against a rolling hourly
 * cap (issue #507; platform-qualified in issue #732 —
 * `config.whatsapp.voice.rateLimitPerHour` /
 * `config.discord.voice.rateLimitPerHour`). Per-sender rather than
 * per-conversation (unlike `reserveWebSearchSlot`) since this bounds one
 * person's own audio volume, not a shared conversation. Returns false
 * without reserving if the sender already hit `limit` within the last hour.
 * Called from `BaileysAdapter`/`DiscordAdapter` BEFORE any media download,
 * so a refused slot never triggers a download/decode/model run. Callers must
 * skip this entirely when `limit` is 0 (unlimited) so the default
 * configuration does no bookkeeping. `key` MUST be platform-qualified
 * (e.g. `` `whatsapp:${senderId}` ``/`` `discord:${senderId}` ``) — a bare
 * sender id would let a WhatsApp phone number and a Discord snowflake that
 * happen to collide share one quota bucket across platforms (issue #732).
 */
export const reserveVoiceTranscriptionSlot = makeSlidingWindowReserver(60 * 60 * 1000);

/**
 * Turn-scoped, mutable correlation state threaded in from `execTurn` (issue
 * #411) — currently the most recent qualifying `knowledge_search` hit and
 * (issue #598) whether `rate_answer` recorded a genuine thumbs-down this
 * turn, mirroring the `languagePreference`/`maxTurnsExceeded` turn-scoped
 * signals already threaded through `TurnOutcome`/`AgentReply`. Optional so
 * every existing `buildToolServer(caller, adapter)` call (this file's own
 * tests, mainly) keeps compiling unchanged; callers that don't care about the
 * correlation simply never read it back.
 */
export interface ToolServerTurnState {
  lastKnowledgeHitId: number | null;
  /**
   * Set `true` only when this turn's `rate_answer` call recorded a genuine
   * `helpful: false` rating (`createAnswerFeedback` returned `{ id }`, not
   * `'no_recent_answer'`/`'rate_limited'`) — never on a positive rating or an
   * unrecorded call. Read back by `execTurn` into `TurnOutcome`/`AgentReply`
   * so `router.ts` can direct-fire `notifyAdmins` post-turn (issue #598);
   * `notifyAdmins` itself is never called from this file — see `rate_answer`
   * below and `notifyAdmins`'s own doc comment.
   */
  unhelpfulAnswerRated?: boolean;
  /**
   * Set when this turn's `knowledge_search` below-floor-miss `recordKnowledgeGap`
   * insert crossed `KNOWLEDGE_GAP_ALERT_THRESHOLD` unresolved+unalerted rows
   * in its conversation-scoped cluster for the first time (issue #650). Read
   * back by `execTurn` into `TurnOutcome`/`AgentReply` so `router.ts` can
   * reserve a rate-limit slot and direct-fire `notifyAdmins` post-turn,
   * mirroring `unhelpfulAnswerRated`'s shape exactly — `notifyAdmins` itself
   * is never called from this file, see its own doc comment.
   */
  knowledgeGapCluster?: CrossedKnowledgeGapCluster | null;
  /**
   * Ids of `knowledge_search` hits served this turn that were newly stale
   * (`isKnowledgeStale` true) at serve time, gated by
   * `KNOWLEDGE_STALE_ALERT_ENABLED` (issue #701) — read back by `execTurn`
   * into `TurnOutcome`/`AgentReply` so `router.ts` can atomically gate+stamp
   * (`markStaleKnowledgeAlerted`) and rate-limit+notify post-turn, mirroring
   * `knowledgeGapCluster`'s shape. Appended to, never overwritten, so
   * multiple qualifying `knowledge_search` calls in one turn each get their
   * own alert. `notifyAdmins` itself is never called from this file — see its
   * own doc comment.
   */
  staleKnowledgeAlertIds?: number[];
  /**
   * Set `true` only when this turn's `request_human_help` call recorded a
   * genuine ask (the caller was under its own `HUMAN_HELP_REQUEST_DAILY_
   * LIMIT_PER_USER` cap) — never on a declined-by-cap call. Read back by
   * `execTurn` into `TurnOutcome`/`AgentReply` so `router.ts` can direct-fire
   * `notifyAdmins` post-turn (issue #808), mirroring `unhelpfulAnswerRated`'s
   * shape exactly — `notifyAdmins` itself is never called from this file,
   * see `request_human_help` below and `notifyAdmins`'s own doc comment.
   */
  humanHelpRequested?: boolean;
}

/**
 * Build the in-process MCP tool server for one agent turn. The tools close
 * over the caller context and the adapter handling this conversation, so
 * RBAC and platform routing are baked in. Layers:
 *  1. The tool list attached to the turn is tier-derived (rbac.toolsForRole).
 *  2. Every privileged tool re-asserts the tier before any side effect.
 *  3. Admin data access is scoped in SQL to conversations the admin is in.
 *  4. Destructive actions require an out-of-band CONFIRM (pendingActions.ts).
 *  5. Everything privileged is audited and alerted to super admins.
 */
export function buildToolServer(
  caller: CallerContext,
  adapter: PlatformAdapter,
  getAdapter?: AdapterLookup,
  turnState?: ToolServerTurnState,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
) {
  const ctx = makeToolContext(caller, adapter, getAdapter, turnState, getLangPref);
  // Attach everything; the per-turn allowedTools list (rbac.toolsForRole) is
  // what actually restricts which of these the model can call.
  return createSdkMcpServer({
    name: 'community',
    version: '2.0.0',
    tools: TOOL_REGISTRY.map((def) =>
      tool(def.name, def.description, def.schema, (args) => def.handler(args, ctx), {
        annotations: { readOnlyHint: def.readOnlyHint },
      }),
    ),
  });
}
