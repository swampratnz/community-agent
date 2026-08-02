import type { ZodRawShape } from 'zod';
import type { ToolDef } from './types.js';
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
export const TOOL_REGISTRY: readonly ToolDef<any>[] = [...devTeamTools, ...imageGenTools];

/** Bare snake_case names of every registry tool, in registration order. */
export function registryToolNames(): string[] {
  return TOOL_REGISTRY.map((def) => def.name);
}

/** The fully-qualified `allowedTools` id for a registry tool. */
export function prefixedToolName(def: ToolDef<ZodRawShape>): string {
  return `mcp__community__${def.name}`;
}
