/**
 * Pure debounce for the pause notice (issue #128). Mirrors
 * rateLimitNotice.ts's shape exactly, but debounced against a longer window:
 * a pause_bot is typically longer-lived than a rate-limit burst, so
 * re-notifying on every addressed message would be noisy — once per window
 * is enough to reassure a member the bot isn't broken.
 */

export const PAUSE_NOTICE_TEXT = 'The assistant is temporarily paused — please try again later.';

// Fixed, human-authored te reo Māori variant (issue #300), served instead of
// PAUSE_NOTICE_TEXT to a caller with a standing 'mi' language_prefs row
// (getLanguagePreference, issue #189) — same trust level as the English
// constant: no model call, no translation, no injection surface.
export const PAUSE_NOTICE_TEXT_MI =
  'Kua whakatārewahia te kaiāwhina mō tētahi wā poto — tēnā koa, tukua he wā.';

// Fixed, human-authored plain-language variant (issue #430), served instead
// of PAUSE_NOTICE_TEXT to a caller with a standing 'plain' response-style
// preference (getResponseStyle, issue #126) whose language preference is NOT
// 'mi' — 'mi' takes precedence over 'plain' (see router.ts). Same trust level
// as the English constant: no model call, no translation, no injection
// surface.
export const PAUSE_NOTICE_TEXT_PLAIN = 'The assistant is paused right now. Please try again later.';

export function shouldNotifyPaused(
  lastNotifiedAt: number | undefined,
  now: number,
  windowMs: number,
): boolean {
  return lastNotifiedAt === undefined || now - lastNotifiedAt > windowMs;
}
