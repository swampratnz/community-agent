import { z } from 'zod';
import { logger } from '../../logger.js';
import { isKnownMessage } from '../../storage/repository.js';
import { makeCalendarDayReserver } from '../../util/rateReservation.js';
import { text } from './helpers.js';
import { defineTool } from './types.js';

/**
 * Closed emoji allowlist for `react_to_message` (issue #231) — positive/
 * neutral only, deliberately excluding anything that could read as the bot
 * editorialising against a member (no 👎). Never interpolate a model-supplied
 * emoji string into the Discord API; only one of these fixed values ever
 * reaches `adapter.reactToMessage`, matching the closed-enum discipline
 * `set_language_preference` already uses for untrusted-string inputs.
 */
export const ALLOWED_REACTION_EMOJI = ['✅', '👍', '👀', '🎉'] as const;

/** Per-user reaction tally for the current UTC day (anti-spam on the bot's own identity; issue #231). */
export const REACTION_RATE_LIMIT_PER_DAY = 20;
const reactionDaily = makeCalendarDayReserver();

/**
 * Reserve one reaction slot for `key` against today's per-user cap, same
 * restart-resets-the-window shape as `reserveImageGenDaily` — acceptable here
 * because a reaction is far lower-consequence than an image-gen subprocess
 * spawn, so an in-memory (not DB) cap is proportionate and needs no migration.
 */
function reserveReactionDaily(key: string): boolean {
  return reactionDaily(key, REACTION_RATE_LIMIT_PER_DAY);
}

export const reactionsTools = [
  // Lightweight emoji acknowledgement (issue #231): closed positive/neutral
  // allowlist only, and only on a message the bot has actually seen in this
  // conversation — same "validate targets" discipline as moderate/announce,
  // just scoped to the caller's own conversation rather than an admin's set.
  // Implemented on Discord and both WhatsApp adapters (Baileys: issue #495,
  // Cloud: issue #528) — NOT platform-filtered, unlike list_events.
  defineTool({
    name: 'react_to_message',
    description:
      'React to a message with an emoji instead of replying with text — a lightweight, low-noise ' +
      `acknowledgement ("got it", "noted", "seen"). Only ${ALLOWED_REACTION_EMOJI.join(' ')} are allowed; ` +
      'no other emoji, custom, or Nitro emoji can be used. Defaults to the message that triggered this ' +
      'turn when messageId is omitted. Works on Discord and WhatsApp (both Baileys and Cloud API).',
    minTier: 'member',
    // No `platforms` restriction, and the capability invariant now ENFORCES
    // that: both platforms declare 'react_to_message' (WhatsApp's set is the
    // union over its providers), so a future edit narrowing this def to
    // ['discord'] fails assertToolAvailabilityConsistent — the deliberate-
    // inclusion history from rbac's old hand-maintained list, made structural.
    requiresCapability: 'react_to_message',
    readOnlyHint: false,
    schema: {
      emoji: z
        .enum(ALLOWED_REACTION_EMOJI)
        .describe(`One of: ${ALLOWED_REACTION_EMOJI.join(' ')} — no other value is accepted`),
      messageId: z
        .string()
        .optional()
        .describe('Message id to react to; defaults to the message that triggered this turn'),
    },
    handler: async (args, { caller, adapter }) => {
      if (!adapter.reactToMessage) {
        return text(`Reactions aren't available on ${caller.platform}.`, true);
      }
      const messageId = args.messageId ?? caller.messageId;
      if (!messageId) {
        return text('No message to react to — the current message has no visible id.', true);
      }
      // Same "the bot must have actually seen it" discipline as
      // moderate/announce's target validation, scoped to the caller's own
      // conversation (a member never names a different one).
      if (!(await isKnownMessage(caller.platform, caller.conversationId, messageId))) {
        return text(`Refusing: message "${messageId}" has never been seen in this conversation.`, true);
      }
      const key = `${caller.platform}:${caller.userId}`;
      if (!reserveReactionDaily(key)) {
        return text(
          `You've hit today's reaction limit (${REACTION_RATE_LIMIT_PER_DAY}). Try again tomorrow.`,
          true,
        );
      }
      try {
        await adapter.reactToMessage(caller.conversationId, messageId, args.emoji);
        return text(`Reacted ${args.emoji}.`);
      } catch (err) {
        logger.warn({ err, actor: caller.userId }, 'react_to_message failed');
        return text('Failed to react to that message.', true);
      }
    },
  }),
];
