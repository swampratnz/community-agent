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
  // Read-only, no arguments; returns the admin-set guidelines text verbatim,
  // or a clear not-set-yet message (issue #212).
  'mcp__community__community_guidelines',
  // Read-only, no arguments, reveals nothing about this community — only
  // Anthropic's own public status page (issue #206) — so it's reachable by
  // guests in open mode too, same tier as community_info/knowledge_search.
  'mcp__community__check_status',
  'mcp__community__knowledge_search',
  // Read-only, no arguments — titles-only browse of the knowledge base, the
  // proactive "what's covered" counterpart to knowledge_search's reactive
  // search (issue #437). Reuses knowledge_search's exact scope predicate and
  // additionally excludes 'auto'-provenance entries (issue #214 boundary).
  'mcp__community__list_knowledge_topics',
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
  // see list_member_warnings) and never another member's warnings.
  'mcp__community__my_warnings',
  // Self-scoped, read-only summary of what's stored about the caller —
  // counts mirroring exactly what forget_me/purge_user_data would delete,
  // scoped the same way (own identity + linked identities). Never queries
  // member_notes (issue #45: no member self-access to notes about
  // themselves) or any other admin-only table.
  'mcp__community__my_data',
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
  // Same self-service shape as set_response_style, closed enum — no CONFIRM
  // gate (issue #189).
  'mcp__community__set_language_preference',
  // Time-windowed recap of the caller's OWN current conversation (issue
  // #167) — always scoped to caller.platform/caller.conversationId, never a
  // model-supplied id; same conversation-scope discipline as
  // remember_search's default scope.
  'mcp__community__catch_up',
  // Lightweight emoji acknowledgement (issue #231): closed positive/neutral
  // allowlist only, and only on a message the bot has actually seen in this
  // conversation — same "validate targets" discipline as moderate/announce,
  // just scoped to the caller's own conversation rather than an admin's set.
  // Discord-only; other adapters simply don't implement
  // PlatformAdapter.reactToMessage.
  'mcp__community__react_to_message',
  // Read-only, no arguments, no CONFIRM (issue #388) — the read counterpart
  // to the admin-tier, CONFIRM-gated create_event (issue #230). Publicly
  // visible via Discord's own Events tab the moment create_event runs, so
  // there's no confidentiality boundary to gate at admin tier, same
  // reasoning as community_guidelines/check_status. Discord-only; other
  // adapters simply don't implement PlatformAdapter.listUpcomingEvents.
  'mcp__community__list_events',
] as const;

/** Additional tools for admins — data access scoped to their conversations. */
export const ADMIN_TOOLS = [
  'mcp__community__whats_new',
  'mcp__community__generate_image',
  'mcp__community__user_history',
  'mcp__community__moderate',
  'mcp__community__clear_warnings',
  // Per-member, reason/excerpt-included warning history (auto + admin
  // strikes) — the read moderation_history structurally can't provide, since
  // it reads only admin_audit, never member_warnings (issue #410). Same
  // (platform, userId)-only scope as clear_warnings, not conversation-scoped.
  'mcp__community__list_member_warnings',
  'mcp__community__announce',
  'mcp__community__create_poll',
  // End a running poll early — same admin tier / conversation-scope / audit as
  // create_poll (Discord's only supported poll mutation; polls are otherwise
  // immutable). Finalizes results, never deletes; not CONFIRM-gated (low
  // consequence, mirrors create_poll).
  'mcp__community__end_poll',
  // Discord-only thread management (issue #229) — create_thread additive/
  // rate-capped like create_poll, archive_thread CONFIRM-gated like moderate
  // (it hides an active discussion). See docs/SECURITY.md §11.
  'mcp__community__create_thread',
  'mcp__community__archive_thread',
  // Discord Scheduled Event creation (issue #230) — outward + member-
  // notifying (RSVP/reminders), so admin-tier + CONFIRM, a genuinely higher
  // floor than announce/create_poll. See docs/SECURITY.md.
  'mcp__community__create_event',
  // Symmetric destroy-adjacent counterpart to create_event (issue #424),
  // same pattern create_poll/end_poll and create_thread/archive_thread
  // already established: admin-tier + CONFIRM, marks the event Canceled
  // rather than deleting it. See docs/SECURITY.md.
  'mcp__community__cancel_event',
  // Content curation, same tier as save_knowledge — not super-admin like
  // set_policy, which is runtime bot control (issue #212).
  'mcp__community__set_community_guidelines',
  // Sibling of set_community_guidelines (issue #253): same admin/audited/no-
  // CONFIRM shape, configures the other half of the new-member welcome text.
  'mcp__community__set_welcome_message',
  'mcp__community__save_knowledge',
  'mcp__community__list_knowledge',
  'mcp__community__update_knowledge',
  'mcp__community__delete_knowledge',
  // Retroactive read-only audit (issue #316) for near-duplicate pairs that
  // save_knowledge's write-time nudge never caught — same tier as its
  // siblings, no CONFIRM (read-only, no mutation).
  'mcp__community__list_duplicate_knowledge',
  // Sibling of list_duplicate_knowledge (issue #330): same tier/read-only/no-
  // CONFIRM shape, but the opposite similarity band — flags entries that may
  // quietly disagree (mid-range similarity) rather than converged wording.
  'mcp__community__list_knowledge_conflicts',
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
  'mcp__community__list_knowledge_gaps',
  'mcp__community__moderation_history',
  'mcp__community__add_member',
  'mcp__community__remove_member',
  'mcp__community__link_member',
  'mcp__community__unlink_member',
  // Cosmetic Discord roles (issue #232) — strictly orthogonal to these
  // tiers; see docs/SECURITY.md for the assign-time permission re-check.
  'mcp__community__assign_community_role',
  'mcp__community__remove_community_role',
  'mcp__community__list_assignable_roles',
  'mcp__community__list_reports',
  'mcp__community__resolve_report',
  'mcp__community__list_answer_feedback',
  'mcp__community__list_low_rated_knowledge',
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
  'mcp__community__list_admins',
  'mcp__community__engagement_stats',
  'mcp__community__pause_bot',
  'mcp__community__resume_bot',
  'mcp__community__set_policy',
  'mcp__community__redeploy_bot',
  // Files a GitHub issue via the bot's fine-grained repo token — super-admin
  // only because it is the bot's one outward write credential (docs/SECURITY.md).
  'mcp__community__suggest_issue',
  // Drive the remote dev-team build service over the tailnet: dispatch a job
  // (assess/deliver — deliver is additionally CONFIRM-gated), check status,
  // fetch result. Super-admin only: it is outward-acting authority holding the
  // service's bearer credential, the same trust floor as suggest_issue/
  // redeploy_bot (docs/SECURITY.md).
  'mcp__community__dev_team_dispatch',
  'mcp__community__dev_team_status',
  'mcp__community__dev_team_result',
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
  /** True for a 1:1 DM (WhatsApp is always DM; Discord DM channel) — see issue #197. */
  isDirect: boolean;
  /** Platform-native id of the message that triggered this turn, when the platform exposes one (issue #231: react_to_message's default target). */
  messageId?: string;
}
