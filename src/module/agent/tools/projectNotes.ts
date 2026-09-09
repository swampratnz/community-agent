import { z } from 'zod';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { logger } from '@swampratnz/agent-base/logger.js';
import {
  getLanguagePreference,
  listProjectMembers,
  listVisibleProjects,
  PROJECT_NOTE_CONTENT_MAX_CHARS,
  PROJECT_NOTE_RATE_LIMIT_PER_DAY,
  PROJECT_NOTE_REFERENCE_URL_MAX_CHARS,
  PROJECT_NOTE_TITLE_MAX_CHARS,
  recordProjectNoteRetrieval,
  saveProjectNote,
  searchProjectNotes,
} from '@swampratnz/agent-base/storage/repository.js';
import { formatRelativeAge, resolveSanitizedLabel, text, truncateForEcho, untrusted } from './helpers.js';
import { notice } from '../../strings/notices.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';
import { untrustedEntryContent } from '@swampratnz/agent-base/agent/systemPrompt.js';
import {
  getWithdrawnProjectNoteIds,
  isOwnProjectNote,
  listOwnProjectNotePreviews,
  recordProjectNoteAuthor,
  recordProjectNotePreview,
  recordProjectNoteWithdrawal,
} from '../../storage/projectNoteRecords.js';
import { MY_DATA_SUMMARY_FETCH_CAP } from './selfService.js';

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
      const rawHits = await searchProjectNotes(args.query, {
        platform: caller.platform,
        userId: caller.userId,
        conversationId: caller.conversationId,
        isDirect: caller.isDirect,
      });
      // A withdrawn note stays quarantined for EVERY caller, including its
      // own author (issue #1344 acceptance criterion 3) — filtered here,
      // before rendering and before recordProjectNoteRetrieval, the same
      // consult-a-side-table-before-rendering shape list_suggestions/
      // my_submissions already use for suggestion_withdrawals.
      const withdrawnIds =
        rawHits.length > 0 ? await getWithdrawnProjectNoteIds(rawHits.map((h) => h.id)) : new Set<number>();
      const hits = rawHits.filter((h) => !withdrawnIds.has(h.id));
      if (hits.length === 0) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(notice('projectRecallEmpty', { language }));
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
      if (!saved) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(notice('projectNoteInvalidProject', { language }), true);
      }
      // A rolling-24h write cap, same refusal shape as suggest_knowledge's
      // (PR #929 review). Deliberately worded as a limit that resets, not as
      // a rejection of the content, so a team minuting a long meeting knows
      // the note simply needs to wait rather than being lost to a bug.
      if ('atCap' in saved) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(notice('projectNoteRateLimited', { language })(PROJECT_NOTE_RATE_LIMIT_PER_DAY), true);
      }
      // Best-effort authorship record for withdraw_project_note (issue
      // #1344) — a failure here must never turn a saved note into a
      // reported failure, the same discipline notifyProjectMemberAdded's
      // side-effect writes elsewhere in this codebase already use. AWAITED
      // (unlike project_recall's fire-and-forget recordProjectNoteRetrieval
      // below, which is pure analytics): the member can call
      // withdraw_project_note in their very next message, so the row must
      // exist by the time this reply lands, not merely "eventually".
      try {
        await recordProjectNoteAuthor(saved.id, caller.platform, caller.userId);
      } catch (err) {
        logger.warn({ err }, 'Project note author record failed');
      }
      // Best-effort content-preview capture for my_project_notes (issue
      // #1366) — same discipline and same "right after the author record"
      // placement as recordProjectNoteAuthor above; a failure here must
      // never turn a successfully-saved note into a reported failure, and
      // must not block the author record above from having already been
      // attempted (hence its own try/catch rather than being folded into
      // the one above).
      try {
        await recordProjectNotePreview(
          saved.id,
          args.project,
          truncateForEcho(args.title ? `${args.title}: ${args.content}` : args.content),
        );
      } catch (err) {
        logger.warn({ err }, 'Project note preview record failed');
      }
      const language = await getLanguagePreference(caller.platform, caller.userId);
      return text(notice('projectNoteSaved', { language })(args.project, saved.id));
    },
  }),

  defineTool({
    name: 'project_list',
    description:
      'List the projects you can access in this conversation, with their standing brief. Use this when ' +
      'someone asks what projects they are in or what a project is about. Pass a project slug to see ' +
      "that project's full member roster instead — who else is on the team — when someone asks who is " +
      'on a project with them.',
    minTier: 'member',
    readOnlyHint: true,
    schema: {
      project: z
        .string()
        .optional()
        .describe(
          "Project slug (see project_list with no argument) to see that project's full member roster " +
            'instead of the summary list.',
        ),
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
      assertAtLeast(caller.role, 'member', 'project_list');
      const projects = await listVisibleProjects({
        platform: caller.platform,
        userId: caller.userId,
        conversationId: caller.conversationId,
        isDirect: caller.isDirect,
      });
      if (args.project) {
        // SECURITY (issue #1256): authorization for the roster view reuses
        // ONLY the listVisibleProjects result the no-arg path above already
        // trusts — never a second/weaker check. A slug only resolves to
        // listProjectMembers once it is PROVEN visible to this caller, in
        // this conversation, by appearing in that result. `listVisibleProjects`
        // and `getProjectBySlug` return the same `Project` row shape, so the
        // matched entry already carries everything needed below — no second
        // lookup.
        const project = projects.find((p) => p.slug === args.project);
        if (!project) {
          const language = await getLanguagePreference(caller.platform, caller.userId);
          // Deliberately the exact same reply project_note uses for "no such
          // project" and "exists but not yours / not bound here" (issue
          // #205's wording rule) — never a new notice key, never a
          // distinguishing reply.
          return text(notice('projectNoteInvalidProject', { language }), true);
        }
        const members = await listProjectMembers(project.id);
        // Sanitized display name + platform only — never the raw
        // `platform:userId` string project_info's admin-audit rendering
        // uses (issue #1256 AC #4/#7).
        const roster = await Promise.all(
          members.map(async (m) => `- ${await resolveSanitizedLabel(m.platform, m.userId)} (${m.platform})`),
        );
        // SECURITY: `project.name` is admin-set, unrestricted text (PR #1258
        // review) — the ONLY call site in the codebase that put dynamic
        // content into untrusted()'s label was this one, and untrusted()
        // strips `<>\r\n` from the body but not the label, so a name
        // containing a newline could otherwise escape the quarantine
        // framing. Keep the label static and run the name through
        // untrustedEntryContent (the same stripping formatProjectResults
        // already applies to stored project names) inside the body instead.
        return text(
          untrusted(
            'Project roster',
            `${untrustedEntryContent(project.name)}:\n${roster.length > 0 ? roster.join('\n') : 'No members yet.'}`,
          ),
        );
      }
      if (projects.length === 0) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(notice('projectListEmpty', { language }));
      }
      return text(
        untrusted(
          'Projects',
          projects.map((p) => `- ${p.name} [${p.slug}]${p.brief ? `\n  ${p.brief}` : ''}`).join('\n'),
        ),
      );
    },
  }),

  // Self-service correction path (issue #1344): the one member-authored
  // content type in this codebase with no way to retract a mistake before
  // this. Scoped by noteId, not bulk — unlike withdraw_report/
  // withdraw_appeal (safe in bulk because those queues are small and
  // admin-reviewed promptly), project notes accumulate indefinitely with no
  // review cutoff, so "withdraw everything I ever wrote" would be a
  // disproportionate blast radius for fixing one typo. No CONFIRM: the base
  // project_notes row is never touched, so this is reversible in effect —
  // the same no-CONFIRM precedent every other withdraw_* tool uses.
  defineTool({
    name: 'withdraw_project_note',
    description:
      'Withdraw a project_note you recorded, by its id (shown when you recorded it). Use this if you made a ' +
      'mistake — a typo, a wrong date, a note filed in the wrong project. It only ever affects a note YOU ' +
      "recorded; it cannot touch anyone else's note. The base note is kept on record (not deleted) but is " +
      'quarantined out of every project_recall result from then on, for every member including you. Calling ' +
      'it again on an already-withdrawn note is harmless.',
    minTier: 'member',
    readOnlyHint: false,
    schema: {
      noteId: z.number().int().describe('The note id, shown when you recorded it with project_note'),
    },
    handler: async (args, { caller }) => {
      // SECURITY: re-check member tier in the handler, the same discipline
      // every other tool in this file uses.
      assertAtLeast(caller.role, 'member', 'withdraw_project_note');
      const language = await getLanguagePreference(caller.platform, caller.userId);
      // SECURITY: an unknown noteId and a real-but-not-mine noteId return
      // the IDENTICAL refusal (issue #1344 acceptance criterion 6, the
      // noteId analogue of project_note's own #205 wording rule) — never
      // confirm another member's note exists or who wrote it. A note
      // written before this shipped has no author row and refuses here too,
      // which is expected (no backfill, no guessed authorship).
      const isOwn = await isOwnProjectNote(args.noteId, caller.platform, caller.userId);
      if (!isOwn) {
        return text(notice('projectNoteWithdrawRefused', { language }), true);
      }
      await recordProjectNoteWithdrawal(args.noteId);
      return text(notice('projectNoteWithdrawn', { language })(args.noteId));
    },
  }),

  // Self-service listing (issue #1366), the v2 growth path #1344 explicitly
  // deferred: project_note's own success reply is the ONLY moment a member
  // ever sees a note's id, so a member wanting to withdraw_project_note a
  // note filed days ago previously had no way to find it short of scrolling
  // chat history. Self-scoped by construction — listOwnProjectNotePreviews
  // joins project_note_previews through project_note_authors on the
  // caller's OWN platform/userId, so no argument can widen it to another
  // member's notes (there are no arguments at all, matching my_data/
  // my_submissions' schema {} shape).
  defineTool({
    name: 'my_project_notes',
    description:
      'List the project notes YOU recorded with project_note, across every project — id, project slug, a ' +
      "truncated preview of what you wrote, how long ago, and whether it's since been withdrawn. Use this " +
      'when a member wants to find the id of a note they filed earlier (needed by withdraw_project_note), or ' +
      "just wants to review what they've recorded. Never returns another member's notes. A withdrawn note " +
      'still appears here (marked withdrawn) so you can confirm a withdrawal took effect, even though ' +
      'withdraw_project_note fully quarantines it from project_recall.',
    minTier: 'member',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller }) => {
      // SECURITY: re-check member tier in the handler, the same discipline
      // every other tool in this file uses.
      assertAtLeast(caller.role, 'member', 'my_project_notes');
      const language = await getLanguagePreference(caller.platform, caller.userId);
      const notes = await listOwnProjectNotePreviews(
        caller.platform,
        caller.userId,
        MY_DATA_SUMMARY_FETCH_CAP,
      );
      if (notes.length === 0) {
        return text(notice('myProjectNotesEmpty', { language }));
      }
      // Withdrawn/active marker (issue #1344's withdrawal side-table),
      // consulted the same way project_recall's filter step does — except
      // here a withdrawn note is ANNOTATED, never filtered out, so a member
      // can see their own withdrawal took effect (deliberately unlike
      // project_recall's full quarantine of the same note for every reader
      // including its author).
      const withdrawnIds = await getWithdrawnProjectNoteIds(notes.map((n) => n.id));
      // Previews are member-authored free text re-entering the model's
      // context, so they are quarantined exactly as project_recall
      // quarantines the same underlying content.
      return text(
        untrusted(
          'Your project notes',
          notes
            .map((n) => {
              const marker = withdrawnIds.has(n.id) ? ' (withdrawn)' : '';
              return `- [#${n.id}, ${n.projectSlug}, ${formatRelativeAge(n.createdAt)}] ${n.preview}${marker}`;
            })
            .join('\n'),
        ),
      );
    },
  }),
];
