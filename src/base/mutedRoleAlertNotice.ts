/**
 * Muted-role permission-overwrite retry-exhaustion alert: the shared
 * `shouldNotifyAfterWindow` debounce (util/noticeDebounce.ts) under a domain
 * name, gating a single process-wide super-admin DM for the Discord adapter's
 * `applyMutedRoleOverwrite` retry-exhaustion path — a transient-Discord-API
 * failure is a systemic condition, not a per-channel event (issue #276).
 */

export { shouldNotifyAfterWindow as shouldNotifyMutedRoleOverwriteFailed } from './util/noticeDebounce.js';
