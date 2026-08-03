import { z } from 'zod';
import type { Platform } from '../../../base/platforms/types.js';
import { assertAtLeast } from '../../../base/auth/tiers.js';
import { sanitizeName } from '../../../base/util/sanitizeName.js';
import { listAccessRequests, listSuggestions, resolveSuggestion } from '../../../base/storage/repository.js';
import { text, untrusted } from './helpers.js';
import { notifySuggestionResolved } from './notify.js';
import { defineTool } from '../../../base/agent/tools/types.js';

export const accessAndSuggestionsTools = [
  defineTool({
    name: 'list_access_requests',
    description:
      'List gated guests who have asked the bot for access — identity and request count only, never message content. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: { limit: z.number().optional().describe('Max entries (default 50)') },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'list_access_requests');
      const rows = await listAccessRequests(args.limit ?? 50);
      if (rows.length === 0) return text('No pending access requests.');
      return text(
        untrusted(
          'Access requests',
          rows
            .map((r) => {
              // firstRequestedAt is always the DB-stored insert timestamp for
              // this (platform, user_id) row (repository.ts's
              // listAccessRequests) — never sourced from a tool argument, so
              // it can't be spoofed by a caller-supplied value (issue #515).
              const waitingDays = Math.floor((Date.now() - r.firstRequestedAt.getTime()) / 86_400_000);
              return (
                `${r.platform} ${r.userName ? sanitizeName(r.userName) : r.userId} (${r.userId}) — ` +
                `${r.requestCount} request(s), first ${r.firstRequestedAt.toISOString()} (waiting ${waitingDays}d), ` +
                `last ${r.lastRequestedAt.toISOString()}`
              );
            })
            .join('\n'),
        ),
      );
    },
  }),

  defineTool({
    name: 'list_suggestions',
    description:
      'List member-submitted bot-improvement suggestions for triage. The bridge to the pipeline stays ' +
      'human: file anything worthwhile as a GitHub proposal yourself — the bot has no repo access. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      status: z
        .enum(['new', 'reviewed', 'declined', 'done'])
        .optional()
        .describe('Filter by status (default: all statuses)'),
      limit: z.number().optional().describe('Max entries (default 50, max 200)'),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'list_suggestions');
      const rows = await listSuggestions(args.status, args.limit ?? 50);
      if (rows.length === 0) return text('No suggestions found.');
      return text(
        untrusted(
          'Suggestions',
          rows
            .map(
              (s) =>
                `#${s.id} [${s.status}] ${s.platform} ${s.displayName ? sanitizeName(s.displayName) : s.userId} (${s.createdAt.toISOString()}): ${s.content}`,
            )
            .join('\n'),
        ),
      );
    },
  }),

  defineTool({
    name: 'resolve_suggestion',
    description:
      'Mark a suggestion as reviewed, declined, or done once triaged. Non-destructive status change ' +
      '(no CONFIRM needed), audited. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      id: z.number().describe('Suggestion id (from list_suggestions)'),
      status: z.enum(['reviewed', 'declined', 'done']).describe('New status'),
    },
    handler: async (args, { caller, audited, adapterFor }) => {
      assertAtLeast(caller.role, 'admin', 'resolve_suggestion');
      const state: { row: { platform: Platform; userId: string; content: string } | null } = { row: null };
      const { success, result } = await audited({
        actionKind: 'resolve_suggestion',
        params: { id: args.id, status: args.status },
        run: async () => {
          const row = await resolveSuggestion(args.id, args.status, caller.userId);
          if (!row) throw new Error(`No suggestion with id ${args.id}.`);
          state.row = row;
          return `marked ${args.status}`;
        },
      });
      // Cross-platform resolution DMs (issue #157): routes through the
      // suggestion's ORIGIN platform's adapter, not the resolving admin's
      // current-turn one, via Router's adapter registry — never misaddresses
      // a DM to the wrong platform. Degrades to today's silent skip if that
      // platform isn't registered in this deployment (e.g. WhatsApp not
      // configured).
      if (success && state.row) {
        const target = adapterFor(state.row.platform);
        if (target)
          await notifySuggestionResolved(
            target,
            state.row.userId,
            args.status,
            state.row.content,
            state.row.platform,
          );
      }
      return text(success ? `Suggestion #${args.id} marked ${args.status}.` : `Failed: ${result}`, !success);
    },
  }),
];
