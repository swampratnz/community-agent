import type { Platform } from '../platforms/types.js';
import type { Tier } from './tiers.js';

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
 * The tier lists are REGISTERED by the tool registry
 * (src/agent/tools/index.ts calls `registerToolTiers` at its module scope,
 * deriving each list from `ToolDef.minTier`) rather than imported from it,
 * so this module never depends on the community tool inventory. Each tool's
 * `minTier` stays the single source of truth — a tool can no longer be
 * registered on the server yet missing from its tier's offer list (the
 * silent dead-code failure the old hand-maintained arrays allowed — see
 * response_latency's historical note in tools/digestsAdmin.ts). Per-tool
 * tier/scope rationale lives on each `defineTool` entry in its domain file.
 * Everything reading the lists FAILS CLOSED before registration: import the
 * registry (as src/index.ts and core.ts do) before deriving a tool surface.
 * The tier lattice itself (`atLeast`/`assertAtLeast`) lives in tiers.ts — a
 * dependency-free leaf the domain files can import without cycling back
 * through this module — and is re-exported here for the many existing
 * import sites.
 *
 * `toolsForRole` additionally drops platform-incompatible tools (Discord-only
 * tools, on WhatsApp) from the tier list itself; `buildQueryOptions`
 * (agent/core.ts) further drops feature-flagged tools whose config flag is
 * off (issue #535) — so a tool nothing can ever successfully call on this
 * deployment isn't even offered to the model, not merely refused at call
 * time.
 */

export type { Tier } from './tiers.js';
export { atLeast, assertAtLeast } from './tiers.js';

/** The four registered tier lists, all prefixed (`mcp__community__*`) names in registry order. */
export interface ToolTierRegistration {
  /** Tools available to members (and guests in open mode). */
  member: readonly string[];
  /** Additional tools for admins — data access scoped to their conversations. */
  admin: readonly string[];
  /** Additional tools for super admins only. */
  superAdmin: readonly string[];
  /**
   * Discord-only tools (registry defs with platforms: ['discord']):
   * implemented by src/platforms/discord/adapter.ts but not by either
   * WhatsApp adapter (cloudAdapter.ts/baileysAdapter.ts both report platform
   * 'whatsapp'), so the handler unconditionally refuses on WhatsApp. Dropped
   * from the tier list itself on non-Discord platforms (issue #535) so the
   * model isn't even offered a schema it can never successfully call there —
   * the handler refusal stays as defense in depth.
   */
  discordOnly: readonly string[];
}

let registered: ToolTierRegistration | null = null;

/**
 * Register the tier lists, exactly once per process — called by the tool
 * registry (src/agent/tools/index.ts) at its own module scope, so importing
 * the registry anywhere is what makes the RBAC surface derivable. A second
 * registration throws rather than swapping the lists after boot, matching
 * the skills-manifest/prompt-sections registries.
 */
export function registerToolTiers(tiers: ToolTierRegistration): void {
  if (registered) {
    throw new Error('tool tiers already registered — the tier lists cannot be swapped after boot');
  }
  registered = {
    member: Object.freeze([...tiers.member]),
    admin: Object.freeze([...tiers.admin]),
    superAdmin: Object.freeze([...tiers.superAdmin]),
    discordOnly: Object.freeze([...tiers.discordOnly]),
  };
  MEMBER_TOOLS = registered.member;
  ADMIN_TOOLS = registered.admin;
  SUPER_ADMIN_TOOLS = registered.superAdmin;
}

/** The registered tier lists; throws (fails closed) if the tool registry never loaded. */
function registeredTiers(): ToolTierRegistration {
  if (!registered) {
    throw new Error(
      'no tool tiers registered — import the tool registry (src/agent/tools/index.js) before deriving a tool surface',
    );
  }
  return registered;
}

// The registered lists under their long-standing names, for the many test
// call sites. Live bindings assigned by registerToolTiers — undefined (never
// a narrower or wider list) until the tool registry has been imported.
export let MEMBER_TOOLS: readonly string[];
export let ADMIN_TOOLS: readonly string[];
export let SUPER_ADMIN_TOOLS: readonly string[];

// `platform` defaults to 'discord' (the unfiltered, full-surface case) so the
// many existing tier-only call sites (tests asserting "this tier can/can't
// reach tool X" with no interest in platform) keep compiling and keep
// asserting the pre-#535 list unchanged; `buildQueryOptions` (core.ts) is the
// one real call site and always passes the caller's actual platform.
export function toolsForRole(role: Tier, platform: Platform = 'discord'): string[] {
  const { member, admin, superAdmin, discordOnly } = registeredTiers();
  const tools =
    role === 'super_admin'
      ? [...member, ...admin, ...superAdmin]
      : role === 'admin'
        ? [...member, ...admin]
        : // Guests only ever reach the agent in open mode; same surface as member.
          [...member];
  return platform === 'discord' ? tools : tools.filter((t) => !discordOnly.includes(t));
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
