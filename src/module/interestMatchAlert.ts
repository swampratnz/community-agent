import { logger } from '@swampratnz/agent-base/logger.js';
import { startTrackedJob } from '@swampratnz/agent-base/jobs/trackedJob.js';
import { WindowClosedError } from '@swampratnz/agent-base/platforms/types.js';
import {
  getLanguagePreference,
  getResponseStyle,
  searchMemberInterestsForSelf,
  WHO_IS_INTO_LIMIT,
  type LanguagePreference,
  type ResponseStyle,
  type SelfInterestMatchResult,
} from '@swampratnz/agent-base/storage/repository.js';
import { persistedPerKeyCrossingLatch, type CrossingLatchDeps } from './crossingLatch.js';
import {
  listInterestMatchAlertOptIns,
  type InterestMatchAlertOptInKey,
} from './storage/interestMatchAlertOptIns.js';
import { INTEREST_MATCH_ALERT_POLICY_KEY } from './storage/policies.js';
import { notice } from './strings/notices.js';
import type { JobSpec } from '@swampratnz/agent-base/jobs/types.js';
import type { Platform, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/**
 * `who_is_into`'s self-match push complement (issue #1332) — the last
 * member-facing discovery pull-tool with no push counterpart; every admin
 * review queue (`list_appeals`, `list_suggestions`, `list_knowledge_candidates`,
 * `list_access_requests`, `list_roster`, `list_reports`) already got one.
 * Structurally mirrors `reportStaleAlert.ts`'s per-key shape, but iterates
 * the opt-in table (`interestMatchAlertOptIns.ts`) instead of `listAdmins()`,
 * and drives `persistedPerKeyCrossingLatch` over each opted-in member's own
 * `searchMemberInterestsForSelf` match count rather than an admin queue size.
 *
 * Alerts a member once on the tick their own self-match count first leaves
 * zero, stays silent while it remains >=1 (including a partial decrease that
 * never reaches zero), and re-arms once it returns to zero (interests
 * withdrawn/cleared) — the identical crossing-latch semantics every sibling
 * stale-alert job ships with, keyed by `${platform}:${platformUserId}` so the
 * latch survives a process restart per member (`crossingLatch.ts`).
 *
 * A member absent from the opt-in table is never scanned or alerted, even
 * with a nonzero self-match count (SECURITY, issue #1332 acceptance
 * criterion 6) — the opt-in table IS the scan set, not a filter applied
 * after a broader query.
 */
export function makeDefaultInterestMatchAlertRun(
  adapters: readonly PlatformAdapter[],
  listOptIns: () => Promise<InterestMatchAlertOptInKey[]> = listInterestMatchAlertOptIns,
  searchSelfMatches: (platform: Platform, userId: string) => Promise<SelfInterestMatchResult> = (
    platform,
    userId,
  ) => searchMemberInterestsForSelf(platform, userId, WHO_IS_INTO_LIMIT),
  resolveNoticeSelection: (
    platform: Platform,
    userId: string,
  ) => Promise<{ language: LanguagePreference; style: ResponseStyle | undefined }> = async (
    platform,
    userId,
  ) => {
    // Same fail-safe degrade as agent/tools/helpers.ts's
    // resolveRecipientNoticeSelection: a registered 'mi' language wins
    // outright and skips the style lookup entirely; a rejected lookup
    // degrades to English/undefined style rather than throwing or blocking
    // the send. Reimplemented locally (not imported) so this job file never
    // reaches into agent/tools/ — jobs and tools are separate extension
    // points in this module.
    const language = await getLanguagePreference(platform, userId).catch(() => 'auto' as const);
    const style: ResponseStyle | undefined =
      language === 'mi'
        ? undefined
        : await getResponseStyle(platform, userId).catch(() => 'standard' as const);
    return { language, style };
  },
  latchDeps?: CrossingLatchDeps,
): () => Promise<void> {
  const latch = persistedPerKeyCrossingLatch(INTEREST_MATCH_ALERT_POLICY_KEY, latchDeps);
  return async () => {
    for (const optIn of await listOptIns()) {
      const adapter = adapters.find((a) => a.platform === optIn.platform && a.isConnected());
      if (!adapter) continue;

      try {
        // hasProfile: false (interests never published, or since withdrawn)
        // counts as zero matches — the same "nothing to report" the caller's
        // own who_is_into sees, and it correctly re-arms the latch rather
        // than throwing on a member who opted in then cleared their
        // interests.
        const selfMatch = await searchSelfMatches(optIn.platform, optIn.userId);
        const count = selfMatch.hasProfile ? selfMatch.hits.length : 0;

        const key = `${optIn.platform}:${optIn.userId}`;
        const step = await latch.step(key, count);
        if (!step.shouldAlert) continue;

        const { language, style } = await resolveNoticeSelection(optIn.platform, optIn.userId);
        // Fixed, argument-free copy — no match count, no interest text, no
        // other member's identity (SECURITY, issue #1332 acceptance
        // criterion 6).
        const message = notice('interestMatchAlertMessage', { language, style });
        logger.warn(
          { platform: optIn.platform, id: optIn.userId },
          'Interest match alert: self-match count crossed zero for member',
        );
        try {
          await adapter.sendDirectMessage(optIn.userId, message);
        } catch (err) {
          if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
            adapter.queueForWindowReopen(optIn.userId, message, 'low');
            logger.warn(
              { platform: optIn.platform, id: optIn.userId },
              "Interest match alert: recipient's window is closed, queued for reopen",
            );
          } else {
            logger.warn(
              { err, platform: optIn.platform, id: optIn.userId },
              'Interest match alert: per-member send failed',
            );
          }
        }
        await step.commit();
      } catch (err) {
        // Mirrors reportStaleAlert.ts's per-admin isolation: one opted-in
        // member's transient read failure must never suppress the tick for
        // every other opted-in member.
        logger.warn(
          { err, platform: optIn.platform, id: optIn.userId },
          'Interest match alert: per-member read failed',
        );
      }
    }
  };
}

/**
 * who_is_into self-match push nudge (issue #1332) — the always-on push
 * complement to who_is_into's pull-only self-match view. Unconditionally
 * enabled, like every sibling stale/crossing-latch alert job: no new env
 * var, no config-schema change. Routed through the shared `startTrackedJob`
 * (same cadence as every other job in the registry) so a throwing `runOnce`
 * gets the same consecutive-failure alerting for free.
 */
export function startInterestMatchAlert(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultInterestMatchAlertRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('interest-match-alert', adapters, true, runOnce);
}

// Registry entry (see src/module/jobs/registry.ts) — always on, no enable flag.
export const interestMatchAlertJob: JobSpec = {
  name: 'interest-match-alert',
  enabled: () => true,
  start: (adapters) => startInterestMatchAlert(adapters),
};
