import { z } from 'zod';
import type { Platform } from '@swampratnz/agent-base/platforms/types.js';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { config } from '@swampratnz/agent-base/config.js';
import {
  countActiveWarnings,
  countRecentDmReportsByReporterAndTarget,
  createContentReport,
  createModerationAppeal,
  getLanguagePreference,
  getResponseStyle,
  isKnownUser,
  listOwnAppeals,
  REPORT_RATE_LIMIT_PER_DAY,
  withdrawOwnReports,
  type LanguagePreference,
  type ResponseStyle,
} from '@swampratnz/agent-base/storage/repository.js';
import { makeCooldownReserver } from '@swampratnz/agent-base/util/rateReservation.js';
import { getWithdrawnAppealIds, recordAppealWithdrawal } from '../../storage/appealWithdrawals.js';
import { text } from './helpers.js';
import { ackReportedMessage, notifyAppealFiled, notifyReportFiled, notifyReportWithdrawn } from './notify.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

/**
 * Resolves the caller's language + `'plain'`-style preference for this
 * file's four formatters (issue #1436) — the direct-reply-side counterpart
 * to `notify.ts`'s own call sites, same precedence/fail-safe shape: `style`
 * is only consulted once `'mi'` is ruled out (it takes precedence, so
 * there's no style DB read on the `'mi'` path), and a lookup failure
 * degrades to `'standard'` rather than throwing. `getLangPref`/`getRespStyle`
 * are the same injectable-resolver seam `notify.ts` uses for its own
 * `getRespStyle` parameter, so the fail-safe is testable without live
 * Postgres.
 */
export async function resolveReportsMemberLanguageAndStyle(
  platform: Platform,
  userId: string,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
  getRespStyle: typeof getResponseStyle = getResponseStyle,
): Promise<{ language: LanguagePreference; style: ResponseStyle | undefined }> {
  const language = await getLangPref(platform, userId);
  const style: ResponseStyle | undefined =
    language === 'mi' ? undefined : await getRespStyle(platform, userId).catch(() => 'standard' as const);
  return { language, style };
}

/**
 * Pure render for `report_content`'s two outcomes — same shape as
 * `feedback.ts`'s formatters (issue #1147), reusing `selfService.ts`'s
 * language-as-parameter pattern. `id`/`limit` are unchanged interpolations.
 * `style` (issue #1436) adds a shorter, simpler English variant when
 * `'plain'` — consulted only once `'mi'` is ruled out, since `'mi'` wins
 * regardless of `style` (mirrors `notify.ts`'s pinned precedence rule); the
 * `'mi'`/default-English branches are unchanged.
 */
export function formatReportContentText(
  outcome: { recorded: true; id: number } | { recorded: false },
  limit: number,
  language: LanguagePreference,
  style: ResponseStyle | undefined,
): string {
  const mi = language === 'mi';
  const plain = style === 'plain';
  if (!outcome.recorded) {
    return mi
      ? `Kua tukuna kētia e koe ${limit} ngā pūrongo i roto i ngā haora 24 kua hipa. Tēnā koa, tatari i mua i ` +
          'te tuku i tētahi atu, whakapā tika rānei ki tētahi kaiwhakahaere mehemea he mea whawhati-tata tēnei.'
      : plain
        ? `You've sent ${limit} reports today. Please wait and try again later. If it's urgent, contact an admin.`
        : `You've already submitted ${limit} reports in the last 24 hours. Please wait before submitting ` +
          'another, or contact an admin directly if this is urgent.';
  }
  return mi
    ? `Kua tuhia te Pūrongo #${outcome.id} mō ngā kaiwhakahaere o tēnei kōrero. Mauruuru mō te tohu mai.`
    : plain
      ? `Report #${outcome.id} saved. The admins can see it. Thanks for telling us.`
      : `Report #${outcome.id} recorded for this conversation's admins. Thanks for flagging it.`;
}

/**
 * Pure render for `withdraw_report`'s outcomes — none-to-withdraw, and
 * withdrew (singular/plural). The withdrawn-id list is an unchanged
 * interpolation in both languages. `style` (issue #1436), same
 * `'mi'`-wins-over-`'plain'` precedence as every formatter in this file.
 */
export function formatWithdrawReportText(
  ids: number[],
  language: LanguagePreference,
  style: ResponseStyle | undefined,
): string {
  const mi = language === 'mi';
  const plain = style === 'plain';
  if (ids.length === 0) {
    return mi
      ? 'Kāore he pūrongo tuwhera hei tango māu.'
      : plain
        ? 'You have no reports to withdraw.'
        : 'You have no open reports to withdraw.';
  }
  const list = ids.map((id) => `#${id}`).join(', ');
  return mi
    ? `Kua tangohia ${ids.length > 1 ? 'ō pūrongo' : 'tō pūrongo'} ${list}. Kāore ēnei e mahia; kua ` +
        'whakamōhiotia ngā kaiwhakahaere mō te tangohanga.'
    : plain
      ? `Withdrew report${ids.length > 1 ? 's' : ''} ${list}. No action will be taken. The admins know.`
      : `Withdrew your report${ids.length > 1 ? 's' : ''} ${list}. They won't be actioned; the admins have ` +
        'been notified of the withdrawal.';
}

/**
 * Pure render for `appeal_moderation`'s three outcomes. `cooldownHours` is
 * an unchanged interpolation in both languages. `style` (issue #1436), same
 * `'mi'`-wins-over-`'plain'` precedence as every formatter in this file.
 */
export function formatAppealModerationText(
  outcome: 'no_active_warnings' | 'rate_limited' | 'sent',
  cooldownHours: number,
  language: LanguagePreference,
  style: ResponseStyle | undefined,
): string {
  const mi = language === 'mi';
  const plain = style === 'plain';
  if (outcome === 'no_active_warnings') {
    return mi
      ? 'Kāore āu whakatūpato e mahi tonu ana hei pīra māu i tēnei wā.'
      : plain
        ? 'You have no active warnings to appeal.'
        : "You don't currently have any active warnings to appeal.";
  }
  if (outcome === 'rate_limited') {
    return mi
      ? `Kua tono kētia koe mō tētahi arotake i te wā tata nei — tēnā koa, tatari i mua i te pīra anō (kotahi ` +
          `ia ${cooldownHours}h).`
      : plain
        ? `You asked for a review recently. Please wait ${cooldownHours} hours, then try again.`
        : `You've already asked for a review recently — please wait before appealing again (once per ` +
          `${cooldownHours}h).`;
  }
  return mi
    ? 'Kua tukuna tō pīra ki ngā kaiwhakahaere mō te arotake. Ka whai kōrero mai rātou mehemea e hiahiatia ana.'
    : plain
      ? 'Your appeal was sent to the admins. They will follow up if needed.'
      : "Your appeal has been sent to the admins for review. They'll follow up if needed.";
}

/**
 * Pure render for `withdraw_appeal`'s outcomes — none-to-withdraw, and
 * withdrew (singular/plural) — the fourth sibling of `formatWithdrawReportText`
 * above / `formatWithdrawSuggestionText` (feedback.ts) / `formatWithdrawKnowledgeTipConfirmText`
 * (knowledgeMember.ts), issue #1278. `ids` is already scoped to the caller's
 * own still-`'open'`, not-yet-withdrawn appeals by the handler; this function
 * does no scoping itself, only formatting. `style` (issue #1436), same
 * `'mi'`-wins-over-`'plain'` precedence as every formatter in this file.
 */
export function formatWithdrawAppealText(
  ids: number[],
  language: LanguagePreference,
  style: ResponseStyle | undefined,
): string {
  const mi = language === 'mi';
  const plain = style === 'plain';
  if (ids.length === 0) {
    return mi
      ? 'Kāore he pīra tuwhera hei tango māu.'
      : plain
        ? 'You have no appeals to withdraw.'
        : 'You have no open appeals to withdraw.';
  }
  const list = ids.map((id) => `#${id}`).join(', ');
  return mi
    ? `Kua tangohia ${ids.length > 1 ? 'ō pīra' : 'tō pīra'} ${list}. Kāore ēnei e arotakehia.`
    : plain
      ? `Withdrew appeal${ids.length > 1 ? 's' : ''} ${list}. No one will review ${ids.length > 1 ? 'them' : 'it'}.`
      : `Withdrew your appeal${ids.length > 1 ? 's' : ''} ${list}. They won't be reviewed.`;
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

// withdraw_appeal's candidate scan cap (issue #1278) — same "generous,
// bounded fetch" reasoning as WITHDRAW_SUGGESTION_SCAN_LIMIT (feedback.ts):
// appeal_moderation's own per-caller cooldown makes a real backlog of a
// single member's still-open appeals far smaller than this in practice.
const WITHDRAW_APPEAL_SCAN_LIMIT = 500;

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
        const { language, style } = await resolveReportsMemberLanguageAndStyle(
          caller.platform,
          caller.userId,
        );
        return text(
          formatReportContentText({ recorded: false }, REPORT_RATE_LIMIT_PER_DAY, language, style),
          true,
        );
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
      const { language, style } = await resolveReportsMemberLanguageAndStyle(caller.platform, caller.userId);
      return text(
        formatReportContentText(
          { recorded: true, id: created.id },
          REPORT_RATE_LIMIT_PER_DAY,
          language,
          style,
        ),
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
      const { language, style } = await resolveReportsMemberLanguageAndStyle(caller.platform, caller.userId);
      if (ids.length === 0) {
        return text(formatWithdrawReportText(ids, language, style), true);
      }
      void notifyReportWithdrawn(adapterFor, {
        ids,
        reporterUserId: caller.userId,
        reporterName: caller.userName,
      });
      return text(formatWithdrawReportText(ids, language, style));
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
        const { language, style } = await resolveReportsMemberLanguageAndStyle(
          caller.platform,
          caller.userId,
        );
        return text(formatAppealModerationText('no_active_warnings', 0, language, style), true);
      }
      const cooldownHours = config.moderation.appealCooldownHours;
      if (!reserveAppealSlot(`${caller.platform}:${caller.userId}`, cooldownHours)) {
        const { language, style } = await resolveReportsMemberLanguageAndStyle(
          caller.platform,
          caller.userId,
        );
        return text(formatAppealModerationText('rate_limited', cooldownHours, language, style), true);
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
      const { language, style } = await resolveReportsMemberLanguageAndStyle(caller.platform, caller.userId);
      return text(formatAppealModerationText('sent', cooldownHours, language, style));
    },
  }),

  // Appellant can retract their OWN open appeal(s) — the fourth sibling
  // (issue #1278) of withdraw_report/withdraw_knowledge_tip/
  // withdraw_suggestion, scoped via listOwnAppeals' own (platform, userId)
  // predicate, so it can never touch another member's appeal. Unlike
  // withdraw_report this never mutates the base moderation_appeals row (its
  // status CHECK constraint is base-owned, with no 'withdrawn' value): the
  // withdrawal is recorded in the module-owned appeal_withdrawals table
  // instead, consulted by resolve_appeal/list_appeals/my_submissions rather
  // than changing what those reads select.
  defineTool({
    name: 'withdraw_appeal',
    description:
      'Withdraw your OWN still-open moderation appeal(s) — use this if you filed one by mistake or want to ' +
      'retract it before an admin reviews it. It only ever affects appeals YOU filed and only ones still ' +
      "'open'; it cannot touch anyone else's appeal or one already resolved/dismissed. The appeal is marked " +
      'withdrawn and kept on record (not deleted); resolve_appeal will refuse a withdrawn one.',
    minTier: 'member',
    readOnlyHint: false,
    schema: {},
    handler: async (_args, { caller }) => {
      // SECURITY: tier is re-asserted here, matching withdraw_suggestion's
      // own defensive double-check — not merely surface-gated by
      // MEMBER_TOOLS.
      assertAtLeast(caller.role, 'member', 'withdraw_appeal');
      const own = await listOwnAppeals(caller.platform, caller.userId, WITHDRAW_APPEAL_SCAN_LIMIT);
      const pending = own.filter((a) => a.status === 'open');
      const alreadyWithdrawn =
        pending.length > 0 ? await getWithdrawnAppealIds(pending.map((a) => a.id)) : new Set<number>();
      const toWithdraw = pending.filter((a) => !alreadyWithdrawn.has(a.id));
      const { language, style } = await resolveReportsMemberLanguageAndStyle(caller.platform, caller.userId);
      if (toWithdraw.length === 0) {
        return text(formatWithdrawAppealText([], language, style), true);
      }
      await Promise.all(toWithdraw.map((a) => recordAppealWithdrawal(a.id)));
      return text(
        formatWithdrawAppealText(
          toWithdraw.map((a) => a.id),
          language,
          style,
        ),
      );
    },
  }),
];
