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
 *
 * `toolsForRole` additionally drops platform-incompatible tools (Discord-only
 * tools, on WhatsApp) from the tier list itself; `buildQueryOptions`
 * (agent/core.ts) further drops feature-flagged tools whose config flag is
 * off (issue #535) — so a tool nothing can ever successfully call on this
 * deployment isn't even offered to the model, not merely refused at call
 * time.
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
  // Self-scoped read of the caller's OWN suggestions/reports/appeals and
  // suggest_knowledge tips (never the shared queue, never another member's
  // rows, never reviewer identity) — the pull-based counterpart to the
  // best-effort resolution DMs.
  'mcp__community__my_submissions',
  // Self-scoped read of the caller's OWN active warning count vs. the
  // configured limit — never a warning's reason/excerpt (admin-only context,
  // see list_member_warnings) and never another member's warnings.
  'mcp__community__my_warnings',
  // Self-scoped: asks admins to double-check the caller's OWN active
  // warning(s)/mute (issue #496) — refuses cleanly with no active warning,
  // so it can't become a generic side channel to message admins (that's
  // already what suggest_improvement is for). Resolves eligibility from
  // caller.platform/caller.userId only, exactly like my_warnings.
  'mcp__community__appeal_moderation',
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
  // Write-only into the SAME admin-reviewed candidate queue the offline
  // context builder feeds (issue #633) — digest_id NULL, rate-capped, dedup-
  // guarded against already-queued/reviewed topics and already-covered
  // knowledge. Nothing a member writes here can influence answers until an
  // admin's accept_knowledge_candidate call; the read/accept/decline side
  // stays admin-tier, same shape as suggest_improvement/list_suggestions.
  'mcp__community__suggest_knowledge',
  // Retract your OWN still-pending suggest_knowledge tip(s) (issue #895) —
  // scoped in SQL to source_platform/source_user_id, so it can never touch
  // another member's tip or a machine-drafted candidate, and never touches
  // an already-reviewed (accepted/declined) tip. Same shape as
  // withdraw_report for content_reports.
  'mcp__community__withdraw_knowledge_tip',
  // Write-only, boolean-only rating of the bot's own last answer to the
  // caller (rate-capped); the read side (list_answer_feedback) is
  // admin-tier — a member can never read the aggregate feedback queue.
  'mcp__community__rate_answer',
  // Zero-argument write; sets a turn-scoped flag only (rate-capped per
  // caller) — router.ts reads it back post-turn to direct-fire the same
  // admin escalation notifyAdmins path rate_answer's thumbs-down uses
  // (issue #808). Never a free-text field, so there is nothing here for a
  // model-composed admin-notification injection to ride.
  'mcp__community__request_human_help',
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
  // Implemented on Discord and both WhatsApp adapters (Baileys: issue #495,
  // Cloud: issue #528) — NOT platform-filtered, unlike list_events below.
  'mcp__community__react_to_message',
  // Read-only, no arguments, no CONFIRM (issue #388) — the read counterpart
  // to the admin-tier, CONFIRM-gated create_event (issue #230). Publicly
  // visible via Discord's own Events tab the moment create_event runs, so
  // there's no confidentiality boundary to gate at admin tier, same
  // reasoning as community_guidelines/check_status. Discord-only; other
  // adapters simply don't implement PlatformAdapter.listUpcomingEvents.
  'mcp__community__list_events',
  // Self-scoped write (one row per identity, upsert/clear semantics),
  // instantly reversible ('clear') like set_response_style — no CONFIRM gate.
  // Publishes to other members (issue #634), so unlike most other
  // self-service MEMBER_TOOLS it re-checks 'member' explicitly in the
  // handler to exclude open-mode guests, same discipline share_project below
  // uses. Only self-declared text is ever stored — never inferred from chat.
  'mcp__community__set_my_interests',
  // Read-only counterpart to set_my_interests — embedding-similarity search
  // over member_interests only, same 'member' floor check. A caller with no
  // published interests of their own can still search.
  'mcp__community__who_is_into',
  // Self-scoped write (rate-capped, own-project-only), instantly reversible
  // like set_response_style — no CONFIRM gate. Publishes to other members
  // (issue #646), so unlike most other self-service MEMBER_TOOLS it re-checks
  // 'member' explicitly in the handler to exclude open-mode guests.
  'mcp__community__share_project',
  // Read-only counterpart to share_project — most-recent or embedding-
  // similarity search over member_projects only, same 'member' floor check.
  'mcp__community__list_projects',
  // Opt-in "notify me to help" flag riding the caller's own member_interests
  // row (issue #729) — self-scoped, instantly reversible like
  // set_response_style, so no CONFIRM gate. Behind FIND_HELPER_ENABLED
  // (agent/core.ts FEATURE_FLAGGED_TOOL_GROUPS); listed here unconditionally
  // like every other MEMBER_TOOLS entry, same layering as
  // generate_image/suggest_issue/dev_team_* above.
  'mcp__community__set_helper_availability',
  // The active-side handoff itself (issue #729): matches the caller's topic
  // against opted-in helpers and sends at most one DM. Re-checks 'member' in
  // the handler like set_my_interests/share_project — this is the first
  // MEMBER_TOOLS write that DMs a DIFFERENT member as a side effect, so it's
  // rate-capped on both the requester and the notified-helper side (see
  // repository.ts FIND_HELPER_REQUESTER_DAILY_LIMIT /
  // FIND_HELPER_WEEKLY_LIMIT_PER_HELPER). Same FIND_HELPER_ENABLED gate as
  // set_helper_availability above.
  'mcp__community__find_helper',
  // The signal-to-action handoff for share_project's seekingCollaborators
  // flag (issue #840): looks up a project by id and sends its owner at most
  // one DM. Re-checks 'member' in the handler like share_project/find_helper
  // above, and is rate-capped on both the requester and the notified-owner
  // side (see repository.ts PROJECT_CONNECTION_REQUESTER_DAILY_LIMIT /
  // PROJECT_CONNECTION_OWNER_WEEKLY_LIMIT), same shape as find_helper. Unlike
  // find_helper this is not behind a feature flag — no new disclosure class,
  // and the DM is solicited (the owner explicitly opted this specific project
  // in via seekingCollaborators), a stronger consent basis than find_helper's
  // topic-match.
  'mcp__community__request_project_connection',
  // On-demand pull of the community-wide weekly member-digest snapshot
  // (issue #841) — the member-facing sibling of admin_digest (#499): same
  // buildMemberDigestContent gathering the scheduled MEMBER_DIGEST_ENABLED
  // push already computes, just available on request instead of waiting up
  // to a week. Re-checks 'member' explicitly in the handler to exclude
  // open-mode guests, same discipline set_my_interests/who_is_into use.
  'mcp__community__community_digest',
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
  // Enumerates currently-muted members by identity — the growth path #403
  // itself named and deferred (issue #487). Same admin-tier, non-
  // conversation-scoped boundary as clear_warnings/list_member_warnings;
  // never includes reason/excerpt.
  'mcp__community__list_muted_members',
  // Durable queue for appeal_moderation (issue #554): a member appealing
  // their own active warning(s)/mute is a self-scoped MEMBER_TOOLS write
  // (appeal_moderation); reviewing/resolving the filed appeal is admin-tier,
  // same guild-wide (not conversation-scoped) boundary as clear_warnings/
  // list_member_warnings — warnings/mutes carry no conversation to scope by.
  'mcp__community__list_appeals',
  'mcp__community__resolve_appeal',
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
  // Consolidates a detected duplicate/conflict pair into one entry (issue
  // #886) — same admin-tier + CONFIRM + audited shape as update_knowledge/
  // delete_knowledge, the two write tools it replaces the unlinked manual
  // two-call workaround with.
  'mcp__community__merge_knowledge',
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
  // On-demand pull of the caller's own weekly admin-digest snapshot (issue
  // #499) — same signals/scoping the ADMIN_DIGEST_ENABLED push already
  // computes, just available on request instead of waiting up to a week.
  'mcp__community__admin_digest',
  // Argument-less roll-up of the five review-queue tools' own counts (issue
  // #743) — access requests/suggestions/knowledge candidates are guild-wide
  // like their list_* tools; reports uses callerScope()+linked-identity
  // exclusion like list_reports; appeals uses caller.platform like
  // list_appeals. No new scoping decision, no new data exposure.
  'mcp__community__review_queue',
  // Time-to-first-answer aggregate (issue #877). Admin-tier and
  // callerScope()-scoped exactly like review_queue/question_digest above.
  // Registering the tool and asserting the tier INSIDE the handler is not
  // enough on its own: the per-turn surface is tier-derived from
  // toolsForRole(), and filterFeatureFlaggedTools only ever REMOVES entries —
  // so a tool missing from this list is never offered to the SDK for any
  // role, admin included, and is dead code in production (issue #877 review).
  'mcp__community__response_latency',
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
  // Clusters unhelpful-rating comments across BOTH grounded and ungrounded
  // answers by embedding similarity (issue #724) — the cross-cutting
  // complement list_low_rated_knowledge (per-entry, grounded-only) doesn't
  // provide, instrumenting the second half of VISION's answer-quality
  // north star.
  'mcp__community__list_unhelpful_themes',
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
  'mcp__community__admin_activity',
  'mcp__community__list_admins',
  'mcp__community__engagement_stats',
  // Read-only, no CONFIRM, no DB/model call — reflects the fixed
  // FEATURE_FLAG_MAP allowlist (issue #559) against the already-loaded
  // config object. Super-admin only: several flags are security-relevant
  // posture (e.g. moderation.llmAbuseEnabled), same least-privilege
  // reasoning as engagement_stats/admin_activity's own super-admin floor.
  'mcp__community__feature_flags',
  'mcp__community__pause_bot',
  'mcp__community__resume_bot',
  'mcp__community__set_policy',
  'mcp__community__redeploy_bot',
  // Files a GitHub issue via the bot's fine-grained repo token — super-admin
  // only because it is the bot's one outward write credential (docs/SECURITY.md).
  'mcp__community__suggest_issue',
  // Drive the remote dev-team build service over the tailnet: dispatch a job
  // (assess/deliver — deliver is additionally CONFIRM-gated), check status,
  // fetch result, turn a completed assessment into a tracked backlog, list an
  // assessment's findings, and dispatch a fresh skeptical agent to re-check
  // one finding. Super-admin only: it is outward-acting authority holding the
  // service's bearer credential, the same trust floor as suggest_issue/
  // redeploy_bot (docs/SECURITY.md).
  'mcp__community__dev_team_dispatch',
  'mcp__community__dev_team_status',
  'mcp__community__dev_team_result',
  'mcp__community__dev_team_backlog',
  'mcp__community__dev_team_findings',
  'mcp__community__dev_team_verify',
] as const;

// Discord-only tools: implemented by src/platforms/discord/adapter.ts but not
// by either WhatsApp adapter (cloudAdapter.ts/baileysAdapter.ts both report
// platform 'whatsapp'), so the handler unconditionally refuses on WhatsApp
// (see tools.ts's `!adapter.listUpcomingEvents` / `adminCapabilities.has(...)`
// checks). Dropped from the tier list itself on non-Discord platforms (issue
// #535) so the model isn't even offered a schema it can never successfully
// call there — the handler refusal stays as defense in depth.
//
// `react_to_message` is deliberately NOT in this list: unlike the other
// tools here it IS implemented on both WhatsApp adapters (Baileys: issue
// #495, Cloud: issue #528) — see PlatformAdapter.reactToMessage and the
// 'Works on Discord and WhatsApp' tool description in agent/tools.ts.
const DISCORD_ONLY_TOOLS: readonly string[] = [
  // Gated on adapter.listUpcomingEvents, which only DiscordAdapter implements.
  'mcp__community__list_events',
  // Gated on adapter.adminCapabilities.has(...) — DiscordAdapter is the only
  // adapter whose adminCapabilities set includes any of these six actions;
  // both WhatsApp adapters' sets are limited to warn/kick/delete/(un)mute.
  'mcp__community__create_event',
  'mcp__community__cancel_event',
  'mcp__community__create_poll',
  'mcp__community__end_poll',
  'mcp__community__create_thread',
  'mcp__community__archive_thread',
  'mcp__community__assign_community_role',
  'mcp__community__remove_community_role',
  'mcp__community__list_assignable_roles',
];

// `platform` defaults to 'discord' (the unfiltered, full-surface case) so the
// many existing tier-only call sites (tests asserting "this tier can/can't
// reach tool X" with no interest in platform) keep compiling and keep
// asserting the pre-#535 list unchanged; `buildQueryOptions` (core.ts) is the
// one real call site and always passes the caller's actual platform.
export function toolsForRole(role: Tier, platform: Platform = 'discord'): string[] {
  const tools =
    role === 'super_admin'
      ? [...MEMBER_TOOLS, ...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]
      : role === 'admin'
        ? [...MEMBER_TOOLS, ...ADMIN_TOOLS]
        : // Guests only ever reach the agent in open mode; same surface as member.
          [...MEMBER_TOOLS];
  return platform === 'discord' ? tools : tools.filter((t) => !DISCORD_ONLY_TOOLS.includes(t));
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
