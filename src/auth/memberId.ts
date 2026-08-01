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
 * numbers are 7-{@link MAX_WHATSAPP_ID_DIGITS} (deliberately tighter than
 * E.164's 15 — see that constant).
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
  // The two out-of-range WhatsApp cases are deliberately SEPARATE, because they
  // have different causes and so need different advice. Folding them together
  // told an admin who fat-fingered a 5-digit id that it was "probably a LID
  // copied from the roster" — a confident, wrong diagnosis, in exactly the
  // situation this validation exists to make less confusing.
  if (platform === 'whatsapp' && id.length > MAX_WHATSAPP_ID_DIGITS) {
    // TOO LONG: refused as AMBIGUOUS rather than merely malformed. 14+ digits
    // is the band WhatsApp LIDs occupy, and a LID is indistinguishable from an
    // E.164 number once the `@lid` suffix is stripped. See the constant above.
    throw new Error(
      `"${rawId}" doesn't look like a WhatsApp number (expected 7-${MAX_WHATSAPP_ID_DIGITS} digits, ` +
        `E.164 without +) — it is too long. If this is a Discord id, pass platform: "discord". ` +
        `If you copied it from the roster or a group listing, it is probably a WhatsApp LID ` +
        `(a privacy id), NOT a phone number — a member added under a LID can never be matched to ` +
        `a real sender, because inbound messages always resolve to the phone number. Use the ` +
        `person's actual phone number in E.164 form.`,
    );
  }
  if (platform === 'whatsapp' && id.length < 7) {
    // TOO SHORT: an ordinary typo — a partial number, or one missing its
    // country code. Deliberately says nothing about LIDs, which are long.
    throw new Error(
      `"${rawId}" doesn't look like a WhatsApp number (expected 7-${MAX_WHATSAPP_ID_DIGITS} digits, ` +
        `E.164 without +) — it is too short. Check for a missing country code (e.g. NZ 021 234 5678 -> 6421234567) ` +
        `or a truncated number.`,
    );
  }
  return id;
}

/**
 * Decide whether a supplied WhatsApp id is a LID we can resolve to a real
 * phone number, and resolve it if so.
 *
 * Extracted from `resolveMemberTarget` so the decision is unit-testable
 * without standing up the whole tool transport: `lookup` is injected, so a
 * test can drive the known/unknown/not-a-LID branches directly.
 *
 * Returns the phone number when `rawId` is LID-shaped AND we have learned that
 * LID's number from a real message envelope; otherwise null, meaning "not
 * resolvable — carry on and let normalizeMemberId explain the problem".
 *
 * Deliberately conservative: it only ever fires for an id too long to be a
 * valid member number anyway, so it can never reinterpret something that would
 * otherwise have been accepted as a phone number.
 */
export async function resolveWhatsappLid(
  rawId: string,
  lookup: (lid: string) => Promise<string | null>,
): Promise<string | null> {
  const id = rawId.trim().replace(/^\+/, '');
  if (!/^\d+$/.test(id) || id.length <= MAX_WHATSAPP_ID_DIGITS) return null;
  const phone = await lookup(id);
  if (!phone) return null;
  // Never hand back something that would fail validation anyway — a corrupt or
  // mis-learned mapping must not smuggle an invalid id past the gate.
  try {
    return normalizeMemberId('whatsapp', phone);
  } catch {
    return null;
  }
}
