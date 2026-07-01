import { config } from '../config.js';
import { getMemberRole } from '../storage/repository.js';
import type { Platform } from '../platforms/types.js';
import type { Tier } from './rbac.js';

/**
 * Resolve a user's tier: env-bootstrapped super admins first, then the
 * community_users table, else guest. Identity comes from the platform
 * envelope only — never from message content.
 */
export async function resolveRole(platform: Platform, userId: string): Promise<Tier> {
  if (isSuperAdmin(platform, userId)) return 'super_admin';
  const stored = await getMemberRole(platform, userId);
  return stored ?? 'guest';
}

export function isSuperAdmin(platform: Platform, userId: string): boolean {
  return platform === 'discord'
    ? config.rbac.superAdminDiscordIds.includes(userId)
    : config.rbac.superAdminWhatsappNumbers.includes(userId);
}

/** All configured super-admin user ids for a platform (for alerting). */
export function superAdminIds(platform: Platform): readonly string[] {
  return platform === 'discord'
    ? config.rbac.superAdminDiscordIds
    : config.rbac.superAdminWhatsappNumbers;
}
