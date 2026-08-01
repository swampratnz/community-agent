import type { Platform } from '../platforms/types.js';

/**
 * Upper bound on a WhatsApp member id, deliberately BELOW E.164's 15-digit
 * maximum.
 *
 * WhatsApp LIDs (privacy ids, the `<digits>@lid` form) occupy the 14-16 digit
 * band, and once the `@lid` suffix is stripped a LID is just digits —
 * indistinguishable from a long phone number. Accepting that band let four
 * phantom members be created on 2026-07-21/27 and 2026-08-01: an admin (or the
 * model, reading `list_roster`, which is LID-keyed) supplied a LID, it passed
 * validation as a "number", and the row could never match a real sender —
 * inbound messages always resolve LID -> phone via `senderPn`, so the stored
 * identity was unreachable. The members silently stayed gated guests, and one
 * of them broke a project-membership check months later.
 *
 * 13 is the cut because it separates the two populations cleanly in practice:
 * every real member number observed here is 10-12 digits, while every observed
 * LID is 14-15 (820 of 850 roster entries). The residual cost is that a genuine
 * 14-15 digit E.164 number is refused; that is the deliberate trade. Refusing an
 * ambiguous id LOUDLY, with an actionable message, beats silently minting an
 * identity that can never be matched or safely messaged — `targetJid` would
 * route those digits to `<id>@s.whatsapp.net`, i.e. potentially a real but
 * unrelated person's number.
 */
export const MAX_WHATSAPP_ID_DIGITS = 13;

/**
 * Validate and normalize a membership target id for a platform, so a WhatsApp
 * number can't be silently filed as a Discord user (issue #78). Strips a
 * leading '+', requires an all-digit id, and range-checks the length by
 * platform. Throws with an actionable message (pointing at the `platform`
 * argument) on a mismatch — Discord snowflakes are 17-20 digits, WhatsApp
 * E.164 numbers are 7-15.
 */
export function normalizeMemberId(platform: Platform, rawId: string): string {
  const id = rawId.trim().replace(/^\+/, '');
  if (!/^\d+$/.test(id)) {
    throw new Error(
      `"${rawId}" is not a valid ${platform} id: expected digits only ` +
        `(${platform === 'whatsapp' ? 'E.164 number without +' : 'Discord snowflake'}).`,
    );
  }
  if (platform === 'discord' && (id.length < 17 || id.length > 20)) {
    throw new Error(
      `"${rawId}" doesn't look like a Discord user id (expected a 17-20 digit snowflake). ` +
        `If this is a WhatsApp number, pass platform: "whatsapp".`,
    );
  }
  if (platform === 'whatsapp' && (id.length < 7 || id.length > MAX_WHATSAPP_ID_DIGITS)) {
    // 14+ digits is refused as AMBIGUOUS, not merely malformed: that is the
    // length band WhatsApp LIDs occupy, and a LID is indistinguishable from an
    // E.164 number once the `@lid` suffix is stripped. See the constant below.
    throw new Error(
      `"${rawId}" doesn't look like a WhatsApp number (expected 7-${MAX_WHATSAPP_ID_DIGITS} digits, ` +
        `E.164 without +). If this is a Discord id, pass platform: "discord". ` +
        `If you copied it from the roster or a group listing, it is probably a WhatsApp LID ` +
        `(a privacy id), NOT a phone number — a member added under a LID can never be matched to ` +
        `a real sender, because inbound messages always resolve to the phone number. Use the ` +
        `person's actual phone number in E.164 form.`,
    );
  }
  return id;
}
