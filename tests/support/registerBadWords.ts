import { registerDefaultBadWords } from '@swampratnz/agent-base/moderation/wordlist.js';
import { DEFAULT_BAD_WORDS } from '../../src/module/moderation/badWords.js';

/** The manifest's `defaultBadWords` registration (src/module/agentModule.ts), for tests. */
registerDefaultBadWords(DEFAULT_BAD_WORDS);
