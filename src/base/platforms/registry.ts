import type { Platform, PlatformAdapter, PlatformMemberIdRules } from './types.js';
import { DISCORD_MEMBER_ID_RULES } from './discord/memberIdRules.js';
import { WHATSAPP_MEMBER_ID_RULES } from './whatsapp/memberIdRules.js';

/**
 * The platform registry (agent-base plan item 9, §3 `adapters` row): the ONE
 * place the set of platforms lives now that `Platform` is an open string
 * (types.ts) rather than a closed union duplicated across core.ts, tool
 * metadata and zod enums. Two layers, split by import weight:
 *
 * 1. **Descriptors** (this file): lightweight per-platform declarations —
 *    the platform id and its member-id validation rules — importing ONLY
 *    leaf modules, so `src/auth/memberId.ts` can dispatch over the registry
 *    without dragging discord.js/Baileys into every import graph that
 *    validates an id.
 * 2. **Factories** (`factories.ts`): the heavy composition layer — adapter
 *    constructors plus each platform's declared tool-capability set — which
 *    only the process entry point, the availability invariant and adapter
 *    tests import.
 *
 * SECURITY: opening the `Platform` type moves NO trust decision here. Roles
 * still come from env + `community_users` (auth/roles.ts), tool surfaces are
 * still tier-derived (auth/rbac.ts), and model-facing platform arguments
 * remain CLOSED zod enums (tools/helpers.ts `platformArg`). What this file
 * adds is a fail-closed dispatch: an unregistered platform string has no
 * member-id rules (`descriptorFor` returns undefined and callers throw) and
 * no adapter, so it cannot acquire behaviour by being named.
 */

/** One registered platform: its id plus the per-adapter declarations that are cheap to import. */
export interface PlatformDescriptor {
  readonly platform: Platform;
  /** Member-id validation heuristics — `auth/memberId.ts` dispatches here. */
  readonly memberId: PlatformMemberIdRules;
}

/**
 * One adapter factory registration (the plan's `{platform, create(cfg)}`
 * shape; config arrives via the `config` singleton the adapters already
 * read, so `create` takes no parameter today).
 */
export interface AdapterFactory {
  readonly platform: Platform;
  /**
   * Capability ids this PLATFORM declares for tool availability — the union
   * over the platform's selectable providers of every `AdminAction` kind in
   * `adminCapabilities` plus the feature-capability ids (`react_to_message`,
   * `list_events`) for the optional adapter methods tools key on. A union,
   * deliberately: availability is per-platform and must not vary with
   * provider selection (`toolsForRole` outputs are deployment-stable), so a
   * capability only one provider implements is DECLARED here and
   * feature-checked in the tool handler at runtime — the react_to_message
   * precedent from rbac history.
   */
  readonly toolCapabilities: ReadonlySet<string>;
  /** Build the adapter, or return null when this platform is disabled/unconfigured for the deployment. */
  create(): PlatformAdapter | null;
}

/**
 * Every platform this codebase ships, in adapter-start order. Adding a
 * platform = adding a descriptor here + a factory in factories.ts; nothing
 * else names platforms structurally.
 */
export const PLATFORM_DESCRIPTORS: readonly PlatformDescriptor[] = [
  { platform: 'discord', memberId: DISCORD_MEMBER_ID_RULES },
  { platform: 'whatsapp', memberId: WHATSAPP_MEMBER_ID_RULES },
];

/**
 * All registered platform ids, in registration order — the registry-derived
 * replacement for the `ALL_PLATFORMS` copies core.ts/tools kept by hand while
 * `Platform` was a closed union.
 */
export const KNOWN_PLATFORMS: readonly Platform[] = PLATFORM_DESCRIPTORS.map((d) => d.platform);

/** Look up a platform's descriptor; undefined for an unregistered platform (callers fail closed). */
export function descriptorFor(platform: Platform): PlatformDescriptor | undefined {
  return PLATFORM_DESCRIPTORS.find((d) => d.platform === platform);
}

/**
 * The slice of a `ToolDef` the availability invariant reads — structural, so
 * this leaf module never imports the tool registry's types (which import
 * platform types right back).
 */
export interface ToolPlatformClaim {
  readonly name: string;
  readonly platforms?: readonly Platform[];
  readonly requiresCapability?: string;
}

/**
 * SECURITY invariant (agent-base plan item 9): a tool's `platforms`
 * restriction must be DERIVABLE from the registered adapters' declared
 * capabilities, not hand-mirrored folklore. For every def that declares
 * `requiresCapability`, the set of platforms it is offered on
 * (`def.platforms`, or every registered platform when omitted) must equal
 * EXACTLY the set of platforms whose factory declares that capability —
 * so a restriction can neither be too wide (offering a tool somewhere no
 * provider can ever execute it) nor too narrow (silently dropping a tool
 * from a platform that supports it, the regression class the
 * react_to_message deliberate-inclusion history guards: it must stay offered
 * on WhatsApp because a WhatsApp provider implements reactions, even though
 * not every provider does). And every def that restricts `platforms` at all
 * MUST name the capability that justifies the restriction — an unjustified
 * restriction is exactly the hand-maintained drift this check exists to kill.
 *
 * Runs at startup (index.ts, before any adapter starts) and in the
 * `SECURITY:` platform-registry tests. Throws with the offending tool name.
 */
export function assertToolAvailabilityConsistent(
  defs: readonly ToolPlatformClaim[],
  factories: readonly AdapterFactory[],
): void {
  const platforms = factories.map((f) => f.platform);
  if (new Set(platforms).size !== platforms.length) {
    throw new Error(`Duplicate platform in adapter factories: ${platforms.join(', ')}`);
  }
  for (const factory of factories) {
    if (!descriptorFor(factory.platform)) {
      throw new Error(`Adapter factory "${factory.platform}" has no registered platform descriptor`);
    }
  }
  for (const def of defs) {
    for (const p of def.platforms ?? []) {
      if (!platforms.includes(p)) {
        throw new Error(`Tool "${def.name}" restricts to unregistered platform "${p}"`);
      }
    }
    if (def.platforms !== undefined && def.requiresCapability === undefined) {
      throw new Error(
        `Tool "${def.name}" restricts platforms to [${def.platforms.join(', ')}] without a ` +
          `requiresCapability justifying it — platform restrictions must be capability-derived`,
      );
    }
    if (def.requiresCapability === undefined) continue;
    const cap = def.requiresCapability;
    const supported = platforms.filter((p) =>
      factories.some((f) => f.platform === p && f.toolCapabilities.has(cap)),
    );
    const offered = def.platforms ?? platforms;
    const missing = offered.filter((p) => !supported.includes(p));
    const dropped = supported.filter((p) => !offered.includes(p));
    if (missing.length > 0 || dropped.length > 0) {
      throw new Error(
        `Tool "${def.name}" (requiresCapability "${cap}") is inconsistent with the declared adapter ` +
          `capabilities: offered on [${[...offered].sort().join(', ')}] but the capability is declared ` +
          `by [${[...supported].sort().join(', ')}]` +
          (missing.length > 0 ? ` — no adapter can execute it on: ${missing.join(', ')}` : '') +
          (dropped.length > 0 ? ` — silently unavailable on: ${dropped.join(', ')}` : ''),
      );
    }
  }
}
