import type { ZodRawShape } from 'zod';
import type { ToolDef } from './types.js';
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
import { devTeamTools } from './devTeam.js';
import { imageGenTools } from './imageGen.js';

/**
 * THE single declarative tool inventory (docs/TOOL-REGISTRY-DESIGN.md §2),
 * composed from per-domain arrays. During the strangler migration this holds
 * only the converted domains — `buildToolServer` (tools.ts) registers
 * `[...registry-built tools, ...remaining closure tools]` — and nothing is
 * yet DERIVED from it (rbac.ts's tier arrays and core.ts's flag groups stay
 * authoritative until the flip); `tests/toolRegistry.test.ts` cross-checks
 * that the registry's metadata never disagrees with those hand arrays.
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
