import { z } from 'zod';
import { assertAtLeast } from '../../auth/rbac.js';
import { recentChanges } from '../changelog.js';
import { resolveLinkedIdentities, userMessages } from '../../storage/repository.js';
import { text, untrusted } from './helpers.js';
import { defineTool } from './types.js';

// --- Admin tools (scoped to the admin's own conversations) ------------------

export const activityTools = [
  defineTool({
    name: 'whats_new',
    description:
      "Report the bot's own recent updates from its changelog. Use this whenever " +
      "someone asks what's new, what changed, what you've been upgraded with, or " +
      'about your recent versions/releases.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      limit: z
        .number()
        .int()
        .positive()
        .max(10)
        .optional()
        .describe('How many recent changelog sections to include (default 2)'),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'whats_new');
      return text(await recentChanges(args.limit ?? 2));
    },
  }),

  defineTool({
    name: 'user_history',
    description:
      'Look up recent message history for a user (moderation). Admins only see history from conversations they are in.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      userId: z.string().describe('Platform user id to inspect'),
      limit: z.number().optional().describe('Max messages (default 20)'),
    },
    handler: async (args, { caller, callerScope }) => {
      assertAtLeast(caller.role, 'admin', 'user_history');
      const allowed = await callerScope();
      const rows = await userMessages(caller.platform, args.userId, args.limit ?? 20, allowed ?? undefined);
      const linked = await resolveLinkedIdentities(caller.platform, args.userId);
      const linkNote =
        linked.length > 1
          ? `Linked identities (link_member): ${linked.map((l) => `${l.platform}:${l.userId}`).join(', ')}\n`
          : '';
      if (rows.length === 0) return text(`${linkNote}No history for that user (within your conversations).`);
      return text(
        linkNote +
          untrusted(
            `History for ${args.userId}`,
            rows
              .map(
                (r) =>
                  `[${r.createdAt.toISOString()}] (${r.conversationId}) ${r.direction}: ${r.content.slice(0, 200)}`,
              )
              .join('\n'),
          ),
      );
    },
  }),
];
