import { readPolicy } from '@swampratnz/agent-base/storage/policyStore.js';

/**
 * The community-owned policy keys — the content half of the policy store,
 * paired with the base mechanism in `policyStore.ts` (cache, writer, base
 * keys). The keys are registered by this module's manifest
 * (src/module/agentModule.ts), which `createAgent` applies before anything
 * can read or write one — an unregistered key THROWS, so a forgotten entry
 * here is loud rather than silent.
 */

/**
 * The six crossing-latch stale-alert jobs' "is the latch currently open"
 * markers (issue #1198) — the first job-computed state this store holds,
 * rather than admin-authored text. Each holds only
 * `CROSSING_LATCH_ACTIVE_MARKER`/`CROSSING_LATCH_INACTIVE_MARKER`
 * (`crossingLatch.ts`), never an appeal/suggestion/candidate/request/roster/
 * admin id or any other identifying value. Exported so each owning job file
 * imports the same literal rather than re-typing it — a typo'd duplicate
 * would silently split one job's latch across two keys.
 */
export const APPEAL_STALE_ALERT_POLICY_KEY = 'appeal_stale_alert_active';
export const SUGGESTION_STALE_ALERT_POLICY_KEY = 'suggestion_stale_alert_active';
export const KNOWLEDGE_CANDIDATE_STALE_ALERT_POLICY_KEY = 'knowledge_candidate_stale_alert_active';
export const ACCESS_REQUEST_STALE_ALERT_POLICY_KEY = 'access_request_stale_alert_active';
export const ROSTER_STALE_ALERT_POLICY_KEY = 'roster_stale_alert_active';
export const DEPARTED_ADMIN_ALERT_POLICY_KEY = 'departed_admin_alert_active';

export const COMMUNITY_POLICY_KEYS = {
  community_guidelines: null,
  community_guidelines_mi: null,
  welcome_message: null,
  welcome_message_mi: null,
  [APPEAL_STALE_ALERT_POLICY_KEY]: null,
  [SUGGESTION_STALE_ALERT_POLICY_KEY]: null,
  [KNOWLEDGE_CANDIDATE_STALE_ALERT_POLICY_KEY]: null,
  [ACCESS_REQUEST_STALE_ALERT_POLICY_KEY]: null,
  [ROSTER_STALE_ALERT_POLICY_KEY]: null,
  [DEPARTED_ADMIN_ALERT_POLICY_KEY]: null,
} as const;

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
