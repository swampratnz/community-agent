import { KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD } from '@swampratnz/agent-base/storage/repository.js';
// Kept for import-graph continuity only — this is NO LONGER load-bearing.
// tools/index.ts used to call registerToolTiers/registerToolServerParts/
// registerFlaggedToolPredicates at its own module scope, so importing this
// barrel was what made `buildToolServer`/`toolsForRole` work. It now only
// EXPORTS those three values (COMMUNITY_TOOL_TIERS, COMMUNITY_TOOL_SERVER_PARTS,
// COMMUNITY_FLAGGED_TOOL_PREDICATES); `agentModule.ts` names them and
// `createAgent` performs every registration, after all modules are imported.
import './tools/index.js';

// This file is the BARREL for the tool registry split (docs/
// TOOL-REGISTRY-DESIGN.md §3): every symbol that moved into src/agent/tools/
// is re-exported here so the 20+ existing import sites (tests especially)
// keep working unchanged. Every tool now lives in a ToolDef domain file
// under src/agent/tools/ — and the per-turn server assembly lives in the
// base kernel `agent/toolServer.ts`, re-exported below.
export {
  resolveSanitizedLabel,
  formatRelativeAge,
  type KnowledgeCitationInfo,
  KNOWLEDGE_CONFLICT_CAVEAT_TEXT,
  formatKnowledgeCitationNote,
  KNOWLEDGE_TIE_MARGIN,
  formatKnowledgeSearchResults,
  formatFoundKnowledge,
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
  SUGGESTION_RESOLUTION_ECHO_CHARS,
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
export { EVENTS_LIST_LIMIT, formatCommunityInfoText } from './tools/info.js';
export { CATCH_UP_DEFAULT_HOURS, CATCH_UP_MAX_HOURS, CATCH_UP_MAX_MESSAGES } from './tools/memory.js';
export { APPEAL_MODERATION_REASON_MAX_CHARS } from './tools/reportsMember.js';
export { HUMAN_HELP_REQUEST_DAILY_LIMIT_PER_USER } from './tools/feedback.js';
export { ALLOWED_REACTION_EMOJI, REACTION_RATE_LIMIT_PER_DAY } from './tools/reactions.js';
export { LIST_PROJECTS_DEFAULT_LIMIT, WHO_IS_INTO_NO_PROFILE_HINT } from './tools/social.js';
export { WARN_USER_RATE_LIMIT_PER_HOUR } from './tools/moderation.js';
export { TEAM_SETUP_MEMBER_CAP } from './tools/teamSetup.js';
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
} from '@swampratnz/agent-base/agent/webSearchGuard.js';

/**
 * Turn-scoped, mutable correlation state threaded in from `execTurn` (issue
 * #411) — the generic, module-augmentable bag from `agent/turnState.ts`
 * (agent-base plan §3): base declares it empty, and this module's keys
 * (`lastKnowledgeHitId`, `unhelpfulAnswerRated`, `knowledgeGapCluster`,
 * `staleKnowledgeAlertIds`, `humanHelpRequested` — full contracts documented
 * there) live in `agent/communityTurnState.ts`, whose registering
 * side-effect import now sits in src/index.ts's composition-root block (and
 * in the preambles of tests that finalize turn state without loading it).
 * Still optional on the tool context, so every existing
 * `buildToolServer(caller, adapter)` call keeps compiling unchanged.
 */
export type { ToolServerTurnState } from '@swampratnz/agent-base/agent/turnState.js';

/**
 * The per-turn server assembly moved to the base kernel (agent-base plan §2
 * `agent/` row): `buildToolServer` there composes whatever parts the
 * community registry registered (tools/index.ts). Re-exported so existing
 * import sites keep working unchanged.
 */
export { buildToolServer } from '@swampratnz/agent-base/agent/toolServer.js';
