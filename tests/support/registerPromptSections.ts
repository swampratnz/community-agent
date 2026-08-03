import { registerPromptSections } from '@swampratnz/agent-base/agent/promptSpine.js';
import { COMMUNITY_PROMPT_SECTIONS } from '../../src/module/agent/communityPromptSections.js';

/** The manifest's `promptSections` registration (src/module/agentModule.ts), for tests. */
registerPromptSections(COMMUNITY_PROMPT_SECTIONS);
