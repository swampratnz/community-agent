/**
 * Pure debounce for the muted-role permission-overwrite retry-exhaustion
 * alert. Mirrors budgetCheckFailureNotice.ts's shouldNotifyBudgetCheckFailed
 * exactly, but this one gates a single process-wide super-admin DM for the
 * Discord adapter's `applyMutedRoleOverwrite` retry-exhaustion path — a
 * transient-Discord-API failure is a systemic condition, not a per-channel
 * event (issue #276).
 */

export function shouldNotifyMutedRoleOverwriteFailed(
  lastNotifiedAt: number | undefined,
  now: number,
  windowMs: number,
): boolean {
  return lastNotifiedAt === undefined || now - lastNotifiedAt > windowMs;
}
