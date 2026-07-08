import { logger } from '../logger.js';
import { getPolicyValue, setPolicyValue } from './repository.js';

/**
 * Runtime policies set by super admins via the set_policy / pause tools.
 * Values live in the `policies` table; reads are cached briefly so the hot
 * message path doesn't hit the DB for every message.
 */

export type CodeAnswersPolicy = 'off' | 'snippets' | 'full';

export const POLICY_KEYS = [
  'code_answers',
  'paused',
  'community_guidelines',
  'community_guidelines_mi',
  'welcome_message',
] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];

const DEFAULTS: Record<PolicyKey, unknown> = {
  code_answers: 'snippets',
  paused: false,
  community_guidelines: null,
  community_guidelines_mi: null,
  welcome_message: null,
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

/**
 * The current community guidelines text, or null if never set (or cleared
 * via an empty string — see set_community_guidelines, issue #212). Consumers
 * (welcome messages, the community_guidelines tool) treat null identically
 * whether guidelines were never set or were explicitly cleared.
 */
export async function getCommunityGuidelines(): Promise<string | null> {
  const v = await readPolicy('community_guidelines');
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The te reo Māori variant of the community guidelines, or null if never set
 * (or cleared via an empty string). Served to callers with a standing
 * `set_language_preference('mi')` in place of the default-language text —
 * see the `community_guidelines` tool (issue #266). Same
 * never-set-vs-cleared null contract as getCommunityGuidelines.
 */
export async function getCommunityGuidelinesMi(): Promise<string | null> {
  const v = await readPolicy('community_guidelines_mi');
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The current admin-configured welcome message, or null if never set (or
 * cleared via an empty string — see set_welcome_message, issue #253). Null
 * means "use the platform's hardcoded default", same null-means-default-or-
 * cleared contract as getCommunityGuidelines.
 */
export async function getWelcomeMessage(): Promise<string | null> {
  const v = await readPolicy('welcome_message');
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export async function updatePolicy(key: PolicyKey, value: unknown, updatedBy: string): Promise<void> {
  await setPolicyValue(key, value, updatedBy);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/** Test-only reset of the in-memory policy cache between test cases. */
export function resetPolicyCacheForTests(): void {
  cache.clear();
}
