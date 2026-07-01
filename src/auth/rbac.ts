import type { Platform, Role } from '../platforms/types.js';

/**
 * Role-based access control.
 *
 * Role is resolved from platform-native identity at the adapter boundary and
 * carried on every IncomingMessage. The agent core uses {@link toolsForRole}
 * to decide which tools an LLM turn is even *allowed* to call, so a normal
 * user's request can never reach a privileged tool — RBAC is enforced in the
 * tool surface, not just the prompt.
 */

/** Tool names (mcp__server__tool) available to everyone. */
export const USER_TOOLS = [
  'mcp__community__remember_search',
  'mcp__community__knowledge_search',
  'mcp__community__community_info',
] as const;

/** Additional tools available only to admins. */
export const ADMIN_TOOLS = [
  'mcp__community__moderate',
  'mcp__community__announce',
  'mcp__community__save_knowledge',
  'mcp__community__user_history',
] as const;

export function toolsForRole(role: Role): string[] {
  return role === 'admin' ? [...USER_TOOLS, ...ADMIN_TOOLS] : [...USER_TOOLS];
}

/** Discord role resolution from configured admin role/user ids. */
export function resolveDiscordRole(
  userId: string,
  memberRoleIds: readonly string[],
  cfg: { adminRoleIds: readonly string[]; adminUserIds: readonly string[] },
): Role {
  if (cfg.adminUserIds.includes(userId)) return 'admin';
  if (memberRoleIds.some((rid) => cfg.adminRoleIds.includes(rid))) return 'admin';
  return 'user';
}

/** WhatsApp role resolution from configured admin numbers (E.164, no +). */
export function resolveWhatsappRole(number: string, adminNumbers: readonly string[]): Role {
  return adminNumbers.includes(number) ? 'admin' : 'user';
}

/** Defensive double-check used inside admin tools before any side effect. */
export function assertAdmin(role: Role, action: string): void {
  if (role !== 'admin') {
    throw new Error(`Permission denied: "${action}" requires admin and caller is "${role}".`);
  }
}

export interface CallerContext {
  platform: Platform;
  userId: string;
  userName: string;
  role: Role;
  conversationId: string;
}
