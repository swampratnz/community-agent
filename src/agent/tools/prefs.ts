import { z } from 'zod';
import { setLanguagePreference, setResponseStyle } from '../../storage/repository.js';
import { text } from './helpers.js';
import { defineTool } from './types.js';

export const prefsTools = [
  defineTool({
    name: 'set_response_style',
    description:
      "Set the caller's standing reply style for every future message in every conversation, so they " +
      "don't have to re-ask each time. Call with 'plain' when someone asks you to explain things more " +
      'simply, avoid jargon, or use plainer language going forward — not for a one-off "explain that ' +
      "again\" request, which should just be honoured directly in the reply. Call with 'standard' to " +
      'revert to the normal style.',
    minTier: 'member',
    readOnlyHint: false,
    schema: { style: z.enum(['standard', 'plain']).describe('The reply style to use from now on') },
    handler: async (args, { caller }) => {
      await setResponseStyle(caller.platform, caller.userId, args.style);
      return text(
        args.style === 'plain'
          ? "Got it — I'll keep replies simple and jargon-free from now on. Say the word to switch back."
          : 'Got it — back to the normal reply style.',
      );
    },
  }),

  defineTool({
    name: 'set_language_preference',
    description:
      "Set the caller's standing reply language for every future message in every conversation, so " +
      "they don't have to re-ask each time. Call with 'en' when someone asks you to always reply in " +
      "NZ English from now on, or with 'mi' when someone asks you to always reply in te reo Māori " +
      "from now on, regardless of what language their own messages are written in. Call with 'auto' " +
      "to revert to today's default of mirroring whichever language their current message is in. Only " +
      'call this for an explicit STANDING request ("always reply to me in Māori from now on") — a ' +
      'one-off "reply in Māori just now" should just be honoured directly in the reply, without ' +
      'calling this tool.',
    minTier: 'member',
    readOnlyHint: false,
    schema: { language: z.enum(['auto', 'en', 'mi']).describe('The reply language to use from now on') },
    handler: async (args, { caller }) => {
      await setLanguagePreference(caller.platform, caller.userId, args.language);
      if (args.language === 'en') {
        return text("Got it — I'll always reply in NZ English from now on. Say the word to switch back.");
      }
      if (args.language === 'mi') {
        return text(
          "Got it — I'll always reply in te reo Māori from now on where I can. Say the word to switch back.",
        );
      }
      return text('Got it — back to mirroring whichever language you write in.');
    },
  }),
];
