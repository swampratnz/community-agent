import { z } from 'zod';
import type { PlatformAdapter } from '../../platforms/types.js';
import { assertAtLeast } from '../../auth/tiers.js';
import { config } from '../../config.js';
import { getMemberRole } from '../../storage/repository.js';
import { resolveSanitizedLabel, text } from './helpers.js';
import { defineTool } from './types.js';

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
function checkAssignableRole(adapter: PlatformAdapter, roleId: string): string | null {
  if (!adapter.adminCapabilities.has('assign_community_role')) {
    return `This platform (${adapter.platform}) does not support community roles.`;
  }
  if (!config.discord.assignableRoleIds.includes(roleId)) {
    return `Refusing: role "${roleId}" is not on the assignable-role allowlist.`;
  }
  return null;
}

export const discordRolesTools = [
  defineTool({
    name: 'assign_community_role',
    description:
      'Assign a cosmetic/community Discord role (e.g. a regional tag or "verified builder") to a member. ' +
      "Presentation only — it never changes the member's bot permission tier. Only roles on the " +
      'configured allowlist can be assigned, and only while the role currently carries zero Discord ' +
      'permissions. Discord only. Admin only; requires confirmation.',
    minTier: 'admin',
    platforms: ['discord'],
    requiresCapability: 'assign_community_role',
    readOnlyHint: false,
    schema: {
      userId: z.string().min(1).describe('Platform user id to assign the role to'),
      roleId: z.string().min(1).describe('Discord role id (must be on the assignable allowlist)'),
    },
    handler: async (args, { caller, adapter, requireConfirm, audited }) => {
      assertAtLeast(caller.role, 'admin', 'assign_community_role');
      const refusal = checkAssignableRole(adapter, args.roleId);
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
  }),

  defineTool({
    name: 'remove_community_role',
    description:
      'Remove a previously assigned cosmetic/community Discord role from a member. Same allowlist as ' +
      'assign_community_role. Discord only. Admin only; requires confirmation.',
    minTier: 'admin',
    platforms: ['discord'],
    requiresCapability: 'remove_community_role',
    readOnlyHint: false,
    schema: {
      userId: z.string().min(1).describe('Platform user id to remove the role from'),
      roleId: z.string().min(1).describe('Discord role id (must be on the assignable allowlist)'),
    },
    handler: async (args, { caller, adapter, requireConfirm, audited }) => {
      assertAtLeast(caller.role, 'admin', 'remove_community_role');
      const refusal = checkAssignableRole(adapter, args.roleId);
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
  }),

  defineTool({
    name: 'list_assignable_roles',
    description:
      'List the configured cosmetic Discord roles (DISCORD_ASSIGNABLE_ROLES) with their current name and ' +
      'whether each currently carries any Discord permission — a flagged role would be refused by ' +
      'assign_community_role until an admin strips its permissions. Read-only. Admin only.',
    minTier: 'admin',
    platforms: ['discord'],
    requiresCapability: 'list_assignable_roles',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller, adapter }) => {
      assertAtLeast(caller.role, 'admin', 'list_assignable_roles');
      if (!adapter.adminCapabilities.has('list_assignable_roles')) {
        return text(`This platform (${adapter.platform}) does not support community roles.`, true);
      }
      const result = await adapter.performAdminAction({ kind: 'list_assignable_roles' });
      return text(result);
    },
  }),
];
