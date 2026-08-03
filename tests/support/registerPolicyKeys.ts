import { registerPolicyKeys } from '@swampratnz/agent-base/storage/policyStore.js';
import { COMMUNITY_POLICY_KEYS } from '../../src/module/storage/policies.js';

/** The manifest's `policyKeys` registration (src/module/agentModule.ts), for tests. */
registerPolicyKeys({ ...COMMUNITY_POLICY_KEYS });
