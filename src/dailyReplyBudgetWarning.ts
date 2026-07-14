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

export const DAILY_REPLY_BUDGET_WARNING_TEXT = (remaining: number) =>
  `\n\n(You have ${remaining} repl${remaining === 1 ? 'y' : 'ies'} left today.)`;

// Fixed, human-authored te reo Māori variant (issue #300's precedent), served
// instead of DAILY_REPLY_BUDGET_WARNING_TEXT to a caller with a standing 'mi'
// language_prefs row — same trust level as the English variant: no model
// call, no translation, no injection surface beyond the interpolated integer.
export const DAILY_REPLY_BUDGET_WARNING_TEXT_MI = (remaining: number) =>
  `\n\n(E ${remaining} ō whakautu e toe ana māu i tēnei rā.)`;

// Fixed, human-authored plain-language variant (issue #430's precedent),
// served instead of DAILY_REPLY_BUDGET_WARNING_TEXT to a caller with a
// standing 'plain' response-style preference whose language preference is
// NOT 'mi' — 'mi' takes precedence over 'plain', matching every other
// notice pair in this codebase.
export const DAILY_REPLY_BUDGET_WARNING_TEXT_PLAIN = (remaining: number) =>
  `\n\n(You have ${remaining} left today.)`;
