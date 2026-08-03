import { registerToolTiers } from '@swampratnz/agent-base/auth/rbac.js';
import { registerToolServerParts } from '@swampratnz/agent-base/agent/toolServer.js';
import { registerFlaggedToolPredicates } from '@swampratnz/agent-base/agent/featureFlags.js';
import {
  COMMUNITY_FLAGGED_TOOL_PREDICATES,
  COMMUNITY_TOOL_SERVER_PARTS,
  COMMUNITY_TOOL_TIERS,
} from '../../src/module/agent/tools/index.js';

/**
 * The manifest's three tool-surface registrations (src/module/agentModule.ts),
 * for tests: tier lists, tool-server parts and feature-flag predicates. They
 * always move together — all three are derived from the same `TOOL_REGISTRY`.
 */
registerToolTiers(COMMUNITY_TOOL_TIERS);
registerToolServerParts(COMMUNITY_TOOL_SERVER_PARTS);
registerFlaggedToolPredicates(COMMUNITY_FLAGGED_TOOL_PREDICATES);
