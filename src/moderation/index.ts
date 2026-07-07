import { config } from '../config.js';
import { atLeast } from '../auth/rbac.js';
import { resolveRole } from '../auth/roles.js';
import { addWarning, countActiveWarnings } from '../storage/repository.js';
import { makeClassifier, Moderator, type ModerationEnforcer } from './moderator.js';

/**
 * Build the production Moderator from config, wiring the given platform
 * enforcer. Admins and super admins are exempt (never warned or muted), decided
 * by the same role resolution the router uses.
 */
export function createModerator(enforcer: ModerationEnforcer): Moderator {
  return new Moderator({
    enabled: config.moderation.enabled,
    strikeLimit: config.moderation.strikeLimit,
    strikeWindowDays: config.moderation.strikeWindowDays,
    classify: makeClassifier({
      badWords: config.moderation.badWords,
      llmAbuseEnabled: config.moderation.llmAbuseEnabled,
    }),
    isExempt: async (platform, userId) => atLeast(await resolveRole(platform, userId), 'admin'),
    store: { addWarning, countActiveWarnings },
    enforcer,
  });
}

export { Moderator } from './moderator.js';
export type { ModerationEnforcer, ScanContext } from './moderator.js';
