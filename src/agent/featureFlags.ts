import type { Config } from '../config.js';

/**
 * The base feature-flag predicate registry (agent-base plan §3
 * `featureFlags` row): core.ts's per-turn subtractive tool filter reads the
 * flagged set from HERE, and the community tool registry
 * (src/agent/tools/index.ts) registers it at its own module scope — derived
 * from each `ToolDef.featureFlag` — so the base turn engine never imports
 * the community tool inventory to learn which tools are flagged. Reads FAIL
 * CLOSED before registration, matching registerToolTiers.
 */

/** One feature-flagged tool: its prefixed name and its live-config predicate. */
export interface FlaggedToolPredicate {
  name: string;
  enabled: (cfg: Config) => boolean;
}

let registered: ReadonlyArray<FlaggedToolPredicate> | null = null;

/**
 * Register the flagged-tool predicates, exactly once per process — called by
 * the tool registry (src/agent/tools/index.ts) at its own module scope. A
 * second registration throws rather than swapping the set after boot.
 */
export function registerFlaggedToolPredicates(predicates: ReadonlyArray<FlaggedToolPredicate>): void {
  if (registered) {
    throw new Error(
      'feature-flag predicates already registered — the flagged set cannot be swapped after boot',
    );
  }
  registered = Object.freeze([...predicates]);
}

/**
 * Every feature-flagged def's prefixed name with its live-config predicate —
 * consumed by core.ts's per-turn subtractive filter, which evaluates each
 * predicate against the CURRENT config at call time (never freezing the
 * boolean at import, the trap the old hand-maintained flag groups had).
 * Throws (fails closed) if the tool registry never loaded.
 */
export function flaggedToolPredicates(): ReadonlyArray<FlaggedToolPredicate> {
  if (!registered) {
    throw new Error(
      'no feature-flag predicates registered — import the tool registry (src/agent/tools/index.js) before filtering a tool surface',
    );
  }
  return registered;
}
