import type { Tier } from '../platforms/types.js';

/**
 * The tier lattice and its two comparison helpers — the dependency-free LEAF
 * of the auth layer, split out of rbac.ts when the tier arrays there became
 * DERIVED from the tool registry (docs/TOOL-REGISTRY-DESIGN.md §2's flip):
 * every tool domain file under src/agent/tools/ needs `atLeast`/
 * `assertAtLeast` for its in-handler defence-in-depth checks, and rbac.ts now
 * imports the registry those domain files compose — importing the helpers
 * from rbac.ts would make that a runtime cycle. rbac.ts re-exports everything
 * here, so its many existing import sites keep working unchanged.
 */

export type { Tier } from '../platforms/types.js';

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
