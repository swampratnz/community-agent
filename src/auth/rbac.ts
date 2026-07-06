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
  'mcp__community__report_content',
  // Reporter can retract their OWN report(s) — scoped in SQL to
  // reporter_user_id, so it can never touch anyone else's report.
  'mcp__community__withdraw_report',
  // Self-scoped read of the caller's OWN suggestions/reports (never the
  // shared queue, never another member's rows, never reviewer identity) —
  // the pull-based counterpart to the best-effort resolution DMs.
  'mcp__community__my_submissions',
  // Self-scoped read of the caller's OWN active warning count vs. the
  // configured limit — never a warning's reason/excerpt (admin-only context,
  // see moderation_history) and never another member's warnings.
  'mcp__community__my_warnings',
  // Write-only into the member's own queue (rate-capped); the shared-queue
  // read side (list_suggestions) is admin-tier — a member can never read
  // anyone else's suggestion, only their own via my_submissions.
  'mcp__community__suggest_improvement',
  // Write-only, boolean-only rating of the bot's own last answer to the
  // caller (rate-capped); the read side (list_answer_feedback) is
  // admin-tier — a member can never read the aggregate feedback queue.
  'mcp__community__rate_answer',
  // Self-service, non-destructive, instantly reversible — no CONFIRM gate.
  'mcp__community__set_response_style',
] as const;

/** Additional tools for admins — data access scoped to their conversations. */
export const ADMIN_TOOLS = [
  'mcp__community__whats_new',
  'mcp__community__generate_image',
  'mcp__community__user_history',
  'mcp__community__moderate',
  'mcp__community__clear_warnings',
  'mcp__community__announce',
  'mcp__community__save_knowledge',
  'mcp__community__list_knowledge',
  'mcp__community__update_knowledge',
  'mcp__community__delete_knowledge',
  'mcp__community__list_access_requests',
  'mcp__community__add_member_note',
  'mcp__community__list_member_notes',
  'mcp__community__delete_member_note',
  'mcp__community__list_roster',
  'mcp__community__list_context_digests',
  'mcp__community__list_knowledge_candidates',
  'mcp__community__accept_knowledge_candidate',
  'mcp__community__decline_knowledge_candidate',
  'mcp__community__question_digest',
  'mcp__community__moderation_history',
  'mcp__community__add_member',
  'mcp__community__remove_member',
  'mcp__community__link_member',
  'mcp__community__unlink_member',
  'mcp__community__list_reports',
  'mcp__community__resolve_report',
  'mcp__community__list_answer_feedback',
  'mcp__community__list_suggestions',
  'mcp__community__resolve_suggestion',
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
  'mcp__community__redeploy_bot',
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
