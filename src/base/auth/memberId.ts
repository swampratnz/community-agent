import type { Platform } from '../platforms/types.js';
import { descriptorFor, KNOWN_PLATFORMS } from '../platforms/registry.js';

/**
 * Membership-target id validation — since agent-base plan item 9 a THIN
 * DISPATCHER over the platform registry: the actual heuristics (Discord's
 * 17-20 digit snowflake band, WhatsApp's 7-13 digit E.164 bound and the LID
 * lore behind it) are per-adapter declarations in
 * `src/platforms/discord/memberIdRules.ts` and
 * `src/platforms/whatsapp/memberIdRules.ts`, registered on each platform's
 * descriptor. The exports below are unchanged in name, signature and
 * byte-for-byte error behaviour, so every import site and test is untouched.
 */

export { MAX_WHATSAPP_ID_DIGITS, resolveWhatsappLid } from '../platforms/whatsapp/memberIdRules.js';

/**
 * Validate and normalize a membership target id for a platform, so a WhatsApp
 * number can't be silently filed as a Discord user (issue #78). Dispatches to
 * the platform's registered member-id rules; throws with an actionable
 * message (pointing at the `platform` argument) on a shape mismatch.
 *
 * Fails CLOSED for a platform with no registered rules: `Platform` is an
 * open string now, and an id that no registered platform vouches for must
 * never be minted into an identity row (the same never-mint-an-unmatchable-
 * identity principle as the WhatsApp LID bound). Unreachable today — every
 * caller passes either an adapter-envelope platform or a closed zod enum
 * value — so this is a backstop, not a behaviour change.
 */
export function normalizeMemberId(platform: Platform, rawId: string): string {
  const descriptor = descriptorFor(platform);
  if (!descriptor) {
    throw new Error(
      `Unknown platform "${platform}": no registered member-id rules ` +
        `(registered platforms: ${KNOWN_PLATFORMS.join(', ')}).`,
    );
  }
  return descriptor.memberId.normalizeMemberId(rawId);
}
