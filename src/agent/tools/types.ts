import type { InferShape, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { ZodRawShape } from 'zod';
import type { AdapterLookup, Platform, PlatformAdapter } from '../../platforms/types.js';
import type { CallerContext } from '../../auth/rbac.js';
import type { Config } from '../../config.js';
import type { getLanguagePreference } from '../../storage/repository.js';
import type { ToolServerTurnState } from '../tools.js';

/**
 * What an MCP tool handler resolves to — derived from the SDK's own
 * `SdkMcpToolDefinition` handler signature (the same `CallToolResult` the
 * `tool()` helper types its handlers with) rather than importing
 * `@modelcontextprotocol/sdk` directly, which is only a transitive
 * dependency of this repo.
 */
export type ToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>;

/**
 * The per-turn kernel handed to every registry tool handler — the explicit
 * replacement for the `buildToolServer` megaclosure's captured variables and
 * helper closures (docs/TOOL-REGISTRY-DESIGN.md §2). Built once per turn by
 * `makeToolContext` (context.ts); handlers destructure only the names they
 * actually use.
 *
 * Security-critical properties live here in exactly one place:
 * `requireConfirm`'s forgeable-pending-notice sanitize strip and `audited`'s
 * "audit row + 'system'-priority super-admin alert" pairing are received via
 * this context, so a domain file cannot re-implement either wrongly.
 */
export interface ToolContext {
  caller: CallerContext;
  adapter: PlatformAdapter;
  getAdapter?: AdapterLookup;
  turnState?: ToolServerTurnState;
  getLangPref: typeof getLanguagePreference;
  // The five helpers are function-typed PROPERTIES, not method signatures:
  // they are plain closures over the turn's caller/adapter with no `this`,
  // and both `buildToolServer` and registry handlers destructure them off
  // the context (which method syntax would flag via unbound-method).
  /** Adapter to notify through for a row stored under `platform` — the turn's own adapter when it matches, else a `getAdapter` lookup (issue #157). */
  adapterFor: (platform: Platform) => PlatformAdapter | undefined;
  /** Conversations the caller may reach with privileged/data tools; null = unrestricted (super admin). */
  callerScope: () => Promise<string[] | null>;
  /** Run a privileged action with an audit row + super-admin alert on success — see context.ts. */
  audited: (input: {
    actionKind: string;
    targetUserId?: string;
    conversationId?: string;
    params?: Record<string, unknown>;
    run: () => Promise<string>;
  }) => Promise<{ success: boolean; result: string }>;
  /** Queue a destructive action behind an out-of-band CONFIRM reply — see context.ts. */
  requireConfirm: (
    description: string,
    minTier: 'guest' | 'member' | 'admin' | 'super_admin',
    run: () => Promise<string>,
  ) => ToolResult;
  /** Resolve + validate the target of a membership tool — see context.ts. */
  resolveMemberTarget: (
    rawUserId: string,
    platformArg?: Platform,
  ) => Promise<{ platform: Platform; userId: string }>;
}

/**
 * One declarative tool registration (docs/TOOL-REGISTRY-DESIGN.md §2): the
 * single — and, since the flip, the ONLY — place a tool's name, tier,
 * platform restriction, feature flag and handler live. rbac.ts's tier
 * arrays, its Discord-only platform filter and core.ts's feature-flag
 * filter are all derived from these fields via tools/index.ts;
 * `tests/toolRegistry.test.ts` pins the derivation's invariants.
 */
export interface ToolDef<Shape extends ZodRawShape> {
  /** Bare snake_case name; the registry derives `mcp__community__<name>` everywhere — the prefix is never hand-typed here. */
  name: string;
  description: string;
  /** Tier that gets the tool OFFERED (guest keeps the member surface, as today). */
  minTier: 'member' | 'admin' | 'super_admin';
  /** Omit = all platforms. `['discord']` drops the tool from non-Discord surfaces via rbac.ts's derived platform filter. */
  platforms?: readonly Platform[];
  /** Evaluated per turn against the live config by core.ts's subtractive flag filter. Omit for unflagged tools. */
  featureFlag?: (cfg: Config) => boolean;
  readOnlyHint: boolean;
  schema: Shape;
  handler: (args: InferShape<Shape>, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * Identity helper so a `ToolDef`'s `handler` gets its `args` inferred from
 * `schema` — the same `ZodRawShape` → `InferShape` approach the SDK's
 * `tool()` uses for its own handler parameter.
 */
export function defineTool<Shape extends ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}
