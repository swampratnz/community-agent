/**
 * Classifies a thrown `query()` error (or non-success result) as an upstream
 * Claude usage-limit/overload condition, distinct from a random internal
 * failure — see issue #131. Pure and dependency-free so it's unit-testable
 * without mocking the SDK.
 *
 * The match set is intentionally small and anchored: it only inspects the
 * *thrown error's own message* (SDK/CLI-produced, never user-supplied text),
 * and the reply/DM text is always a fixed string — the raw error is never
 * echoed, matching the "never surface the raw internal transcript" invariant
 * this shares with core.ts's non-success branch.
 */
const USAGE_LIMIT_PATTERNS = [/rate.?limit/i, /usage limit/i, /\b429\b/, /overloaded_error/i, /\bquota\b/i];

export function isUsageLimitFailure(message: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

export const USAGE_LIMIT_REPLY =
  "Sorry — I'm temporarily unable to answer because this bot has hit its shared usage limit. " +
  "This isn't a bug — please try again later.";

export const USAGE_LIMIT_REPLY_ADMIN_NOTIFIED = `${USAGE_LIMIT_REPLY} An admin has been notified.`;

export interface UsageLimitTracker {
  alerted: boolean;
}

export function initialUsageLimitTracker(): UsageLimitTracker {
  return { alerted: false };
}

/**
 * Pure debounce, mirroring usageAlert.ts's stepUsageAlertTracker: one DM per
 * ongoing window of usage-limit failures, no repeat while it's still
 * happening, and a silent re-arm the next time a turn does NOT classify as a
 * usage-limit failure (recovery) — so a sustained outage produces exactly
 * one admin DM, not one per failed turn.
 */
export function stepUsageLimitTracker(
  tracker: UsageLimitTracker,
  failedOnUsageLimit: boolean,
): { tracker: UsageLimitTracker; shouldAlert: boolean } {
  if (!failedOnUsageLimit) {
    return { tracker: { alerted: false }, shouldAlert: false };
  }
  return { tracker: { alerted: true }, shouldAlert: !tracker.alerted };
}
