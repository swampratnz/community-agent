/**
 * Daily-reply-budget check-failure alert: the shared
 * `shouldNotifyAfterWindow` debounce (util/noticeDebounce.ts) under a domain
 * name. Unlike the rate-limit/pause notices this gates a single process-wide
 * super-admin DM rather than a per-user member notice — a countRepliesToUser
 * failure is a systemic DB/infra condition, not a per-user event (issue #203).
 */

export { shouldNotifyAfterWindow as shouldNotifyBudgetCheckFailed } from './util/noticeDebounce.js';
