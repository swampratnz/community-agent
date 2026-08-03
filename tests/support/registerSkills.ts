import { registerSkillsManifest } from '@swampratnz/agent-base/agent/skillsManifest.js';
import { COMMUNITY_SKILLS } from '../../src/module/agent/enabledSkills.js';

/** The manifest's `skills` registration (src/module/agentModule.ts), for tests. */
registerSkillsManifest(COMMUNITY_SKILLS);
