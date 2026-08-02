/**
 * Pause notice (issue #128): text constants plus the shared
 * `shouldNotifyAfterWindow` debounce (util/noticeDebounce.ts) under a domain
 * name, debounced against a longer window than the rate-limit notice:
 * a pause_bot is typically longer-lived than a rate-limit burst, so
 * re-notifying on every addressed message would be noisy — once per window
 * is enough to reassure a member the bot isn't broken.
 */

import { notice } from './strings/notices.js';

// The text itself lives in the strings catalogue (agent-base plan item 6);
// these consts are derived so every existing import site and pinned test
// value stays byte-identical.
export const PAUSE_NOTICE_TEXT = notice('pauseNotice');

// Fixed, human-authored te reo Māori variant (issue #300), served instead of
// PAUSE_NOTICE_TEXT to a caller with a standing 'mi' language_prefs row
// (getLanguagePreference, issue #189) — same trust level as the English
// constant: no model call, no translation, no injection surface.
export const PAUSE_NOTICE_TEXT_MI = notice('pauseNotice', { language: 'mi' });

// Fixed, human-authored plain-language variant (issue #430), served instead
// of PAUSE_NOTICE_TEXT to a caller with a standing 'plain' response-style
// preference (getResponseStyle, issue #126) whose language preference is NOT
// 'mi' — 'mi' takes precedence over 'plain' (see strings/catalogue.ts, which
// now owns that precedence). Same trust level as the English constant: no
// model call, no translation, no injection surface.
export const PAUSE_NOTICE_TEXT_PLAIN = notice('pauseNotice', { style: 'plain' });

export { shouldNotifyAfterWindow as shouldNotifyPaused } from './util/noticeDebounce.js';
