/**
 * Static text for the daily reply-budget notice (previously an un-hoisted
 * inline literal in router.ts). Mirrors pauseNotice.ts/rateLimitNotice.ts's
 * per-notice-file convention, but carries no debounce helper of its own —
 * router.ts already tracks the 24h budgetNotified window inline.
 */

export const DAILY_BUDGET_NOTICE_TEXT =
  "You've reached today's usage limit for the assistant — try again later.";

// Fixed, human-authored te reo Māori variant (issue #300), served instead of
// DAILY_BUDGET_NOTICE_TEXT to a caller with a standing 'mi' language_prefs
// row (getLanguagePreference, issue #189) — same trust level as the English
// constant: no model call, no translation, no injection surface.
export const DAILY_BUDGET_NOTICE_TEXT_MI =
  'Kua eke koe ki te whāiti whakamahi o te rā mō te kaiāwhina — tēnā koa, whakamātau anō ā tērā rā.';

// Fixed, human-authored plain-language variant (issue #430), served instead
// of DAILY_BUDGET_NOTICE_TEXT to a caller with a standing 'plain'
// response-style preference (getResponseStyle, issue #126) whose language
// preference is NOT 'mi' — 'mi' takes precedence over 'plain' (see
// router.ts). Same trust level as the English constant: no model call, no
// translation, no injection surface.
export const DAILY_BUDGET_NOTICE_TEXT_PLAIN = "You've used all of today's replies. Try again tomorrow.";
