import { z } from 'zod';
import { assertAtLeast } from '../../auth/tiers.js';
import {
  addProjectMember,
  archiveProject,
  bindProjectSurface,
  createProject,
  getMemberRole,
  getProjectBySlug,
  listAllProjects,
  listProjectMembers,
  listProjectSurfaces,
  removeProjectMember,
  TEAM_PROJECT_BRIEF_MAX_CHARS,
  TEAM_PROJECT_NAME_MAX_CHARS,
  unarchiveProject,
  unbindProjectSurface,
} from '../../storage/repository.js';
import { platformArg, text } from './helpers.js';
import { defineTool } from './types.js';

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

export const projectsAdminTools = [
  defineTool({
    name: 'project_create',
    description:
      'Create a project: a shared memory for a standing team (e.g. an Impact Lab), which its members can ' +
      'read and add to across Discord and WhatsApp. Creating it grants nobody access — add members with ' +
      'project_add_member and bind the conversations it may be discussed in with project_bind_here. ' +
      'Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
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
    handler: async (args, { caller, audited }) => {
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
  }),

  defineTool({
    name: 'project_add_member',
    description:
      "Give a community member access to a project's shared memory. This grants DATA ACCESS ONLY — it " +
      "NEVER changes anyone's tier, exactly like link_member. If the member's Discord and WhatsApp " +
      'identities have been linked with link_member, adding either one gives them access from both. ' +
      'Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      project: z.string().describe('The project slug'),
      userId: z.string().min(1).describe('Platform user id of the member to add'),
      platform: platformArg,
    },
    handler: async (args, { caller, audited, resolveMemberTarget }) => {
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
  }),

  defineTool({
    name: 'project_remove_member',
    description:
      "Take away a member's access to a project's shared memory. They immediately stop being able to " +
      'read or add to it. Notes they already recorded stay with the project — this revokes access, it ' +
      "does not erase their contributions. Never changes anyone's tier. Admin only.",
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      project: z.string().describe('The project slug'),
      userId: z.string().min(1).describe('Platform user id of the member to remove'),
      platform: platformArg,
    },
    handler: async (args, { caller, audited, resolveMemberTarget }) => {
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
  }),

  defineTool({
    name: 'project_info',
    description:
      'Review projects as an admin: with no argument, list every active project; with a slug, show who ' +
      'has access to it and which conversations it is bound to. Read-only. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      project: z.string().optional().describe('Project slug. Omit to list all active projects instead.'),
    },
    handler: async (args, { caller }) => {
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
  }),

  defineTool({
    name: 'project_unbind_here',
    description:
      "Stop a project's content being discussed in THIS conversation, undoing project_bind_here. " +
      'Members keep their access and can still reach the project by DM or in its other bound ' +
      'conversations. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: { project: z.string().describe('The project slug') },
    handler: async (args, { caller, audited }) => {
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
  }),

  defineTool({
    name: 'project_archive',
    description:
      'Archive a project when a team is finished. This is a revocation, not a label: its shared memory ' +
      'immediately stops being readable by anyone, including its own members. Nothing is deleted, so ' +
      'the record is kept and project_unarchive puts it back. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: { project: z.string().describe('The project slug') },
    handler: async (args, { caller, audited }) => {
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
  }),

  defineTool({
    name: 'project_unarchive',
    description:
      'Bring an archived project back, undoing project_archive: its existing members can read and add ' +
      'to its shared memory again from the conversations it was already bound to. This restores the ' +
      'access that existed before archiving — it grants nobody new access. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: { project: z.string().describe('The project slug') },
    handler: async (args, { caller, audited }) => {
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
  }),

  defineTool({
    name: 'project_bind_here',
    description:
      "Allow a project's content to be discussed in THIS conversation. Until a conversation is bound, " +
      'members can only reach the project by DM — this is what stops private project content being ' +
      "recited into a public channel. Bind the project's own private channel or group. Admin only.",
    minTier: 'admin',
    readOnlyHint: false,
    schema: { project: z.string().describe('The project slug') },
    handler: async (args, { caller, audited }) => {
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
  }),
];
