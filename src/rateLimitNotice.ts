/**
 * Pure debounce for the per-user rate-limit notice. Mirrors router.ts's
 * inline budgetNotified check (router.ts:180-181), but debounced against
 * the rate-limit window instead of the 24h budget window, so a burst of
 * over-limit messages produces exactly one notice per episode.
 */

export const RATE_LIMIT_NOTICE_TEXT =
  "You're sending messages a bit fast — please wait a moment and try again.";

export function shouldNotifyRateLimited(
  lastNotifiedAt: number | undefined,
  now: number,
  windowMs: number,
): boolean {
  return lastNotifiedAt === undefined || now - lastNotifiedAt > windowMs;
}
