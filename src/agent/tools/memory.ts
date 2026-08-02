import { z } from 'zod';
import { assertAtLeast } from '../../auth/rbac.js';
import { config } from '../../config.js';
import { logger, hashId } from '../../logger.js';
import { recentConversationHistory, searchMemory } from '../../storage/repository.js';
import { sanitizeName } from '../../util/sanitizeName.js';
import { memoryHitJumpLink } from '../discordLink.js';
import { text, untrusted } from './helpers.js';
import { defineTool } from './types.js';

/** Per-message truncation shared by remember_search and catch_up (issue #167) so both quote the same amount of any one message. */
const RECALL_TRUNCATION_CHARS = 400;

/** catch_up (issue #167): default recap window when the caller doesn't ask for a specific one. */
export const CATCH_UP_DEFAULT_HOURS = 24;

/** catch_up: hard ceiling on the requested window, regardless of what `hours` asks for. */
export const CATCH_UP_MAX_HOURS = 24 * 7;

/**
 * catch_up's own row cap — deliberately NOT config.behaviour.memoryTopK
 * (tuned for a handful of embedding-similarity hits, not a whole-window
 * recap). Each row truncates to RECALL_TRUNCATION_CHARS (400) chars, so this
 * cap tops out around 40 * 400 = 16,000 chars (~4k tokens) of injected
 * untrusted context for one tool call — a bounded, deliberate slice of the
 * current turn's budget on top of the smaller automatic recall already
 * injected each turn.
 */
export const CATCH_UP_MAX_MESSAGES = 40;

export const memoryTools = [
  defineTool({
    name: 'remember_search',
    description:
      'Search past interactions for relevant context. Members search the current conversation; admins may search conversations they are in; super admins may search everything.',
    minTier: 'member',
    readOnlyHint: true,
    schema: {
      query: z.string().describe('What to search for in past conversations'),
      scope: z
        .enum(['conversation', 'mine', 'all'])
        .optional()
        .describe(
          "'conversation' (default) = this conversation; 'mine' (admin) = all conversations you are in; 'all' (super admin) = every conversation on both platforms",
        ),
    },
    handler: async (args, { caller, callerScope }) => {
      const scope = args.scope ?? 'conversation';
      let hits;
      if (scope === 'all') {
        assertAtLeast(caller.role, 'super_admin', 'remember_search:all');
        hits = await searchMemory(args.query, {});
      } else if (scope === 'mine') {
        assertAtLeast(caller.role, 'admin', 'remember_search:mine');
        const allowed = await callerScope();
        hits = await searchMemory(args.query, {
          platform: caller.platform,
          ...(allowed ? { conversationIds: allowed } : {}),
        });
      } else {
        hits = await searchMemory(args.query, {
          platform: caller.platform,
          conversationId: caller.conversationId,
        });
      }
      if (hits.length === 0) return text('No relevant past interactions found.');
      return text(
        untrusted(
          'Search results',
          hits
            .map((h, i) => {
              const link = memoryHitJumpLink(h, config.discord.guildId);
              // Sanitize the recalled author name (untrusted platform display
              // name): untrusted() strips angle brackets but not newlines, so a
              // `\n\n[SYSTEM] ...` nickname would otherwise land as an apparent
              // standalone directive inside this result (finding A).
              const name = sanitizeName(h.userName);
              return `${i + 1}. (${(h.similarity * 100).toFixed(0)}% match) [${h.direction}${name ? ` by ${name}` : ''}] ${h.content.slice(0, RECALL_TRUNCATION_CHARS)}${link ? ` (${link})` : ''}`;
            })
            .join('\n'),
        ),
      );
    },
  }),

  defineTool({
    name: 'catch_up',
    description:
      'Recap recent activity in the CURRENT conversation (this channel or DM) in chronological order, ' +
      'for a member who has been away and wants to know what they missed. Always scoped to this ' +
      'conversation only — call it with no arguments unless the member names a specific timeframe. ' +
      'Use this for "what did I miss?", "what\'s been happening here?", "catch me up", and similar asks ' +
      '— not for a topic-specific question, which remember_search answers better.',
    minTier: 'member',
    readOnlyHint: true,
    schema: {
      hours: z
        .number()
        .positive()
        .optional()
        .describe(
          `How many hours back to look (default ${CATCH_UP_DEFAULT_HOURS}). Hard-capped at ${CATCH_UP_MAX_HOURS} regardless of what's requested.`,
        ),
    },
    handler: async (args, { caller }) => {
      const hours = Math.min(args.hours ?? CATCH_UP_DEFAULT_HOURS, CATCH_UP_MAX_HOURS);
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      // Always the caller's own real conversation — never a model-supplied
      // id — identical scoping discipline to remember_search's default scope.
      const entries = await recentConversationHistory(
        caller.platform,
        caller.conversationId,
        since,
        CATCH_UP_MAX_MESSAGES,
      );
      // Usage signal (issue #167 AC): a log counter of invocations plus the
      // empty-vs-nonempty split, so adoption is measurable without a new
      // table/migration.
      logger.info(
        {
          platform: caller.platform,
          conversationId: hashId(caller.conversationId),
          hours,
          resultCount: entries.length,
        },
        'catch_up invocation',
      );
      if (entries.length === 0) {
        return text(`Nothing new here in the last ${hours} hour${hours === 1 ? '' : 's'}.`);
      }
      return text(
        untrusted(
          `Recent activity (last ${hours}h)`,
          entries
            .map((e) => {
              const link = memoryHitJumpLink(e, config.discord.guildId);
              // Same sanitization as remember_search above — the recalled
              // author name is an untrusted, newline-unbounded display name
              // (finding A).
              const name = sanitizeName(e.userName);
              return `[${e.createdAt.toISOString()}] [${e.direction}${name ? ` by ${name}` : ''}] ${e.content.slice(0, RECALL_TRUNCATION_CHARS)}${link ? ` (${link})` : ''}`;
            })
            .join('\n'),
        ),
      );
    },
  }),
];
