import { readPolicy, registerPolicyKeys } from '../../base/storage/policyStore.js';

/**
 * The community-owned policy keys — the content half of the policy store,
 * paired with the base mechanism in `policyStore.ts` (cache, writer, base
 * keys). Registration happens at THIS module's import time, and the four
 * typed accessors below are the only readers of these keys, so loading any
 * of them loads the registration first — no separate ordering to get wrong.
 */

registerPolicyKeys({
  community_guidelines: null,
  community_guidelines_mi: null,
  welcome_message: null,
  welcome_message_mi: null,
});

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

/**
 * The te reo Māori variant of the welcome message, or null if never set (or
 * cleared via an empty string). Served to a rejoining Discord member with a
 * standing `set_language_preference('mi')` in place of the default-language
 * welcome — see onGuildMemberAdd (issue #282). Same never-set-vs-cleared null
 * contract as getCommunityGuidelinesMi.
 */
export async function getWelcomeMessageMi(): Promise<string | null> {
  const v = await readPolicy('welcome_message_mi');
  return typeof v === 'string' && v.length > 0 ? v : null;
}
