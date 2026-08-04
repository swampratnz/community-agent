import { z } from 'zod';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { sanitizeName } from '@swampratnz/agent-base/util/sanitizeName.js';
import {
  addMemberNote,
  deleteMemberNote,
  getMemberNote,
  getMemberRole,
  listContextDigests,
  listMemberNotes,
  listRoster,
  MEMBER_NOTE_MAX_CHARS,
  rosterCounts,
} from '@swampratnz/agent-base/storage/repository.js';
import { platformArg, text, untrusted } from './helpers.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

export const rosterTools = [
  defineTool({
    name: 'add_member_note',
    description:
      'Attach a durable, admin-curated context note to a KNOWN community member (e.g. "runs the Chch ' +
      'meetup", "prefers email"). Person-scoped facts belong here, never in the global knowledge FAQ. ' +
      'Notes are human-entered only — never auto-populate one from web search or message content ' +
      'without the admin explicitly asking to save that text. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      userId: z.string().min(1).describe('Platform user id of the member the note is about'),
      note: z
        .string()
        .min(1)
        .max(MEMBER_NOTE_MAX_CHARS)
        .describe(`The note text (max ${MEMBER_NOTE_MAX_CHARS} characters)`),
      platform: platformArg,
    },
    handler: async (args, { caller, audited, resolveMemberTarget }) => {
      assertAtLeast(caller.role, 'admin', 'add_member_note');
      const { platform, userId } = await resolveMemberTarget(args.userId, args.platform);
      if ((await getMemberRole(platform, userId)) === null) {
        return text(`Refusing: "${userId}" is not a registered community member on ${platform}.`, true);
      }
      // The audit row records that a note was added, never the note text —
      // audit rows survive a purge, member_notes must not (SECURITY.md).
      const { success, result } = await audited({
        actionKind: 'add_member_note',
        targetUserId: userId,
        params: { platform, noteChars: args.note.length },
        run: async () => {
          const id = await addMemberNote({ platform, userId, note: args.note, createdBy: caller.userId });
          return `note #${id} added`;
        },
      });
      return text(success ? `Saved note for ${userId} (${result}).` : `Failed: ${result}`, !success);
    },
  }),

  defineTool({
    name: 'list_member_notes',
    description:
      'Show the admin-curated context notes kept about one member. Notes are admin-only reading — they never appear on member turns, in knowledge_search, or in memory recall. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: { userId: z.string().min(1).describe('Platform user id of the member'), platform: platformArg },
    handler: async (args, { caller, resolveMemberTarget }) => {
      assertAtLeast(caller.role, 'admin', 'list_member_notes');
      const { platform, userId } = await resolveMemberTarget(args.userId, args.platform);
      const notes = await listMemberNotes(platform, userId);
      if (notes.length === 0) return text(`No notes for ${userId} on ${platform}.`);
      return text(
        untrusted(
          `Notes for ${userId}`,
          notes.map((n) => `#${n.id} [${n.createdAt.toISOString()} by ${n.createdBy}] ${n.note}`).join('\n'),
        ),
      );
    },
  }),

  defineTool({
    name: 'delete_member_note',
    description:
      'Permanently delete one member context note by id (from list_member_notes). Requires confirmation. ' +
      'Audited. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: { id: z.number().describe('Note id') },
    handler: async (args, { caller, requireConfirm, audited }) => {
      assertAtLeast(caller.role, 'admin', 'delete_member_note');
      // Resolve the note first so the CONFIRM names whose note is being
      // deleted — an injected bare id can't quietly erase the wrong one —
      // and so an unknown id is refused before anything is queued.
      const note = await getMemberNote(args.id);
      if (!note) return text(`No note with id ${args.id}.`, true);
      // Same CONFIRM gate as delete_knowledge: deletion is irreversible, so
      // the model can request it but only the admin's out-of-band reply
      // executes it (CLAUDE.md invariant).
      return requireConfirm(
        `delete member note #${args.id} about ${note.userId} on ${note.platform} ("${note.note.slice(0, 80)}${note.note.length > 80 ? '…' : ''}")`,
        'admin',
        async () => {
          const { success, result } = await audited({
            actionKind: 'delete_member_note',
            targetUserId: note.userId,
            params: { id: args.id },
            run: async () => {
              const deleted = await deleteMemberNote(args.id);
              if (!deleted) throw new Error(`No note with id ${args.id}.`);
              return 'deleted';
            },
          });
          return success ? `Deleted note #${args.id}.` : `Failed: ${result}`;
        },
      );
    },
  }),

  defineTool({
    name: 'list_roster',
    description:
      'Show the server roster kept from join/leave events: recent joiners, people who joined but were ' +
      'never added as members (the onboarding queue), or recent leavers — plus growth counts. Identity ' +
      'metadata only, never message content. Guild-wide (not conversation-scoped). Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      filter: z
        .enum(['recent', 'not_members', 'left', 'all'])
        .optional()
        .describe(
          "'recent' (default) = joined within the window; 'not_members' = present but never added to " +
            "community_users (onboarding queue); 'left' = left within the window; 'all' = everyone present",
        ),
      days: z.number().optional().describe("Window in days for 'recent'/'left' (default 7, max 90)"),
      limit: z.number().optional().describe('Max entries (default 50, max 200)'),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'list_roster');
      const filter = args.filter ?? 'recent';
      const rows = await listRoster(caller.platform, filter, args.days ?? 7, args.limit ?? 50);
      const counts = await rosterCounts(caller.platform);
      const summary = `Roster: ${counts.total} present · ${counts.joinedThisWeek} joined this week · ${counts.leftThisWeek} left this week.`;
      if (rows.length === 0) return text(`${summary}\nNo entries match filter "${filter}".`);
      return text(
        `${summary}\n` +
          untrusted(
            `Roster (${filter})`,
            rows
              .map(
                (r) =>
                  `${r.displayName ? sanitizeName(r.displayName) : r.userId} (${r.userId}) — joined ${r.joinedAt.toISOString()}` +
                  `${r.leftAt ? `, left ${r.leftAt.toISOString()}` : ''}` +
                  `${r.rejoinedCount > 0 ? `, rejoined ${r.rejoinedCount}x` : ''}` +
                  `${r.isMember ? '' : ', NOT yet a member'}`,
              )
              .join('\n'),
          ),
      );
    },
  }),

  defineTool({
    name: 'list_context_digests',
    description:
      'Show durable community-context digests the offline builder distilled from stored interactions: ' +
      'recurring topics with aggregate summaries and how many people/messages carried each. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      days: z.number().optional().describe('How far back to look (default 30, max 365)'),
      limit: z.number().optional().describe('Max digests (default 20, max 100)'),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'list_context_digests');
      const rows = await listContextDigests(args.days ?? 30, args.limit ?? 20);
      if (rows.length === 0) {
        return text(
          'No context digests found. The offline builder may be disabled (CONTEXT_BUILDER_ENABLED) or has not run yet.',
        );
      }
      return text(
        untrusted(
          'Context digests',
          rows
            .map(
              (d) =>
                `#${d.id} [${d.periodStart.toISOString().slice(0, 10)}..${d.periodEnd.toISOString().slice(0, 10)}] ` +
                `${d.topic} — ${d.summary} (${d.questionCount} messages from ${d.distinctUsers} people)`,
            )
            .join('\n'),
        ),
      );
    },
  }),
];
