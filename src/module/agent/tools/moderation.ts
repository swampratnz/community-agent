import { z } from 'zod';
import { assertAtLeast, atLeast } from '../../../base/auth/tiers.js';
import { resolveRole } from '../../../base/auth/roles.js';
import { config } from '../../../base/config.js';
import { logger, hashId } from '../../../base/logger.js';
import { makeSlidingWindowReserver } from '../../../base/util/rateReservation.js';
import {
  clearWarnings,
  getInteractionContentByMessageId,
  isKnownConversation,
  isKnownMessage,
  isKnownUser,
  isUserBlocked,
  listBlockedUsers,
  listMemberWarnings,
  listMutedMembers,
  MODERATION_ACTION_KINDS,
  recentModerationEntries,
} from '../../../base/storage/repository.js';
import { text, unreachableConversationRefusal, untrusted } from './helpers.js';
import { applyManualWarnStrike, notifyWarningsCleared } from './notify.js';
import { defineTool } from '../../../base/agent/tools/types.js';

/**
 * Per-conversation cap on `warn_user` within a rolling hour (issue #315).
 * `warn_user` is the one non-CONFIRM moderation action (`moderate`'s own
 * comment: "warnings are low-blast-radius; everything else needs CONFIRM"),
 * but until now carried no throttle of any kind. Mirrors the
 * `create_poll`/`create_thread` rate-cap-not-CONFIRM treatment.
 */
export const WARN_USER_RATE_LIMIT_PER_HOUR = 10;

/**
 * Reserve one warn_user slot for `conversationId` against a rolling hourly
 * cap (WARN_USER_RATE_LIMIT_PER_HOUR), same sliding-window shape as
 * `reservePollSlot`. Returns false without reserving if the conversation
 * already hit `limit` within the last hour.
 */
const reserveWarnSlot = makeSlidingWindowReserver(60 * 60 * 1000);

export const moderationTools = [
  defineTool({
    name: 'moderate',
    description:
      'Perform a moderation action. warn_user sends immediately; timeout/kick/ban/unban/delete/block/unblock require the admin to reply CONFIRM. ban_user (Discord only) is durable — the member cannot rejoin via invite — but unban_user reverses it in-bot, same gates as every other action. block_user (WhatsApp only) is the bot-side equivalent: it stops the bot ever replying to that sender again, platform-wide, with no platform API call; unblock_user reverses it. block_user cannot target an admin or super admin. Admins can only act in conversations they are in.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
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
    handler: async (args, { caller, adapter, getLangPref, callerScope, audited, requireConfirm }) => {
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
  }),

  defineTool({
    name: 'clear_warnings',
    description:
      "Clear a member's auto-moderation warnings and lift any resulting mute so they can post again. Admin only. Use this when a member was blocked after reaching the warning limit (you'll have seen the alert in the mod-alerts channel) and you want to give them another chance. Lenient/reversible, so no CONFIRM needed.",
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      targetUserId: z.string().describe('Platform user id whose warnings to clear'),
      reason: z.string().optional().describe('Optional note for the audit log'),
    },
    handler: async (args, { caller, adapter, audited }) => {
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
  }),

  // Per-member, reason/excerpt-included warning history (auto + admin
  // strikes) — the read moderation_history structurally can't provide, since
  // it reads only admin_audit, never member_warnings (issue #410). Same
  // (platform, userId)-only scope as clear_warnings, not conversation-scoped.
  defineTool({
    name: 'list_member_warnings',
    description:
      "Show one member's full auto-moderation warning history — both auto-detected (wordlist/LLM) and " +
      "manually-issued (moderate's warn action) warnings, each with its reason and, for auto-detected " +
      'strikes, the flagged excerpt, newest first. Use this before escalating (warn → timeout → kick/mute) ' +
      "to see WHY a member was warned, not just how many times. Scoped to the target's (platform, userId) " +
      'only, same as clear_warnings — not conversation-scoped. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      targetUserId: z.string().describe('Platform user id whose warning history to show'),
      limit: z.number().optional().describe('Max entries (default 20)'),
    },
    handler: async (args, { caller }) => {
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
  }),

  // Enumerates currently-muted members by identity — the growth path #403
  // itself named and deferred (issue #487). Same admin-tier, non-
  // conversation-scoped boundary as clear_warnings/list_member_warnings;
  // never includes reason/excerpt.
  defineTool({
    name: 'list_muted_members',
    description:
      "Enumerate currently muted members by identity — the growth path the digest's bare " +
      '`🔇 N member(s) currently muted` count (issue #357) was never meant to provide on its own (issue ' +
      '#487). Each row is user id, strike count, status (`active`/`stale`), and last-warning timestamp — ' +
      'never a reason or excerpt (that stays behind list_member_warnings, one level deeper). `stale` rows ' +
      'are an over-approximation: their strikes aged out of the configured window but they were never ' +
      'explicitly unmuted via clear_warnings, so they may still be muted — never treat a stale row as a ' +
      'confirmed live mute. Admin only, guild-wide (not conversation-scoped, same as clear_warnings), ' +
      'capped at 50 rows, newest warning first.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller }) => {
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
  }),

  // Enumerates the WhatsApp bot-side block list (issue #924) — the read
  // block_user/unblock_user (#572) never got. Same admin-tier, guild-wide
  // (blocked_users has no conversation_id) boundary as list_muted_members.
  defineTool({
    name: 'list_blocked_members',
    description:
      "Enumerate WhatsApp's bot-side block list (issue #924) — the read `block_user`/`unblock_user` " +
      "(#572) never got, the same 'a bare count/log is not a who answer' gap list_muted_members (#487) " +
      'closed for auto-moderation mutes. Each row is external id, who blocked them, reason (if any), and ' +
      'blocked-at timestamp — the same fields moderation_history already shows per-action, just not ' +
      'aggregated into one current-state view. Admin only, guild-wide (blocked_users has no ' +
      'conversation_id), capped at 50 rows, newest block first.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller }) => {
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
  }),

  defineTool({
    name: 'moderation_history',
    description:
      "Show recent moderation actions (warnings, timeouts, kicks, bans, deletions, announcements) in your conversations — for checking prior history before escalating. Optionally filter to one member and/or one action kind, e.g. to review a specific member's prior warnings before deciding whether to escalate. Admin only.",
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      limit: z.number().optional().describe('Max entries (default 20, max 100)'),
      targetUserId: z.string().optional().describe('Only show actions taken against this member'),
      actionKind: z.enum(MODERATION_ACTION_KINDS).optional().describe('Only show actions of this kind'),
    },
    handler: async (args, { caller, callerScope }) => {
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
  }),
];
