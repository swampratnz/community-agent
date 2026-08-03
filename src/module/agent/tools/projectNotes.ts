import { z } from 'zod';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { logger } from '@swampratnz/agent-base/logger.js';
import {
  listVisibleProjects,
  PROJECT_NOTE_CONTENT_MAX_CHARS,
  PROJECT_NOTE_RATE_LIMIT_PER_DAY,
  PROJECT_NOTE_REFERENCE_URL_MAX_CHARS,
  PROJECT_NOTE_TITLE_MAX_CHARS,
  recordProjectNoteRetrieval,
  saveProjectNote,
  searchProjectNotes,
} from '@swampratnz/agent-base/storage/repository.js';
import { text, untrusted } from './helpers.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

// --- Project tools (issue #927) --------------------------------------------
//
// Member tier, like every other tool in this section. Being in a project is
// DATA SCOPE, NOT A TIER: these tools are on every member's surface and are
// simply inert for someone with no visible project, so nothing here changes
// what `toolsForRole` derives. Both access checks (membership, expanded
// through linked identities; and surface, i.e. a bound conversation or a DM)
// live in SQL in `visibleProjectIds` — never re-derived here.

export const projectNotesTools = [
  defineTool({
    name: 'project_recall',
    description:
      'Search the shared memory of a project you are part of — decisions, notes and references the team ' +
      'saved. Use this whenever someone asks what the team decided, agreed, or recorded about something. ' +
      'Only ever returns content from projects you are a member of, and only in a conversation that ' +
      'project is bound to.',
    minTier: 'member',
    readOnlyHint: true,
    schema: { query: z.string().describe('What to look up in the project memory') },
    handler: async (args, { caller }) => {
      // SECURITY: re-check member tier in the handler, the same discipline
      // share_project/set_my_interests/who_is_into/find_helper/community_digest
      // already use (see rbac.ts). MEMBER_TOOLS is also a GUEST's surface in
      // open mode ("Guests only ever reach the agent in open mode; same
      // surface as member"), and visibleProjectIds intentionally checks only
      // project_members — never tier — so without this an open-mode guest who
      // still has a membership row reads a team's private notes. That is the
      // mechanism behind the removed-member leak fixed in removeMember too
      // (PR #929 review).
      assertAtLeast(caller.role, 'member', 'project_recall');
      const hits = await searchProjectNotes(args.query, {
        platform: caller.platform,
        userId: caller.userId,
        conversationId: caller.conversationId,
        isDirect: caller.isDirect,
      });
      if (hits.length === 0) {
        return text('Nothing in project memory matches that (or you have no project accessible here).');
      }
      recordProjectNoteRetrieval(hits.map((h) => h.id)).catch((err) =>
        logger.warn({ err }, 'Project note retrieval count update failed'),
      );
      // Notes are member-authored free text re-entering the model's context,
      // so they are quarantined exactly as community_digest and admin_digest
      // quarantine theirs — context, never instructions.
      return text(
        untrusted(
          'Project memory',
          hits
            .map((h) => {
              const ref = h.referenceUrl ? `\n  reference: ${h.referenceUrl}` : '';
              return `- [${h.projectSlug}] ${h.title ? `${h.title}: ` : ''}${h.content}${ref}`;
            })
            .join('\n'),
        ),
      );
    },
  }),

  defineTool({
    name: 'project_note',
    description:
      'Record a decision, note or document reference in a project you are part of, so the team can find ' +
      'it later. Use this when someone says to remember/record/note something for the project. The ' +
      'reference link is stored verbatim and never opened.',
    minTier: 'member',
    readOnlyHint: false,
    schema: {
      project: z.string().describe('The project slug (see project_list)'),
      content: z
        .string()
        .min(1)
        .max(PROJECT_NOTE_CONTENT_MAX_CHARS)
        .describe(`What to record (max ${PROJECT_NOTE_CONTENT_MAX_CHARS} characters)`),
      title: z
        .string()
        .max(PROJECT_NOTE_TITLE_MAX_CHARS)
        .optional()
        .describe(`Short label for the note (max ${PROJECT_NOTE_TITLE_MAX_CHARS} characters)`),
      referenceUrl: z
        .string()
        .url()
        .max(PROJECT_NOTE_REFERENCE_URL_MAX_CHARS)
        .optional()
        .describe('Optional link to an external doc — stored, never fetched'),
    },
    handler: async (args, { caller }) => {
      // SECURITY: re-check member tier in the handler, the same discipline
      // share_project/set_my_interests/who_is_into/find_helper/community_digest
      // already use (see rbac.ts). MEMBER_TOOLS is also a GUEST's surface in
      // open mode ("Guests only ever reach the agent in open mode; same
      // surface as member"), and visibleProjectIds intentionally checks only
      // project_members — never tier — so without this an open-mode guest who
      // still has a membership row reads a team's private notes. That is the
      // mechanism behind the removed-member leak fixed in removeMember too
      // (PR #929 review).
      assertAtLeast(caller.role, 'member', 'project_note');
      const saved = await saveProjectNote(
        {
          platform: caller.platform,
          userId: caller.userId,
          conversationId: caller.conversationId,
          isDirect: caller.isDirect,
        },
        {
          slug: args.project,
          content: args.content,
          title: args.title,
          referenceUrl: args.referenceUrl,
        },
      );
      // Deliberately the same reply for "no such project" and "exists but not
      // yours / not bound here" (issue #205's wording rule): distinguishing
      // them would confirm a project's existence to a non-member.
      if (!saved) return text('No project by that name is accessible here.', true);
      // A rolling-24h write cap, same refusal shape as suggest_knowledge's
      // (PR #929 review). Deliberately worded as a limit that resets, not as
      // a rejection of the content, so a team minuting a long meeting knows
      // the note simply needs to wait rather than being lost to a bug.
      if ('atCap' in saved) {
        return text(
          `You've already recorded ${PROJECT_NOTE_RATE_LIMIT_PER_DAY} project notes in the last 24 ` +
            'hours. Try again later, or ask an admin if the team needs a higher limit.',
          true,
        );
      }
      return text(`Recorded in ${args.project}.`);
    },
  }),

  defineTool({
    name: 'project_list',
    description:
      'List the projects you can access in this conversation, with their standing brief. Use this when ' +
      'someone asks what projects they are in or what a project is about.',
    minTier: 'member',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller }) => {
      // SECURITY: re-check member tier in the handler, the same discipline
      // share_project/set_my_interests/who_is_into/find_helper/community_digest
      // already use (see rbac.ts). MEMBER_TOOLS is also a GUEST's surface in
      // open mode ("Guests only ever reach the agent in open mode; same
      // surface as member"), and visibleProjectIds intentionally checks only
      // project_members — never tier — so without this an open-mode guest who
      // still has a membership row reads a team's private notes. That is the
      // mechanism behind the removed-member leak fixed in removeMember too
      // (PR #929 review).
      assertAtLeast(caller.role, 'member', 'project_list');
      const projects = await listVisibleProjects({
        platform: caller.platform,
        userId: caller.userId,
        conversationId: caller.conversationId,
        isDirect: caller.isDirect,
      });
      if (projects.length === 0) return text('You have no project accessible in this conversation.');
      return text(
        untrusted(
          'Projects',
          projects.map((p) => `- ${p.name} [${p.slug}]${p.brief ? `\n  ${p.brief}` : ''}`).join('\n'),
        ),
      );
    },
  }),
];
