import type { PlatformMemberIdRules } from '../types.js';

/**
 * Discord's member-id heuristics (agent-base plan item 9): the per-adapter
 * declaration behind `src/auth/memberId.ts`'s `normalizeMemberId('discord',
 * …)` dispatch. Deliberately a leaf module with no discord.js/config import,
 * so the registry (and anything that only needs id validation, like the
 * memberId unit tests) never drags the heavy adapter into its import graph.
 *
 * A Discord user id is a snowflake: all digits, 17-20 of them. The error
 * strings are byte-identical to the pre-split `memberId.ts` branches —
 * including the cross-platform "pass platform: \"whatsapp\"" hint, which is
 * deliberate UX (the common confusion is an admin holding an id from the
 * *other* platform), not a coupling this module needs at the type level.
 */
export const DISCORD_MEMBER_ID_RULES: PlatformMemberIdRules = {
  normalizeMemberId(rawId: string): string {
    const id = rawId.trim().replace(/^\+/, '');
    if (!/^\d+$/.test(id)) {
      throw new Error(`"${rawId}" is not a valid discord id: expected digits only (Discord snowflake).`);
    }
    if (id.length < 17 || id.length > 20) {
      throw new Error(
        `"${rawId}" doesn't look like a Discord user id (expected a 17-20 digit snowflake). ` +
          `If this is a WhatsApp number, pass platform: "whatsapp".`,
      );
    }
    return id;
  },
};
