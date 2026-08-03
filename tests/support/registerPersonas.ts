import { registerPersona } from '@swampratnz/agent-base/agent/personaRegistry.js';
import { COMMUNITY_PERSONAS } from '../../src/module/agent/personas.js';

/** The manifest's `personas` registration (src/module/agentModule.ts), for tests. */
for (const entry of COMMUNITY_PERSONAS) registerPersona(entry.persona, { isDefault: entry.isDefault });
