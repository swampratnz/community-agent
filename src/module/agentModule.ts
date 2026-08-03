import type { AgentModuleManifest } from '@swampratnz/agent-base';
import { config } from '@swampratnz/agent-base/config.js';
import type { ToolContext } from '@swampratnz/agent-base/agent/tools/types.js';
import { NOTICE_AXES, NOTICE_ENTRIES } from './strings/notices.js';
import { COMMUNITY_POLICY_KEYS } from './storage/policies.js';
import { DEFAULT_BAD_WORDS } from './moderation/badWords.js';
import { COMMUNITY_PROMPT_SECTIONS } from './agent/communityPromptSections.js';
import { COMMUNITY_TURN_STATE_FINALIZER } from './agent/communityTurnState.js';
import { COMMUNITY_PERSONAS } from './agent/personas.js';
import { COMMUNITY_SKILLS } from './agent/enabledSkills.js';
import { COMMUNITY_COMMANDS } from './commands.js';
import {
  COMMUNITY_FLAGGED_TOOL_PREDICATES,
  COMMUNITY_TOOL_SERVER_PARTS,
  COMMUNITY_TOOL_TIERS,
} from './agent/tools/index.js';
import { COMMUNITY_MIGRATIONS } from './storage/schema/manifest.js';

/**
 * The display settings this deployment's member-facing output is written
 * against. agent-base defaults `DISPLAY_TIMEZONE`/`DISPLAY_LOCALE` to
 * `UTC`/`en-GB` — it cannot know a deployment's timezone — but every event
 * time this community renders was `Pacific/Auckland`/`en-NZ` before the
 * package flip, and the prose around them says so ("Current date (NZ)").
 *
 * So `init()` ASSERTS them rather than letting a missing env var silently
 * re-render every event time in UTC. A wrong render is invisible in tests and
 * obvious only to a member who turns up an hour late; a refused boot is not.
 * See `.env.example` and docs/DEPLOYMENT.md — both set these explicitly.
 */
const REQUIRED_DISPLAY_SETTINGS = { displayTimezone: 'Pacific/Auckland', displayLocale: 'en-NZ' } as const;

function assertDisplaySettings(): void {
  const wrong = Object.entries(REQUIRED_DISPLAY_SETTINGS).filter(
    ([key, want]) => config.behaviour[key as keyof typeof REQUIRED_DISPLAY_SETTINGS] !== want,
  );
  if (wrong.length === 0) return;
  const envName = { displayTimezone: 'DISPLAY_TIMEZONE', displayLocale: 'DISPLAY_LOCALE' } as const;
  const lines = wrong.map(
    ([key, want]) =>
      `  - ${envName[key as keyof typeof envName]} must be '${want}' (got ` +
      `'${String(config.behaviour[key as keyof typeof REQUIRED_DISPLAY_SETTINGS])}')`,
  );
  throw new Error(
    'nz-claude-community: this deployment renders member-facing times in NZ local time, but the ' +
      `display settings do not say so:\n${lines.join('\n')}\n` +
      'Set them in the environment (see .env.example) — agent-base defaults them to UTC/en-GB, which ' +
      'would silently re-render every event time.',
  );
}

/**
 * The NZ Claude Community module — everything this deployment contributes to
 * the agent-base framework, as ONE manifest.
 *
 * This replaces the side-effect-import composition `src/index.ts` used to
 * carry: a dozen module files each calling a `register*()` at their own module
 * scope, in an order nothing enforced, with a forgotten import discovered at
 * first use (a blank notice in front of a member) rather than at startup.
 * `createAgent` now owns the order — plan → init → singletons → additive
 * registrations → readiness probe → migrations → start — and rejects an
 * incomplete composition before the process has registered anything at all.
 *
 * Pinned to this deployment's own `ToolContext`: agent-base 0.1.1 made the
 * manifest generic in it, so every tool handler in `toolServerParts.registry`
 * is checked against the context `makeContext` actually builds instead of
 * riding on the unknown-default's bivariance.
 *
 * Adding an extension point is a two-line change: export the value from the
 * file that owns the content, name it here. Do NOT re-add module-scope
 * `register*()` calls in those files — a value registered twice throws, and
 * the whole point of the manifest is that the surface is inspectable as data.
 */
export const nzCommunityModule: AgentModuleManifest<ToolContext> = {
  name: 'nz-claude-community',
  init: assertDisplaySettings,

  // Singleton registries — exactly one module may supply each.
  notices: { axes: NOTICE_AXES, entries: NOTICE_ENTRIES },
  toolTiers: COMMUNITY_TOOL_TIERS,
  toolServerParts: COMMUNITY_TOOL_SERVER_PARTS,
  flaggedToolPredicates: COMMUNITY_FLAGGED_TOOL_PREDICATES,
  skills: COMMUNITY_SKILLS,
  promptSections: COMMUNITY_PROMPT_SECTIONS,
  commands: COMMUNITY_COMMANDS,
  defaultBadWords: DEFAULT_BAD_WORDS,

  // Additive registries.
  personas: COMMUNITY_PERSONAS,
  turnStateFinalizers: [COMMUNITY_TURN_STATE_FINALIZER],
  policyKeys: COMMUNITY_POLICY_KEYS,

  // Schema: base's fragments run first, these after (one atomic query).
  migrations: COMMUNITY_MIGRATIONS,
};
