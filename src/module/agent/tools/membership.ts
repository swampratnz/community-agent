import { z } from 'zod';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { normalizeMemberId } from '@swampratnz/agent-base/auth/memberId.js';
import { isSuperAdmin } from '@swampratnz/agent-base/auth/roles.js';
import { logger } from '@swampratnz/agent-base/logger.js';
import {
  clearAccessRequest,
  getMemberRole,
  linkMembers,
  listAccessRequests,
  removeMember,
  resolveLinkedIdentities,
  unlinkMember,
  upsertMember,
} from '@swampratnz/agent-base/storage/repository.js';
import { ACCESS_REQUEST_STALE_ALERT_SCAN_LIMIT } from '../../accessRequestStaleAlert.js';
import { recordAccessRequestResolution } from '../../storage/accessRequestResolutions.js';
import { platformArg, resolveSanitizedLabel, text } from './helpers.js';
import { notifyMemberApproved } from './notify.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

/**
 * Fixed, static note appended to `add_member`'s reply when
 * `notifyMemberApproved` reports the confirmation DM did not land (issue
 * #556) — so the acting admin isn't told the identical success text
 * regardless of delivery. Deliberately never a function of the underlying
 * adapter error (which can embed platform-specific detail): this is one of
 * exactly two hardcoded strings, the other being `ADMIN_DM_FAILED_NOTE`.
 */
const MEMBER_DM_FAILED_NOTE = " (Couldn't DM them the welcome message — they may not know yet.)";

export const membershipTools = [
  defineTool({
    name: 'add_member',
    description:
      'Register a user as a community member so the bot will talk to them (gated mode). Admin only; grants member tier only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      userId: z.string().min(1).describe('Platform user id (Discord user id / WhatsApp number without +)'),
      platform: platformArg,
      displayName: z.string().optional().describe('Human-readable name for records'),
    },
    handler: async (args, { caller, audited, adapterFor, resolveMemberTarget }) => {
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
      // Looked up BEFORE clearAccessRequest — the row is gone after (issue
      // #1239). No match (e.g. an admin proactively add_members someone who
      // never filed a request) means no resolution event to log.
      const pendingRequest = (await listAccessRequests(ACCESS_REQUEST_STALE_ALERT_SCAN_LIMIT)).find(
        (r) => r.platform === platform && r.userId === userId,
      );
      await clearAccessRequest(platform, userId).catch((err) =>
        logger.warn({ err, userId }, 'Failed to clear access request'),
      );
      if (pendingRequest) {
        // Best-effort, same non-blocking guard as clearAccessRequest just
        // above — the metric write must never be able to fail or block
        // add_member itself.
        await recordAccessRequestResolution(pendingRequest.firstRequestedAt, 'approved').catch((err) =>
          logger.warn({ err, userId }, 'Failed to record access request resolution'),
        );
      }
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
  }),

  defineTool({
    name: 'remove_member',
    description:
      'Remove a member (revokes bot access in gated mode). Cannot remove admins. Admin only. ' +
      'Requires confirmation.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: { userId: z.string().min(1).describe('Platform user id to remove'), platform: platformArg },
    handler: async (args, { caller, requireConfirm, audited, resolveMemberTarget }) => {
      assertAtLeast(caller.role, 'admin', 'remove_member');
      const { platform, userId } = await resolveMemberTarget(args.userId, args.platform);
      // Resolve the name before the row is deleted (roster still has it after).
      const label = await resolveSanitizedLabel(platform, userId);
      if (isSuperAdmin(platform, userId)) {
        return text('Refusing: that user is a super admin.', true);
      }
      return requireConfirm(`remove ${label} from ${platform} members`, 'admin', async () => {
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
        return result === 'membership removed'
          ? `Removed ${label} from ${platform} members.`
          : `Failed: ${result}`;
      });
    },
  }),

  defineTool({
    name: 'link_member',
    description:
      "Link two platform identities (e.g. a member's Discord account and WhatsApp number) as the same " +
      'person, so forget_me/purge_user_data, the daily reply budget, and admin views (user_history) ' +
      'follow the person, not the platform row. Both identities must already be known community members ' +
      "(use add_member first). NEVER changes anyone's tier — a member linked to an admin still resolves " +
      "as member-only. Linking expands forget_me's blast radius: once linked, forget_me from EITHER " +
      'identity erases stored data for BOTH — that is the intended effect, which is why this requires ' +
      'confirmation. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      platformA: z.enum(['discord', 'whatsapp']).describe('Platform of the first identity'),
      userIdA: z.string().min(1).describe('Platform user id of the first identity'),
      platformB: z.enum(['discord', 'whatsapp']).describe('Platform of the second identity'),
      userIdB: z.string().min(1).describe('Platform user id of the second identity'),
    },
    handler: async (args, { caller, requireConfirm, audited }) => {
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
  }),

  defineTool({
    name: 'unlink_member',
    description:
      'Undo a previous link_member: the given identity becomes independently subject to forget_me/purge ' +
      'and the daily reply budget again. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: { userId: z.string().min(1).describe('Platform user id to unlink'), platform: platformArg },
    handler: async (args, { caller, requireConfirm, audited }) => {
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
  }),
];
