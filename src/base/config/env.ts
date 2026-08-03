import { config as loadEnv } from 'dotenv';

// Loaded here — the one module every config entry point (the boot slice in
// boot.ts and the full composition barrel in ../config.ts) imports first — so
// `.env` is read exactly once no matter which of them wins the import race.
loadEnv({ quiet: true });

// dotenv (and shell `set -a; . ./.env`) load a blank `KEY=` line as the empty
// string, not as absent. For every optional/coerced field that means "unset"
// silently becomes "0" or an invalid enum value instead of the intended
// default. Normalise blank values to undefined up front so optional env vars
// behave the same whether they're commented out or left empty.
export function emptyStringsToUndefined(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value === '' ? undefined : value;
  }
  return result;
}

/**
 * The process environment, dotenv-loaded and blank-normalised exactly once at
 * import time. Both parse sites (boot.ts's db+log subset and the barrel's full
 * schema) read this same snapshot, so they can never disagree about what the
 * environment said.
 */
export const normalizedEnv = emptyStringsToUndefined(process.env);

/**
 * One slice-local `.refine()` in portable form: the slices export these as
 * data (predicate + params) so the composition barrel can apply them to the
 * MERGED schema — a refine baked onto a slice's own `z.object` would not
 * survive the `{ ...sliceA, ...sliceB }` shape merge. `E` is the slice's own
 * parsed-env type; the merged env is structurally assignable to it, so a
 * slice refinement can never reach outside its own keys.
 */
export interface EnvRefinement<E> {
  check: (e: E) => unknown;
  params: { message: string; path: string[] };
}
