import { registerCommands } from '@swampratnz/agent-base/commands/registry.js';
import { COMMUNITY_COMMANDS } from '../../src/module/commands.js';

/** The manifest's `commands` registration (src/module/agentModule.ts), for tests. */
registerCommands(COMMUNITY_COMMANDS);
