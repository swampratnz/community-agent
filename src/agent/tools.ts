import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AdapterLookup, Platform, PlatformAdapter } from '../platforms/types.js';
import { assertAtLeast, type CallerContext } from '../auth/rbac.js';
import { normalizeMemberId } from '../auth/memberId.js';
import { makeCalendarDayReserver, makeSlidingWindowReserver } from '../util/rateReservation.js';
import { isSuperAdmin } from '../auth/roles.js';
import { config } from '../config.js';
import { logger, hashId } from '../logger.js';
import {
  adminActivitySummary,
  clearUserSessions,
  demoteAdmin,
  getMemberRole,
  KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD,
  type CrossedKnowledgeGapCluster,
  listAdminRoster,
  purgeUserData,
  recentAuditEntries,
  resolveDisplayName,
  getLanguagePreference,
  upsertMember,
  usageStats,
  engagementStats,
} from '../storage/repository.js';
import { updatePolicy } from '../storage/policies.js';
import { redactSecrets } from './outbound.js';
import { createIssue } from '../github/issues.js';
import { triggerRedeploy } from './redeploy.js';
import { makeToolContext } from './tools/context.js';
import { TOOL_REGISTRY } from './tools/index.js';
import {
  formatAdminActivity,
  formatEngagementStats,
  formatFeatureFlags,
  formatOtherConfiguredKnobs,
  formatUsageStats,
  platformArg,
  PROJECT_NOTE_RETENTION_NOTICE,
  resolveSanitizedLabel,
  text,
} from './tools/helpers.js';
import { notifyAdminApproved } from './tools/notify.js';

// This file is the BARREL for the tool registry split (docs/
// TOOL-REGISTRY-DESIGN.md §3): every symbol that moved into src/agent/tools/
// is re-exported here so the 20+ existing import sites (tests especially)
// keep working unchanged, and the remaining super-admin closure tools
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
  // Destructured back into this scope so the remaining (unconverted) closure
  // tools below keep referencing these helpers bare, exactly as when they
  // were defined inline here — see makeToolContext (tools/context.ts).
  const { adapterFor, audited, requireConfirm, resolveMemberTarget } = ctx;
  // Tools already converted to the declarative registry (tools/index.ts),
  // wrapped so each handler receives this turn's ctx.
  const registryTools = TOOL_REGISTRY.map((def) =>
    tool(def.name, def.description, def.schema, (args) => def.handler(args, ctx), {
      annotations: { readOnlyHint: def.readOnlyHint },
    }),
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
