// Stage 1 bad-language detection: a zero-cost, case-insensitive, whole-word
// match against a curated term list. Runs on EVERY scanned message when
// moderation is enabled. The default terms are registered by the community
// list (src/module/moderation/badWords.ts); operators extend them via
// MODERATION_BAD_WORDS (config.moderation.badWords), and community-specific
// slurs are best added there rather than shipped verbatim in source.

/**
 * The default term list is community CONTENT, so it is REGISTERED here by
 * `src/module/moderation/badWords.ts` at that module's import time rather than
 * defined in this mechanism file (agent-base plan §3). Exactly once per
 * process; a second registration throws rather than swapping the floor after
 * boot, matching the tool-tier and prompt-section registries.
 */
let registeredDefaults: readonly string[] | null = null;

export function registerDefaultBadWords(terms: readonly string[]): void {
  if (registeredDefaults) {
    throw new Error(
      'default bad words already registered — the default term list cannot be swapped after boot',
    );
  }
  registeredDefaults = Object.freeze([...terms]);
}

/**
 * The registered defaults. FAILS LOUD rather than degrading to an empty
 * list: an unregistered read means the community module never loaded, and
 * silently matching nothing but the operator's extra terms would be a
 * moderation downgrade nobody sees. Import `moderation/badWords.js` (as
 * src/index.ts does) before building a detector.
 */
function defaultBadWords(): readonly string[] {
  if (!registeredDefaults) {
    throw new Error(
      'no default bad words registered — import the community list (src/module/moderation/badWords.js) before building a wordlist detector',
    );
  }
  return registeredDefaults;
}

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
    new Set([...defaultBadWords(), ...extraTerms].map((t) => t.trim().toLowerCase()).filter(Boolean)),
  );
  if (terms.length === 0) return () => null;
  const pattern = new RegExp(`\\b(${terms.map(escapeRegExp).join('|')})\\b`, 'i');
  return (text: string) => {
    const match = pattern.exec(text);
    if (!match) return null;
    return { reason: `bad language ("${match[1].toLowerCase()}")`, excerpt: excerptOf(text) };
  };
}
