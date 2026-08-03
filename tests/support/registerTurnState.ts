import { registerTurnStateFinalizer } from '@swampratnz/agent-base/agent/turnState.js';
import { COMMUNITY_TURN_STATE_FINALIZER } from '../../src/module/agent/communityTurnState.js';

/** The manifest's `turnStateFinalizers` registration (src/module/agentModule.ts), for tests. */
registerTurnStateFinalizer(COMMUNITY_TURN_STATE_FINALIZER);
