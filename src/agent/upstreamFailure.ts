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
import { notice } from '../strings/catalogue.js';

const USAGE_LIMIT_PATTERNS = [/rate.?limit/i, /usage limit/i, /\b429\b/, /overloaded_error/i, /\bquota\b/i];

export function isUsageLimitFailure(message: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

// The reply text lives in the strings catalogue (agent-base plan item 6);
// these consts are derived so every existing import site and pinned test
// value stays byte-identical.
export const USAGE_LIMIT_REPLY = notice('usageLimitReply');

export const USAGE_LIMIT_REPLY_ADMIN_NOTIFIED = notice('usageLimitReplyAdminNotified');

// Fixed, human-authored te reo Māori variants (issue #396), served instead of
// the English constants above to a caller with a standing 'mi' language_prefs
// row (getLanguagePreference, issue #189) — same trust level as the English
// constants: no model call, no translation, no injection surface. Mirrors the
// `_MI`-variant pattern established by #266/#300/#331/#363.
export const USAGE_LIMIT_REPLY_MI = notice('usageLimitReply', { language: 'mi' });

export const USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_MI = notice('usageLimitReplyAdminNotified', {
  language: 'mi',
});

// Fixed, human-authored plain-language variants (issue #430) of the two
// constants above, served instead to a caller with a standing 'plain'
// response-style preference (getResponseStyle, issue #126) whose language
// preference is NOT 'mi' — 'mi' takes precedence over 'plain' (see
// core.ts's FALLBACK_REPLY_PLAIN). Same trust level as the English
// constants: no model call, no translation, no injection surface.
export const USAGE_LIMIT_REPLY_PLAIN = notice('usageLimitReply', { style: 'plain' });

export const USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_PLAIN = notice('usageLimitReplyAdminNotified', {
  style: 'plain',
});

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
