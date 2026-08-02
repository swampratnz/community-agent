import type { Platform } from '../platforms/types.js';
import type { Tier } from './tiers.js';
import {
  adminToolNames,
  discordOnlyToolNames,
  memberToolNames,
  superAdminToolNames,
} from '../agent/tools/index.js';

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
 * The tier arrays below are DERIVED from the tool registry
 * (src/agent/tools/index.ts): each tool's `ToolDef.minTier` is the single
 * source of truth, so a tool can no longer be registered on the server yet
 * missing from its tier's offer list (the silent dead-code failure the old
 * hand-maintained arrays allowed — see response_latency's historical note in
 * tools/digestsAdmin.ts). Per-tool tier/scope rationale lives on each
 * `defineTool` entry in its domain file. The tier lattice itself
 * (`atLeast`/`assertAtLeast`) lives in tiers.ts — a dependency-free leaf the
 * domain files can import without cycling back through this module — and is
 * re-exported here for the many existing import sites.
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

/** Tools (mcp__community__*) available to members (and guests in open mode). */
export const MEMBER_TOOLS: readonly string[] = memberToolNames();

/** Additional tools for admins — data access scoped to their conversations. */
export const ADMIN_TOOLS: readonly string[] = adminToolNames();

/** Additional tools for super admins only. */
export const SUPER_ADMIN_TOOLS: readonly string[] = superAdminToolNames();

// Discord-only tools (registry defs with platforms: ['discord']): implemented
// by src/platforms/discord/adapter.ts but not by either WhatsApp adapter
// (cloudAdapter.ts/baileysAdapter.ts both report platform 'whatsapp'), so the
// handler unconditionally refuses on WhatsApp. Dropped from the tier list
// itself on non-Discord platforms (issue #535) so the model isn't even
// offered a schema it can never successfully call there — the handler
// refusal stays as defense in depth.
const DISCORD_ONLY_TOOLS: readonly string[] = discordOnlyToolNames();

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
