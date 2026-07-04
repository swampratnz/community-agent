// Stage 1 bad-language detection: a zero-cost, case-insensitive, whole-word
// match against a curated term list. Runs on EVERY scanned message when
// moderation is enabled. Operators extend the defaults via MODERATION_BAD_WORDS
// (config.moderation.badWords); community-specific slurs are best added there
// rather than shipped verbatim in source.

/**
 * A deliberately small default set of common profanity so the feature has a
 * sane out-of-the-box floor. It is NOT comprehensive and does not attempt to
 * catch obfuscation/leetspeak — real deployments should tune
 * MODERATION_BAD_WORDS to their community's standards.
 */
export const DEFAULT_BAD_WORDS: readonly string[] = [
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'cunt',
  'dickhead',
  'motherfucker',
];

export interface Detection {
  /** Short label for the warning ("bad language (...)", "abuse (...)"). */
  reason: string;
  /** Capped snippet of the offending message, for admin context only. */
  excerpt: string;
}

const MAX_EXCERPT = 200;

/** A short, whitespace-collapsed, capped snippet of the offending message. */
export function excerptOf(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > MAX_EXCERPT ? `${trimmed.slice(0, MAX_EXCERPT)}…` : trimmed;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a whole-word, case-insensitive matcher over the built-in defaults
 * merged with any operator-supplied terms. Returns a Detection for the first
 * matched term, or null when clean. `\b` word boundaries mean "class" does not
 * trip "ass" and "assistant" does not trip a slur substring.
 */
export function makeWordlistDetector(extraTerms: string[] = []): (text: string) => Detection | null {
  const terms = Array.from(
    new Set([...DEFAULT_BAD_WORDS, ...extraTerms].map((t) => t.trim().toLowerCase()).filter(Boolean)),
  );
  if (terms.length === 0) return () => null;
  const pattern = new RegExp(`\\b(${terms.map(escapeRegExp).join('|')})\\b`, 'i');
  return (text: string) => {
    const match = pattern.exec(text);
    if (!match) return null;
    return { reason: `bad language ("${match[1].toLowerCase()}")`, excerpt: excerptOf(text) };
  };
}
