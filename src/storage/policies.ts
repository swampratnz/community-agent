import { logger } from '../logger.js';
import { getPolicyValue, setPolicyValue } from './repository.js';

/**
 * Runtime policies set by super admins via the set_policy / pause tools.
 * Values live in the `policies` table; reads are cached briefly so the hot
 * message path doesn't hit the DB for every message.
 */

export type CodeAnswersPolicy = 'off' | 'snippets' | 'full';

export const POLICY_KEYS = ['code_answers', 'paused'] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];

const DEFAULTS: Record<PolicyKey, unknown> = {
  code_answers: 'snippets',
  paused: false,
};

const CACHE_TTL_MS = 30_000;
const cache = new Map<PolicyKey, { value: unknown; expires: number }>();

async function readPolicy(key: PolicyKey): Promise<unknown> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  let value: unknown = null;
  try {
    value = await getPolicyValue(key);
  } catch (err) {
    logger.warn({ err, key }, 'Policy read failed; using default');
  }
  const resolved = value ?? DEFAULTS[key];
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

export async function updatePolicy(key: PolicyKey, value: unknown, updatedBy: string): Promise<void> {
  await setPolicyValue(key, value, updatedBy);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}
