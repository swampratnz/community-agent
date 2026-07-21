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

export const VOICE_LANGUAGE_CAVEAT_TEXT =
  'Heads up: voice notes are transcribed in English only right now, so the text I acted on may not match what you said.';

// Fixed, human-authored te reo Māori variant (issue #655), served instead of
// VOICE_LANGUAGE_CAVEAT_TEXT to a sender with a standing 'mi' language_prefs
// row (getLanguagePreference, issue #189) — same trust level as the English
// constant: no model call, no translation, no injection surface.
export const VOICE_LANGUAGE_CAVEAT_TEXT_MI =
  'He mihi whakamōhio: ko te reo Ingarihi anake e whakamāoritia ana ngā karere reo i tēnei wā, nā reira tērā pea kāore te kupu i mahia e au e rite tonu ana ki tāu i kī ai.';

export function shouldNotify(lastNotifiedAt: number | undefined, now: number, windowMs: number): boolean {
  return lastNotifiedAt === undefined || now - lastNotifiedAt > windowMs;
}
