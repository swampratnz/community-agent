import { z } from 'zod';
import { config } from '@swampratnz/agent-base/config.js';
import {
  countActiveWarnings,
  countRecentDmReportsByReporterAndTarget,
  createContentReport,
  createModerationAppeal,
  getLanguagePreference,
  isKnownUser,
  REPORT_RATE_LIMIT_PER_DAY,
  withdrawOwnReports,
  type LanguagePreference,
} from '@swampratnz/agent-base/storage/repository.js';
import { makeCooldownReserver } from '@swampratnz/agent-base/util/rateReservation.js';
import { text } from './helpers.js';
import { ackReportedMessage, notifyAppealFiled, notifyReportFiled, notifyReportWithdrawn } from './notify.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

/**
 * Pure render for `report_content`'s two outcomes — same shape as
 * `feedback.ts`'s formatters (issue #1147), reusing `selfService.ts`'s
 * language-as-parameter pattern. `id`/`limit` are unchanged interpolations.
 */
export function formatReportContentText(
  outcome: { recorded: true; id: number } | { recorded: false },
  limit: number,
  language: LanguagePreference,
): string {
  const mi = language === 'mi';
  if (!outcome.recorded) {
    return mi
      ? `Kua tukuna kētia e koe ${limit} ngā pūrongo i roto i ngā haora 24 kua hipa. Tēnā koa, tatari i mua i ` +
          'te tuku i tētahi atu, whakapā tika rānei ki tētahi kaiwhakahaere mehemea he mea whawhati-tata tēnei.'
      : `You've already submitted ${limit} reports in the last 24 hours. Please wait before submitting ` +
          'another, or contact an admin directly if this is urgent.';
  }
  return mi
    ? `Kua tuhia te Pūrongo #${outcome.id} mō ngā kaiwhakahaere o tēnei kōrero. Mauruuru mō te tohu mai.`
    : `Report #${outcome.id} recorded for this conversation's admins. Thanks for flagging it.`;
}

/**
 * Pure render for `withdraw_report`'s outcomes — none-to-withdraw, and
 * withdrew (singular/plural). The withdrawn-id list is an unchanged
 * interpolation in both languages.
 */
export function formatWithdrawReportText(ids: number[], language: LanguagePreference): string {
  const mi = language === 'mi';
  if (ids.length === 0) {
    return mi ? 'Kāore he pūrongo tuwhera hei tango māu.' : 'You have no open reports to withdraw.';
  }
  const list = ids.map((id) => `#${id}`).join(', ');
  return mi
    ? `Kua tangohia ${ids.length > 1 ? 'ō pūrongo' : 'tō pūrongo'} ${list}. Kāore ēnei e mahia; kua ` +
        'whakamōhiotia ngā kaiwhakahaere mō te tangohanga.'
    : `Withdrew your report${ids.length > 1 ? 's' : ''} ${list}. They won't be actioned; the admins have ` +
        'been notified of the withdrawal.';
}

/**
 * Pure render for `appeal_moderation`'s three outcomes. `cooldownHours` is
 * an unchanged interpolation in both languages.
 */
export function formatAppealModerationText(
  outcome: 'no_active_warnings' | 'rate_limited' | 'sent',
  cooldownHours: number,
  language: LanguagePreference,
): string {
  const mi = language === 'mi';
  if (outcome === 'no_active_warnings') {
    return mi
      ? 'Kāore āu whakatūpato e mahi tonu ana hei pīra māu i tēnei wā.'
      : "You don't currently have any active warnings to appeal.";
  }
  if (outcome === 'rate_limited') {
    return mi
      ? `Kua tono kētia koe mō tētahi arotake i te wā tata nei — tēnā koa, tatari i mua i te pīra anō (kotahi ` +
          `ia ${cooldownHours}h).`
      : `You've already asked for a review recently — please wait before appealing again (once per ` +
          `${cooldownHours}h).`;
  }
  return mi
    ? 'Kua tukuna tō pīra ki ngā kaiwhakahaere mō te arotake. Ka whai kōrero mai rātou mehemea e hiahiatia ana.'
    : "Your appeal has been sent to the admins for review. They'll follow up if needed.";
}

/**
 * appeal_moderation's optional free-text `reason` (issue #496) — same
 * bound treatment as `report_content`'s `reason`, since both are a short,
 * member-supplied explanation destined for an outbound admin DM.
 */
export const APPEAL_MODERATION_REASON_MAX_CHARS = 500;

/**
 * appeal_moderation last-fired timestamp per CALLER (`platform:userId`), for
 * its per-caller cooldown (`MODERATION_APPEAL_COOLDOWN_HOURS`, issue #496).
 * Scoped to the caller rather than the conversation — unlike every
 * `reserve*Slot` cap above — since an appeal is inherently about one
 * person's own status. In-memory/best-effort for the MVP (no new table): a
 * restart merely permits one extra appeal DM, harmless for a non-destructive
 * notification.
 */
const appealModerationCooldown = makeCooldownReserver();

/**
 * Reserve one appeal_moderation slot for `key` against a rolling per-caller
 * cooldown. Returns false without reserving if `key` already appealed within
 * `cooldownHours`.
 */
function reserveAppealSlot(key: string, cooldownHours: number): boolean {
  return appealModerationCooldown(key, cooldownHours * 60 * 60 * 1000);
}

export const reportsMemberTools = [
  defineTool({
    name: 'report_content',
    description:
      'Report harassment, spam, or a rule violation in this conversation to its admins for review. ' +
      'Only confirms the report was recorded — it does not take any moderation action itself.',
    minTier: 'member',
    readOnlyHint: false,
    schema: {
      reason: z.string().min(1).max(500).describe('What happened, in your own words (max 500 characters)'),
      targetUserId: z.string().optional().describe('Platform user id of the person being reported, if known'),
      messageId: z.string().optional().describe('The specific message id being reported, if known'),
    },
    handler: async (args, { caller, adapter, adapterFor }) => {
      // targetUserId is reporter-supplied and unauthenticated — unlike
      // moderate/clear_warnings (admin-only, already gated by isKnownUser),
      // any member can name anyone here. Since target_user_id also drives the
      // accused-admin visibility exclusion (listReports/countOpenReports/
      // resolveContentReport), an unverified id could be used to blind an
      // unrelated admin from a report that isn't about them at all. Only a
      // target the bot has actually seen before is trusted to drive that
      // exclusion; an unknown/typo'd id is dropped rather than stored
      // (issue #197 review).
      const targetUserId =
        args.targetUserId && (await isKnownUser(caller.platform, args.targetUserId))
          ? args.targetUserId
          : undefined;
      const created = await createContentReport({
        platform: caller.platform,
        reporterUserId: caller.userId,
        reporterName: caller.userName,
        conversationId: caller.conversationId,
        targetUserId,
        messageId: args.messageId,
        reason: args.reason,
        isDirect: caller.isDirect,
      });
      if (!created) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatReportContentText({ recorded: false }, REPORT_RATE_LIMIT_PER_DAY, language), true);
      }
      // Only computed for a DM report naming a known target — exactly the
      // case the accused-admin exclusion applies to (issue #305). Inclusive
      // of the just-inserted row, so this count reaching the threshold on
      // the report that crosses it is what triggers the alert line.
      const recentSameTargetCount =
        caller.isDirect && targetUserId
          ? await countRecentDmReportsByReporterAndTarget(caller.platform, caller.userId, targetUserId)
          : undefined;
      void notifyReportFiled(adapterFor, {
        id: created.id,
        reporterUserId: caller.userId,
        reporterName: caller.userName,
        conversationId: caller.conversationId,
        targetUserId,
        messageId: args.messageId,
        reason: args.reason,
        recentSameTargetCount,
      });
      ackReportedMessage(adapter, caller.platform, caller.conversationId, args.messageId);
      const language = await getLanguagePreference(caller.platform, caller.userId);
      return text(
        formatReportContentText({ recorded: true, id: created.id }, REPORT_RATE_LIMIT_PER_DAY, language),
      );
    },
  }),

  // Reporter can retract their OWN report(s) — scoped in SQL to
  // reporter_user_id, so it can never touch anyone else's report.
  defineTool({
    name: 'withdraw_report',
    description:
      'Withdraw your OWN previously-filed content report(s) — use this if you filed one by mistake or as a ' +
      'joke and no longer want it reviewed. It only ever affects reports YOU filed; it cannot touch anyone ' +
      "else's. The report is marked withdrawn and kept on record (not deleted), and the admins are notified.",
    minTier: 'member',
    readOnlyHint: false,
    schema: {},
    handler: async (_args, { caller, adapterFor }) => {
      const ids = await withdrawOwnReports(caller.platform, caller.userId);
      const language = await getLanguagePreference(caller.platform, caller.userId);
      if (ids.length === 0) {
        return text(formatWithdrawReportText(ids, language), true);
      }
      void notifyReportWithdrawn(adapterFor, {
        ids,
        reporterUserId: caller.userId,
        reporterName: caller.userName,
      });
      return text(formatWithdrawReportText(ids, language));
    },
  }),

  // Self-scoped: asks admins to double-check the caller's OWN active
  // warning(s)/mute (issue #496) — refuses cleanly with no active warning,
  // so it can't become a generic side channel to message admins (that's
  // already what suggest_improvement is for). Resolves eligibility from
  // caller.platform/caller.userId only, exactly like my_warnings.
  defineTool({
    name: 'appeal_moderation',
    description:
      "Ask the admins to review the caller's OWN active auto-moderation warning(s) — use when a member believes " +
      'a warning (or being at/over the warning limit) was a false positive and wants a human to double-check. ' +
      'NOT a general way to message admins — refuses cleanly with no active warnings (see suggest_improvement/' +
      "report_content for other admin-notification paths). Always scoped to the caller's own platform/user id, " +
      'never a model-supplied identifier — same self-scoping as my_warnings. Does not itself change any ' +
      "warning or mute state — only an admin's clear_warnings can do that.",
    minTier: 'member',
    readOnlyHint: false,
    schema: {
      reason: z
        .string()
        .max(APPEAL_MODERATION_REASON_MAX_CHARS)
        .optional()
        .describe(
          "Optional short explanation of why the warning should be reviewed, in the member's own words " +
            `(max ${APPEAL_MODERATION_REASON_MAX_CHARS} characters). Only pass through what they actually ` +
            'said — never invent one.',
        ),
    },
    handler: async (args, { caller, adapterFor }) => {
      // Self-scoped, exactly like my_warnings: the eligibility gate reads
      // ONLY caller.platform/caller.userId — there is no argument a model
      // could supply to check or appeal on behalf of another user.
      const active = await countActiveWarnings(caller.platform, caller.userId);
      if (active === 0) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatAppealModerationText('no_active_warnings', 0, language), true);
      }
      const cooldownHours = config.moderation.appealCooldownHours;
      if (!reserveAppealSlot(`${caller.platform}:${caller.userId}`, cooldownHours)) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatAppealModerationText('rate_limited', cooldownHours, language), true);
      }
      // Durable record FIRST (issue #554) — a missed/dismissed DM must never
      // erase the appeal with no trace. Awaited, not fire-and-forget: the
      // whole point of this write is that it survives even when the DM
      // below fails, so it must actually land before we report success.
      await createModerationAppeal({
        platform: caller.platform,
        userId: caller.userId,
        userName: caller.userName,
        reason: args.reason,
        activeWarnings: active,
        strikeLimit: config.moderation.strikeLimit,
      });
      void notifyAppealFiled(adapterFor, {
        callerUserId: caller.userId,
        callerName: caller.userName,
        activeWarnings: active,
        strikeLimit: config.moderation.strikeLimit,
        reason: args.reason,
      });
      const language = await getLanguagePreference(caller.platform, caller.userId);
      return text(formatAppealModerationText('sent', cooldownHours, language));
    },
  }),
];
