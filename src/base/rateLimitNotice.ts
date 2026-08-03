/**
 * Per-user rate-limit notice: text constants plus the shared
 * `shouldNotifyAfterWindow` debounce (util/noticeDebounce.ts) under a
 * domain name, debounced against the rate-limit window so a burst of
 * over-limit messages produces exactly one notice per episode.
 */

import { notice } from './strings/catalogue.js';

// The text itself lives in the strings catalogue (agent-base plan item 6);
// these consts are derived so every existing import site and pinned test
// value stays byte-identical.
export const RATE_LIMIT_NOTICE_TEXT = notice('rateLimitNotice');

// Fixed, human-authored te reo Māori variant (issue #300), served instead of
// RATE_LIMIT_NOTICE_TEXT to a caller with a standing 'mi' language_prefs row
// (getLanguagePreference, issue #189) — same trust level as the English
// constant: no model call, no translation, no injection surface.
export const RATE_LIMIT_NOTICE_TEXT_MI = notice('rateLimitNotice', { language: 'mi' });

// Fixed, human-authored plain-language variant (issue #430), served instead
// of RATE_LIMIT_NOTICE_TEXT to a caller with a standing 'plain' response-style
// preference (getResponseStyle, issue #126) whose language preference is
// NOT 'mi' — 'mi' takes precedence over 'plain' (see strings/catalogue.ts,
// which now owns that precedence). Same trust level as the English constant:
// no model call, no translation, no injection surface.
export const RATE_LIMIT_NOTICE_TEXT_PLAIN = notice('rateLimitNotice', { style: 'plain' });

export { shouldNotifyAfterWindow as shouldNotifyRateLimited } from './util/noticeDebounce.js';
