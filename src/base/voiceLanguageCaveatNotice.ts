/**
 * Static caveat DM sent to a WhatsApp voice-note sender whose stored language
 * preference is 'mi' (issue #655): `WHATSAPP_VOICE_MODEL` is English-only
 * (docs/SECURITY.md, docs/ARCHITECTURE.md), so their transcript may be
 * garbled with zero other signal that anything went wrong. Mirrors
 * rateLimitNotice.ts's exact convention: a fixed English string plus a fixed,
 * human-authored `_MI` variant — no model call, no translation, no injection
 * surface, since neither is ever built from the transcript or any runtime
 * input.
 */

import { notice } from './strings/catalogue.js';

// The text itself lives in the strings catalogue (agent-base plan item 6);
// these consts are derived so every existing import site and pinned test
// value stays byte-identical.
export const VOICE_LANGUAGE_CAVEAT_TEXT = notice('voiceLanguageCaveat');

// Fixed, human-authored te reo Māori variant (issue #655), served instead of
// VOICE_LANGUAGE_CAVEAT_TEXT to a sender with a standing 'mi' language_prefs
// row (getLanguagePreference, issue #189) — same trust level as the English
// constant: no model call, no translation, no injection surface.
export const VOICE_LANGUAGE_CAVEAT_TEXT_MI = notice('voiceLanguageCaveat', { language: 'mi' });

export { shouldNotifyAfterWindow as shouldNotify } from './util/noticeDebounce.js';
