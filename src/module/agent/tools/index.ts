import type { ZodRawShape } from 'zod';
import type { Config } from '@swampratnz/agent-base/config.js';
import type { ToolTierRegistration } from '@swampratnz/agent-base/auth/rbac.js';
import type { ToolServerParts } from '@swampratnz/agent-base/agent/toolServer.js';
import type { FlaggedToolPredicate } from '@swampratnz/agent-base/agent/featureFlags.js';
import { makeToolContext } from './context.js';
import type { ToolContext, ToolDef } from '@swampratnz/agent-base/agent/tools/types.js';
import { infoTools } from './info.js';
import { knowledgeMemberTools } from './knowledgeMember.js';
import { memoryTools } from './memory.js';
import { selfServiceTools } from './selfService.js';
import { reportsMemberTools } from './reportsMember.js';
import { feedbackTools } from './feedback.js';
import { prefsTools } from './prefs.js';
import { reactionsTools } from './reactions.js';
import { socialTools } from './social.js';
import { digestMemberTools } from './digestMember.js';
import { projectNotesTools } from './projectNotes.js';
import { activityTools } from './activity.js';
import { moderationTools } from './moderation.js';
import { appealsAdminTools } from './appealsAdmin.js';
import { broadcastTools } from './broadcast.js';
import { eventsTools } from './events.js';
import { policyTextTools } from './policyText.js';
import { knowledgeAdminTools } from './knowledgeAdmin.js';
import { accessAndSuggestionsTools } from './accessAndSuggestions.js';
import { rosterTools } from './roster.js';
import { digestsAdminTools } from './digestsAdmin.js';
import { reportsAdminTools } from './reportsAdmin.js';
import { membershipTools } from './membership.js';
import { discordRolesTools } from './discordRoles.js';
import { projectsAdminTools } from './projectsAdmin.js';
import { superAdminTools } from './superAdmin.js';
import { devTeamTools } from './devTeam.js';
import { imageGenTools } from './imageGen.js';

/**
 * THE single declarative tool inventory (docs/TOOL-REGISTRY-DESIGN.md §2),
 * composed from per-domain arrays. Everything downstream is DERIVED from it:
 * `buildToolServer` (tools.ts) registers exactly these defs, rbac.ts's tier
 * arrays and `toolsForRole` come from the memoised name lists below, and
 * core.ts's per-turn feature-flag filter evaluates `flaggedToolPredicates()`
 * against the live config — so a tool's name, tier, platform restriction and
 * flag can never again drift across hand-maintained copies
 * (`tests/toolRegistry.test.ts` pins the invariants).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOL_REGISTRY: readonly ToolDef<any>[] = [
  ...infoTools,
  ...knowledgeMemberTools,
  ...memoryTools,
  ...selfServiceTools,
  ...reportsMemberTools,
  ...feedbackTools,
  ...prefsTools,
  ...reactionsTools,
  ...socialTools,
  ...digestMemberTools,
  ...projectNotesTools,
  ...activityTools,
  ...moderationTools,
  ...appealsAdminTools,
  ...broadcastTools,
  ...eventsTools,
  ...policyTextTools,
  ...knowledgeAdminTools,
  ...accessAndSuggestionsTools,
  ...rosterTools,
  ...digestsAdminTools,
  ...reportsAdminTools,
  ...membershipTools,
  ...discordRolesTools,
  ...projectsAdminTools,
  ...superAdminTools,
  ...devTeamTools,
  ...imageGenTools,
];

/** Bare snake_case names of every registry tool, in registration order. */
export function registryToolNames(): string[] {
  return TOOL_REGISTRY.map((def) => def.name);
}

/** The fully-qualified `allowedTools` id for a registry tool. */
export function prefixedToolName(def: ToolDef<ZodRawShape>): string {
  return `mcp__community__${def.name}`;
}

// The derived metadata below is memoised at module scope: TOOL_REGISTRY is
// static, so each list is computed exactly once. All names are prefixed
// (`mcp__community__*`) and in registry order — the shape rbac.ts's tier
// arrays and core.ts's flag filter consume directly.
const byTier = (tier: 'member' | 'admin' | 'super_admin'): readonly string[] =>
  TOOL_REGISTRY.filter((def) => def.minTier === tier).map((def) => prefixedToolName(def));

const MEMBER_TOOL_NAMES = byTier('member');
const ADMIN_TOOL_NAMES = byTier('admin');
const SUPER_ADMIN_TOOL_NAMES = byTier('super_admin');

/**
 * Discord-only tools: defs whose `platforms` is defined and does not include
 * 'whatsapp' (today that always means exactly `['discord']`) — the registry
 * replacement for rbac.ts's old hand-maintained DISCORD_ONLY_TOOLS list.
 */
const DISCORD_ONLY_TOOL_NAMES = TOOL_REGISTRY.filter(
  (def) => def.platforms !== undefined && !def.platforms.includes('whatsapp'),
).map((def) => prefixedToolName(def));

const FLAGGED_TOOL_PREDICATES: ReadonlyArray<{ name: string; enabled: (cfg: Config) => boolean }> =
  TOOL_REGISTRY.flatMap((def) =>
    def.featureFlag ? [{ name: prefixedToolName(def), enabled: def.featureFlag }] : [],
  );

// The three derived registrations this registry owns. All are handed to
// `createAgent` by this module's manifest (src/module/agentModule.ts) rather
// than performed at module scope, so composition order is enforced in one
// place instead of resting on an import list — but every consumer still reads
// them back from the BASE registry (rbac.ts's `toolsForRole`, the kernel's
// `buildToolServer`, core.ts's per-turn flag filter), each of which fails
// closed until registration has happened.

/** Tier lists rbac.ts derives `toolsForRole` from. */
export const COMMUNITY_TOOL_TIERS: ToolTierRegistration = {
  member: MEMBER_TOOL_NAMES,
  admin: ADMIN_TOOL_NAMES,
  superAdmin: SUPER_ADMIN_TOOL_NAMES,
  discordOnly: DISCORD_ONLY_TOOL_NAMES,
};

/**
 * The base tool kernel's parts: the MCP server name (the root of every
 * `mcp__community__*` id), the declarative registry, and the per-turn context
 * factory — all community content, so `buildToolServer` fails closed until
 * they are registered.
 */
export const COMMUNITY_TOOL_SERVER_PARTS: ToolServerParts<ToolContext> = {
  name: 'community',
  makeContext: makeToolContext,
  registry: TOOL_REGISTRY,
};

/** Feature-flag predicates for core.ts's per-turn subtractive filter. */
export const COMMUNITY_FLAGGED_TOOL_PREDICATES: readonly FlaggedToolPredicate[] = FLAGGED_TOOL_PREDICATES;

/** Prefixed names of every member-tier registry def, in registry order. */
export function memberToolNames(): readonly string[] {
  return MEMBER_TOOL_NAMES;
}

/** Prefixed names of every admin-tier registry def, in registry order. */
export function adminToolNames(): readonly string[] {
  return ADMIN_TOOL_NAMES;
}

/** Prefixed names of every super-admin-tier registry def, in registry order. */
export function superAdminToolNames(): readonly string[] {
  return SUPER_ADMIN_TOOL_NAMES;
}

/** Prefixed names of every def not offered on WhatsApp (platforms: ['discord']). */
export function discordOnlyToolNames(): readonly string[] {
  return DISCORD_ONLY_TOOL_NAMES;
}

/**
 * Every feature-flagged def's prefixed name with its live-config predicate —
 * consumed by core.ts's per-turn subtractive filter, which evaluates each
 * predicate against the CURRENT config at call time (never freezing the
 * boolean at import, the trap the old hand-maintained flag groups had).
 */
export function flaggedToolPredicates(): ReadonlyArray<{
  name: string;
  enabled: (cfg: Config) => boolean;
}> {
  return FLAGGED_TOOL_PREDICATES;
}
