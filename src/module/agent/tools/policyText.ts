import { z } from 'zod';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { updatePolicy } from '@swampratnz/agent-base/storage/policyStore.js';
// The community policy keys this file writes (and, below, reads) are
// registered by policies.ts at its import time — importing its getters here
// also satisfies that load-before-use requirement, so a direct import of this
// module can't hit policyStore's unknown-key throw.
import { getWelcomeMessage, getWelcomeMessageMi } from '../../storage/policies.js';
import { text } from './helpers.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

/**
 * Cap on stored community guidelines text (issue #212). Bounded by Discord's
 * hard 2000-character message limit — guidelines are appended to the static
 * welcome message and sent unchunked (`member.send`/channel fallback), so an
 * unbounded value could blow that limit and silently drop the whole welcome
 * (both the DM and channel-fallback sends would fail the same way). Leaves
 * headroom for the ~230-character static WELCOME_MESSAGE plus its guidelines
 * preamble; WhatsApp has no comparable limit, so the tighter platform sets
 * the bound.
 */
export const COMMUNITY_GUIDELINES_MAX_CHARS = 1500;

/**
 * Cap on the admin-configured welcome message (issue #253). Sized so a
 * maxed-out configured welcome PLUS a maxed-out configured
 * COMMUNITY_GUIDELINES_MAX_CHARS PLUS the `"\n\nCommunity guidelines:\n"`
 * preamble (24 chars) can never exceed Discord's 2000-character message
 * limit: 2000 - 1500 - 24 = 476 headroom; 400 leaves comfortable margin.
 */
export const WELCOME_MESSAGE_MAX_CHARS = 400;

export const policyTextTools = [
  // Content curation, same tier as save_knowledge — not super-admin like
  // set_policy, which is runtime bot control (issue #212).
  defineTool({
    name: 'set_community_guidelines',
    description:
      'Set the community guidelines/rules text shown to members (appended verbatim to new-member welcome ' +
      `messages and returned verbatim by community_guidelines). Max ${COMMUNITY_GUIDELINES_MAX_CHARS} ` +
      "characters. Pass an empty string to clear. Pass language: 'mi' to set/clear the te reo Māori " +
      "variant served to members with a standing set_language_preference('mi') instead of the default " +
      "(en) text — omit or pass 'en' for the default-language text. Admin only.",
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      text: z
        .string()
        .max(COMMUNITY_GUIDELINES_MAX_CHARS)
        .describe(`The guidelines text, or "" to clear (max ${COMMUNITY_GUIDELINES_MAX_CHARS} characters)`),
      language: z
        .enum(['en', 'mi'])
        .optional()
        .describe("Which variant to set: 'en' (default) or 'mi' (te reo Māori). Defaults to 'en'."),
    },
    handler: async (args, { caller, audited }) => {
      assertAtLeast(caller.role, 'admin', 'set_community_guidelines');
      const language = args.language ?? 'en';
      const policyKey = language === 'mi' ? 'community_guidelines_mi' : 'community_guidelines';
      const { success, result } = await audited({
        actionKind: 'set_community_guidelines',
        params: { text: args.text, language },
        run: async () => {
          await updatePolicy(policyKey, args.text, caller.userId);
          return args.text ? 'updated' : 'cleared';
        },
      });
      if (!success) return text(`Failed: ${result}`, true);
      const label = language === 'mi' ? 'Community guidelines (mi)' : 'Community guidelines';
      return text(args.text ? `${label} updated.` : `${label} cleared.`);
    },
  }),

  // Sibling of set_community_guidelines (issue #253): same admin/audited/no-
  // CONFIRM shape, configures the other half of the new-member welcome text.
  defineTool({
    name: 'set_welcome_message',
    description:
      'Set the welcome message sent to new members on join (Discord DM/channel fallback, WhatsApp group ' +
      `post), in place of the hardcoded default. Max ${WELCOME_MESSAGE_MAX_CHARS} characters. Pass an ` +
      "empty string to clear and revert to the default. Pass language: 'mi' to set/clear the te reo " +
      "Māori variant served to a rejoining Discord member with a standing set_language_preference('mi') " +
      "instead of the default (en) text — omit or pass 'en' for the default-language text. Admin only.",
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      text: z
        .string()
        .max(WELCOME_MESSAGE_MAX_CHARS)
        .describe(`The welcome text, or "" to clear (max ${WELCOME_MESSAGE_MAX_CHARS} characters)`),
      language: z
        .enum(['en', 'mi'])
        .optional()
        .describe("Which variant to set: 'en' (default) or 'mi' (te reo Māori). Defaults to 'en'."),
    },
    handler: async (args, { caller, audited }) => {
      assertAtLeast(caller.role, 'admin', 'set_welcome_message');
      const language = args.language ?? 'en';
      const policyKey = language === 'mi' ? 'welcome_message_mi' : 'welcome_message';
      const { success, result } = await audited({
        actionKind: 'set_welcome_message',
        params: { text: args.text, language },
        run: async () => {
          await updatePolicy(policyKey, args.text, caller.userId);
          return args.text ? 'updated' : 'cleared';
        },
      });
      if (!success) return text(`Failed: ${result}`, true);
      const label = language === 'mi' ? 'Welcome message (mi)' : 'Welcome message';
      return text(args.text ? `${label} updated.` : `${label} cleared.`);
    },
  }),

  // Read counterpart to set_welcome_message (issue #1377) — the #212/#253
  // sibling pattern's read half that community_guidelines got and this one
  // never did. Admin-tier (not member, unlike community_guidelines): the
  // evidenced need is an admin verifying their own write, not a member
  // question, and showing both language variants at once regardless of the
  // caller's own standing language_preference avoids the mi-verification
  // dance community_guidelines still has today. No CONFIRM, no audited() —
  // matches community_guidelines/feature_flags/list_access_requests, none of
  // which wrap their read-only handlers.
  defineTool({
    name: 'welcome_message',
    description:
      "Return this community's currently configured welcome message — both the default (en) and te reo " +
      'Māori (mi) variants — exactly as an admin set them via set_welcome_message. Call this to check ' +
      'whether a write took effect, or what a new joiner currently receives. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'welcome_message');
      const [en, mi] = await Promise.all([getWelcomeMessage(), getWelcomeMessageMi()]);
      const enLine = `Welcome message (en): ${en ?? "Not set — falls back to this platform's default welcome text."}`;
      const miLine = `Welcome message (mi): ${mi ?? 'Not set.'}`;
      return text(`${enLine}\n${miLine}`);
    },
  }),
];
