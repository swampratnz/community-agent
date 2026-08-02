import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AdapterLookup, Platform, PlatformAdapter } from '../platforms/types.js';
import { assertAtLeast, atLeast, type CallerContext } from '../auth/rbac.js';
import { normalizeMemberId } from '../auth/memberId.js';
import { sanitizeName } from '../util/sanitizeName.js';
import { makeCalendarDayReserver, makeSlidingWindowReserver } from '../util/rateReservation.js';
import { isSuperAdmin, resolveRole } from '../auth/roles.js';
import { config } from '../config.js';
import { logger, hashId } from '../logger.js';
import {
  acceptKnowledgeCandidate,
  adminActivitySummary,
  addMemberNote,
  clearAccessRequest,
  clearWarnings,
  countAccessRequests,
  countOpenAppeals,
  countOpenReports,
  countPendingKnowledgeCandidates,
  countPendingSuggestions,
  clearUserSessions,
  declineKnowledgeCandidate,
  deleteKnowledge,
  getInteractionContentByMessageId,
  getKnowledgeContentById,
  deleteMemberNote,
  demoteAdmin,
  getMemberNote,
  getMemberRole,
  type KnowledgeCandidate,
  KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD,
  type KnowledgeDuplicateMatch,
  listDuplicateKnowledge,
  listKnowledgeConflictCandidates,
  listKnowledgeCandidates,
  listBlockedUsers,
  listMemberNotes,
  listMemberWarnings,
  listMutedMembers,
  MEMBER_NOTE_MAX_CHARS,
  isKnownConversation,
  isKnownMessage,
  isKnownUser,
  isUserBlocked,
  linkMembers,
  listAccessRequests,
  listAdminRoster,
  listAnswerFeedback,
  listAppeals,
  listContextDigests,
  listKnowledge,
  listKnowledgeFeedbackSummary,
  listReports,
  listRoster,
  listSuggestions,
  mergeKnowledgeEntries,
  oldestAccessRequestAgeDays,
  oldestOpenAppealAgeDays,
  oldestOpenReportAgeDays,
  oldestPendingCandidateAgeDays,
  oldestPendingSuggestionAgeDays,
  MODERATION_ACTION_KINDS,
  type ModerationAppeal,
  purgeUserData,
  recentAuditEntries,
  recentKnowledgeGapClusters,
  type CrossedKnowledgeGapCluster,
  recentModerationEntries,
  recentQuestionClusters,
  recentUnhelpfulFeedbackClusters,
  removeMember,
  resolveContentReport,
  resolveDisplayName,
  resolveModerationAppeal,
  resolveSuggestion,
  responseLatencyStats,
  rosterCounts,
  resolveLinkedIdentities,
  saveKnowledge,
  getLanguagePreference,
  createProject,
  getProjectBySlug,
  addProjectMember,
  removeProjectMember,
  bindProjectSurface,
  unbindProjectSurface,
  archiveProject,
  unarchiveProject,
  TEAM_PROJECT_NAME_MAX_CHARS,
  TEAM_PROJECT_BRIEF_MAX_CHARS,
  listAllProjects,
  listProjectMembers,
  listProjectSurfaces,
  unlinkMember,
  updateKnowledge,
  upsertMember,
  usageStats,
  engagementStats,
  userMessages,
} from '../storage/repository.js';
import { updatePolicy } from '../storage/policies.js';
import { recentChanges } from './changelog.js';
import { redactSecrets } from './outbound.js';
import { createIssue } from '../github/issues.js';
import { triggerRedeploy } from './redeploy.js';
import { formatNzEventTime } from '../util/nzTime.js';
import { buildAdminDigestForAdmin } from '../adminDigest.js';
import { makeToolContext } from './tools/context.js';
import { TOOL_REGISTRY } from './tools/index.js';
import {
  formatAdminActivity,
  formatEngagementStats,
  formatFeatureFlags,
  formatOtherConfiguredKnobs,
  formatUsageStats,
  isoInstantSchema,
  parseIsoInstant,
  platformArg,
  PROJECT_NOTE_RETENTION_NOTICE,
  resolveSanitizedLabel,
  text,
  unreachableConversationRefusal,
  untrusted,
} from './tools/helpers.js';
import {
  applyManualWarnStrike,
  notifyAdminApproved,
  notifyAppealResolved,
  notifyKnowledgeTipResolved,
  notifyMemberApproved,
  notifyReportResolved,
  notifySuggestionResolved,
  notifyWarningsCleared,
} from './tools/notify.js';

// This file is the BARREL for the tool registry split (docs/
// TOOL-REGISTRY-DESIGN.md §3): every symbol that moved into src/agent/tools/
// is re-exported here so the 20+ existing import sites (tests especially)
// keep working unchanged, and the remaining ~110 unconverted closure tools
// below keep their original bodies until their domain's conversion PR.
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

// Re-exported (not defined here — see the import above) so storage/
// repository.ts's own `knowledgeCoversTopic` dedup guard (issue #102) can
// share the exact same floor without a repository.ts <-> agent/tools.ts
// import cycle. See the full derivation comment on the definition in
// repository.ts.
export { KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD };

/**
 * Cap on stored community guidelines text (issue #212). Bounded by Discord's
 * hard 2000-character message limit — guidelines are appended to the static
 * welcome message and sent unchunked (`member.send`/channel fallback), so an
 * unbounded value could blow that limit and silently drop the whole welcome
 * (both the DM and channel-fallback sends would fail the same way). Leaves
 * headroom for the ~230-character static WELCOME_MESSAGE plus its guidelines
 * preamble; WhatsApp has no comparable limit, so the tighter platform sets
 * the bound.
 */
export const COMMUNITY_GUIDELINES_MAX_CHARS = 1500;

/**
 * Cap on the admin-configured welcome message (issue #253). Sized so a
 * maxed-out configured welcome PLUS a maxed-out configured
 * COMMUNITY_GUIDELINES_MAX_CHARS PLUS the `"\n\nCommunity guidelines:\n"`
 * preamble (24 chars) can never exceed Discord's 2000-character message
 * limit: 2000 - 1500 - 24 = 476 headroom; 400 leaves comfortable margin.
 */
export const WELCOME_MESSAGE_MAX_CHARS = 400;

/**
 * create_poll (issue #228) bounds — the Discord Poll API's own hard limits
 * (question/answer length, answer count, duration), enforced here so a
 * malformed request fails at our zod schema boundary instead of a late
 * Discord API error: https://discord.com/developers/docs/resources/poll.
 */
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_QUESTION_MAX_CHARS = 300;
export const POLL_OPTION_MAX_CHARS = 55;
export const POLL_MIN_DURATION_HOURS = 1;
export const POLL_MAX_DURATION_HOURS = 32 * 24;
export const POLL_DEFAULT_DURATION_HOURS = 24;

/**
 * Per-conversation cap on new polls within a rolling hour. `create_poll` is
 * an outward-posting, announce-class action (same abuse surface as
 * `announce`); the adversarial review for #228 called for a per-window cap
 * rather than CONFIRM-gating, since a poll is lower-consequence than an
 * announcement and `announce` itself isn't CONFIRM-gated either.
 */
export const POLL_RATE_LIMIT_PER_HOUR = 5;

/**
 * Per-conversation cap on `end_poll` within a rolling hour (PR #272 review).
 * `end_poll` has the same admin-tier/scope/capability guards as `create_poll`
 * but ends (rather than posts) a poll, so it needs its own cap for the same
 * threat: an injected/hijacked admin turn should not be able to end every live
 * poll in scope unthrottled. Kept slightly higher than the create cap because a
 * legitimate admin more plausibly closes several polls than posts several.
 */
export const POLL_END_RATE_LIMIT_PER_HOUR = 10;

/** create_thread (issue #229) bound — Discord's own hard limit on a thread's name. */
export const THREAD_NAME_MAX_CHARS = 100;

/**
 * Per-channel cap on new threads within a rolling hour, same additive/
 * rate-capped-not-CONFIRM-gated treatment as `create_poll` (issue #228) — the
 * adversarial review for #229 agreed `create_thread` is additive and can be
 * ungated with a per-window cap, unlike `archive_thread` (CONFIRM-gated, it
 * hides an active discussion).
 */
export const THREAD_CREATE_RATE_LIMIT_PER_HOUR = 5;

/**
 * Per-conversation cap on `warn_user` within a rolling hour (issue #315).
 * `warn_user` is the one non-CONFIRM moderation action (`moderate`'s own
 * comment: "warnings are low-blast-radius; everything else needs CONFIRM"),
 * but until now carried no throttle of any kind. Mirrors the
 * `create_poll`/`create_thread` rate-cap-not-CONFIRM treatment.
 */
export const WARN_USER_RATE_LIMIT_PER_HOUR = 10;

/**
 * Per-conversation cap on `announce` within a rolling hour (issue #315).
 * `announce` was the only one of the four residual-risk levers named in
 * `docs/SECURITY.md` with zero throttle, despite being the *higher*-
 * consequence sibling of `create_poll` (the #228 code comment already treats
 * them as the same abuse surface). Same value as `POLL_RATE_LIMIT_PER_HOUR`.
 */
export const ANNOUNCE_RATE_LIMIT_PER_HOUR = 5;

/**
 * create_event (issue #230) Discord Scheduled Event field bounds — Discord's
 * own hard limits (name/description/location length), enforced at the zod
 * schema boundary same as the create_poll bounds above:
 * https://discord.com/developers/docs/resources/guild-scheduled-event.
 */
export const EVENT_NAME_MAX_CHARS = 100;
export const EVENT_DESCRIPTION_MAX_CHARS = 1000;
export const EVENT_LOCATION_MAX_CHARS = 100;

/**
 * cancel_event's audit-only `reason` (issue #424) has no Discord field to
 * bound it against — same shape as report_content's `reason`, so the same
 * 500-char cap.
 */
export const EVENT_CANCEL_REASON_MAX_CHARS = 500;

/**
 * Fixed, static note appended to `add_member`'s reply when
 * `notifyMemberApproved` reports the confirmation DM did not land (issue
 * #556) — so the acting admin isn't told the identical success text
 * regardless of delivery. Deliberately never a function of the underlying
 * adapter error (which can embed platform-specific detail): this is one of
 * exactly two hardcoded strings, the other being `ADMIN_DM_FAILED_NOTE`.
 */
const MEMBER_DM_FAILED_NOTE = " (Couldn't DM them the welcome message — they may not know yet.)";

/**
 * Fixed, static note appended to `grant_admin`'s reply when
 * `notifyAdminApproved` reports the promotion DM did not land (issue #556) —
 * mirrors `MEMBER_DM_FAILED_NOTE`'s rationale exactly, with its own wording
 * since this is a promotion, not a fresh membership.
 */
const ADMIN_DM_FAILED_NOTE = " (Couldn't DM them about the promotion — they may not know yet.)";

/**
 * After a role change (grant_admin/revoke_admin) commits, reset the target's
 * active-conversation sessions so their new tier takes effect on the very next
 * message rather than being shadowed by stale in-session context until the
 * session rolls over (see `clearUserSessions`). Best-effort: a reset failure is
 * logged but never fails or reverses the already-committed role change.
 */
async function resetSessionsForRoleChange(platform: Platform, userId: string, action: string): Promise<void> {
  try {
    const cleared = await clearUserSessions(platform, userId);
    if (cleared > 0) {
      logger.info(
        { action, platform, userId: hashId(userId), cleared },
        'Reset target sessions after role change',
      );
    }
  } catch (err) {
    logger.warn(
      { err, action, platform, userId: hashId(userId) },
      'Failed to reset target sessions after role change',
    );
  }
}

/** suggest_issue filings per super admin, for the rolling calendar-day cap. */
const reserveIssueDaily = makeCalendarDayReserver();

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
 * Reserve one create_poll slot for `conversationId` against a rolling
 * hourly cap (POLL_RATE_LIMIT_PER_HOUR; sliding window, unlike
 * reserveImageGenDaily's calendar-day bucket — a 1-hour cap doesn't align
 * to midnight). Returns false without reserving if the conversation already
 * hit `limit` within the last hour.
 */
const reservePollSlot = makeSlidingWindowReserver(60 * 60 * 1000);

/**
 * Reserve one `end_poll` slot for `conversationId`
 * (POLL_END_RATE_LIMIT_PER_HOUR) — same sliding-hour shape as
 * `reservePollSlot`, but a SEPARATE window so ending polls neither consumes
 * nor is blocked by the create_poll budget (PR #272 review).
 */
const reservePollEndSlot = makeSlidingWindowReserver(60 * 60 * 1000);

/**
 * Reserve one create_thread slot for the parent channel against a rolling
 * hourly cap (THREAD_CREATE_RATE_LIMIT_PER_HOUR), same sliding-window shape
 * as `reservePollSlot`. Returns false without reserving if the channel
 * already hit `limit` within the last hour.
 */
const reserveThreadSlot = makeSlidingWindowReserver(60 * 60 * 1000);

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
 * Reserve one warn_user slot for `conversationId` against a rolling hourly
 * cap (WARN_USER_RATE_LIMIT_PER_HOUR), same sliding-window shape as
 * `reservePollSlot`. Returns false without reserving if the conversation
 * already hit `limit` within the last hour.
 */
const reserveWarnSlot = makeSlidingWindowReserver(60 * 60 * 1000);

/**
 * Reserve one announce slot for `conversationId` against a rolling hourly
 * cap (ANNOUNCE_RATE_LIMIT_PER_HOUR), same sliding-window shape as
 * `reservePollSlot`. Returns false without reserving if the conversation
 * already hit `limit` within the last hour.
 */
const reserveAnnounceSlot = makeSlidingWindowReserver(60 * 60 * 1000);

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
  // Destructured back into this scope so the remaining (unconverted) closure
  // tools below keep referencing these helpers bare, exactly as when they
  // were defined inline here — see makeToolContext (tools/context.ts).
  const { adapterFor, callerScope, audited, requireConfirm, resolveMemberTarget } = ctx;
  // Tools already converted to the declarative registry (tools/index.ts),
  // wrapped so each handler receives this turn's ctx.
  const registryTools = TOOL_REGISTRY.map((def) =>
    tool(def.name, def.description, def.schema, (args) => def.handler(args, ctx), {
      annotations: { readOnlyHint: def.readOnlyHint },
    }),
  );

  // --- Admin tools (scoped to the admin's own conversations) ------------------

  const whatsNew = tool(
    'whats_new',
    "Report the bot's own recent updates from its changelog. Use this whenever " +
      "someone asks what's new, what changed, what you've been upgraded with, or " +
      'about your recent versions/releases.',
    {
      limit: z
        .number()
        .int()
        .positive()
        .max(10)
        .optional()
        .describe('How many recent changelog sections to include (default 2)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'whats_new');
      return text(await recentChanges(args.limit ?? 2));
    },
    { annotations: { readOnlyHint: true } },
  );

  const userHistory = tool(
    'user_history',
    'Look up recent message history for a user (moderation). Admins only see history from conversations they are in.',
    {
      userId: z.string().describe('Platform user id to inspect'),
      limit: z.number().optional().describe('Max messages (default 20)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'user_history');
      const allowed = await callerScope();
      const rows = await userMessages(caller.platform, args.userId, args.limit ?? 20, allowed ?? undefined);
      const linked = await resolveLinkedIdentities(caller.platform, args.userId);
      const linkNote =
        linked.length > 1
          ? `Linked identities (link_member): ${linked.map((l) => `${l.platform}:${l.userId}`).join(', ')}\n`
          : '';
      if (rows.length === 0) return text(`${linkNote}No history for that user (within your conversations).`);
      return text(
        linkNote +
          untrusted(
            `History for ${args.userId}`,
            rows
              .map(
                (r) =>
                  `[${r.createdAt.toISOString()}] (${r.conversationId}) ${r.direction}: ${r.content.slice(0, 200)}`,
              )
              .join('\n'),
          ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const moderate = tool(
    'moderate',
    'Perform a moderation action. warn_user sends immediately; timeout/kick/ban/unban/delete/block/unblock require the admin to reply CONFIRM. ban_user (Discord only) is durable — the member cannot rejoin via invite — but unban_user reverses it in-bot, same gates as every other action. block_user (WhatsApp only) is the bot-side equivalent: it stops the bot ever replying to that sender again, platform-wide, with no platform API call; unblock_user reverses it. block_user cannot target an admin or super admin. Admins can only act in conversations they are in.',
    {
      action: z
        .enum([
          'timeout_user',
          'kick_user',
          'ban_user',
          'unban_user',
          'delete_message',
          'warn_user',
          'block_user',
          'unblock_user',
        ])
        .describe('The moderation action to perform'),
      targetUserId: z.string().describe('Platform user id to act on (message author for delete_message)'),
      reason: z.string().describe('Reason, for the audit log and the affected user'),
      durationMinutes: z.number().optional().describe('For timeouts: duration in minutes'),
      messageId: z.string().optional().describe('For delete_message: the platform message id to delete'),
      conversationId: z
        .string()
        .optional()
        .describe('Conversation/channel id if the action is scoped to one'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', `moderate:${args.action}`);
      if (!adapter.adminCapabilities.has(args.action)) {
        return text(`This platform (${adapter.platform}) does not support "${args.action}".`, true);
      }
      const targetConversation = args.conversationId ?? caller.conversationId;

      // Admins act only inside conversations they belong to.
      const allowed = await callerScope();
      if (allowed && !allowed.includes(targetConversation)) {
        return text(`Refusing: you are not a participant of conversation "${targetConversation}".`, true);
      }
      // Targets must be people/places the bot has actually seen.
      if (
        targetConversation !== caller.conversationId &&
        !(await isKnownConversation(caller.platform, targetConversation))
      ) {
        return text(unreachableConversationRefusal(targetConversation), true);
      }
      // block_user cannot target an admin/super admin — mirrors remove_member's
      // and applyManualWarnStrike's existing "never act against an admin+"
      // guard. Checked before isKnownUser: an admin/super admin's role is
      // resolved from env/community_users, not from ever having been "seen"
      // in an interaction, so this refusal must not depend on that unrelated
      // reachability check.
      if (
        args.action === 'block_user' &&
        atLeast(await resolveRole(caller.platform, args.targetUserId), 'admin')
      ) {
        return text('Refusing: cannot block an admin or super admin.', true);
      }
      // unblock_user admits via isUserBlocked as an ALTERNATE path to
      // isKnownUser: purge_user_data/forget_me hard-deletes the target's
      // interactions (what isKnownUser reads) while deliberately keeping the
      // blocked_users row alive, so after a purge isKnownUser is permanently
      // false for that id — without this, a purged identity could never be
      // unblocked (review finding on #678). A currently-blocked identity is
      // definitionally known; an id that is neither seen nor blocked still
      // gets the refusal below.
      const admitsViaBlock =
        args.action === 'unblock_user' && (await isUserBlocked(caller.platform, args.targetUserId));
      if (!admitsViaBlock && !(await isKnownUser(caller.platform, args.targetUserId))) {
        return text(`Refusing: user "${args.targetUserId}" has never been seen on ${caller.platform}.`, true);
      }
      // delete_message's real messageId only reaches the adapter deep inside
      // CONFIRM/audited; check it upfront so a missing id is refused before
      // burning the admin's CONFIRM round-trip or writing a failed-but-
      // recorded audit row (issue #312).
      if (args.action === 'delete_message' && !args.messageId) {
        return text('Refusing: delete_message requires messageId.', true);
      }

      // Target's standing language preference, threaded into params ONLY for
      // warn_user (issue #618, same reuse of the #266/#282/#300/#331/#333/#339
      // `_MI` + getLanguagePreference pattern) — degrades to undefined (the
      // English wrapper) on lookup failure, extending the #52 fail-open
      // invariant, same `.catch(() => 'auto')` shape as moderator.ts:235.
      // Never resolved for any other action, so it can't leak into an
      // unrelated AdminAction's params.
      let warnLanguage: 'mi' | undefined;
      if (args.action === 'warn_user') {
        const lang = await getLangPref(caller.platform, args.targetUserId).catch(() => 'auto' as const);
        warnLanguage = lang === 'mi' ? 'mi' : undefined;
      }
      const params = {
        reason: args.reason,
        durationMinutes: args.durationMinutes,
        messageId: args.messageId,
        // Read only by the WhatsApp adapters' block_user case — the DB row's
        // blocked_by column. Harmless for every other action, which ignores it.
        blockedBy: caller.userId,
        ...(args.action === 'warn_user' ? { language: warnLanguage } : {}),
      };
      // Set by `run()` on a successful warn_user delivery only — read below to
      // gate the strike-system write on the DM actually having gone out,
      // mirroring the proposal's "after run() succeeds" contract. Harmless
      // for the other actions below, which never read it.
      let warnDelivered = false;
      const run = async () => {
        const { success, result } = await audited({
          actionKind: args.action,
          targetUserId: args.targetUserId,
          conversationId: targetConversation,
          params,
          run: () =>
            adapter.performAdminAction({
              kind: args.action,
              targetUserId: args.targetUserId,
              conversationId: targetConversation,
              params,
            }),
        });
        if (args.action === 'warn_user') warnDelivered = success;
        return success ? `Done: ${result}` : `Failed: ${result}`;
      };

      // Warnings are low-blast-radius; everything else needs CONFIRM. Still
      // rate-capped though (issue #315) — the reservation check sits before
      // `run()`/`audited(...)` so a refused warning is never executed or
      // written to the audit log as a success.
      if (args.action === 'warn_user') {
        if (!reserveWarnSlot(targetConversation, WARN_USER_RATE_LIMIT_PER_HOUR)) {
          return text(
            `Refusing: conversation "${targetConversation}" already hit the warn limit (${WARN_USER_RATE_LIMIT_PER_HOUR}/hour) — try again later.`,
            true,
          );
        }
        const runResult = await run();
        // Wires this manual warning into the strike system (issue #384):
        // best-effort, so a bookkeeping/mute failure never turns an already-
        // delivered warning DM into a reported failure.
        if (warnDelivered) {
          await applyManualWarnStrike({
            adapter,
            platform: caller.platform,
            targetUserId: args.targetUserId,
            issuedByUserId: caller.userId,
            reason: args.reason,
          }).catch((err) => {
            logger.warn(
              { err, targetUserId: hashId(args.targetUserId) },
              'Manual-warn strike bookkeeping failed',
            );
          });
        }
        return text(runResult);
      }
      // delete_message: name the actual message id in the CONFIRM text, plus
      // a best-effort content preview when the bot has this message stored
      // (issue #312) — never a hard isKnownMessage gate, since the tool's
      // most common legitimate target is a message the bot never archived
      // (ambient archiving is opt-in and off by default). The preview is
      // sourced only from the stored interaction row, never model-composed
      // or live-fetched from the platform.
      let messageSuffix = '';
      if (args.action === 'delete_message') {
        messageSuffix = `, message ${args.messageId}`;
        if (await isKnownMessage(caller.platform, targetConversation, args.messageId!)) {
          const content = await getInteractionContentByMessageId(
            caller.platform,
            targetConversation,
            args.messageId!,
          );
          if (content) {
            // content is attacker-controlled (the message being moderated,
            // possibly authored by the very account under review) — strip the
            // same characters untrusted()/sanitizeName() do before it reaches
            // this model-visible CONFIRM text, so a planted newline/angle-
            // bracket/quote can't fake a tag or a second "Reply CONFIRM"
            // block (the quarantine-escape class from issue #227, flagged in
            // PR review for #312).
            const sanitized = content.replace(/[<>"\r\n]/g, ' ');
            messageSuffix += ` ("${sanitized.slice(0, 80)}${sanitized.length > 80 ? '…' : ''}")`;
          }
        }
      }
      return requireConfirm(
        `${args.action} on ${args.targetUserId} in ${targetConversation}${messageSuffix} (reason: ${args.reason})`,
        'admin',
        run,
      );
    },
  );

  const clearWarningsTool = tool(
    'clear_warnings',
    "Clear a member's auto-moderation warnings and lift any resulting mute so they can post again. Admin only. Use this when a member was blocked after reaching the warning limit (you'll have seen the alert in the mod-alerts channel) and you want to give them another chance. Lenient/reversible, so no CONFIRM needed.",
    {
      targetUserId: z.string().describe('Platform user id whose warnings to clear'),
      reason: z.string().optional().describe('Optional note for the audit log'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'clear_warnings');
      if (!(await isKnownUser(caller.platform, args.targetUserId))) {
        return text(`Refusing: user "${args.targetUserId}" has never been seen on ${caller.platform}.`, true);
      }
      const state = { cleared: 0, muteNote: '', muteLifted: false };
      const { success, result } = await audited({
        actionKind: 'clear_warnings',
        targetUserId: args.targetUserId,
        conversationId: caller.conversationId,
        params: { reason: args.reason },
        run: async () => {
          const cleared = await clearWarnings(caller.platform, args.targetUserId, caller.userId);
          state.cleared = cleared;
          // Lift the mute too, if the platform supports it. The DB clear is the
          // source of truth; a failed unmute is reported inline, not fatal.
          let muteNote = '';
          if (adapter.adminCapabilities.has('unmute_user')) {
            try {
              await adapter.performAdminAction({
                kind: 'unmute_user',
                targetUserId: args.targetUserId,
                conversationId: caller.conversationId,
              });
              state.muteLifted = true;
            } catch (err) {
              logger.warn({ err, targetUserId: args.targetUserId }, 'Unmute after clear_warnings failed');
              muteNote = ' (but I could not lift the Discord mute — check my Manage Roles permission)';
            }
          }
          state.muteNote = muteNote;
          return cleared > 0
            ? `Cleared ${cleared} warning(s); ${args.targetUserId} can post again${muteNote}.`
            : `${args.targetUserId} had no active warnings${muteNote}.`;
        },
      });
      // Member-facing notice (issue #865) — only on a genuine cleared > 0
      // transition, never for a no-op clear, and always via the caller's own
      // platform adapter (clear_warnings never operates cross-platform).
      // muteLifted is only true when an unmute_user call was attempted AND
      // succeeded — platforms without the capability (WhatsApp has no mute
      // mechanism at all) always get the mute-free wording, per the #866
      // review (a bare `!state.muteNote` wrongly said "mute lifted" whenever
      // the platform simply lacked unmute_user, not just when it failed).
      if (success && state.cleared > 0) {
        await notifyWarningsCleared(adapter, args.targetUserId, caller.platform, state.muteLifted);
      }
      return text(success ? result : `Failed: ${result}`);
    },
  );

  const listMemberWarningsTool = tool(
    'list_member_warnings',
    "Show one member's full auto-moderation warning history — both auto-detected (wordlist/LLM) and " +
      "manually-issued (moderate's warn action) warnings, each with its reason and, for auto-detected " +
      'strikes, the flagged excerpt, newest first. Use this before escalating (warn → timeout → kick/mute) ' +
      "to see WHY a member was warned, not just how many times. Scoped to the target's (platform, userId) " +
      'only, same as clear_warnings — not conversation-scoped. Admin only.',
    {
      targetUserId: z.string().describe('Platform user id whose warning history to show'),
      limit: z.number().optional().describe('Max entries (default 20)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_member_warnings');
      if (!(await isKnownUser(caller.platform, args.targetUserId))) {
        return text(`Refusing: user "${args.targetUserId}" has never been seen on ${caller.platform}.`, true);
      }
      const rows = await listMemberWarnings(caller.platform, args.targetUserId, args.limit ?? 20);
      if (rows.length === 0) return text(`No warnings on record for ${args.targetUserId}.`);
      return text(
        rows
          .map((r) => {
            const issuer = r.issuedBy ? ` by ${r.issuedBy}` : '';
            const cleared = r.clearedAt ? ` [cleared ${r.clearedAt.toISOString()}]` : '';
            const reasonText = `\n  ${untrusted('reason', r.reason)}`;
            const excerptText = r.excerpt != null ? `\n  ${untrusted('excerpt', r.excerpt)}` : '';
            return `[${r.createdAt.toISOString()}] ${r.source}${issuer}${cleared}:${reasonText}${excerptText}`;
          })
          .join('\n'),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const listMutedMembersTool = tool(
    'list_muted_members',
    "Enumerate currently muted members by identity — the growth path the digest's bare " +
      '`🔇 N member(s) currently muted` count (issue #357) was never meant to provide on its own (issue ' +
      '#487). Each row is user id, strike count, status (`active`/`stale`), and last-warning timestamp — ' +
      'never a reason or excerpt (that stays behind list_member_warnings, one level deeper). `stale` rows ' +
      'are an over-approximation: their strikes aged out of the configured window but they were never ' +
      'explicitly unmuted via clear_warnings, so they may still be muted — never treat a stale row as a ' +
      'confirmed live mute. Admin only, guild-wide (not conversation-scoped, same as clear_warnings), ' +
      'capped at 50 rows, newest warning first.',
    {},
    async () => {
      assertAtLeast(caller.role, 'admin', 'list_muted_members');
      const rows = await listMutedMembers(
        caller.platform,
        config.moderation.strikeLimit,
        config.moderation.strikeWindowDays,
      );
      if (rows.length === 0) return text('No members are currently muted.');
      return text(
        rows
          .map((r) => {
            const hedge =
              r.status === 'stale'
                ? ' (may still be muted — strikes aged out of the window, never explicitly cleared)'
                : '';
            return (
              `${r.userId}: ${r.strikeCount} strike(s), ${r.status}${hedge}, ` +
              `last warning ${r.lastWarningAt.toISOString()}`
            );
          })
          .join('\n'),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const listBlockedMembersTool = tool(
    'list_blocked_members',
    "Enumerate WhatsApp's bot-side block list (issue #924) — the read `block_user`/`unblock_user` " +
      "(#572) never got, the same 'a bare count/log is not a who answer' gap list_muted_members (#487) " +
      'closed for auto-moderation mutes. Each row is external id, who blocked them, reason (if any), and ' +
      'blocked-at timestamp — the same fields moderation_history already shows per-action, just not ' +
      'aggregated into one current-state view. Admin only, guild-wide (blocked_users has no ' +
      'conversation_id), capped at 50 rows, newest block first.',
    {},
    async () => {
      assertAtLeast(caller.role, 'admin', 'list_blocked_members');
      const rows = await listBlockedUsers(caller.platform);
      if (rows.length === 0) return text('No blocked users.');
      return text(
        untrusted(
          'Blocked users',
          rows
            .map((r) => {
              const reasonText = r.reason ? `: ${r.reason}` : '';
              return `${r.externalId} — blocked by ${r.blockedBy} at ${r.blockedAt.toISOString()}${reasonText}`;
            })
            .join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const listAppealsTool = tool(
    'list_appeals',
    "List members' filed appeals of their own auto-moderation warning(s)/mute (issue #554) — the durable " +
      'queue `appeal_moderation` writes into, so a missed/dismissed admin DM no longer erases the record. ' +
      'Each row snapshots the active-warning count and strike limit at filing time, plus the optional ' +
      'reason. Admin only, guild-wide (not conversation-scoped, same as list_member_warnings/' +
      'clear_warnings) — warnings/mutes carry no conversation boundary to scope by.',
    {
      status: z
        .enum(['open', 'resolved', 'dismissed'])
        .optional()
        .describe('Filter by status (default: all statuses)'),
      limit: z.number().optional().describe('Max entries (default 50)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_appeals');
      const rows = await listAppeals(args.status, args.limit ?? 50);
      if (rows.length === 0) return text('No appeals found.');
      return text(
        untrusted(
          'Moderation appeals',
          rows
            .map(
              (r) =>
                `#${r.id} [${r.status}] ${r.platform} — ${r.userName ? sanitizeName(r.userName) : r.userId} ` +
                `(${r.userId}), ${r.activeWarnings}/${r.strikeLimit} active warnings` +
                `${r.reason ? `: ${r.reason}` : ''} (${r.createdAt.toISOString()})`,
            )
            .join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const resolveAppealTool = tool(
    'resolve_appeal',
    'Mark a filed moderation appeal as resolved or dismissed once triaged. Non-destructive status change ' +
      '(no CONFIRM needed), audited. Does NOT itself clear the warnings or lift a mute — that stays ' +
      "clear_warnings' job alone, a deliberate, separate admin judgement call. Admin only, guild-wide, " +
      'same as list_appeals.',
    {
      id: z.number().describe('Appeal id (from list_appeals)'),
      status: z.enum(['resolved', 'dismissed']).describe('New status'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'resolve_appeal');
      const state: { row: ModerationAppeal | null } = { row: null };
      const { success, result } = await audited({
        actionKind: 'resolve_appeal',
        params: { id: args.id, status: args.status },
        run: async () => {
          const row = await resolveModerationAppeal(args.id, args.status, caller.userId);
          if (!row) throw new Error(`No appeal with id ${args.id}.`);
          state.row = row;
          return `marked ${args.status}`;
        },
      });
      // Cross-platform resolution DM (issue #157's mechanism, issue #622's
      // missing half of #554's own "mirror content_reports" pattern): routes
      // through the appeal's ORIGIN platform's adapter, degrading to a
      // silent skip if that platform isn't registered in this deployment.
      // The target is always state.row's own userId/platform — never any
      // resolve_appeal argument — so no caller-supplied value can redirect it.
      if (success && state.row) {
        const target = adapterFor(state.row.platform);
        if (target)
          await notifyAppealResolved(
            target,
            state.row.userId,
            args.status,
            state.row.reason,
            state.row.platform,
          );
      }
      return text(success ? `Appeal #${args.id} marked ${args.status}.` : `Failed: ${result}`, !success);
    },
  );

  const announce = tool(
    'announce',
    'Post an announcement to a conversation. Admins can only announce in conversations they are in.',
    {
      message: z.string().describe('The announcement text'),
      conversationId: z
        .string()
        .optional()
        .describe('Target channel/conversation id; defaults to the current one'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'announce');
      const target = args.conversationId ?? caller.conversationId;
      const allowed = await callerScope();
      if (allowed && !allowed.includes(target)) {
        return text(`Refusing: you are not a participant of conversation "${target}".`, true);
      }
      if (
        target !== caller.conversationId &&
        !(await isKnownConversation(caller.platform, target)) &&
        !(await adapter.canPostTo?.(target))
      ) {
        return text(unreachableConversationRefusal(target), true);
      }
      if (!reserveAnnounceSlot(target, ANNOUNCE_RATE_LIMIT_PER_HOUR)) {
        return text(
          `Refusing: conversation "${target}" already hit the announce limit (${ANNOUNCE_RATE_LIMIT_PER_HOUR}/hour) — try again later.`,
          true,
        );
      }
      const { success, result } = await audited({
        actionKind: 'announce',
        conversationId: target,
        params: { message: args.message },
        run: async () => {
          await adapter.sendMessage({ conversationId: target, text: args.message });
          return 'sent';
        },
      });
      return text(success ? `Announcement posted to ${target}.` : `Failed: ${result}`, !success);
    },
  );

  const createPoll = tool(
    'create_poll',
    'Post a native Discord poll to gauge interest (e.g. meetup dates, topic preferences) — a structured ' +
      'vote with a visible tally and duration, unlike a reaction straw poll. Discord only. Admins can only ' +
      'post in conversations they are in. Set multiChoice to let voters pick more than one option. NOTE: ' +
      'Discord polls cannot be edited after posting — the question, options, duration, and single-vs-multi ' +
      'choice setting are fixed at creation. To change a poll, end it (end_poll) and post a new one; the new ' +
      "poll starts with zero votes (the old poll's votes cannot be carried over).",
    {
      question: z.string().max(POLL_QUESTION_MAX_CHARS).describe('The poll question'),
      options: z
        .array(z.string().max(POLL_OPTION_MAX_CHARS))
        .min(POLL_MIN_OPTIONS)
        .max(POLL_MAX_OPTIONS)
        .describe(
          `${POLL_MIN_OPTIONS}-${POLL_MAX_OPTIONS} answer options, each up to ${POLL_OPTION_MAX_CHARS} characters`,
        ),
      multiChoice: z
        .boolean()
        .optional()
        .describe(
          'Allow selecting more than one option (default: single choice). Fixed at creation — cannot be changed later.',
        ),
      durationHours: z
        .number()
        .min(POLL_MIN_DURATION_HOURS)
        .max(POLL_MAX_DURATION_HOURS)
        .optional()
        .describe(
          `Poll duration in hours (${POLL_MIN_DURATION_HOURS}-${POLL_MAX_DURATION_HOURS}, default ${POLL_DEFAULT_DURATION_HOURS})`,
        ),
      conversationId: z
        .string()
        .optional()
        .describe('Target channel/conversation id; defaults to the current one'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'create_poll');
      if (!adapter.adminCapabilities.has('create_poll')) {
        return text(`This platform (${adapter.platform}) does not support polls.`, true);
      }
      const target = args.conversationId ?? caller.conversationId;
      const allowed = await callerScope();
      if (allowed && !allowed.includes(target)) {
        return text(`Refusing: you are not a participant of conversation "${target}".`, true);
      }
      if (
        target !== caller.conversationId &&
        !(await isKnownConversation(caller.platform, target)) &&
        !(await adapter.canPostTo?.(target))
      ) {
        return text(unreachableConversationRefusal(target), true);
      }
      if (!reservePollSlot(target, POLL_RATE_LIMIT_PER_HOUR)) {
        return text(
          `Refusing: conversation "${target}" already hit the poll limit (${POLL_RATE_LIMIT_PER_HOUR}/hour) — try again later.`,
          true,
        );
      }
      // Range is enforced at the zod schema boundary above; only truncate to
      // whole hours here (the schema permits fractional values in-range).
      const duration = Math.trunc(args.durationHours ?? POLL_DEFAULT_DURATION_HOURS);
      const params = {
        question: args.question,
        options: args.options,
        durationHours: duration,
        multiChoice: args.multiChoice ?? false,
      };
      const { success, result } = await audited({
        actionKind: 'create_poll',
        conversationId: target,
        params,
        run: () =>
          adapter.performAdminAction({
            kind: 'create_poll',
            conversationId: target,
            params,
          }),
      });
      return text(success ? `Poll posted to ${target}.` : `Failed: ${result}`, !success);
    },
  );

  const endPoll = tool(
    'end_poll',
    'End (finalize) a running Discord poll early: freezes its current results and stops further voting. ' +
      'Discord only; admins can only act in conversations they are in. This is IRREVERSIBLE, but it does NOT ' +
      'delete the poll or its votes — the final tally stays visible. Discord polls cannot be edited or ' +
      'converted (e.g. to multi-choice) after posting; to change one, end it here and post a fresh poll with ' +
      'create_poll.',
    {
      messageId: z
        .string()
        .describe("The poll message's id (in Discord: right-click the poll → Copy Message ID)"),
      conversationId: z
        .string()
        .optional()
        .describe('Channel/conversation id the poll is in; defaults to the current one'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'end_poll');
      if (!adapter.adminCapabilities.has('end_poll')) {
        return text(`This platform (${adapter.platform}) does not support polls.`, true);
      }
      const target = args.conversationId ?? caller.conversationId;
      const allowed = await callerScope();
      if (allowed && !allowed.includes(target)) {
        return text(`Refusing: you are not a participant of conversation "${target}".`, true);
      }
      if (target !== caller.conversationId && !(await isKnownConversation(caller.platform, target))) {
        return text(`Refusing: conversation "${target}" is unknown.`, true);
      }
      if (!reservePollEndSlot(target, POLL_END_RATE_LIMIT_PER_HOUR)) {
        return text(
          `Refusing: conversation "${target}" already hit the end-poll limit (${POLL_END_RATE_LIMIT_PER_HOUR}/hour) — try again later.`,
          true,
        );
      }
      const params = { messageId: args.messageId };
      const { success, result } = await audited({
        actionKind: 'end_poll',
        conversationId: target,
        params,
        run: () =>
          adapter.performAdminAction({
            kind: 'end_poll',
            conversationId: target,
            params,
          }),
      });
      return text(success ? result : `Failed: ${result}`, !success);
    },
  );

  const createThread = tool(
    'create_thread',
    'Open a Discord thread under a channel to split a longer discussion out of the main flow, optionally ' +
      'seeded from an existing message. Discord only. Admins can only open threads in conversations they are in.',
    {
      name: z
        .string()
        .min(1)
        .max(THREAD_NAME_MAX_CHARS)
        .describe(`The thread's title, up to ${THREAD_NAME_MAX_CHARS} characters`),
      channelId: z
        .string()
        .optional()
        .describe('Parent channel id to open the thread under; defaults to the current conversation'),
      seedMessageId: z
        .string()
        .optional()
        .describe('Optional existing message id in that channel to start the thread from'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'create_thread');
      if (!adapter.adminCapabilities.has('create_thread')) {
        return text(`This platform (${adapter.platform}) does not support creating threads.`, true);
      }
      const target = args.channelId ?? caller.conversationId;
      const allowed = await callerScope();
      if (allowed && !allowed.includes(target)) {
        return text(`Refusing: you are not a participant of conversation "${target}".`, true);
      }
      if (
        target !== caller.conversationId &&
        !(await isKnownConversation(caller.platform, target)) &&
        !(await adapter.canPostTo?.(target))
      ) {
        return text(unreachableConversationRefusal(target), true);
      }
      // Defensive guard (adversarial review, issue #229): thread messages are
      // moderation-scanned under their PARENT channel's allowlist membership
      // (DiscordAdapter.scopeChannelId resolves a thread to its parent for the
      // scan gate in onDiscordMessage), so a thread opened under a
      // non-allowlisted parent would be an unmoderated space the bot itself
      // manufactured. Refuse rather than rely solely on that scan-side fix
      // staying correct.
      if (
        config.moderation.enabled &&
        config.discord.allowedChannelIds.length > 0 &&
        !config.discord.allowedChannelIds.includes(target)
      ) {
        return text(
          `Refusing: moderation is enabled with a channel allowlist and "${target}" is not on it — a thread ` +
            'there would not be moderation-scanned.',
          true,
        );
      }
      if (args.seedMessageId && !(await isKnownMessage(caller.platform, target, args.seedMessageId))) {
        return text(`Refusing: message "${args.seedMessageId}" is unknown in "${target}".`, true);
      }
      if (!reserveThreadSlot(target, THREAD_CREATE_RATE_LIMIT_PER_HOUR)) {
        return text(
          `Refusing: conversation "${target}" already hit the thread-creation limit ` +
            `(${THREAD_CREATE_RATE_LIMIT_PER_HOUR}/hour) — try again later.`,
          true,
        );
      }
      const params = { name: args.name, seedMessageId: args.seedMessageId };
      const { success, result } = await audited({
        actionKind: 'create_thread',
        conversationId: target,
        params,
        run: () =>
          adapter.performAdminAction({
            kind: 'create_thread',
            conversationId: target,
            params,
          }),
      });
      return text(success ? result : `Failed: ${result}`, !success);
    },
  );

  const archiveThread = tool(
    'archive_thread',
    'Archive a Discord thread the bot can see, ending active discussion there. CONFIRM required — this hides ' +
      "the thread from the channel's active list. Discord only. Admins can only archive threads in " +
      'conversations they are in.',
    {
      threadId: z.string().describe('The thread id to archive'),
      reason: z.string().optional().describe('Optional note for the audit log'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'archive_thread');
      if (!adapter.adminCapabilities.has('archive_thread')) {
        return text(`This platform (${adapter.platform}) does not support archiving threads.`, true);
      }
      const allowed = await callerScope();
      if (allowed && !allowed.includes(args.threadId)) {
        return text(`Refusing: you are not a participant of conversation "${args.threadId}".`, true);
      }
      if (
        args.threadId !== caller.conversationId &&
        !(await isKnownConversation(caller.platform, args.threadId))
      ) {
        return text(unreachableConversationRefusal(args.threadId), true);
      }
      const params = { reason: args.reason };
      const run = async () => {
        const { success, result } = await audited({
          actionKind: 'archive_thread',
          conversationId: args.threadId,
          params,
          run: () =>
            adapter.performAdminAction({
              kind: 'archive_thread',
              conversationId: args.threadId,
              params,
            }),
        });
        return success ? `Done: ${result}` : `Failed: ${result}`;
      };

      return requireConfirm(
        `archive_thread on ${args.threadId}${args.reason ? ` (reason: ${args.reason})` : ''}`,
        'admin',
        run,
      );
    },
  );

  const createEvent = tool(
    'create_event',
    "Create a real Discord Scheduled Event (shows in the server's Events tab with RSVP + reminders) for a " +
      'meetup — much higher signal than a text announcement that scrolls away. Discord only. Admin only; ' +
      'requires confirmation, since it is an outward artifact that notifies the whole server. startTime/' +
      'endTime must be concrete, resolved ISO 8601 timestamps — resolve relative phrases like "next Tuesday ' +
      '7pm" against the current NZ date yourself first; never pass relative or ambiguous text.',
    {
      name: z.string().min(1).max(EVENT_NAME_MAX_CHARS).describe('Event name/title'),
      startTime: isoInstantSchema(
        'Concrete ISO 8601 start instant with an explicit offset or "Z", e.g. "2026-07-14T19:00:00+12:00" ' +
          '(NZ = Pacific/Auckland). Must be in the future.',
      ),
      endTime: isoInstantSchema(
        'Concrete ISO 8601 end instant, same format as startTime. Optional for a channel-hosted event; ' +
          'required for an external/physical location.',
      ).optional(),
      description: z
        .string()
        .max(EVENT_DESCRIPTION_MAX_CHARS)
        .optional()
        .describe('Event description, shown on the event page'),
      location: z
        .string()
        .min(1)
        .max(EVENT_LOCATION_MAX_CHARS)
        .describe(
          'Either a physical/external location (e.g. "Wellington Central Library") or the id of a Discord ' +
            'voice/stage channel the bot can see, for an online meetup.',
        ),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'create_event');
      if (!adapter.adminCapabilities.has('create_event')) {
        return text(`This platform (${adapter.platform}) does not support scheduled events.`, true);
      }
      // Format validity is a zod schema boundary (isoInstantSchema); the
      // future/ordering checks are cross-field and depend on wall-clock time,
      // so they run here, before ever registering a CONFIRM — same discipline
      // as assign_community_role's pre-checks (issue #232).
      const start = parseIsoInstant(args.startTime)!;
      if (start.getTime() <= Date.now()) {
        return text('Refusing: startTime must be in the future.', true);
      }
      if (args.endTime) {
        const end = parseIsoInstant(args.endTime)!;
        if (end.getTime() <= start.getTime()) {
          return text('Refusing: endTime must be after startTime.', true);
        }
      }
      const params = {
        name: args.name,
        description: args.description ?? '',
        startTime: args.startTime,
        endTime: args.endTime,
        location: args.location,
      };
      // CONFIRM text quotes every salient mutated field — name, start time,
      // location, and a truncated description (binding acceptance criterion
      // from the adversarial verdict on #230, sharpened by review on the PR:
      // location/description are just as outward-facing as name/startTime, so
      // the human must see them too before confirming). requireConfirm strips
      // the newline/angle-bracket forgery class from the whole description at
      // its choke point (the 2026-07-28 audit N2 generalisation of #227), so
      // these fields reach the human as the actual values minus those chars —
      // NOT byte-for-byte verbatim — and the human still confirms the real
      // artifact rather than model-composed prose. Same truncation pattern as
      // delete_member_note's note preview.
      const descPreview = args.description
        ? ` ("${args.description.slice(0, 80)}${args.description.length > 80 ? '…' : ''}")`
        : '';
      return requireConfirm(
        `create event "${args.name}" starting ${args.startTime} at "${args.location}"${descPreview}`,
        'admin',
        async () => {
          const { success, result } = await audited({
            actionKind: 'create_event',
            params,
            run: () => adapter.performAdminAction({ kind: 'create_event', params }),
          });
          return success ? `Done: ${result}` : `Failed: ${result}`;
        },
      );
    },
  );

  const cancelEvent = tool(
    'cancel_event',
    'Cancel a Discord Scheduled Event created via create_event: marks it Canceled (stays visible, ' +
      "struck-through, RSVP history intact) rather than deleting it — Discord's own UI convention for a " +
      'meetup that fell through. CONFIRM required. Discord only, admin only. Only a Scheduled event can be ' +
      'canceled — an event that is already Active, Completed, or Canceled is refused.',
    {
      eventId: z.string().describe("The scheduled event's id (see list_events)"),
      reason: z
        .string()
        .max(EVENT_CANCEL_REASON_MAX_CHARS)
        .optional()
        .describe(
          `Optional note for the audit log (Discord has no public cancellation-reason field), max ` +
            `${EVENT_CANCEL_REASON_MAX_CHARS} characters`,
        ),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'cancel_event');
      if (!adapter.adminCapabilities.has('cancel_event') || !adapter.getScheduledEvent) {
        return text(`This platform (${adapter.platform}) does not support scheduled events.`, true);
      }
      // Target validation live from Discord, not the DB (scheduled events
      // aren't tracked in `interactions`) — same "the bot must be able to
      // verify what it's acting on" discipline as isKnownConversation/
      // isKnownMessage, before a CONFIRM is ever registered (issue #424).
      const event = await adapter.getScheduledEvent(args.eventId);
      if (!event) {
        return text(`Refusing: scheduled event "${args.eventId}" was not found in this guild.`, true);
      }
      if (event.status !== 'scheduled') {
        return text(
          `Refusing: event "${event.name}" is currently ${event.status}, not scheduled — only a scheduled ` +
            'event can be canceled.',
          true,
        );
      }
      const params = { eventId: args.eventId, reason: args.reason };
      // CONFIRM text quotes the resolved event name + start time verbatim,
      // same discipline as create_event's own CONFIRM prompt — the human
      // confirms the actual artifact, not model-composed prose.
      return requireConfirm(
        `cancel event "${event.name}" starting ${formatNzEventTime(event.scheduledStartAt)}` +
          `${args.reason ? ` (reason: ${args.reason})` : ''}`,
        'admin',
        async () => {
          const { success, result } = await audited({
            actionKind: 'cancel_event',
            params,
            run: () => adapter.performAdminAction({ kind: 'cancel_event', params }),
          });
          return success ? `Done: ${result}` : `Failed: ${result}`;
        },
      );
    },
  );

  const setCommunityGuidelines = tool(
    'set_community_guidelines',
    'Set the community guidelines/rules text shown to members (appended verbatim to new-member welcome ' +
      `messages and returned verbatim by community_guidelines). Max ${COMMUNITY_GUIDELINES_MAX_CHARS} ` +
      "characters. Pass an empty string to clear. Pass language: 'mi' to set/clear the te reo Māori " +
      "variant served to members with a standing set_language_preference('mi') instead of the default " +
      "(en) text — omit or pass 'en' for the default-language text. Admin only.",
    {
      text: z
        .string()
        .max(COMMUNITY_GUIDELINES_MAX_CHARS)
        .describe(`The guidelines text, or "" to clear (max ${COMMUNITY_GUIDELINES_MAX_CHARS} characters)`),
      language: z
        .enum(['en', 'mi'])
        .optional()
        .describe("Which variant to set: 'en' (default) or 'mi' (te reo Māori). Defaults to 'en'."),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'set_community_guidelines');
      const language = args.language ?? 'en';
      const policyKey = language === 'mi' ? 'community_guidelines_mi' : 'community_guidelines';
      const { success, result } = await audited({
        actionKind: 'set_community_guidelines',
        params: { text: args.text, language },
        run: async () => {
          await updatePolicy(policyKey, args.text, caller.userId);
          return args.text ? 'updated' : 'cleared';
        },
      });
      if (!success) return text(`Failed: ${result}`, true);
      const label = language === 'mi' ? 'Community guidelines (mi)' : 'Community guidelines';
      return text(args.text ? `${label} updated.` : `${label} cleared.`);
    },
  );

  const setWelcomeMessage = tool(
    'set_welcome_message',
    'Set the welcome message sent to new members on join (Discord DM/channel fallback, WhatsApp group ' +
      `post), in place of the hardcoded default. Max ${WELCOME_MESSAGE_MAX_CHARS} characters. Pass an ` +
      "empty string to clear and revert to the default. Pass language: 'mi' to set/clear the te reo " +
      "Māori variant served to a rejoining Discord member with a standing set_language_preference('mi') " +
      "instead of the default (en) text — omit or pass 'en' for the default-language text. Admin only.",
    {
      text: z
        .string()
        .max(WELCOME_MESSAGE_MAX_CHARS)
        .describe(`The welcome text, or "" to clear (max ${WELCOME_MESSAGE_MAX_CHARS} characters)`),
      language: z
        .enum(['en', 'mi'])
        .optional()
        .describe("Which variant to set: 'en' (default) or 'mi' (te reo Māori). Defaults to 'en'."),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'set_welcome_message');
      const language = args.language ?? 'en';
      const policyKey = language === 'mi' ? 'welcome_message_mi' : 'welcome_message';
      const { success, result } = await audited({
        actionKind: 'set_welcome_message',
        params: { text: args.text, language },
        run: async () => {
          await updatePolicy(policyKey, args.text, caller.userId);
          return args.text ? 'updated' : 'cleared';
        },
      });
      if (!success) return text(`Failed: ${result}`, true);
      const label = language === 'mi' ? 'Welcome message (mi)' : 'Welcome message';
      return text(args.text ? `${label} updated.` : `${label} cleared.`);
    },
  );

  const saveKnowledgeTool = tool(
    'save_knowledge',
    'Save a durable fact/FAQ/resource to community knowledge for future recall. Admin only.',
    {
      title: z.string().optional().describe('Short title'),
      content: z.string().describe('The knowledge content to remember'),
      scope: z.string().optional().describe("'global' (default), a platform, or a conversation id"),
      sourceUrl: z
        .string()
        .url()
        .optional()
        .describe(
          'Optional citation URL shown to members alongside this answer (e.g. the page it came from)',
        ),
      sourceTitle: z.string().optional().describe('Optional human-readable label for sourceUrl'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'save_knowledge');
      const { id, similarEntry } = await saveKnowledge({
        title: args.title,
        content: args.content,
        scope: args.scope,
        sourceUserId: caller.userId,
        createdByRole: caller.role,
        sourceUrl: args.sourceUrl,
        sourceTitle: args.sourceTitle,
        callerPlatform: caller.platform,
      });
      let reply = `Saved knowledge entry #${id}.`;
      if (similarEntry) {
        const pct = (similarEntry.similarity * 100).toFixed(0);
        const label = similarEntry.title ? `"${similarEntry.title}"` : similarEntry.content.slice(0, 80);
        reply += ` Note: this looks similar (${pct}%) to existing entry #${similarEntry.id} (${label}) — consider update_knowledge on #${similarEntry.id} instead if this is the same topic.`;
      }
      return text(reply);
    },
  );

  const listKnowledgeTool = tool(
    'list_knowledge',
    'Browse curated community knowledge entries directly (not semantic search) — for finding an entry to correct or retire. Admin only.',
    {
      scope: z
        .string()
        .optional()
        .describe('Filter to a scope (e.g. "global", a platform, or a conversation id)'),
      limit: z.number().optional().describe('Max entries (default 20)'),
      offset: z.number().optional().describe('Pagination offset (default 0)'),
      staleOnly: z
        .boolean()
        .optional()
        .describe(
          'Only show entries untouched for KNOWLEDGE_STALE_DAYS+ days (the same entries counted in the ' +
            'weekly digest); ordered oldest-touched first.',
        ),
      provenance: z
        .enum(['admin', 'super_admin', 'auto', 'docs'])
        .optional()
        .describe(
          'Filter to entries created by this role/provenance (e.g. "auto" to review unreviewed ' +
            'web-researched entries)',
        ),
      sourceUnreachable: z
        .boolean()
        .optional()
        .describe(
          'Only show entries whose sourceUrl the weekly link-rot check flagged as unreachable ' +
            '(dead citation — re-verify or fix)',
        ),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_knowledge');
      const staleDays = config.adminDigest.knowledgeStaleDays;
      const staleMaxAgeDays = config.adminDigest.knowledgeStaleMaxAgeDays;
      if (args.staleOnly && staleDays <= 0 && staleMaxAgeDays <= 0) {
        return text(
          'Staleness tracking is disabled (neither KNOWLEDGE_STALE_DAYS nor KNOWLEDGE_STALE_MAX_AGE_DAYS is set).',
        );
      }
      const entries = await listKnowledge({
        scope: args.scope,
        limit: args.limit,
        offset: args.offset,
        ...(args.staleOnly ? { staleOnly: true, staleDays, staleMaxAgeDays } : {}),
        ...(args.provenance ? { provenance: args.provenance } : {}),
        ...(args.sourceUnreachable ? { sourceUnreachable: true } : {}),
      });
      if (entries.length === 0) return text('No knowledge entries found.');
      return text(
        untrusted(
          'Knowledge entries',
          entries
            .map(
              (e) =>
                `#${e.id} [${e.scope}] [${e.createdByRole}] ${e.title ? `${e.title}: ` : ''}${e.content.slice(0, 200)} ` +
                `(updated ${e.updatedAt.toISOString()}, retrieved ${e.retrievalCount}x` +
                `${e.lastRetrievedAt ? `, last ${e.lastRetrievedAt.toISOString()}` : ''}` +
                `${e.sourceUrl ? `, source: ${e.sourceTitle ?? e.sourceUrl} (${e.sourceUrl})` : ''}` +
                `${e.verifiedAt ? `, verified ${e.verifiedAt.toISOString()}` : ''}` +
                `${e.sourceUnreachable ? `, ⚠️ source unreachable (checked ${e.sourceCheckedAt?.toISOString()})` : ''})`,
            )
            .join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const listDuplicateKnowledgeTool = tool(
    'list_duplicate_knowledge',
    'Audit the knowledge base for existing near-duplicate entry pairs (same scope, high embedding ' +
      'similarity) — the retroactive counterpart to the nudge save_knowledge shows at write time. Use ' +
      'this to find pairs to merge (update_knowledge) or retire (delete_knowledge). Admin only.',
    {
      scope: z.string().optional().describe('Restrict the audit to a single scope (e.g. "global")'),
      limit: z.number().optional().describe('Max pairs to return (default 20)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_duplicate_knowledge');
      const pairs = await listDuplicateKnowledge(args.scope, args.limit);
      if (pairs.length === 0) return text('No near-duplicate knowledge pairs found.');
      return text(
        untrusted(
          'Near-duplicate knowledge pairs',
          pairs
            .map((p) => {
              const pct = (p.similarity * 100).toFixed(0);
              const aLabel = p.aTitle ? `"${p.aTitle}"` : `#${p.aId}`;
              const bLabel = p.bTitle ? `"${p.bTitle}"` : `#${p.bId}`;
              return `#${p.aId} (${aLabel}) ↔ #${p.bId} (${bLabel}) — ${pct}% similar`;
            })
            .join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const listKnowledgeConflictsTool = tool(
    'list_knowledge_conflicts',
    'Audit the knowledge base for pairs of entries that are about the same topic but worded ' +
      'differently enough that they may disagree (same scope, mid-range embedding similarity — clears ' +
      "knowledge_search's relevance floor but sits well under the near-duplicate threshold). Sibling of " +
      'list_duplicate_knowledge, which catches the opposite case (converged wording). Each pair is a ' +
      'candidate for admin review, not a confirmed contradiction — check both entries and merge ' +
      '(update_knowledge) or retire (delete_knowledge) as appropriate. Admin only.',
    {
      scope: z.string().optional().describe('Restrict the audit to a single scope (e.g. "global")'),
      limit: z.number().optional().describe('Max pairs to return (default 20)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_knowledge_conflicts');
      const pairs = await listKnowledgeConflictCandidates(args.scope, args.limit);
      if (pairs.length === 0) return text('No conflict-candidate knowledge pairs found.');
      return text(
        untrusted(
          'Conflict-candidate knowledge pairs — each is a candidate for admin review, not a confirmed contradiction',
          pairs
            .map((p) => {
              const pct = (p.similarity * 100).toFixed(0);
              const aLabel = p.aTitle ? `"${p.aTitle}"` : `#${p.aId}`;
              const bLabel = p.bTitle ? `"${p.bTitle}"` : `#${p.bId}`;
              return `#${p.aId} (${aLabel}) ↔ #${p.bId} (${bLabel}) — ${pct}% similar`;
            })
            .join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const updateKnowledgeTool = tool(
    'update_knowledge',
    'Correct an existing knowledge entry (title/content/scope/source). Re-embeds the content. Setting ' +
      'sourceUrl or sourceTitle re-verifies the citation (bumps verified_at to now). Requires ' +
      'confirmation (the edit overwrites trusted, member-facing content in place). Admin only.',
    {
      id: z.number().describe('Knowledge entry id (from list_knowledge or knowledge_search)'),
      title: z.string().optional().describe('New title; omit to leave unchanged'),
      content: z.string().optional().describe('New content; omit to leave unchanged'),
      scope: z.string().optional().describe('New scope; omit to leave unchanged'),
      sourceUrl: z
        .string()
        .url()
        .optional()
        .describe('New citation URL; omit to leave unchanged. Setting it re-verifies the citation.'),
      sourceTitle: z
        .string()
        .optional()
        .describe('New human-readable label for sourceUrl; omit to leave unchanged'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'update_knowledge');
      // CONFIRM-gated like delete_knowledge: an in-place overwrite of a
      // knowledge entry is destructive to trusted content that's served
      // verbatim to every tier (including via the zero-token shortcut), so an
      // injected admin turn could otherwise silently replace the curated KB.
      // The gate means an injection can request but never complete the edit.
      return requireConfirm(`update knowledge entry #${args.id}`, 'admin', async () => {
        // Capture the pre-edit text so the audit row records what was replaced
        // (in-place UPDATE keeps no history) — recoverability if a bad/hostile
        // edit slips through.
        const prior = await getKnowledgeContentById(args.id);
        const state: { similarEntry?: KnowledgeDuplicateMatch } = {};
        const { success, result } = await audited({
          actionKind: 'update_knowledge',
          params: {
            id: args.id,
            title: args.title,
            content: args.content,
            scope: args.scope,
            sourceUrl: args.sourceUrl,
            sourceTitle: args.sourceTitle,
            priorTitle: prior?.title,
            priorContent: prior?.content,
          },
          run: async () => {
            const outcome = await updateKnowledge({
              id: args.id,
              title: args.title,
              content: args.content,
              scope: args.scope,
              sourceUrl: args.sourceUrl,
              sourceTitle: args.sourceTitle,
              callerPlatform: caller.platform,
            });
            if (!outcome.updated) throw new Error(`No knowledge entry with id ${args.id}.`);
            state.similarEntry = outcome.similarEntry;
            return 'updated';
          },
        });
        if (!success) return `Failed: ${result}`;
        let reply = `Updated knowledge entry #${args.id}.`;
        if (state.similarEntry) {
          const { similarEntry } = state;
          const pct = (similarEntry.similarity * 100).toFixed(0);
          const label = similarEntry.title ? `"${similarEntry.title}"` : similarEntry.content.slice(0, 80);
          reply += ` Note: this looks similar (${pct}%) to existing entry #${similarEntry.id} (${label}) — consider update_knowledge on #${similarEntry.id} instead if this is the same topic.`;
        }
        return reply;
      });
    },
  );

  const deleteKnowledgeTool = tool(
    'delete_knowledge',
    'Retire (permanently delete) a knowledge entry that is no longer accurate. Requires confirmation. Admin only.',
    { id: z.number().describe('Knowledge entry id (from list_knowledge or knowledge_search)') },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'delete_knowledge');
      return requireConfirm(`delete knowledge entry #${args.id}`, 'admin', async () => {
        const { success, result } = await audited({
          actionKind: 'delete_knowledge',
          params: { id: args.id },
          run: async () => {
            const deleted = await deleteKnowledge(args.id);
            if (!deleted) throw new Error(`No knowledge entry with id ${args.id}.`);
            return 'deleted';
          },
        });
        return success ? `Deleted knowledge entry #${args.id}.` : `Failed: ${result}`;
      });
    },
  );

  const mergeKnowledgeTool = tool(
    'merge_knowledge',
    "Consolidate a detected duplicate/conflict pair into one entry: keeps `keepId`, folds `mergeId`'s " +
      'retrieval_count/last_retrieved_at history onto it, then deletes `mergeId`. Optional title/content/scope ' +
      "override the survivor's content (and re-embed it) exactly like update_knowledge; omit them to leave " +
      "keepId's existing wording untouched. Use this after list_duplicate_knowledge or list_knowledge_conflicts " +
      'to act on a pair instead of a manual update_knowledge + delete_knowledge. Requires confirmation. Admin only.',
    {
      keepId: z.number().describe('Knowledge entry id to keep (the survivor)'),
      mergeId: z.number().describe('Knowledge entry id to merge into keepId and delete'),
      title: z
        .string()
        .optional()
        .describe("New title for the survivor; omit to leave keepId's title unchanged"),
      content: z
        .string()
        .optional()
        .describe("New content for the survivor; omit to leave keepId's content unchanged"),
      scope: z
        .string()
        .optional()
        .describe("New scope for the survivor; omit to leave keepId's scope unchanged"),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'merge_knowledge');
      return requireConfirm(
        `merge knowledge entry #${args.mergeId} into #${args.keepId}`,
        'admin',
        async () => {
          // Pre-merge text of the entry being deleted, same recoverability
          // precedent as update_knowledge's `prior` capture — a merge deletes
          // mergeId, so this is the only record of what it contained.
          const prior = await getKnowledgeContentById(args.mergeId);
          const { success, result } = await audited({
            actionKind: 'merge_knowledge',
            params: {
              keepId: args.keepId,
              mergeId: args.mergeId,
              title: args.title,
              content: args.content,
              scope: args.scope,
              mergedTitle: prior?.title,
              mergedContent: prior?.content,
            },
            run: async () => {
              const outcome = await mergeKnowledgeEntries(args.keepId, args.mergeId, {
                title: args.title,
                content: args.content,
                scope: args.scope,
              });
              if (!outcome.merged) throw new Error(outcome.error ?? 'Merge failed.');
              return 'merged';
            },
          });
          return success
            ? `Merged knowledge entry #${args.mergeId} into #${args.keepId}.`
            : `Failed: ${result}`;
        },
      );
    },
  );

  const listAccessRequestsTool = tool(
    'list_access_requests',
    'List gated guests who have asked the bot for access — identity and request count only, never message content. Admin only.',
    { limit: z.number().optional().describe('Max entries (default 50)') },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_access_requests');
      const rows = await listAccessRequests(args.limit ?? 50);
      if (rows.length === 0) return text('No pending access requests.');
      return text(
        untrusted(
          'Access requests',
          rows
            .map((r) => {
              // firstRequestedAt is always the DB-stored insert timestamp for
              // this (platform, user_id) row (repository.ts's
              // listAccessRequests) — never sourced from a tool argument, so
              // it can't be spoofed by a caller-supplied value (issue #515).
              const waitingDays = Math.floor((Date.now() - r.firstRequestedAt.getTime()) / 86_400_000);
              return (
                `${r.platform} ${r.userName ? sanitizeName(r.userName) : r.userId} (${r.userId}) — ` +
                `${r.requestCount} request(s), first ${r.firstRequestedAt.toISOString()} (waiting ${waitingDays}d), ` +
                `last ${r.lastRequestedAt.toISOString()}`
              );
            })
            .join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const listSuggestionsTool = tool(
    'list_suggestions',
    'List member-submitted bot-improvement suggestions for triage. The bridge to the pipeline stays ' +
      'human: file anything worthwhile as a GitHub proposal yourself — the bot has no repo access. Admin only.',
    {
      status: z
        .enum(['new', 'reviewed', 'declined', 'done'])
        .optional()
        .describe('Filter by status (default: all statuses)'),
      limit: z.number().optional().describe('Max entries (default 50, max 200)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_suggestions');
      const rows = await listSuggestions(args.status, args.limit ?? 50);
      if (rows.length === 0) return text('No suggestions found.');
      return text(
        untrusted(
          'Suggestions',
          rows
            .map(
              (s) =>
                `#${s.id} [${s.status}] ${s.platform} ${s.displayName ? sanitizeName(s.displayName) : s.userId} (${s.createdAt.toISOString()}): ${s.content}`,
            )
            .join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const resolveSuggestionTool = tool(
    'resolve_suggestion',
    'Mark a suggestion as reviewed, declined, or done once triaged. Non-destructive status change ' +
      '(no CONFIRM needed), audited. Admin only.',
    {
      id: z.number().describe('Suggestion id (from list_suggestions)'),
      status: z.enum(['reviewed', 'declined', 'done']).describe('New status'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'resolve_suggestion');
      const state: { row: { platform: Platform; userId: string; content: string } | null } = { row: null };
      const { success, result } = await audited({
        actionKind: 'resolve_suggestion',
        params: { id: args.id, status: args.status },
        run: async () => {
          const row = await resolveSuggestion(args.id, args.status, caller.userId);
          if (!row) throw new Error(`No suggestion with id ${args.id}.`);
          state.row = row;
          return `marked ${args.status}`;
        },
      });
      // Cross-platform resolution DMs (issue #157): routes through the
      // suggestion's ORIGIN platform's adapter, not the resolving admin's
      // current-turn one, via Router's adapter registry — never misaddresses
      // a DM to the wrong platform. Degrades to today's silent skip if that
      // platform isn't registered in this deployment (e.g. WhatsApp not
      // configured).
      if (success && state.row) {
        const target = adapterFor(state.row.platform);
        if (target)
          await notifySuggestionResolved(
            target,
            state.row.userId,
            args.status,
            state.row.content,
            state.row.platform,
          );
      }
      return text(success ? `Suggestion #${args.id} marked ${args.status}.` : `Failed: ${result}`, !success);
    },
  );

  const addMemberNoteTool = tool(
    'add_member_note',
    'Attach a durable, admin-curated context note to a KNOWN community member (e.g. "runs the Chch ' +
      'meetup", "prefers email"). Person-scoped facts belong here, never in the global knowledge FAQ. ' +
      'Notes are human-entered only — never auto-populate one from web search or message content ' +
      'without the admin explicitly asking to save that text. Admin only.',
    {
      userId: z.string().min(1).describe('Platform user id of the member the note is about'),
      note: z
        .string()
        .min(1)
        .max(MEMBER_NOTE_MAX_CHARS)
        .describe(`The note text (max ${MEMBER_NOTE_MAX_CHARS} characters)`),
      platform: platformArg,
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'add_member_note');
      const { platform, userId } = await resolveMemberTarget(args.userId, args.platform);
      if ((await getMemberRole(platform, userId)) === null) {
        return text(`Refusing: "${userId}" is not a registered community member on ${platform}.`, true);
      }
      // The audit row records that a note was added, never the note text —
      // audit rows survive a purge, member_notes must not (SECURITY.md).
      const { success, result } = await audited({
        actionKind: 'add_member_note',
        targetUserId: userId,
        params: { platform, noteChars: args.note.length },
        run: async () => {
          const id = await addMemberNote({ platform, userId, note: args.note, createdBy: caller.userId });
          return `note #${id} added`;
        },
      });
      return text(success ? `Saved note for ${userId} (${result}).` : `Failed: ${result}`, !success);
    },
  );

  const listMemberNotesTool = tool(
    'list_member_notes',
    'Show the admin-curated context notes kept about one member. Notes are admin-only reading — they never appear on member turns, in knowledge_search, or in memory recall. Admin only.',
    { userId: z.string().min(1).describe('Platform user id of the member'), platform: platformArg },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_member_notes');
      const { platform, userId } = await resolveMemberTarget(args.userId, args.platform);
      const notes = await listMemberNotes(platform, userId);
      if (notes.length === 0) return text(`No notes for ${userId} on ${platform}.`);
      return text(
        untrusted(
          `Notes for ${userId}`,
          notes.map((n) => `#${n.id} [${n.createdAt.toISOString()} by ${n.createdBy}] ${n.note}`).join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const deleteMemberNoteTool = tool(
    'delete_member_note',
    'Permanently delete one member context note by id (from list_member_notes). Requires confirmation. ' +
      'Audited. Admin only.',
    { id: z.number().describe('Note id') },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'delete_member_note');
      // Resolve the note first so the CONFIRM names whose note is being
      // deleted — an injected bare id can't quietly erase the wrong one —
      // and so an unknown id is refused before anything is queued.
      const note = await getMemberNote(args.id);
      if (!note) return text(`No note with id ${args.id}.`, true);
      // Same CONFIRM gate as delete_knowledge: deletion is irreversible, so
      // the model can request it but only the admin's out-of-band reply
      // executes it (CLAUDE.md invariant).
      return requireConfirm(
        `delete member note #${args.id} about ${note.userId} on ${note.platform} ("${note.note.slice(0, 80)}${note.note.length > 80 ? '…' : ''}")`,
        'admin',
        async () => {
          const { success, result } = await audited({
            actionKind: 'delete_member_note',
            targetUserId: note.userId,
            params: { id: args.id },
            run: async () => {
              const deleted = await deleteMemberNote(args.id);
              if (!deleted) throw new Error(`No note with id ${args.id}.`);
              return 'deleted';
            },
          });
          return success ? `Deleted note #${args.id}.` : `Failed: ${result}`;
        },
      );
    },
  );

  const listRosterTool = tool(
    'list_roster',
    'Show the server roster kept from join/leave events: recent joiners, people who joined but were ' +
      'never added as members (the onboarding queue), or recent leavers — plus growth counts. Identity ' +
      'metadata only, never message content. Guild-wide (not conversation-scoped). Admin only.',
    {
      filter: z
        .enum(['recent', 'not_members', 'left', 'all'])
        .optional()
        .describe(
          "'recent' (default) = joined within the window; 'not_members' = present but never added to " +
            "community_users (onboarding queue); 'left' = left within the window; 'all' = everyone present",
        ),
      days: z.number().optional().describe("Window in days for 'recent'/'left' (default 7, max 90)"),
      limit: z.number().optional().describe('Max entries (default 50, max 200)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_roster');
      const filter = args.filter ?? 'recent';
      const rows = await listRoster(caller.platform, filter, args.days ?? 7, args.limit ?? 50);
      const counts = await rosterCounts(caller.platform);
      const summary = `Roster: ${counts.total} present · ${counts.joinedThisWeek} joined this week · ${counts.leftThisWeek} left this week.`;
      if (rows.length === 0) return text(`${summary}\nNo entries match filter "${filter}".`);
      return text(
        `${summary}\n` +
          untrusted(
            `Roster (${filter})`,
            rows
              .map(
                (r) =>
                  `${r.displayName ? sanitizeName(r.displayName) : r.userId} (${r.userId}) — joined ${r.joinedAt.toISOString()}` +
                  `${r.leftAt ? `, left ${r.leftAt.toISOString()}` : ''}` +
                  `${r.rejoinedCount > 0 ? `, rejoined ${r.rejoinedCount}x` : ''}` +
                  `${r.isMember ? '' : ', NOT yet a member'}`,
              )
              .join('\n'),
          ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const listContextDigestsTool = tool(
    'list_context_digests',
    'Show durable community-context digests the offline builder distilled from stored interactions: ' +
      'recurring topics with aggregate summaries and how many people/messages carried each. Admin only.',
    {
      days: z.number().optional().describe('How far back to look (default 30, max 365)'),
      limit: z.number().optional().describe('Max digests (default 20, max 100)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_context_digests');
      const rows = await listContextDigests(args.days ?? 30, args.limit ?? 20);
      if (rows.length === 0) {
        return text(
          'No context digests found. The offline builder may be disabled (CONTEXT_BUILDER_ENABLED) or has not run yet.',
        );
      }
      return text(
        untrusted(
          'Context digests',
          rows
            .map(
              (d) =>
                `#${d.id} [${d.periodStart.toISOString().slice(0, 10)}..${d.periodEnd.toISOString().slice(0, 10)}] ` +
                `${d.topic} — ${d.summary} (${d.questionCount} messages from ${d.distinctUsers} people)`,
            )
            .join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const listKnowledgeCandidatesTool = tool(
    'list_knowledge_candidates',
    'Browse the knowledge-candidate review queue: Q&A drafts the offline context builder proposed from ' +
      'recurring, answerable questions in community chat (behind CONTEXT_CANDIDATES_ENABLED). Nothing here ' +
      'is visible to members — review each with accept_knowledge_candidate or decline_knowledge_candidate. ' +
      'Admin only.',
    {
      status: z
        .enum(['pending', 'accepted', 'declined', 'withdrawn'])
        .optional()
        .describe('Filter by status (default: all statuses)'),
      limit: z.number().optional().describe('Max entries (default 50, max 200)'),
      oldestFirst: z
        .boolean()
        .optional()
        .describe(
          'Order by created_at ascending (oldest-drafted first) instead of the default newest-first — ' +
            'use this to find candidates that have sat unreviewed the longest.',
        ),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_knowledge_candidates');
      const rows = await listKnowledgeCandidates(args.status, args.limit ?? 50, args.oldestFirst ?? false);
      if (rows.length === 0) return text('No knowledge candidates found.');
      const lines = await Promise.all(
        rows.map(async (c) => {
          // SECURITY: a member-sourced tip's own title/content is untrusted
          // text this handler renders alongside the `[member-suggested by
          // ...]` provenance tag it adds itself — strip square brackets so
          // crafted title/content can't forge a fake tag (angle brackets/
          // newlines are already stripped by the surrounding untrusted()
          // wrapper below). Applied uniformly, not just to member-sourced
          // rows, since a machine-drafted candidate's text is untrusted too.
          const safeTitle = c.title.replace(/[[\]]/g, ' ');
          const safeContent = c.content.replace(/[[\]]/g, ' ');
          const safeTopic = c.topic.replace(/[[\]]/g, ' ');
          let provenance = '';
          if (c.sourcePlatform && c.sourceUserId) {
            const name = await resolveSanitizedLabel(c.sourcePlatform, c.sourceUserId);
            provenance = ` [member-suggested by ${name}]`;
          }
          return (
            `#${c.id} [${c.status}]${provenance} ${safeTitle}: ${safeContent} ` +
            `(topic: ${safeTopic}, drafted ${c.createdAt.toISOString()}` +
            `${c.digestId ? `, digest #${c.digestId}` : ''})`
          );
        }),
      );
      return text(untrusted('Knowledge candidates', lines.join('\n')));
    },
    { annotations: { readOnlyHint: true } },
  );

  const acceptKnowledgeCandidateTool = tool(
    'accept_knowledge_candidate',
    "Accept a pending knowledge candidate, publishing it as a durable knowledge entry via save_knowledge's " +
      'own path (so the near-duplicate nudge applies). Optional title/content override lets you fix wording ' +
      'at accept time without a separate update_knowledge call. Optional sourceUrl/sourceTitle attach a ' +
      'citation shown to members alongside the answer. Audited. Admin only.',
    {
      id: z.number().describe('Candidate id (from list_knowledge_candidates)'),
      title: z.string().optional().describe('Override title; omit to publish the drafted title as-is'),
      content: z.string().optional().describe('Override content; omit to publish the drafted content as-is'),
      sourceUrl: z.string().url().optional().describe('Optional citation URL shown to members'),
      sourceTitle: z.string().optional().describe('Optional human-readable label for sourceUrl'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'accept_knowledge_candidate');
      const state: {
        outcome: {
          knowledgeId: number;
          similarEntry?: KnowledgeDuplicateMatch;
          title: string;
          sourcePlatform: Platform | null;
          sourceUserId: string | null;
        } | null;
      } = { outcome: null };
      const { success, result } = await audited({
        actionKind: 'accept_knowledge_candidate',
        params: {
          id: args.id,
          title: args.title,
          content: args.content,
          sourceUrl: args.sourceUrl,
          sourceTitle: args.sourceTitle,
        },
        run: async () => {
          const outcome = await acceptKnowledgeCandidate({
            id: args.id,
            title: args.title,
            content: args.content,
            reviewedBy: caller.userId,
            sourceUrl: args.sourceUrl,
            sourceTitle: args.sourceTitle,
          });
          if (!outcome) throw new Error(`No pending knowledge candidate with id ${args.id}.`);
          state.outcome = outcome;
          return `published as knowledge #${outcome.knowledgeId}`;
        },
      });
      if (!success || !state.outcome) return text(`Failed: ${result}`, true);
      // Cross-platform resolution DM (issue #703, mirroring resolve_appeal's
      // #622 mechanism): only fires for a member-submitted tip (non-null
      // sourceUserId — a machine-drafted candidate has no member to notify),
      // routed via the tip's ORIGIN platform, never the resolving admin's own.
      // The target is always state.outcome's own sourcePlatform/sourceUserId —
      // never any accept_knowledge_candidate argument — so no caller-supplied
      // value can redirect it.
      if (state.outcome.sourceUserId && state.outcome.sourcePlatform) {
        const target = adapterFor(state.outcome.sourcePlatform);
        if (target)
          await notifyKnowledgeTipResolved(
            target,
            state.outcome.sourceUserId,
            'accepted',
            state.outcome.title,
            state.outcome.sourcePlatform,
          );
      }
      let reply = `Accepted candidate #${args.id} — saved as knowledge entry #${state.outcome.knowledgeId}.`;
      if (state.outcome.similarEntry) {
        const { similarEntry } = state.outcome;
        const pct = (similarEntry.similarity * 100).toFixed(0);
        const label = similarEntry.title ? `"${similarEntry.title}"` : similarEntry.content.slice(0, 80);
        reply += ` Note: this looks similar (${pct}%) to existing entry #${similarEntry.id} (${label}) — consider update_knowledge on #${similarEntry.id} instead if this is the same topic.`;
      }
      return text(reply);
    },
  );

  const declineKnowledgeCandidateTool = tool(
    'decline_knowledge_candidate',
    'Decline a pending knowledge candidate — retained as declined (never published, and the builder will ' +
      'not re-propose the same topic) rather than deleted. Non-destructive status change (no CONFIRM ' +
      'needed), audited. Admin only.',
    { id: z.number().describe('Candidate id (from list_knowledge_candidates)') },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'decline_knowledge_candidate');
      const state: { row: KnowledgeCandidate | null } = { row: null };
      const { success, result } = await audited({
        actionKind: 'decline_knowledge_candidate',
        params: { id: args.id },
        run: async () => {
          const declined = await declineKnowledgeCandidate(args.id, caller.userId);
          if (!declined) throw new Error(`No pending knowledge candidate with id ${args.id}.`);
          state.row = declined;
          return 'declined';
        },
      });
      // See the matching comment on accept_knowledge_candidate above — same
      // provenance-gated, origin-platform-routed DM, never caller-redirectable.
      if (success && state.row?.sourceUserId && state.row.sourcePlatform) {
        const target = adapterFor(state.row.sourcePlatform);
        if (target)
          await notifyKnowledgeTipResolved(
            target,
            state.row.sourceUserId,
            'declined',
            state.row.title,
            state.row.sourcePlatform,
          );
      }
      return text(success ? `Declined candidate #${args.id}.` : `Failed: ${result}`, !success);
    },
  );

  const questionDigest = tool(
    'question_digest',
    'Show recurring questions asked in your conversations over recent days (count >= 2), a signal for what should become a knowledge entry. Admin only.',
    {
      days: z.number().optional().describe('Window in days (default 7, max 30)'),
      limit: z.number().optional().describe('Max clusters to return (default 10)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'question_digest');
      const allowed = await callerScope();
      const clusters = await recentQuestionClusters(allowed, args.days ?? 7, args.limit ?? 10);
      if (clusters.length === 0)
        return text('No recurring questions in that window (within your conversations).');
      return text(
        untrusted(
          'Recurring questions',
          clusters.map((c, i) => `${i + 1}. (${c.count}x) ${c.representative.slice(0, 300)}`).join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const adminDigestTool = tool(
    'admin_digest',
    'On-demand pull of your OWN admin-digest snapshot — the same recurring-question, pending-access-request, ' +
      'open-report, pending-suggestion, stale/gap/candidate/low-rated-knowledge, roster, muted-member, ' +
      'max-turns-failure, duplicate/conflict-knowledge, and onboarding-queue signals the weekly digest DM ' +
      'would send you right now, without waiting for its cadence. Takes no arguments — always your own scoped ' +
      "view, never another admin's. Read-only; does not affect when your next weekly digest DM arrives. Admin only.",
    {},
    async () => {
      assertAtLeast(caller.role, 'admin', 'admin_digest');
      // Read-only pull: take only the rendered message. Deliberately ignore
      // `currentCounts` — snapshotting is exclusive to the scheduled
      // `runAdminDigestOnce`, so an on-demand pull never advances the
      // week-over-week trend baseline (issue #499 / #497).
      const { message } = await buildAdminDigestForAdmin(caller.platform, caller.userId, adapter);
      if (message == null) return text('Nothing to report right now.');
      // Unlike the weekly DM push (plain text straight to a human, never
      // re-parsed), this tool result re-enters the model's context — and the
      // cluster section embeds raw member-submitted question text
      // (recentQuestionClusters). Quarantine the whole message the same way
      // question_digest quarantines the identical cluster data above (issue
      // #499 review).
      return text(untrusted('Admin digest', message));
    },
    { annotations: { readOnlyHint: true } },
  );

  const reviewQueueTool = tool(
    'review_queue',
    'Single roll-up of all five admin review queues — access requests, suggestions, knowledge candidates, ' +
      'reports, and appeals — each with its current pending/open count, so triage starts with one glance ' +
      "instead of polling five separate list_* tools in turn. Every line also shows the oldest item's age in " +
      'whole days once that queue is non-empty. Reports reflect only your own conversation scope, same as ' +
      'list_reports (never a guild-wide total); appeals reflect only your own platform, same as list_appeals. ' +
      'Read-only, takes no arguments. Admin only.',
    {},
    async () => {
      assertAtLeast(caller.role, 'admin', 'review_queue');
      const allowed = await callerScope();
      // Same linked-identity-aware accused-admin exclusion list_reports uses
      // (issue #197 + link_member), so the reports line here can never show a
      // count larger than what list_reports would actually let this admin open.
      const viewerIds = (await resolveLinkedIdentities(caller.platform, caller.userId)).map((i) => i.userId);
      const [
        accessRequestCount,
        accessRequestAgeDays,
        suggestionCount,
        suggestionAgeDays,
        candidateCount,
        candidateAgeDays,
        reportCount,
        reportAgeDays,
        appealCount,
        appealAgeDays,
      ] = await Promise.all([
        countAccessRequests(),
        oldestAccessRequestAgeDays(),
        countPendingSuggestions(),
        oldestPendingSuggestionAgeDays(),
        countPendingKnowledgeCandidates(),
        oldestPendingCandidateAgeDays(),
        countOpenReports(allowed, viewerIds),
        oldestOpenReportAgeDays(allowed, viewerIds),
        countOpenAppeals(caller.platform),
        oldestOpenAppealAgeDays(caller.platform),
      ]);
      // Each oldest*AgeDays resolves to null over an empty (or fully-scoped-
      // out) row set, never 0 — so gating the suffix on non-null is exactly
      // "only when this queue is non-empty" (acceptance criterion 2).
      const ageSuffix = (ageDays: number | null) => (ageDays !== null ? ` (oldest ${ageDays}d)` : '');
      const lines = [
        `- Access requests: ${accessRequestCount} pending${ageSuffix(accessRequestAgeDays)}`,
        `- Suggestions: ${suggestionCount} pending${ageSuffix(suggestionAgeDays)}`,
        `- Knowledge candidates: ${candidateCount} pending${ageSuffix(candidateAgeDays)}`,
        `- Reports (your conversations): ${reportCount} open${ageSuffix(reportAgeDays)}`,
        `- Appeals: ${appealCount} open${ageSuffix(appealAgeDays)}`,
      ];
      return text(`📋 Review queue\n${lines.join('\n')}`);
    },
    { annotations: { readOnlyHint: true } },
  );

  const listKnowledgeGaps = tool(
    'list_knowledge_gaps',
    'Show searches (asked >= 2 times) in your conversations over recent days that found no confident answer — ' +
      'the miss-specific complement to question_digest, a signal for what should become a knowledge entry. ' +
      "Entries are searches with no confident answer, not necessarily members' verbatim questions. Admin only.",
    {
      days: z.number().optional().describe('Window in days (default 7, max 30)'),
      limit: z.number().optional().describe('Max clusters to return (default 10)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_knowledge_gaps');
      const allowed = await callerScope();
      const clusters = await recentKnowledgeGapClusters(allowed, args.days ?? 7, args.limit ?? 10);
      if (clusters.length === 0)
        return text('No recurring knowledge-search misses in that window (within your conversations).');
      return text(
        untrusted(
          'Knowledge-search misses',
          clusters.map((c, i) => `${i + 1}. (${c.count}x) ${c.representative.slice(0, 300)}`).join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const responseLatencyTool = tool(
    'response_latency',
    "Show how quickly your conversations' members are getting answered — count of replies, median and " +
      'p90 response time in seconds, over a recent window (default 7 days, max 30). Pairs each reply to a ' +
      "member with that member's preceding message; proactive digest/alert pushes are never counted. " +
      "Optionally scope to 'auto_answer' (ambient auto-answer replies only) or 'mention' (every other " +
      'reply — DMs and text-command replies included, since those also set replyToUserId without ' +
      "autoAnswer); default 'all'. Aggregate only — never a per-message timestamp, user id, or message " +
      'excerpt. Admin only.',
    {
      days: z.number().optional().describe('Window in days (default 7, max 30)'),
      scope: z
        .enum(['all', 'auto_answer', 'mention'])
        .optional()
        .describe("Restrict to 'auto_answer' or 'mention' replies (default 'all')"),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'response_latency');
      const allowed = await callerScope();
      const stats = await responseLatencyStats(allowed, args.days ?? 7, args.scope ?? 'all');
      const days = Math.min(Math.max(Math.trunc(args.days ?? 7) || 7, 1), 30);
      if (!stats) return text(`⏱️ Response latency (last ${days}d): not enough data yet.`);
      return text(
        `⏱️ Response latency (last ${days}d): ${stats.count} replies, ` +
          `median ${Math.round(stats.medianSeconds)}s, p90 ${Math.round(stats.p90Seconds)}s`,
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const moderationHistory = tool(
    'moderation_history',
    "Show recent moderation actions (warnings, timeouts, kicks, bans, deletions, announcements) in your conversations — for checking prior history before escalating. Optionally filter to one member and/or one action kind, e.g. to review a specific member's prior warnings before deciding whether to escalate. Admin only.",
    {
      limit: z.number().optional().describe('Max entries (default 20, max 100)'),
      targetUserId: z.string().optional().describe('Only show actions taken against this member'),
      actionKind: z.enum(MODERATION_ACTION_KINDS).optional().describe('Only show actions of this kind'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'moderation_history');
      const allowed = await callerScope();
      const rows = await recentModerationEntries(
        allowed,
        args.limit ?? 20,
        args.targetUserId,
        args.actionKind,
      );
      if (rows.length === 0) return text('No moderation actions recorded (within your conversations).');
      return text(
        rows
          .map(
            (r) =>
              `[${r.createdAt.toISOString()}] ${r.platform} ${r.conversationId ?? 'unknown'} — ${r.actorUserId} → ${r.actionKind}${r.targetUserId ? ` (${r.targetUserId})` : ''} ${r.success ? '✓' : '✗'} ${r.result ?? ''}`,
          )
          .join('\n'),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const listReportsTool = tool(
    'list_reports',
    'List member-submitted content reports (harassment/spam/rule violations) from your conversations, ' +
      'plus any reports filed from a 1:1 DM (those have no conversation any regular admin naturally ' +
      'participates in). Exception: a DM report filed against you is not shown here — only a super admin ' +
      'can see and resolve a report about you, so you cannot dismiss one filed against yourself. Admin only.',
    {
      status: z
        .enum(['open', 'resolved', 'dismissed', 'withdrawn'])
        .optional()
        .describe('Filter by status (default: all statuses)'),
      limit: z.number().optional().describe('Max entries (default 50)'),
      targetUserId: z.string().optional().describe('Only show reports filed against this member'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_reports');
      const allowed = await callerScope();
      // The accused-admin exclusion must cover EVERY identity linked to this
      // admin (issue #197 + link_member): a Discord+WhatsApp admin listing on
      // one platform could otherwise see a DM report filed against their other
      // identity, since a single raw id `<> ALL` their own list.
      const viewerIds = (await resolveLinkedIdentities(caller.platform, caller.userId)).map((i) => i.userId);
      const rows = await listReports(allowed, args.status, args.limit ?? 50, viewerIds, args.targetUserId);
      if (rows.length === 0) return text('No reports found (within your conversations).');
      return text(
        untrusted(
          'Content reports',
          rows
            .map(
              (r) =>
                `#${r.id} [${r.status}] ${r.platform} ${r.conversationId} — reporter ${r.reporterName ? sanitizeName(r.reporterName) : r.reporterUserId}` +
                `${r.targetUserId ? `, target ${r.targetUserId}` : ''}${r.messageId ? `, message ${r.messageId}` : ''}: ` +
                `${r.reason} (${r.createdAt.toISOString()})`,
            )
            .join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const resolveReportTool = tool(
    'resolve_report',
    'Mark a content report as resolved or dismissed once triaged. Non-destructive status change (no ' +
      'CONFIRM needed), audited. Admins can resolve reports from conversations they are in, plus ' +
      'DM-originated reports — except one filed against themselves, which stays super-admin-only. ' +
      'Admin only.',
    {
      id: z.number().describe('Report id (from list_reports)'),
      status: z.enum(['resolved', 'dismissed']).describe('New status'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'resolve_report');
      const allowed = await callerScope();
      // Same linked-identity-aware accused-admin exclusion as list_reports.
      const viewerIds = (await resolveLinkedIdentities(caller.platform, caller.userId)).map((i) => i.userId);
      const state: { row: { platform: Platform; reporterUserId: string; reason: string } | null } = {
        row: null,
      };
      const { success, result } = await audited({
        actionKind: 'resolve_report',
        params: { id: args.id, status: args.status },
        run: async () => {
          const row = await resolveContentReport(
            args.id,
            args.status,
            caller.userId,
            allowed ?? undefined,
            viewerIds,
          );
          if (!row) throw new Error(`No report with id ${args.id} in your conversations.`);
          state.row = row;
          return `marked ${args.status}`;
        },
      });
      // Cross-platform resolution DMs (issue #157), identical mechanism to
      // resolve_suggestion above: routes through the report's ORIGIN
      // platform's adapter via Router's registry, degrading to a silent skip
      // if that platform isn't registered in this deployment.
      if (success && state.row) {
        const target = adapterFor(state.row.platform);
        if (target)
          await notifyReportResolved(
            target,
            state.row.reporterUserId,
            args.status,
            state.row.reason,
            state.row.platform,
          );
      }
      return text(success ? `Report #${args.id} marked ${args.status}.` : `Failed: ${result}`, !success);
    },
  );

  const listAnswerFeedbackTool = tool(
    'list_answer_feedback',
    "List member ratings (helpful/unhelpful) of the bot's answers from your conversations. Where shown, " +
      "'served from knowledge #N' is a best-effort correlation with the knowledge_search hit that most " +
      "recently cleared the relevance floor in that turn — not a guarantee the model's answer actually drew " +
      'from that entry. A rating from a conversation you do not participate in is not visible here even to ' +
      'admins — only to a super admin. Admin only.',
    {
      unhelpfulOnly: z.boolean().optional().describe('Only show unhelpful (thumbs-down) ratings'),
      limit: z.number().optional().describe('Max entries (default 50)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_answer_feedback');
      const allowed = await callerScope();
      const rows = await listAnswerFeedback(allowed, args.unhelpfulOnly ?? false, args.limit ?? 50);
      if (rows.length === 0) return text('No answer feedback found (within your conversations).');
      return text(
        rows
          .map((r) => {
            const knowledgeNote =
              r.knowledgeEntryId != null ? `, served from knowledge #${r.knowledgeEntryId}` : '';
            const answerText = r.content != null ? `\n  ${untrusted('answer', r.content)}` : '';
            const commentText = r.comment != null ? `\n  ${untrusted('comment', r.comment)}` : '';
            return (
              `#${r.id} [${r.helpful ? 'helpful' : 'unhelpful'}] ${r.platform} ${r.conversationId} — ` +
              `from ${r.userId}${r.interactionId ? `, answer #${r.interactionId}` : ' (rated answer since purged)'}` +
              `${knowledgeNote} (${r.createdAt.toISOString()})${answerText}${commentText}`
            );
          })
          .join('\n'),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const listLowRatedKnowledgeTool = tool(
    'list_low_rated_knowledge',
    'Show knowledge entries with accumulated unhelpful ratings (>= minUnhelpful) — grouped by entry so you ' +
      "can spot a bad or stale FAQ answer without scanning list_answer_feedback's raw per-rating list. " +
      'Covers answers served via the deterministic knowledge shortcut (exact match) AND, best-effort, the ' +
      'normal model-mediated knowledge_search path: the entry attributed there is a correlation with the ' +
      'most recent knowledge_search hit that cleared the relevance floor in that turn, not a guarantee the ' +
      "model's reply actually drew from it — treat a flagged entry as a lead to check, not certain proof. " +
      'Ratings on interactions with no knowledgeEntryId at all are still excluded. A rating from a ' +
      'conversation you do not participate in is not counted here even for admins — only for a super admin. ' +
      'When present, includes the most recent member comment left on an unhelpful rating for that entry, ' +
      'so you see why without switching to list_answer_feedback. Admin only.',
    {
      minUnhelpful: z
        .number()
        .optional()
        .describe('Minimum unhelpful ratings for an entry to be shown (default 2)'),
      limit: z.number().optional().describe('Max entries (default 20)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_low_rated_knowledge');
      const allowed = await callerScope();
      const rows = await listKnowledgeFeedbackSummary(allowed, args.minUnhelpful ?? 2, args.limit ?? 20);
      if (rows.length === 0)
        return text('No knowledge entries meet that unhelpful-rating threshold (within your conversations).');
      return text(
        untrusted(
          'Low-rated knowledge entries',
          rows
            .map((r) => {
              const commentNote = r.sampleComment ? `\n  ${untrusted('comment', r.sampleComment)}` : '';
              return (
                `#${r.knowledgeEntryId}${r.title ? ` "${r.title}"` : ''} — ${r.helpfulCount} helpful, ` +
                `${r.unhelpfulCount} unhelpful (updated ${r.updatedAt.toISOString()})${commentNote}`
              );
            })
            .join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const listUnhelpfulThemesTool = tool(
    'list_unhelpful_themes',
    'Show recurring themes (count >= 2) across unhelpful (thumbs-down) answer ratings that carry a member ' +
      'comment, clustered by similarity — the cross-cutting complement to list_low_rated_knowledge (which is ' +
      "per-entry and excludes ungrounded answers) and list_answer_feedback's raw per-rating list. Covers BOTH " +
      "knowledge-grounded and ungrounded answers. A comment from a conversation you don't participate in is not " +
      'counted here even for admins — only for a super admin. Admin only.',
    {
      days: z.number().optional().describe('Window in days (default 7, max 30)'),
      limit: z.number().optional().describe('Max themes to return (default 10)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'list_unhelpful_themes');
      const allowed = await callerScope();
      const clusters = await recentUnhelpfulFeedbackClusters(allowed, args.days ?? 7, args.limit ?? 10);
      if (clusters.length === 0)
        return text('No recurring unhelpful-answer themes in that window (within your conversations).');
      return text(
        untrusted(
          'Recurring unhelpful-answer themes',
          clusters.map((c, i) => `${i + 1}. (${c.count}x) ${c.representative.slice(0, 300)}`).join('\n'),
        ),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const addMember = tool(
    'add_member',
    'Register a user as a community member so the bot will talk to them (gated mode). Admin only; grants member tier only.',
    {
      userId: z.string().min(1).describe('Platform user id (Discord user id / WhatsApp number without +)'),
      platform: platformArg,
      displayName: z.string().optional().describe('Human-readable name for records'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'add_member');
      const { platform, userId } = await resolveMemberTarget(args.userId, args.platform);
      const wasAlreadyMember = (await getMemberRole(platform, userId)) !== null;
      const finalRole = await upsertMember({
        platform,
        userId,
        role: 'member',
        addedBy: caller.userId,
        displayName: args.displayName,
      });
      await audited({
        actionKind: 'add_member',
        targetUserId: userId,
        params: { platform, displayName: args.displayName },
        run: async () => `registered as ${finalRole} on ${platform}`,
      });
      await clearAccessRequest(platform, userId).catch((err) =>
        logger.warn({ err, userId }, 'Failed to clear access request'),
      );
      // Cross-platform approval DM (issue #157's pattern, extended by #548):
      // routes through the TARGET's platform adapter, not the acting admin's
      // current-turn one — degrades to a silent skip if that platform isn't
      // registered in this deployment. Capture whether the DM was delivered
      // (issue #556) so the reply can flag a failed send; an unregistered
      // target attempts nothing, so it counts as delivered (no failure note).
      const memberTarget = adapterFor(platform);
      const dmDelivered = memberTarget
        ? await notifyMemberApproved(memberTarget, userId, wasAlreadyMember, platform)
        : true;
      const label = await resolveSanitizedLabel(platform, userId, args.displayName);
      const note = dmDelivered ? '' : MEMBER_DM_FAILED_NOTE;
      return text(`Added ${label} as ${finalRole} on ${platform}.${note}`);
    },
  );

  const removeMemberTool = tool(
    'remove_member',
    'Remove a member (revokes bot access in gated mode). Cannot remove admins. Admin only.',
    { userId: z.string().min(1).describe('Platform user id to remove'), platform: platformArg },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'remove_member');
      const { platform, userId } = await resolveMemberTarget(args.userId, args.platform);
      // Resolve the name before the row is deleted (roster still has it after).
      const label = await resolveSanitizedLabel(platform, userId);
      if (isSuperAdmin(platform, userId)) {
        return text('Refusing: that user is a super admin.', true);
      }
      const { result } = await audited({
        actionKind: 'remove_member',
        targetUserId: userId,
        params: { platform },
        run: async () => {
          const removed = await removeMember(platform, userId);
          if (!removed)
            throw new Error('No member row removed (not a member, or an admin — revoke admin first).');
          return 'membership removed';
        },
      });
      return text(
        result === 'membership removed' ? `Removed ${label} from ${platform} members.` : `Failed: ${result}`,
        result !== 'membership removed',
      );
    },
  );

  const linkMemberTool = tool(
    'link_member',
    "Link two platform identities (e.g. a member's Discord account and WhatsApp number) as the same " +
      'person, so forget_me/purge_user_data, the daily reply budget, and admin views (user_history) ' +
      'follow the person, not the platform row. Both identities must already be known community members ' +
      "(use add_member first). NEVER changes anyone's tier — a member linked to an admin still resolves " +
      "as member-only. Linking expands forget_me's blast radius: once linked, forget_me from EITHER " +
      'identity erases stored data for BOTH — that is the intended effect, which is why this requires ' +
      'confirmation. Admin only.',
    {
      platformA: z.enum(['discord', 'whatsapp']).describe('Platform of the first identity'),
      userIdA: z.string().min(1).describe('Platform user id of the first identity'),
      platformB: z.enum(['discord', 'whatsapp']).describe('Platform of the second identity'),
      userIdB: z.string().min(1).describe('Platform user id of the second identity'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'link_member');
      const a = { platform: args.platformA, userId: normalizeMemberId(args.platformA, args.userIdA) };
      const b = { platform: args.platformB, userId: normalizeMemberId(args.platformB, args.userIdB) };
      if (a.platform === b.platform && a.userId === b.userId) {
        return text('Refusing: cannot link an identity to itself.', true);
      }
      // Authority: an admin must have at least one identity on their own
      // platform. Linking two identities that are *both* on another platform is
      // super-admin-only — consistent with resolveMemberTarget's cross-platform
      // gate on add_member/remove_member/unlink_member.
      if (a.platform !== caller.platform && b.platform !== caller.platform) {
        assertAtLeast(caller.role, 'super_admin', 'linking two identities both on another platform');
      }
      if (isSuperAdmin(a.platform, a.userId) || isSuperAdmin(b.platform, b.userId)) {
        return text('Refusing: super admins are configured in the environment, not linkable here.', true);
      }
      if (!(await getMemberRole(a.platform, a.userId)) || !(await getMemberRole(b.platform, b.userId))) {
        return text(
          'Refusing: both identities must already be known community members (add_member first).',
          true,
        );
      }
      return requireConfirm(
        `link ${a.platform}:${a.userId} and ${b.platform}:${b.userId} as the same person — ` +
          'forget_me and the daily reply budget will apply across both afterwards',
        'admin',
        async () => {
          const { success, result } = await audited({
            actionKind: 'link_member',
            targetUserId: `${a.platform}:${a.userId}+${b.platform}:${b.userId}`,
            params: { a, b },
            run: async () => {
              const { personId } = await linkMembers(a.platform, a.userId, b.platform, b.userId);
              return `linked as person #${personId}`;
            },
          });
          return success
            ? `Linked ${a.platform}:${a.userId} and ${b.platform}:${b.userId}: ${result}.`
            : `Failed: ${result}`;
        },
      );
    },
  );

  const unlinkMemberTool = tool(
    'unlink_member',
    'Undo a previous link_member: the given identity becomes independently subject to forget_me/purge ' +
      'and the daily reply budget again. Admin only.',
    { userId: z.string().min(1).describe('Platform user id to unlink'), platform: platformArg },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'unlink_member');
      const platform = args.platform ?? caller.platform;
      const userId = normalizeMemberId(platform, args.userId);
      const label = await resolveSanitizedLabel(platform, userId);
      // An admin may unlink an identity on their own platform, or one linked to
      // an identity on their platform (they have authority over that person).
      // Unlinking a foreign identity with no on-platform link is super-admin-only
      // — symmetric with link_member's both-foreign gate above.
      if (platform !== caller.platform) {
        const group = await resolveLinkedIdentities(platform, userId);
        if (!group.some((g) => g.platform === caller.platform)) {
          assertAtLeast(caller.role, 'super_admin', 'unlinking an identity on another platform');
        }
      }
      return requireConfirm(`unlink ${label} on ${platform} from its linked identity`, 'admin', async () => {
        const { success, result } = await audited({
          actionKind: 'unlink_member',
          targetUserId: userId,
          params: { platform },
          run: async () => {
            const done = await unlinkMember(platform, userId);
            if (!done) throw new Error('That identity is not currently linked to anyone.');
            return 'unlinked';
          },
        });
        return success ? `Unlinked ${label} on ${platform}: ${result}.` : `Failed: ${result}`;
      });
    },
  );

  // --- Cosmetic community roles (issue #232) ----------------------------------
  //
  // Strictly orthogonal to the RBAC tiers above: these tools only ever touch
  // Discord's own role assignment, never `community_users.role`/`resolveRole`
  // (pinned by a SECURITY: test). The load-bearing security control is NOT
  // this tool-level allowlist check — it's the assign-time live permission
  // re-check inside DiscordAdapter.performAdminAction, since the allowlist is
  // only a curation-time guarantee and a role's permission bitfield can
  // change afterwards. See docs/SECURITY.md.

  /** Shared allowlist + support guard for assign/remove_community_role. */
  function checkAssignableRole(roleId: string): string | null {
    if (!adapter.adminCapabilities.has('assign_community_role')) {
      return `This platform (${adapter.platform}) does not support community roles.`;
    }
    if (!config.discord.assignableRoleIds.includes(roleId)) {
      return `Refusing: role "${roleId}" is not on the assignable-role allowlist.`;
    }
    return null;
  }

  const assignCommunityRoleTool = tool(
    'assign_community_role',
    'Assign a cosmetic/community Discord role (e.g. a regional tag or "verified builder") to a member. ' +
      "Presentation only — it never changes the member's bot permission tier. Only roles on the " +
      'configured allowlist can be assigned, and only while the role currently carries zero Discord ' +
      'permissions. Discord only. Admin only; requires confirmation.',
    {
      userId: z.string().min(1).describe('Platform user id to assign the role to'),
      roleId: z.string().min(1).describe('Discord role id (must be on the assignable allowlist)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'assign_community_role');
      const refusal = checkAssignableRole(args.roleId);
      if (refusal) return text(refusal, true);
      if (!(await getMemberRole(caller.platform, args.userId))) {
        return text(`Refusing: "${args.userId}" is not a known community member (add_member first).`, true);
      }
      const label = await resolveSanitizedLabel(caller.platform, args.userId);
      return requireConfirm(`assign community role ${args.roleId} to ${label}`, 'admin', async () => {
        const { success, result } = await audited({
          actionKind: 'assign_community_role',
          targetUserId: args.userId,
          params: { roleId: args.roleId },
          run: () =>
            adapter.performAdminAction({
              kind: 'assign_community_role',
              targetUserId: args.userId,
              params: { roleId: args.roleId },
            }),
        });
        return success ? `Done: ${result}` : `Failed: ${result}`;
      });
    },
  );

  const removeCommunityRoleTool = tool(
    'remove_community_role',
    'Remove a previously assigned cosmetic/community Discord role from a member. Same allowlist as ' +
      'assign_community_role. Discord only. Admin only; requires confirmation.',
    {
      userId: z.string().min(1).describe('Platform user id to remove the role from'),
      roleId: z.string().min(1).describe('Discord role id (must be on the assignable allowlist)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'remove_community_role');
      const refusal = checkAssignableRole(args.roleId);
      if (refusal) return text(refusal, true);
      if (!(await getMemberRole(caller.platform, args.userId))) {
        return text(`Refusing: "${args.userId}" is not a known community member (add_member first).`, true);
      }
      const label = await resolveSanitizedLabel(caller.platform, args.userId);
      return requireConfirm(`remove community role ${args.roleId} from ${label}`, 'admin', async () => {
        const { success, result } = await audited({
          actionKind: 'remove_community_role',
          targetUserId: args.userId,
          params: { roleId: args.roleId },
          run: () =>
            adapter.performAdminAction({
              kind: 'remove_community_role',
              targetUserId: args.userId,
              params: { roleId: args.roleId },
            }),
        });
        return success ? `Done: ${result}` : `Failed: ${result}`;
      });
    },
  );

  const listAssignableRolesTool = tool(
    'list_assignable_roles',
    'List the configured cosmetic Discord roles (DISCORD_ASSIGNABLE_ROLES) with their current name and ' +
      'whether each currently carries any Discord permission — a flagged role would be refused by ' +
      'assign_community_role until an admin strips its permissions. Read-only. Admin only.',
    {},
    async () => {
      assertAtLeast(caller.role, 'admin', 'list_assignable_roles');
      if (!adapter.adminCapabilities.has('list_assignable_roles')) {
        return text(`This platform (${adapter.platform}) does not support community roles.`, true);
      }
      const result = await adapter.performAdminAction({ kind: 'list_assignable_roles' });
      return text(result);
    },
    { annotations: { readOnlyHint: true } },
  );

  /**
   * Admin project tools resolve by slug via getProjectBySlug, which does NOT
   * exclude archived projects — deliberately, since membership and surface
   * edits must still work on an archived project so a team can be tidied up
   * before (or set up before) an unarchive. But doing so silently reads as a
   * no-op to the admin: nothing they change takes effect until the project is
   * unarchived, because visibleProjectIds excludes archived projects from every
   * read and write. So say so in the reply (PR #929 review).
   */
  const archivedSuffix = (project: { archivedAt: Date | null }) =>
    project.archivedAt
      ? ' Note: this project is ARCHIVED, so nobody can reach it until project_unarchive.'
      : '';

  // --- Project management (issue #927, admin tier) ----------------------------
  //
  // Membership and surface bindings are set HERE and only here — never from
  // message content, exactly as roles are. Modelled on link_member: admin
  // tier, audited, explicit about never touching anyone's tier.

  const projectCreate = tool(
    'project_create',
    'Create a project: a shared memory for a standing team (e.g. an Impact Lab), which its members can ' +
      'read and add to across Discord and WhatsApp. Creating it grants nobody access — add members with ' +
      'project_add_member and bind the conversations it may be discussed in with project_bind_here. ' +
      'Admin only.',
    {
      slug: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'lowercase letters, digits and hyphens')
        .describe('Short handle used to refer to the project, e.g. "impact-lab"'),
      name: z
        .string()
        .min(1)
        .max(TEAM_PROJECT_NAME_MAX_CHARS)
        .describe(`Human-readable project name (max ${TEAM_PROJECT_NAME_MAX_CHARS} characters)`),
      brief: z
        .string()
        .max(TEAM_PROJECT_BRIEF_MAX_CHARS)
        .optional()
        .describe(
          'Standing context about the project, shown to members who list it (max ' +
            `${TEAM_PROJECT_BRIEF_MAX_CHARS} characters)`,
        ),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'project_create');
      const { result } = await audited({
        actionKind: 'project_create',
        params: { slug: args.slug },
        run: async () => {
          // The uniqueness check IS the insert (PR #929 review) — a
          // SELECT-then-INSERT races two concurrent admins into a raw
          // constraint-violation message instead of this reply.
          const project = await createProject({
            slug: args.slug,
            name: args.name,
            brief: args.brief,
            createdBy: caller.userId,
          });
          if (!project) return `A project "${args.slug}" already exists.`;
          return `Created project ${project.name} [${project.slug}]. No members yet.`;
        },
      });
      return text(result);
    },
    { annotations: { readOnlyHint: false } },
  );

  const projectAddMember = tool(
    'project_add_member',
    "Give a community member access to a project's shared memory. This grants DATA ACCESS ONLY — it " +
      "NEVER changes anyone's tier, exactly like link_member. If the member's Discord and WhatsApp " +
      'identities have been linked with link_member, adding either one gives them access from both. ' +
      'Admin only.',
    {
      project: z.string().describe('The project slug'),
      userId: z.string().min(1).describe('Platform user id of the member to add'),
      platform: platformArg,
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'project_add_member');
      const target = await resolveMemberTarget(args.userId, args.platform);
      // Deliberately NOT requireConfirm-gated, and the precedent is
      // `add_member`, not `link_member` (PR #929 review). This repo's CONFIRM
      // gate is for DESTRUCTIVE or irreversible actions — delete_knowledge,
      // remove_member, unlink_member, grant_admin. `link_member` is gated for
      // exactly that reason, stated in its own description: linking expands
      // what a single forget_me ERASES, permanently and across both
      // identities. Granting project access destroys nothing, and
      // `project_remove_member` below reverses it in one call. `add_member`
      // — which grants access to the whole bot, a strictly larger grant than
      // one project's notes — is likewise admin-tier + audited with no
      // confirm. Adding one here would make this stricter than the tool it
      // is a subset of.
      const { result } = await audited({
        actionKind: 'project_add_member',
        targetUserId: target.userId,
        params: { project: args.project },
        run: async () => {
          const project = await getProjectBySlug(args.project);
          if (!project) return `No project "${args.project}".`;
          // SECURITY (PR #929 review): the target must already be a known
          // community member, exactly as link_member requires. Granting
          // project access to an arbitrary (platform, userId) would create a
          // membership row for an identity that never passed add_member —
          // and since visibleProjectIds checks only that row, never tier, in
          // an open-mode deployment that identity would read the team's notes
          // while sitting at guest tier.
          if (!(await getMemberRole(target.platform, target.userId))) {
            return `${target.userId} is not a community member yet — run add_member first.`;
          }
          const added = await addProjectMember(project.id, target.platform, target.userId, caller.userId);
          return added
            ? `Added to ${project.name}. Their tier is unchanged.${archivedSuffix(project)}`
            : `Already a member of ${project.name}.${archivedSuffix(project)}`;
        },
      });
      return text(result);
    },
    { annotations: { readOnlyHint: false } },
  );

  const projectRemoveMember = tool(
    'project_remove_member',
    "Take away a member's access to a project's shared memory. They immediately stop being able to " +
      'read or add to it. Notes they already recorded stay with the project — this revokes access, it ' +
      "does not erase their contributions. Never changes anyone's tier. Admin only.",
    {
      project: z.string().describe('The project slug'),
      userId: z.string().min(1).describe('Platform user id of the member to remove'),
      platform: platformArg,
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'project_remove_member');
      const target = await resolveMemberTarget(args.userId, args.platform);
      const { result } = await audited({
        actionKind: 'project_remove_member',
        targetUserId: target.userId,
        params: { project: args.project },
        run: async () => {
          const project = await getProjectBySlug(args.project);
          if (!project) return `No project "${args.project}".`;
          const removed = await removeProjectMember(project.id, target.platform, target.userId);
          return removed
            ? `Removed from ${project.name}. Their notes remain with the project.${archivedSuffix(project)}`
            : `Not a member of ${project.name}.${archivedSuffix(project)}`;
        },
      });
      return text(result);
    },
    { annotations: { readOnlyHint: false } },
  );

  const projectInfo = tool(
    'project_info',
    'Review projects as an admin: with no argument, list every active project; with a slug, show who ' +
      'has access to it and which conversations it is bound to. Read-only. Admin only.',
    {
      project: z.string().optional().describe('Project slug. Omit to list all active projects instead.'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'project_info');
      // Deliberately guild-wide, not scoped to projects this admin belongs to
      // (PR #929 review). The "admin data access is scoped in SQL to
      // conversations the admin is in" rule governs MEMBER CONTENT — messages,
      // notes, the things members said in confidence. This is the
      // administrative register: names, slugs, who has access, which
      // conversations are bound, and never a single project NOTE. An admin who
      // could only administer projects they happened to be a member of could
      // not audit the grants they are responsible for, and could grant
      // themselves the visibility anyway with one project_add_member call.
      // Same precedent as list_roster and blocked_users.
      if (!args.project) {
        const projects = await listAllProjects();
        if (projects.length === 0) return text('No projects yet.');
        return text(projects.map((p) => `- ${p.name} [${p.slug}]`).join('\n'));
      }
      const project = await getProjectBySlug(args.project);
      if (!project) return text(`No project "${args.project}".`, true);
      const [members, surfaces] = await Promise.all([
        listProjectMembers(project.id),
        listProjectSurfaces(project.id),
      ]);
      const lines = [
        `${project.name} [${project.slug}]${project.archivedAt ? ' — ARCHIVED' : ''}`,
        members.length > 0
          ? `Members (${members.length}): ${members.map((m) => `${m.platform}:${m.userId}`).join(', ')}`
          : 'Members: none yet.',
        surfaces.length > 0
          ? `Bound conversations (${surfaces.length}): ${surfaces
              .map((s) => `${s.platform}:${s.conversationId}`)
              .join(', ')}`
          : 'Bound conversations: none — members can only reach it by DM.',
      ];
      return text(lines.join('\n'));
    },
    { annotations: { readOnlyHint: true } },
  );

  const projectUnbindHere = tool(
    'project_unbind_here',
    "Stop a project's content being discussed in THIS conversation, undoing project_bind_here. " +
      'Members keep their access and can still reach the project by DM or in its other bound ' +
      'conversations. Admin only.',
    { project: z.string().describe('The project slug') },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'project_unbind_here');
      const { result } = await audited({
        actionKind: 'project_unbind_here',
        conversationId: caller.conversationId,
        params: { project: args.project },
        run: async () => {
          const project = await getProjectBySlug(args.project);
          if (!project) return `No project "${args.project}".`;
          const unbound = await unbindProjectSurface(project.id, caller.platform, caller.conversationId);
          return unbound
            ? `${project.name} can no longer be discussed here.${archivedSuffix(project)}`
            : `${project.name} was not bound to this conversation.${archivedSuffix(project)}`;
        },
      });
      return text(result);
    },
    { annotations: { readOnlyHint: false } },
  );

  const projectArchive = tool(
    'project_archive',
    'Archive a project when a team is finished. This is a revocation, not a label: its shared memory ' +
      'immediately stops being readable by anyone, including its own members. Nothing is deleted, so ' +
      'the record is kept and project_unarchive puts it back. Admin only.',
    { project: z.string().describe('The project slug') },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'project_archive');
      // Not requireConfirm-gated, on the same reasoning as
      // project_add_member/project_remove_member above: this repo's CONFIRM
      // gate is for DESTRUCTIVE or IRREVERSIBLE actions, and archiving is
      // neither. It deletes nothing, and project_unarchive below reverses it
      // in one call — which is precisely why that tool exists (PR #929
      // review). Ship the two together or this becomes a one-way door.
      const { result } = await audited({
        actionKind: 'project_archive',
        params: { project: args.project },
        run: async () => {
          const archived = await archiveProject(args.project);
          return archived
            ? `Archived ${args.project}. Its notes are retained but no longer readable — project_unarchive restores access.`
            : `No active project "${args.project}".`;
        },
      });
      return text(result);
    },
    { annotations: { readOnlyHint: false } },
  );

  const projectUnarchive = tool(
    'project_unarchive',
    'Bring an archived project back, undoing project_archive: its existing members can read and add ' +
      'to its shared memory again from the conversations it was already bound to. This restores the ' +
      'access that existed before archiving — it grants nobody new access. Admin only.',
    { project: z.string().describe('The project slug') },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'project_unarchive');
      const { result } = await audited({
        actionKind: 'project_unarchive',
        params: { project: args.project },
        run: async () => {
          const unarchived = await unarchiveProject(args.project);
          return unarchived
            ? `Restored ${args.project}. Its members can read and add to it again.`
            : `No archived project "${args.project}".`;
        },
      });
      return text(result);
    },
    { annotations: { readOnlyHint: false } },
  );

  const projectBindHere = tool(
    'project_bind_here',
    "Allow a project's content to be discussed in THIS conversation. Until a conversation is bound, " +
      'members can only reach the project by DM — this is what stops private project content being ' +
      "recited into a public channel. Bind the project's own private channel or group. Admin only.",
    { project: z.string().describe('The project slug') },
    async (args) => {
      assertAtLeast(caller.role, 'admin', 'project_bind_here');
      const { result } = await audited({
        actionKind: 'project_bind_here',
        conversationId: caller.conversationId,
        params: { project: args.project },
        run: async () => {
          const project = await getProjectBySlug(args.project);
          if (!project) return `No project "${args.project}".`;
          // Deliberately binds the CURRENT conversation only — there is no
          // conversation-id argument, so neither the model nor a crafted
          // message can bind a channel the admin is not actually in.
          const bound = await bindProjectSurface(
            project.id,
            caller.platform,
            caller.conversationId,
            caller.userId,
          );
          return bound
            ? `${project.name} can now be discussed here.${archivedSuffix(project)}`
            : `${project.name} was already bound to this conversation.${archivedSuffix(project)}`;
        },
      });
      return text(result);
    },
    { annotations: { readOnlyHint: false } },
  );

  // --- Super-admin tools -------------------------------------------------------

  const grantAdmin = tool(
    'grant_admin',
    'Promote a user to admin. Super admin only.',
    {
      userId: z.string().min(1).describe('Platform user id to promote'),
      platform: platformArg,
      displayName: z.string().optional(),
    },
    async (args) => {
      assertAtLeast(caller.role, 'super_admin', 'grant_admin');
      const { platform, userId } = await resolveMemberTarget(args.userId, args.platform);
      const label = await resolveSanitizedLabel(platform, userId, args.displayName);
      // Privilege escalation is the highest-blast-radius action in the
      // system — CONFIRM-gated like kick/purge so an injected turn can
      // request but never complete it.
      return requireConfirm(`GRANT ADMIN to ${label} on ${platform}`, 'super_admin', async () => {
        const wasAlreadyAdmin = (await getMemberRole(platform, userId)) === 'admin';
        const { success, result } = await audited({
          actionKind: 'grant_admin',
          targetUserId: userId,
          params: { platform },
          run: async () => {
            await upsertMember({
              platform,
              userId,
              role: 'admin',
              addedBy: caller.userId,
              displayName: args.displayName,
            });
            return 'granted';
          },
        });
        let dmDelivered = true;
        if (success) {
          await resetSessionsForRoleChange(platform, userId, 'grant_admin');
          // Cross-platform promotion DM (issue #157's pattern, extended by
          // #548): routes through the TARGET's platform adapter, not the acting
          // admin's current-turn one — degrades to a silent skip if that
          // platform isn't registered here. Capture delivery (issue #556) for
          // the failed-send note; an unregistered target attempts nothing, so
          // it counts as delivered.
          const adminTarget = adapterFor(platform);
          dmDelivered = adminTarget
            ? await notifyAdminApproved(adminTarget, userId, wasAlreadyAdmin, platform)
            : true;
        }
        const note = dmDelivered ? '' : ADMIN_DM_FAILED_NOTE;
        return success ? `Granted admin to ${label} on ${platform}.${note}` : `Failed: ${result}`;
      });
    },
  );

  const revokeAdmin = tool(
    'revoke_admin',
    'Demote an admin back to member. Super admin only.',
    { userId: z.string().min(1).describe('Platform user id to demote'), platform: platformArg },
    async (args) => {
      assertAtLeast(caller.role, 'super_admin', 'revoke_admin');
      const { platform, userId } = await resolveMemberTarget(args.userId, args.platform);
      const label = await resolveSanitizedLabel(platform, userId);
      if (isSuperAdmin(platform, userId)) {
        return text('Refusing: super admins are configured in the environment, not manageable here.', true);
      }
      const { success, result } = await audited({
        actionKind: 'revoke_admin',
        targetUserId: userId,
        params: { platform },
        run: async () => {
          const done = await demoteAdmin(platform, userId);
          if (!done) throw new Error('User is not an admin.');
          return 'demoted to member';
        },
      });
      if (success) await resetSessionsForRoleChange(platform, userId, 'revoke_admin');
      return text(success ? `${label} is now a member on ${platform}.` : `Failed: ${result}`, !success);
    },
  );

  const purgeUserDataTool = tool(
    'purge_user_data',
    "Erase a user's stored messages entirely (privacy request handling). Super admin only; requires confirmation.",
    { userId: z.string().min(1).describe('Platform user id whose data to erase') },
    async (args) => {
      assertAtLeast(caller.role, 'super_admin', 'purge_user_data');
      // Normalize the id the same way every other target-taking tool does
      // (strip a leading '+', shape-check per platform) so a `+64…` number or
      // a wrong-platform id is rejected up front instead of matching nothing
      // and reporting a false-success "deleted 0 record(s)" for a deletion
      // request. Uses the caller's own platform (this tool has no platform arg).
      let userId: string;
      try {
        userId = normalizeMemberId(caller.platform, args.userId);
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
      return requireConfirm(
        `PURGE all stored messages (and knowledge entries/content reports sourced from) ${userId} on ${caller.platform}; ${PROJECT_NOTE_RETENTION_NOTICE}`,
        'super_admin',
        async () => {
          const { success, result } = await audited({
            actionKind: 'purge_user_data',
            targetUserId: userId,
            run: async () => {
              const n = await purgeUserData(caller.platform, userId);
              return `deleted ${n} stored record(s)`;
            },
          });
          if (!success) return `Failed: ${result}`;
          // A zero-row purge of a syntactically valid id almost always means
          // the wrong id/platform, not "already clean" — say so plainly rather
          // than reporting a reassuring "Done" for a request that erased
          // nothing. `result` is the audited run's own "deleted N stored
          // record(s)" string, so no second purge call is needed.
          return result.startsWith('deleted 0 ')
            ? `No stored data found for ${userId} on ${caller.platform} — double-check the id and platform. (${result}.)`
            : `Done: ${result}; ${PROJECT_NOTE_RETENTION_NOTICE}.`;
        },
      );
    },
  );

  const auditView = tool(
    'audit_view',
    'Show recent privileged actions from the audit log. Super admin only.',
    { limit: z.number().optional().describe('Max entries (default 20)') },
    async (args) => {
      assertAtLeast(caller.role, 'super_admin', 'audit_view');
      const rows = await recentAuditEntries(args.limit ?? 20);
      if (rows.length === 0) return text('Audit log is empty.');
      return text(
        rows
          .map(
            (r) =>
              `[${r.createdAt.toISOString()}] ${r.platform} ${r.actorUserId} → ${r.actionKind}${r.targetUserId ? ` (${r.targetUserId})` : ''} ${r.success ? '✓' : '✗'} ${r.result ?? ''}`,
          )
          .join('\n'),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const usageStatsTool = tool(
    'usage_stats',
    'Show message volume, cost and top users over recent days. Super admin only.',
    {
      days: z.number().optional().describe('Window in days (default 7, max 365)'),
      platform: z
        .enum(['discord', 'whatsapp'])
        .optional()
        .describe('Restrict top users and cost-by-role to one platform (default: all)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'super_admin', 'usage_stats');
      const days = Math.min(Math.max(Math.trunc(args.days ?? 7) || 7, 1), 365);
      const s = await usageStats(days, args.platform);
      return text(formatUsageStats(s, days, args.platform));
    },
    { annotations: { readOnlyHint: true } },
  );

  const adminActivityTool = tool(
    'admin_activity',
    'Show a per-admin breakdown of privileged action volume over recent days — who is actually doing ' +
      'moderation/curation work, not just a flat log of individual actions. Super admin only.',
    { days: z.number().optional().describe('Window in days (default 30, max 365)') },
    async (args) => {
      assertAtLeast(caller.role, 'super_admin', 'admin_activity');
      const days = Math.min(Math.max(Math.trunc(args.days ?? 30) || 30, 1), 365);
      const rows = await adminActivitySummary(days);
      const named = await Promise.all(
        rows.map(async (r) => ({
          ...r,
          name: (await resolveDisplayName(r.platform, r.actorUserId)) ?? r.actorUserId,
        })),
      );
      return text(formatAdminActivity(named, days));
    },
    { annotations: { readOnlyHint: true } },
  );

  const listAdminsTool = tool(
    'list_admins',
    'List everyone who currently holds bot-admin privilege, flagging any who have left the server/group. ' +
      'Super admin only.',
    {},
    async () => {
      assertAtLeast(caller.role, 'super_admin', 'list_admins');
      const roster = await listAdminRoster();
      if (roster.length === 0) return text('No admins are currently configured in community_users.');
      const lines = roster.map((a) => {
        const name = a.displayName ?? '(no known name)';
        const departed = a.leftServer ? ' — LEFT THE SERVER/GROUP' : '';
        return `${a.platform}: ${name} (${a.platformUserId})${departed}`;
      });
      lines.push('Super admins are configured separately (env-sourced) and are not listed here.');
      return text(lines.join('\n'));
    },
    { annotations: { readOnlyHint: true } },
  );

  const engagementStatsTool = tool(
    'engagement_stats',
    'Show what fraction of currently-present roster members have ever posted at least once — aggregate ' +
      'counts and a percentage only, never individual member identities. "Posted" is bounded by the ' +
      'interaction retention window (older activity may have been purged, so this is not a lifetime figure), ' +
      'and roster coverage is Discord-complete but WhatsApp-partial. Super admin only.',
    {
      platform: z
        .enum(['discord', 'whatsapp'])
        .optional()
        .describe('Restrict to one platform (default: all)'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'super_admin', 'engagement_stats');
      const s = await engagementStats(args.platform);
      return text(formatEngagementStats(s));
    },
    { annotations: { readOnlyHint: true } },
  );

  const featureFlagsTool = tool(
    'feature_flags',
    'List which of the optional, off-by-default behaviours (boolean *_ENABLED config flags — moderation, ' +
      'knowledge/learning, admin alerts, onboarding, WhatsApp, cost-saving shortcuts, integrations) are ' +
      'actually turned on right now, grouped by category, plus a small set of non-boolean operator knobs ' +
      '(a count or bounded value only — never raw ids/tokens). Super admin only.',
    {},
    async () => {
      assertAtLeast(caller.role, 'super_admin', 'feature_flags');
      return text(`${formatFeatureFlags()}\n\n${formatOtherConfiguredKnobs()}`);
    },
    { annotations: { readOnlyHint: true } },
  );

  const pauseBot = tool(
    'pause_bot',
    'Pause the bot community-wide (only super admins can still talk to it). Super admin only.',
    {},
    async () => {
      assertAtLeast(caller.role, 'super_admin', 'pause_bot');
      await updatePolicy('paused', true, caller.userId);
      await audited({ actionKind: 'pause_bot', run: async () => 'paused' });
      return text('Bot paused. Only super admins will get replies until resume_bot.');
    },
  );

  const resumeBot = tool('resume_bot', 'Resume the bot after a pause. Super admin only.', {}, async () => {
    assertAtLeast(caller.role, 'super_admin', 'resume_bot');
    await updatePolicy('paused', false, caller.userId);
    await audited({ actionKind: 'resume_bot', run: async () => 'resumed' });
    return text('Bot resumed.');
  });

  const setPolicy = tool(
    'set_policy',
    "Set a runtime policy. Currently: code_answers = 'off' | 'snippets' | 'full'. Super admin only.",
    {
      key: z.enum(['code_answers']).describe('Policy to set'),
      value: z.string().describe("New value (code_answers: 'off', 'snippets' or 'full')"),
    },
    async (args) => {
      assertAtLeast(caller.role, 'super_admin', 'set_policy');
      if (args.key === 'code_answers' && !['off', 'snippets', 'full'].includes(args.value)) {
        return text("code_answers must be 'off', 'snippets' or 'full'.", true);
      }
      await updatePolicy(args.key, args.value, caller.userId);
      await audited({
        actionKind: 'set_policy',
        params: { key: args.key, value: args.value },
        run: async () => 'updated',
      });
      return text(`Policy ${args.key} set to "${args.value}".`);
    },
  );

  const redeployBot = tool(
    'redeploy_bot',
    'Immediately redeploy the bot from origin/main (fast-forward only), instead of waiting for the ' +
      '1am timer or using SSH. Takes no arguments — it can only trigger a deploy of code a human already ' +
      'merged to main. Super admin only; requires confirmation.',
    {},
    async () => {
      assertAtLeast(caller.role, 'super_admin', 'redeploy_bot');
      // Highest-blast-radius action after grant_admin: CONFIRM-gated like
      // every other destructive/irreversible tool, so an injected turn can
      // request a deploy but never complete one without the super admin's
      // own out-of-band reply.
      return requireConfirm(
        'REDEPLOY the bot from origin/main now — the bot process will restart mid-deploy',
        'super_admin',
        async () => {
          const { success, result } = await audited({
            actionKind: 'redeploy_bot',
            run: () => triggerRedeploy(),
          });
          return success ? result : `Failed: ${result}`;
        },
      );
    },
  );

  // Attach everything; the per-turn allowedTools list (rbac.toolsForRole) is
  // what actually restricts which of these the model can call.
  const suggestIssueTool = tool(
    'suggest_issue',
    'File a GitHub issue on the community-agent repo straight from chat, turning an idea, bug, or ' +
      'feature request into tracked work. Super admin only; requires confirmation (it creates a public ' +
      "artifact on the repo via the bot's own token). Labels default to community-feedback so it enters " +
      'the research pipeline as evidence.',
    {
      title: z.string().min(1).max(200).describe('Short, specific issue title'),
      body: z
        .string()
        .min(1)
        .max(4000)
        .describe('The detail: what, who it helps, and why it matters — written verbatim into the issue.'),
    },
    async (args) => {
      assertAtLeast(caller.role, 'super_admin', 'suggest_issue');
      if (!config.github.enabled) {
        return text('Filing GitHub issues is not enabled on this server.', true);
      }
      // Scrub any secret the message text might contain before it reaches a repo
      // issue (defence in depth — the bot's own token is never in user input, but
      // redact it too). Pattern redaction catches known key formats; the body is
      // otherwise written verbatim, so this is the one sanitisation on the path.
      const knownSecrets = [config.github.token].filter((s): s is string => Boolean(s));
      const title = redactSecrets(args.title, knownSecrets);
      const body =
        redactSecrets(args.body, knownSecrets) +
        `\n\n---\n_Filed from ${caller.platform} chat by a super admin via the community agent._`;
      const labels = config.github.labels;
      const key = `${caller.platform}:${caller.userId}`;

      const run = async () => {
        if (!reserveIssueDaily(key, config.github.dailyLimit)) {
          return `Refused: today's issue-filing limit (${config.github.dailyLimit}) is reached — try again tomorrow.`;
        }
        const { success, result } = await audited({
          actionKind: 'suggest_issue',
          params: { title, labels },
          run: async () => {
            const issue = await createIssue({ title, body, labels });
            return `Filed ${config.github.repo}#${issue.number}: ${issue.url}`;
          },
        });
        return success ? result : `Failed: ${result}`;
      };

      return requireConfirm(`file a GitHub issue on ${config.github.repo}: "${title}"`, 'super_admin', run);
    },
    { annotations: { readOnlyHint: false } },
  );

  return createSdkMcpServer({
    name: 'community',
    version: '2.0.0',
    tools: [
      ...registryTools,
      projectCreate,
      projectAddMember,
      projectRemoveMember,
      projectBindHere,
      projectUnbindHere,
      projectInfo,
      projectArchive,
      projectUnarchive,
      whatsNew,
      userHistory,
      moderate,
      clearWarningsTool,
      listMemberWarningsTool,
      listMutedMembersTool,
      listBlockedMembersTool,
      listAppealsTool,
      resolveAppealTool,
      announce,
      createPoll,
      endPoll,
      createThread,
      archiveThread,
      createEvent,
      cancelEvent,
      setCommunityGuidelines,
      setWelcomeMessage,
      saveKnowledgeTool,
      listKnowledgeTool,
      listDuplicateKnowledgeTool,
      listKnowledgeConflictsTool,
      updateKnowledgeTool,
      deleteKnowledgeTool,
      mergeKnowledgeTool,
      listAccessRequestsTool,
      addMemberNoteTool,
      listMemberNotesTool,
      deleteMemberNoteTool,
      listRosterTool,
      listContextDigestsTool,
      listKnowledgeCandidatesTool,
      acceptKnowledgeCandidateTool,
      declineKnowledgeCandidateTool,
      questionDigest,
      adminDigestTool,
      reviewQueueTool,
      listKnowledgeGaps,
      responseLatencyTool,
      moderationHistory,
      listReportsTool,
      resolveReportTool,
      listAnswerFeedbackTool,
      listLowRatedKnowledgeTool,
      listUnhelpfulThemesTool,
      listSuggestionsTool,
      resolveSuggestionTool,
      addMember,
      removeMemberTool,
      linkMemberTool,
      unlinkMemberTool,
      assignCommunityRoleTool,
      removeCommunityRoleTool,
      listAssignableRolesTool,
      grantAdmin,
      revokeAdmin,
      purgeUserDataTool,
      auditView,
      usageStatsTool,
      adminActivityTool,
      listAdminsTool,
      engagementStatsTool,
      featureFlagsTool,
      pauseBot,
      resumeBot,
      setPolicy,
      redeployBot,
      suggestIssueTool,
    ],
  });
}
