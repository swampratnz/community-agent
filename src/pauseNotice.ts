/**
 * Pure debounce for the pause notice (issue #128). Mirrors
 * rateLimitNotice.ts's shape exactly, but debounced against a longer window:
 * a pause_bot is typically longer-lived than a rate-limit burst, so
 * re-notifying on every addressed message would be noisy — once per window
 * is enough to reassure a member the bot isn't broken.
 */

export const PAUSE_NOTICE_TEXT = 'The assistant is temporarily paused — please try again later.';

export function shouldNotifyPaused(
  lastNotifiedAt: number | undefined,
  now: number,
  windowMs: number,
): boolean {
  return lastNotifiedAt === undefined || now - lastNotifiedAt > windowMs;
}
