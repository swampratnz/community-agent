import { z } from 'zod';
import type { Platform } from '@swampratnz/agent-base/platforms/types.js';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { normalizeMemberId } from '@swampratnz/agent-base/auth/memberId.js';
import { isSuperAdmin } from '@swampratnz/agent-base/auth/roles.js';
import { config } from '@swampratnz/agent-base/config.js';
import { logger, hashId } from '@swampratnz/agent-base/logger.js';
import { makeCalendarDayReserver } from '@swampratnz/agent-base/util/rateReservation.js';
import {
  adminActivitySummary,
  clearUserSessions,
  demoteAdmin,
  getMemberRole,
  listAdminRoster,
  purgeUserData,
  recentAuditEntries,
  resolveDisplayName,
  upsertMember,
  usageStats,
  engagementStats,
} from '@swampratnz/agent-base/storage/repository.js';
import { updatePolicy } from '@swampratnz/agent-base/storage/policyStore.js';
import { redactSecrets } from '@swampratnz/agent-base/agent/outbound.js';
import { createIssue } from '../../github/issues.js';
import { triggerRedeploy } from '@swampratnz/agent-base/agent/redeploy.js';
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
} from './helpers.js';
import { notifyAdminApproved } from './notify.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

/**
 * Fixed, static note appended to `grant_admin`'s reply when
 * `notifyAdminApproved` reports the promotion DM did not land (issue #556) —
 * mirrors `MEMBER_DM_FAILED_NOTE`'s rationale exactly, with its own wording
 * since this is a promotion, not a fresh membership.
 */
const ADMIN_DM_FAILED_NOTE = " (Couldn't DM them about the promotion — they may not know yet.)";

/**
 * This deployment's systemd redeploy unit — community content (it names THIS
 * bot's service), so the base runner (agent/redeploy.ts) takes it as a
 * parameter rather than hard-coding it. Same unit the nightly timer starts,
 * so the flock inside scripts/redeploy.sh rules out overlap between the
 * chat-triggered and timer-triggered paths.
 */
const REDEPLOY_UNIT = 'community-agent-redeploy.service';

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

export const superAdminTools = [
  defineTool({
    name: 'grant_admin',
    description: 'Promote a user to admin. Super admin only.',
    minTier: 'super_admin',
    readOnlyHint: false,
    schema: {
      userId: z.string().min(1).describe('Platform user id to promote'),
      platform: platformArg,
      displayName: z.string().optional(),
    },
    handler: async (args, { caller, adapterFor, audited, requireConfirm, resolveMemberTarget }) => {
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
  }),

  defineTool({
    name: 'revoke_admin',
    description: 'Demote an admin back to member. Super admin only.',
    minTier: 'super_admin',
    readOnlyHint: false,
    schema: { userId: z.string().min(1).describe('Platform user id to demote'), platform: platformArg },
    handler: async (args, { caller, audited, resolveMemberTarget }) => {
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
  }),

  defineTool({
    name: 'purge_user_data',
    description:
      "Erase a user's stored messages entirely (privacy request handling). Super admin only; requires confirmation.",
    minTier: 'super_admin',
    readOnlyHint: false,
    schema: { userId: z.string().min(1).describe('Platform user id whose data to erase') },
    handler: async (args, { caller, audited, requireConfirm }) => {
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
  }),

  defineTool({
    name: 'audit_view',
    description: 'Show recent privileged actions from the audit log. Super admin only.',
    minTier: 'super_admin',
    readOnlyHint: true,
    schema: { limit: z.number().optional().describe('Max entries (default 20)') },
    handler: async (args, { caller }) => {
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
  }),

  defineTool({
    name: 'usage_stats',
    description: 'Show message volume, cost and top users over recent days. Super admin only.',
    minTier: 'super_admin',
    readOnlyHint: true,
    schema: {
      days: z.number().optional().describe('Window in days (default 7, max 365)'),
      platform: z
        .enum(['discord', 'whatsapp'])
        .optional()
        .describe('Restrict top users and cost-by-role to one platform (default: all)'),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'super_admin', 'usage_stats');
      const days = Math.min(Math.max(Math.trunc(args.days ?? 7) || 7, 1), 365);
      const s = await usageStats(days, args.platform);
      return text(formatUsageStats(s, days, args.platform));
    },
  }),

  defineTool({
    name: 'admin_activity',
    description:
      'Show a per-admin breakdown of privileged action volume over recent days — who is actually doing ' +
      'moderation/curation work, not just a flat log of individual actions. Super admin only.',
    minTier: 'super_admin',
    readOnlyHint: true,
    schema: { days: z.number().optional().describe('Window in days (default 30, max 365)') },
    handler: async (args, { caller }) => {
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
  }),

  defineTool({
    name: 'list_admins',
    description:
      'List everyone who currently holds bot-admin privilege, flagging any who have left the server/group. ' +
      'Super admin only.',
    minTier: 'super_admin',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller }) => {
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
  }),

  defineTool({
    name: 'engagement_stats',
    description:
      'Show what fraction of currently-present roster members have ever posted at least once — aggregate ' +
      'counts and a percentage only, never individual member identities. "Posted" is bounded by the ' +
      'interaction retention window (older activity may have been purged, so this is not a lifetime figure), ' +
      'and roster coverage is Discord-complete but WhatsApp-partial. Super admin only.',
    minTier: 'super_admin',
    readOnlyHint: true,
    schema: {
      platform: z
        .enum(['discord', 'whatsapp'])
        .optional()
        .describe('Restrict to one platform (default: all)'),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'super_admin', 'engagement_stats');
      const s = await engagementStats(args.platform);
      return text(formatEngagementStats(s));
    },
  }),

  // Read-only, no CONFIRM, no DB/model call — reflects the fixed
  // FEATURE_FLAG_MAP allowlist (issue #559) against the already-loaded
  // config object. Super-admin only: several flags are security-relevant
  // posture (e.g. moderation.llmAbuseEnabled), same least-privilege
  // reasoning as engagement_stats/admin_activity's own super-admin floor.
  defineTool({
    name: 'feature_flags',
    description:
      'List which of the optional, off-by-default behaviours (boolean *_ENABLED config flags — moderation, ' +
      'knowledge/learning, admin alerts, onboarding, WhatsApp, cost-saving shortcuts, integrations) are ' +
      'actually turned on right now, grouped by category, plus a small set of non-boolean operator knobs ' +
      '(a count or bounded value only — never raw ids/tokens). Super admin only.',
    minTier: 'super_admin',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller }) => {
      assertAtLeast(caller.role, 'super_admin', 'feature_flags');
      return text(`${formatFeatureFlags()}\n\n${formatOtherConfiguredKnobs()}`);
    },
  }),

  defineTool({
    name: 'pause_bot',
    description: 'Pause the bot community-wide (only super admins can still talk to it). Super admin only.',
    minTier: 'super_admin',
    readOnlyHint: false,
    schema: {},
    handler: async (_args, { caller, audited }) => {
      assertAtLeast(caller.role, 'super_admin', 'pause_bot');
      await updatePolicy('paused', true, caller.userId);
      await audited({ actionKind: 'pause_bot', run: async () => 'paused' });
      return text('Bot paused. Only super admins will get replies until resume_bot.');
    },
  }),

  defineTool({
    name: 'resume_bot',
    description: 'Resume the bot after a pause. Super admin only.',
    minTier: 'super_admin',
    readOnlyHint: false,
    schema: {},
    handler: async (_args, { caller, audited }) => {
      assertAtLeast(caller.role, 'super_admin', 'resume_bot');
      await updatePolicy('paused', false, caller.userId);
      await audited({ actionKind: 'resume_bot', run: async () => 'resumed' });
      return text('Bot resumed.');
    },
  }),

  defineTool({
    name: 'set_policy',
    description:
      "Set a runtime policy. Currently: code_answers = 'off' | 'snippets' | 'full'. Super admin only.",
    minTier: 'super_admin',
    readOnlyHint: false,
    schema: {
      key: z.enum(['code_answers']).describe('Policy to set'),
      value: z.string().describe("New value (code_answers: 'off', 'snippets' or 'full')"),
    },
    handler: async (args, { caller, audited }) => {
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
  }),

  defineTool({
    name: 'redeploy_bot',
    description:
      'Immediately redeploy the bot from origin/main (fast-forward only), instead of waiting for the ' +
      '1am timer or using SSH. Takes no arguments — it can only trigger a deploy of code a human already ' +
      'merged to main. Super admin only; requires confirmation.',
    minTier: 'super_admin',
    readOnlyHint: false,
    schema: {},
    handler: async (_args, { caller, audited, requireConfirm }) => {
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
            run: () => triggerRedeploy(REDEPLOY_UNIT),
          });
          return success ? result : `Failed: ${result}`;
        },
      );
    },
  }),

  // Files a GitHub issue via the bot's fine-grained repo token — super-admin
  // only because it is the bot's one outward write credential (docs/SECURITY.md).
  defineTool({
    name: 'suggest_issue',
    description:
      'File a GitHub issue on the community-agent repo straight from chat, turning an idea, bug, or ' +
      'feature request into tracked work. Super admin only; requires confirmation (it creates a public ' +
      "artifact on the repo via the bot's own token). Labels default to community-feedback so it enters " +
      'the research pipeline as evidence.',
    minTier: 'super_admin',
    featureFlag: (cfg) => cfg.github.enabled,
    readOnlyHint: false,
    schema: {
      title: z.string().min(1).max(200).describe('Short, specific issue title'),
      body: z
        .string()
        .min(1)
        .max(4000)
        .describe('The detail: what, who it helps, and why it matters — written verbatim into the issue.'),
    },
    handler: async (args, { caller, audited, requireConfirm }) => {
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
  }),
];
