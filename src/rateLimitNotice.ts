/**
 * Pure debounce for the per-user rate-limit notice. Mirrors router.ts's
 * inline budgetNotified check (router.ts:180-181), but debounced against
 * the rate-limit window instead of the 24h budget window, so a burst of
 * over-limit messages produces exactly one notice per episode.
 */

export const RATE_LIMIT_NOTICE_TEXT =
  "You're sending messages a bit fast — please wait a moment and try again.";

// Fixed, human-authored te reo Māori variant (issue #300), served instead of
// RATE_LIMIT_NOTICE_TEXT to a caller with a standing 'mi' language_prefs row
// (getLanguagePreference, issue #189) — same trust level as the English
// constant: no model call, no translation, no injection surface.
export const RATE_LIMIT_NOTICE_TEXT_MI =
  'Kei te tere rawa āu karere — tēnā koa, tatari mō tētahi wā poto ka whakamātau anō ai.';

// Fixed, human-authored plain-language variant (issue #430), served instead
// of RATE_LIMIT_NOTICE_TEXT to a caller with a standing 'plain' response-style
// preference (getResponseStyle, issue #126) whose language preference is
// NOT 'mi' — 'mi' takes precedence over 'plain' (see router.ts). Same trust
// level as the English constant: no model call, no translation, no injection
// surface.
export const RATE_LIMIT_NOTICE_TEXT_PLAIN =
  "You're sending messages too fast. Please wait a bit, then try again.";

export function shouldNotifyRateLimited(
  lastNotifiedAt: number | undefined,
  now: number,
  windowMs: number,
): boolean {
  return lastNotifiedAt === undefined || now - lastNotifiedAt > windowMs;
}
