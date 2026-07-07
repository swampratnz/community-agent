/**
 * Pure debounce for the daily-reply-budget check-failure alert. Mirrors
 * rateLimitNotice.ts's shouldNotifyRateLimited exactly, but this one gates a
 * single process-wide super-admin DM rather than a per-user member notice —
 * a countRepliesToUser failure is a systemic DB/infra condition, not a
 * per-user event (issue #203).
 */

export function shouldNotifyBudgetCheckFailed(
  lastNotifiedAt: number | undefined,
  now: number,
  windowMs: number,
): boolean {
  return lastNotifiedAt === undefined || now - lastNotifiedAt > windowMs;
}
