import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { ZodRawShape } from 'zod';
import type { AdapterLookup, PlatformAdapter } from '../platforms/types.js';
import type { CallerContext } from '../auth/rbac.js';
import { getLanguagePreference } from '../storage/repository.js';
import type { ToolServerTurnState } from './turnState.js';

/**
 * The base tool-hosting kernel (agent-base plan §2): `buildToolServer` owns
 * the MECHANISM — one in-process MCP server per turn, every registered def
 * attached, the per-turn context threaded into every handler — while the
 * community CONTENT (the tool inventory, the context factory, and the MCP
 * server name that roots every `mcp__<name>__*` id) is registered by the
 * module at its own import time (`registerToolServerParts`, called from
 * src/agent/tools/index.ts's module scope). Everything here FAILS CLOSED
 * before registration, matching the tool-tier registry in auth/rbac.ts.
 */

/**
 * What an MCP tool handler resolves to — derived from the SDK's own
 * `SdkMcpToolDefinition` handler signature rather than importing
 * `@modelcontextprotocol/sdk` directly, which is only a transitive
 * dependency of this repo (the same derivation as tools/types.ts's
 * `ToolResult`, kept structural here so the base kernel never imports the
 * community registry's types).
 */
type ToolServerToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>;

/**
 * The structural slice of a registered tool def this kernel actually needs —
 * name/description/schema for the SDK `tool()` call, the handler, and the
 * read-only annotation. The community registry's richer `ToolDef` (tiers,
 * platform restrictions, feature flags) satisfies this shape; those extra
 * fields are consumed by their own registries, never here.
 */
export interface ToolServerToolDef<Ctx> {
  name: string;
  description: string;
  schema: ZodRawShape;
  readOnlyHint: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any, ctx: Ctx) => Promise<ToolServerToolResult>;
}

/** The community-registered parts `buildToolServer` composes per turn. */
export interface ToolServerParts<Ctx> {
  /**
   * The MCP server name — also the `mcpServers` record key core.ts attaches
   * the server under, and the root of every fully-qualified
   * `mcp__<name>__<tool>` id. Module-owned: the base never hard-codes it.
   */
  name: string;
  /** Builds the per-turn context every registered handler receives. */
  makeContext: (
    caller: CallerContext,
    adapter: PlatformAdapter,
    getAdapter: AdapterLookup | undefined,
    turnState: ToolServerTurnState | undefined,
    getLangPref: typeof getLanguagePreference,
  ) => Ctx;
  /** The declarative tool inventory to attach, in registration order. */
  registry: ReadonlyArray<ToolServerToolDef<Ctx>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registered: ToolServerParts<any> | null = null;

/**
 * Register the tool-server parts, exactly once per process — called by the
 * tool registry (src/agent/tools/index.ts) at its own module scope, so
 * importing the registry anywhere is what makes a tool server buildable. A
 * second registration throws rather than swapping the inventory after boot,
 * matching registerToolTiers/registerPromptSections.
 */
export function registerToolServerParts<Ctx>(parts: ToolServerParts<Ctx>): void {
  if (registered) {
    throw new Error('tool-server parts already registered — the tool inventory cannot be swapped after boot');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registered = parts as ToolServerParts<any>;
}

/** The registered parts; throws (fails closed) if the tool registry never loaded. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registeredParts(): ToolServerParts<any> {
  if (!registered) {
    throw new Error(
      'no tool-server parts registered — import the tool registry (src/agent/tools/index.js) before building a tool server',
    );
  }
  return registered;
}

/**
 * The registered MCP server name — the `mcpServers` key core.ts attaches the
 * built server under. Fails closed like `buildToolServer` itself.
 */
export function toolServerName(): string {
  return registeredParts().name;
}

/**
 * Build the in-process MCP tool server for one agent turn. The tools close
 * over the caller context and the adapter handling this conversation, so
 * RBAC and platform routing are baked in. Layers:
 *  1. The tool list attached to the turn is tier-derived (rbac.toolsForRole).
 *  2. Every privileged tool re-asserts the tier before any side effect.
 *  3. Admin data access is scoped in SQL to conversations the admin is in.
 *  4. Destructive actions require an out-of-band CONFIRM (pendingActions.ts).
 *  5. Everything privileged is audited and alerted to super admins.
 */
export function buildToolServer(
  caller: CallerContext,
  adapter: PlatformAdapter,
  getAdapter?: AdapterLookup,
  turnState?: ToolServerTurnState,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
) {
  const { name, registry, makeContext } = registeredParts();
  const ctx = makeContext(caller, adapter, getAdapter, turnState, getLangPref);
  // Attach everything; the per-turn allowedTools list (rbac.toolsForRole) is
  // what actually restricts which of these the model can call.
  return createSdkMcpServer({
    name,
    version: '2.0.0',
    tools: registry.map((def) =>
      tool(def.name, def.description, def.schema, (args) => def.handler(args, ctx), {
        annotations: { readOnlyHint: def.readOnlyHint },
      }),
    ),
  });
}
