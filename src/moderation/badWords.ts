import { registerDefaultBadWords } from './wordlist.js';

/**
 * The community-owned default bad-word list, registered into the base
 * wordlist mechanism (`wordlist.ts`) at this module's import time — the same
 * seam the file already documented for operators, who extend these defaults
 * via MODERATION_BAD_WORDS (config.moderation.badWords). What counts as
 * unacceptable language is a community standard, so the terms live here and
 * the matcher lives in base.
 *
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

registerDefaultBadWords(DEFAULT_BAD_WORDS);
