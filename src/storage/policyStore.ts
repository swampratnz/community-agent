import { logger } from '../logger.js';
import { getPolicyValue, setPolicyValue } from './repository.js';

/**
 * Runtime policies set by super admins via the set_policy / pause tools.
 * Values live in the `policies` table; reads are cached briefly so the hot
 * message path doesn't hit the DB for every message.
 *
 * The key SET is open: this base module owns only the mechanism (the cached
 * reader, the writer, the two base keys below) and a module registers its
 * own keys + never-set defaults via `registerPolicyKeys` at its own module
 * scope — this repo's community keys live in `storage/policies.ts`. Reading
 * or writing an unregistered key THROWS (fail loud) rather than silently
 * inventing a default, so a typo'd or unregistered key surfaces immediately
 * instead of as a phantom policy that always reads null.
 */

export type CodeAnswersPolicy = 'off' | 'snippets' | 'full';

// Base-owned keys: runtime bot control, not community content.
const BASE_DEFAULTS: Record<string, unknown> = {
  code_answers: 'snippets',
  paused: false,
};

const defaults = new Map<string, unknown>(Object.entries(BASE_DEFAULTS));

/**
 * Register a module's policy keys and their never-set defaults — additive,
 * called at the registering module's own import time (storage/policies.ts).
 * A duplicate key throws rather than silently re-defaulting an existing one,
 * matching registerToolTiers (auth/rbac.ts) and registerNoticePack
 * (strings/catalogue.ts).
 */
export function registerPolicyKeys(moduleDefaults: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(moduleDefaults)) {
    if (defaults.has(key)) {
      throw new Error(`policy key already registered: ${key}`);
    }
    defaults.set(key, value);
  }
}

/** Fail-loud guard shared by the reader and the writer below. */
function assertRegistered(key: string): void {
  if (!defaults.has(key)) {
    throw new Error(`unknown policy key: ${key} — register it via registerPolicyKeys before use`);
  }
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: unknown; expires: number }>();

export async function readPolicy(key: string): Promise<unknown> {
  assertRegistered(key);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  let value: unknown = null;
  try {
    value = await getPolicyValue(key);
  } catch (err) {
    logger.warn({ err, key }, 'Policy read failed; using default');
  }
  const resolved = value ?? defaults.get(key);
  cache.set(key, { value: resolved, expires: Date.now() + CACHE_TTL_MS });
  return resolved;
}

export async function getCodeAnswersPolicy(): Promise<CodeAnswersPolicy> {
  const v = await readPolicy('code_answers');
  return v === 'off' || v === 'full' ? v : 'snippets';
}

export async function isPaused(): Promise<boolean> {
  return (await readPolicy('paused')) === true;
}

export async function updatePolicy(key: string, value: unknown, updatedBy: string): Promise<void> {
  assertRegistered(key);
  await setPolicyValue(key, value, updatedBy);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/** Test-only reset of the in-memory policy cache between test cases. */
export function resetPolicyCacheForTests(): void {
  cache.clear();
}
