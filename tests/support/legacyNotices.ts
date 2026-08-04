import './registerNotices.js';
import { notice } from '@swampratnz/agent-base/strings/catalogue.js';

/**
 * The member-facing notice constants agent-base deleted in the package flip,
 * re-derived here for the tests that pin them.
 *
 * Base used to export a `X`/`X_MI`/`X_PLAIN` family beside each notice
 * (`pauseNotice.ts`'s `PAUSE_NOTICE_TEXT*`, `router.ts`'s `GATED_NOTICE*`,
 * `agent/core.ts`'s `INTERNAL_ERROR_REPLY*`, `moderation/moderator.ts`'s
 * `warnDmText*`, …). Every one of them named THIS community's two axis values
 * — `'mi'` and `'plain'` — in framework code, and each rendered its text at
 * MODULE SCOPE, which made importing a base module throw unless a pack had
 * already been registered. Neither survives a package whose entry point is
 * `createAgent`, so base now calls `notice(id, { language, style })` at the
 * call site with the caller's raw preferences.
 *
 * The VALUES are unchanged: same catalogue entries, same selection, same
 * community pack. So the ~30 suites that assert "the reply is byte-identical
 * to the constant" keep asserting exactly what they did before — they just
 * import the constant from here instead of from a base module that no longer
 * defines it. Do NOT add new entries: new assertions should call `notice()`
 * directly, the way the code does.
 */

const mi = { language: 'mi' } as const;
const plain = { style: 'plain' } as const;

// --- pauseNotice.ts / rateLimitNotice.ts / dailyBudgetNotice.ts ------------
export const PAUSE_NOTICE_TEXT = notice('pauseNotice');
export const PAUSE_NOTICE_TEXT_MI = notice('pauseNotice', mi);
export const PAUSE_NOTICE_TEXT_PLAIN = notice('pauseNotice', plain);

export const RATE_LIMIT_NOTICE_TEXT = notice('rateLimitNotice');
export const RATE_LIMIT_NOTICE_TEXT_MI = notice('rateLimitNotice', mi);
export const RATE_LIMIT_NOTICE_TEXT_PLAIN = notice('rateLimitNotice', plain);

export const DAILY_BUDGET_NOTICE_TEXT = notice('dailyBudgetNotice');
export const DAILY_BUDGET_NOTICE_TEXT_MI = notice('dailyBudgetNotice', mi);
export const DAILY_BUDGET_NOTICE_TEXT_PLAIN = notice('dailyBudgetNotice', plain);

export const DAILY_REPLY_BUDGET_WARNING_TEXT = notice('dailyReplyBudgetWarning');
export const DAILY_REPLY_BUDGET_WARNING_TEXT_MI = notice('dailyReplyBudgetWarning', mi);
export const DAILY_REPLY_BUDGET_WARNING_TEXT_PLAIN = notice('dailyReplyBudgetWarning', plain);

// --- voiceLanguageCaveatNotice.ts -----------------------------------------
export const VOICE_LANGUAGE_CAVEAT_TEXT = notice('voiceLanguageCaveat');
export const VOICE_LANGUAGE_CAVEAT_TEXT_MI = notice('voiceLanguageCaveat', mi);

// --- gatedNotice.ts / router.ts -------------------------------------------
export const GATED_NOTICE = notice('gatedNotice');
export const GATED_NOTICE_MI = notice('gatedNotice', mi);
export const GATED_NOTICE_PLAIN = notice('gatedNotice', plain);

// --- agent/core.ts fallbacks ----------------------------------------------
export const INTERNAL_ERROR_REPLY = notice('internalErrorReply');
export const INTERNAL_ERROR_REPLY_MI = notice('internalErrorReply', mi);
export const INTERNAL_ERROR_REPLY_PLAIN = notice('internalErrorReply', plain);

export const MAX_TURNS_REPLY = notice('maxTurnsReply');
export const MAX_TURNS_REPLY_MI = notice('maxTurnsReply', mi);
export const MAX_TURNS_REPLY_PLAIN = notice('maxTurnsReply', plain);

export const TURN_FAILED_REPLY = notice('turnFailedReply');
export const TURN_FAILED_REPLY_MI = notice('turnFailedReply', mi);
export const TURN_FAILED_REPLY_PLAIN = notice('turnFailedReply', plain);

// --- agent/upstreamFailure.ts ---------------------------------------------
export const USAGE_LIMIT_REPLY = notice('usageLimitReply');
export const USAGE_LIMIT_REPLY_MI = notice('usageLimitReply', mi);
export const USAGE_LIMIT_REPLY_PLAIN = notice('usageLimitReply', plain);
export const USAGE_LIMIT_REPLY_ADMIN_NOTIFIED = notice('usageLimitReplyAdminNotified');
export const USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_MI = notice('usageLimitReplyAdminNotified', mi);
export const USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_PLAIN = notice('usageLimitReplyAdminNotified', plain);

// --- router.ts CONFIRM/CANCEL surface -------------------------------------
export const CANCEL_TEXT = notice('cancelConfirm');
export const CANCEL_TEXT_MI = notice('cancelConfirm', mi);
export const CANCEL_TEXT_PLAIN = notice('cancelConfirm', plain);

export const PERMISSIONS_CHANGED_TEXT = notice('permissionsChanged');
export const PERMISSIONS_CHANGED_TEXT_MI = notice('permissionsChanged', mi);
export const PERMISSIONS_CHANGED_TEXT_PLAIN = notice('permissionsChanged', plain);

export const PENDING_NOTICE = notice('pendingNotice');
export const PENDING_NOTICE_MI = notice('pendingNotice', mi);
export const PENDING_NOTICE_PLAIN = notice('pendingNotice', plain);

export const FAILED_PREFIX_MI = notice('confirmFailedPrefix', mi);
export const DONE_PREFIX_MI = notice('confirmDonePrefix', mi);

// --- moderation/moderator.ts DM texts -------------------------------------
export const warnDmText = notice('warnDm');
export const warnDmTextMi = notice('warnDm', mi);
export const warnDmTextPlain = notice('warnDm', plain);

export const blockedDmText = notice('blockedDm');
export const blockedDmTextMi = notice('blockedDm', mi);
export const blockedDmTextPlain = notice('blockedDm', plain);
