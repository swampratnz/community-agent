import { z } from 'zod';
import { logger } from '@swampratnz/agent-base/logger.js';
import {
  getLanguagePreference,
  isKnownMessage,
  type LanguagePreference,
} from '@swampratnz/agent-base/storage/repository.js';
import { makeCalendarDayReserver } from '@swampratnz/agent-base/util/rateReservation.js';
import { text } from './helpers.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

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

/**
 * Pure render for `react_to_message`'s six outcomes (issue #1328) — same
 * "one function per tool, outcome as a parameter" shape as
 * `formatRateAnswerText`/`formatAppealModerationText`, reusing the language-
 * as-explicit-parameter pattern every other member-tool file already uses.
 * `emoji`/`platform`/`messageId`/`limit` are unchanged interpolations in
 * both languages.
 */
export function formatReactToMessageText(
  outcome:
    | { kind: 'success'; emoji: string }
    | { kind: 'platform_unavailable'; platform: string }
    | { kind: 'no_message_id' }
    | { kind: 'unknown_message'; messageId: string }
    | { kind: 'rate_limited'; limit: number }
    | { kind: 'failure' },
  language: LanguagePreference,
): string {
  const mi = language === 'mi';
  switch (outcome.kind) {
    case 'success':
      return mi ? `Kua tohu ${outcome.emoji}.` : `Reacted ${outcome.emoji}.`;
    case 'platform_unavailable':
      return mi
        ? `Kāore ngā tohu e wātea ana i ${outcome.platform}.`
        : `Reactions aren't available on ${outcome.platform}.`;
    case 'no_message_id':
      return mi
        ? 'Kāore he karere hei tohu — kāore he tautuhinga e kitea ana mō te karere o nāianei.'
        : 'No message to react to — the current message has no visible id.';
    case 'unknown_message':
      return mi
        ? `Kāore e whakaaetia: kāore anō te karere "${outcome.messageId}" kia kitea i tēnei kōrero.`
        : `Refusing: message "${outcome.messageId}" has never been seen in this conversation.`;
    case 'rate_limited':
      return mi
        ? `Kua eke koe ki te tepe tohu mō tēnei rā (${outcome.limit}). Whakamātauria anō āpōpō.`
        : `You've hit today's reaction limit (${outcome.limit}). Try again tomorrow.`;
    case 'failure':
      return mi ? 'I rahua te tohu i taua karere.' : 'Failed to react to that message.';
  }
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
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(
          formatReactToMessageText({ kind: 'platform_unavailable', platform: caller.platform }, language),
          true,
        );
      }
      const messageId = args.messageId ?? caller.messageId;
      if (!messageId) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatReactToMessageText({ kind: 'no_message_id' }, language), true);
      }
      // Same "the bot must have actually seen it" discipline as
      // moderate/announce's target validation, scoped to the caller's own
      // conversation (a member never names a different one).
      if (!(await isKnownMessage(caller.platform, caller.conversationId, messageId))) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatReactToMessageText({ kind: 'unknown_message', messageId }, language), true);
      }
      const key = `${caller.platform}:${caller.userId}`;
      if (!reserveReactionDaily(key)) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(
          formatReactToMessageText({ kind: 'rate_limited', limit: REACTION_RATE_LIMIT_PER_DAY }, language),
          true,
        );
      }
      try {
        await adapter.reactToMessage(caller.conversationId, messageId, args.emoji);
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatReactToMessageText({ kind: 'success', emoji: args.emoji }, language));
      } catch (err) {
        logger.warn({ err, actor: caller.userId }, 'react_to_message failed');
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatReactToMessageText({ kind: 'failure' }, language), true);
      }
    },
  }),
];
