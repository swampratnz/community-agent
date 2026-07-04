import type { Platform } from '../platforms/types.js';

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
  if (platform === 'whatsapp' && (id.length < 7 || id.length > 15)) {
    throw new Error(
      `"${rawId}" doesn't look like a WhatsApp number (expected 7-15 digits, E.164 without +). ` +
        `If this is a Discord id, pass platform: "discord".`,
    );
  }
  return id;
}
