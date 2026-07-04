/**
 * Deterministic classifier for pure acknowledgement replies ("thanks", "ok",
 * "👍") that carry no information for the agent to act on. Used by the
 * router to short-circuit the expensive agent turn (memory recall + a
 * `query()` subprocess against the shared Max pool, see ARCHITECTURE.md
 * "Known cost/latency characteristic") the same way `classifyConfirmReply`
 * short-circuits CONFIRM/CANCEL replies — a pure text classifier consulted
 * BEFORE the agent turn, never inside the model.
 *
 * Exact-match only, never substring/prefix: "thanks but that didn't work" and
 * "ok here's my question" must always reach the agent. A false positive here
 * just means one addressed message gets a canned reply instead of a real
 * answer, so the bar for matching is deliberately conservative.
 */

const ACK_TEXT_PHRASES = new Set([
  'thanks',
  'thank you',
  'thanks!',
  'ty',
  'tysm',
  'cheers',
  'ok',
  'okay',
  'kk',
  'cool',
  'sweet',
  'got it',
  'nice one',
]);

// Emoji-only acknowledgements. Variation selectors (U+FE0E/U+FE0F — the
// "text" vs "emoji" presentation of the same glyph, e.g. a heart sent as
// "❤" vs "❤️") are stripped before comparing so both forms of
// a listed glyph match. Skin-tone modifiers (U+1F3FB-U+1F3FF, e.g. a
// modified thumbs-up) are deliberately NOT stripped: a modified emoji is
// treated as distinct content and falls through to the agent rather than
// being silently normalised away. Multi-codepoint ZWJ sequences are never in
// this list, so they always fall through too.
const ACK_EMOJI = ['👍', '🙏', '❤️', '😂', '🎉'];

const VARIATION_SELECTORS = /[\uFE0E\uFE0F]/g;
const TRAILING_PUNCTUATION = /[!?.,;:]+$/;
const LEADING_MENTIONS = /^(@\S+\s+)+/;

function stripVariationSelectors(s: string): string {
  return s.replace(VARIATION_SELECTORS, '');
}

const ACK_EMOJI_NORMALISED = new Set(ACK_EMOJI.map(stripVariationSelectors));

export function isPureAcknowledgement(text: string): boolean {
  // Same mention-stripping as classifyConfirmReply, so "@6421… thanks" in a
  // WhatsApp group classifies the same as a bare "thanks".
  const stripped = text.trim().replace(LEADING_MENTIONS, '').trim();
  if (!stripped) return false;

  if (ACK_EMOJI_NORMALISED.has(stripVariationSelectors(stripped))) return true;

  const normalisedText = stripped.toLowerCase().replace(TRAILING_PUNCTUATION, '').trim();
  return ACK_TEXT_PHRASES.has(normalisedText);
}
