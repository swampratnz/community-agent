/**
 * Push-side complement to #444's pull-only `my_data` budget figure (issue
 * #511): a fixed, short line appended to a real agent reply once a
 * non-super-admin caller's remaining daily replies fall to
 * DAILY_REPLY_BUDGET_WARN_REMAINING or fewer — so the cutoff itself isn't the
 * first sign a limit exists. Mirrors dailyBudgetNotice.ts's per-notice-file
 * convention and PENDING_NOTICE's "translate the shell, interpolate the
 * dynamic value unchanged" shape (issue #405): `remaining` is a router-
 * computed integer, never member text, so it carries no injection surface.
 */

import { notice } from './strings/catalogue.js';

// The template itself lives in the strings catalogue (agent-base plan item
// 6); these consts are derived so every existing import site and pinned test
// value stays byte-identical.
export const DAILY_REPLY_BUDGET_WARNING_TEXT = notice('dailyReplyBudgetWarning');

// Fixed, human-authored te reo Māori variant (issue #300's precedent), served
// instead of DAILY_REPLY_BUDGET_WARNING_TEXT to a caller with a standing 'mi'
// language_prefs row — same trust level as the English variant: no model
// call, no translation, no injection surface beyond the interpolated integer.
export const DAILY_REPLY_BUDGET_WARNING_TEXT_MI = notice('dailyReplyBudgetWarning', {
  language: 'mi',
});

// Fixed, human-authored plain-language variant (issue #430's precedent),
// served instead of DAILY_REPLY_BUDGET_WARNING_TEXT to a caller with a
// standing 'plain' response-style preference whose language preference is
// NOT 'mi' — 'mi' takes precedence over 'plain', matching every other
// notice pair in this codebase (the precedence itself now lives in
// strings/catalogue.ts).
export const DAILY_REPLY_BUDGET_WARNING_TEXT_PLAIN = notice('dailyReplyBudgetWarning', {
  style: 'plain',
});
