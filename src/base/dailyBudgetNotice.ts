/**
 * Static text for the daily reply-budget notice (previously an un-hoisted
 * inline literal in router.ts). Mirrors pauseNotice.ts/rateLimitNotice.ts's
 * per-notice-file convention, but carries no debounce helper of its own —
 * router.ts already tracks the 24h budgetNotified window inline.
 */

import { notice } from './strings/catalogue.js';

// The text itself lives in the strings catalogue (agent-base plan item 6);
// these consts are derived so every existing import site and pinned test
// value stays byte-identical.
export const DAILY_BUDGET_NOTICE_TEXT = notice('dailyBudgetNotice');

// Fixed, human-authored te reo Māori variant (issue #300), served instead of
// DAILY_BUDGET_NOTICE_TEXT to a caller with a standing 'mi' language_prefs
// row (getLanguagePreference, issue #189) — same trust level as the English
// constant: no model call, no translation, no injection surface.
export const DAILY_BUDGET_NOTICE_TEXT_MI = notice('dailyBudgetNotice', { language: 'mi' });

// Fixed, human-authored plain-language variant (issue #430), served instead
// of DAILY_BUDGET_NOTICE_TEXT to a caller with a standing 'plain'
// response-style preference (getResponseStyle, issue #126) whose language
// preference is NOT 'mi' — 'mi' takes precedence over 'plain' (see
// strings/catalogue.ts, which now owns that precedence). Same trust level as
// the English constant: no model call, no translation, no injection surface.
export const DAILY_BUDGET_NOTICE_TEXT_PLAIN = notice('dailyBudgetNotice', { style: 'plain' });
