import { z } from 'zod';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { recentChanges } from '../changelog.js';
import { resolveLinkedIdentities, userMessages } from '@swampratnz/agent-base/storage/repository.js';
import { text, untrusted } from './helpers.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

// --- Admin tools (scoped to the admin's own conversations) ------------------

/**
 * `userMessages` (agent-base) has no ordering parameter and always queries
 * `ORDER BY created_at DESC` — same shape as `listMemberWarnings`/
 * `recentModerationEntries`. So `oldestFirst: true` below can only ever fetch
 * the newest `USER_HISTORY_SCAN_LIMIT` matching rows (one bounded call, never
 * a second) and sort that window ascending by `createdAt` in JS — the same
 * bounded, precedent-accepted tradeoff `moderation.ts`'s own `*_SCAN_LIMIT`
 * constants describe (issue #1460, mirroring #1371/#1426/#1267/#1443).
 */
const USER_HISTORY_SCAN_LIMIT = 200;

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
      oldestFirst: z
        .boolean()
        .optional()
        .describe(
          'Order by createdAt ascending (earliest message first) instead of the default newest-first — ' +
            'use this to tell whether a pattern has been building over time, not just what happened most ' +
            `recently. Approximate for a user with a long history: only scans the ${USER_HISTORY_SCAN_LIMIT} ` +
            'most recent messages before sorting, so if that user has that many or more, the true earliest ' +
            'may fall outside what was scanned — the response says so explicitly when this happens.',
        ),
    },
    handler: async (args, { caller, callerScope }) => {
      assertAtLeast(caller.role, 'admin', 'user_history');
      const allowed = await callerScope();
      // oldestFirst: true takes exactly one bounded read (never a second
      // call) and sorts/slices in JS — see USER_HISTORY_SCAN_LIMIT above.
      // False/omitted stays byte-identical to before this field existed,
      // using the identical single-call shape as before.
      const scanned = args.oldestFirst
        ? await userMessages(caller.platform, args.userId, USER_HISTORY_SCAN_LIMIT, allowed ?? undefined)
        : null;
      const rows = scanned
        ? [...scanned].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, args.limit ?? 20)
        : await userMessages(caller.platform, args.userId, args.limit ?? 20, allowed ?? undefined);
      const linked = await resolveLinkedIdentities(caller.platform, args.userId);
      const linkNote =
        linked.length > 1
          ? `Linked identities (link_member): ${linked.map((l) => `${l.platform}:${l.userId}`).join(', ')}\n`
          : '';
      if (rows.length === 0) return text(`${linkNote}No history for that user (within your conversations).`);
      // Truncation caveat (mirrors list_member_warnings'/moderation_history's
      // above): `scanned` hitting exactly USER_HISTORY_SCAN_LIMIT means this
      // user may have more history than the single bounded scan could see, so
      // the "oldest" rows below only ever come from the most recent
      // USER_HISTORY_SCAN_LIMIT ones — the genuine earliest could be outside
      // that window and missing here.
      const truncationCaveat =
        scanned && scanned.length === USER_HISTORY_SCAN_LIMIT
          ? ` ⚠️ oldestFirst caveat: user_history found ${USER_HISTORY_SCAN_LIMIT}+ messages for this user, ` +
            `so only the ${USER_HISTORY_SCAN_LIMIT} most recent ones were scanned before sorting — the true ` +
            'oldest may not be shown above.'
          : '';
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
          ) +
          truncationCaveat,
      );
    },
  }),
];
