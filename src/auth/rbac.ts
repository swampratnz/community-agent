import type { Platform } from '../platforms/types.js';

/**
 * Role-based access control — three managed tiers plus 'guest'.
 *
 *   super_admin  env-bootstrapped only (SUPER_ADMIN_*); full access, both
 *                platforms, all conversations. Never grantable via chat.
 *   admin        granted by a super admin; privileged tools scoped to
 *                conversations the admin actually participates in.
 *   member       granted by an admin/super admin; standard tools.
 *   guest        unknown user. In gated mode guests get no agent access.
 *
 * Enforcement is layered: the tool list attached to an LLM turn is computed
 * from the caller's tier (structural — lower tiers never see higher tools);
 * each privileged tool re-asserts the tier; data scoping is applied in SQL
 * against the caller's real conversation membership; destructive actions
 * additionally require an out-of-band CONFIRM from the caller (see
 * agent/pendingActions.ts). Roles come from env/DB only — never chat text.
 */

export type { Tier } from '../platforms/types.js';
import type { Tier } from '../platforms/types.js';

const TIER_ORDER: Record<Tier, number> = {
  guest: 0,
  member: 1,
  admin: 2,
  super_admin: 3,
};

export function atLeast(role: Tier, min: Tier): boolean {
  return TIER_ORDER[role] >= TIER_ORDER[min];
}

/** Defensive double-check used inside privileged tools before any side effect. */
export function assertAtLeast(role: Tier, min: Tier, action: string): void {
  if (!atLeast(role, min)) {
    throw new Error(`Permission denied: "${action}" requires ${min} and caller is "${role}".`);
  }
}

/** Tools (mcp__community__*) available to members (and guests in open mode). */
export const MEMBER_TOOLS = [
  'mcp__community__community_info',
  'mcp__community__knowledge_search',
  'mcp__community__remember_search',
  'mcp__community__forget_me',
] as const;

/** Additional tools for admins — data access scoped to their conversations. */
export const ADMIN_TOOLS = [
  'mcp__community__user_history',
  'mcp__community__moderate',
  'mcp__community__announce',
  'mcp__community__save_knowledge',
  'mcp__community__list_knowledge',
  'mcp__community__update_knowledge',
  'mcp__community__delete_knowledge',
  'mcp__community__add_member',
  'mcp__community__remove_member',
] as const;

/** Additional tools for super admins only. */
export const SUPER_ADMIN_TOOLS = [
  'mcp__community__grant_admin',
  'mcp__community__revoke_admin',
  'mcp__community__purge_user_data',
  'mcp__community__audit_view',
  'mcp__community__usage_stats',
  'mcp__community__pause_bot',
  'mcp__community__resume_bot',
  'mcp__community__set_policy',
] as const;

export function toolsForRole(role: Tier): string[] {
  switch (role) {
    case 'super_admin':
      return [...MEMBER_TOOLS, ...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS];
    case 'admin':
      return [...MEMBER_TOOLS, ...ADMIN_TOOLS];
    default:
      // Guests only ever reach the agent in open mode; same surface as member.
      return [...MEMBER_TOOLS];
  }
}

export interface CallerContext {
  platform: Platform;
  userId: string;
  userName: string;
  role: Tier;
  conversationId: string;
}
