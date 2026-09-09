import { logger } from '@swampratnz/agent-base/logger.js';
import { startTrackedJob } from '@swampratnz/agent-base/jobs/trackedJob.js';
import { WindowClosedError } from '@swampratnz/agent-base/platforms/types.js';
import {
  getLanguagePreference,
  getResponseStyle,
  type LanguagePreference,
  type ResponseStyle,
} from '@swampratnz/agent-base/storage/repository.js';
import {
  claimDueConnectionOutcomeFollowups,
  type DueConnectionOutcomeFollowup,
} from './storage/connectionOutcomes.js';
import { notice } from './strings/notices.js';
import type { JobSpec } from '@swampratnz/agent-base/jobs/types.js';
import type { Platform, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/**
 * The fixed delay (issue #1354's proposed "e.g. 3 days") between a real
 * `find_helper`/`request_project_connection` handoff and the requester-only
 * follow-up DM asking whether it helped — module-scope constant, no new env
 * var (a new knob would be an agent-base config-schema change, the same
 * reasoning `FIND_HELPER_PROJECT_SUGGESTION_FETCH_LIMIT`'s own doc comment
 * gives, social.ts).
 */
export const CONNECTION_OUTCOME_FOLLOWUP_DELAY_DAYS = 3;

/**
 * Bounded per-tick claim size — generous above any real daily handoff volume
 * (both source tools are already daily-rate-capped per requester), same
 * "generous, bounded fetch" reasoning as `WITHDRAW_SUGGESTION_SCAN_LIMIT`
 * (feedback.ts).
 */
const CONNECTION_OUTCOME_FOLLOWUP_BATCH_LIMIT = 200;

/**
 * `find_helper`/`request_project_connection`'s missing OUTCOME signal (issue
 * #1354) — both tools are already counted (`helperMatchesCount`/
 * `projectConnectionsCount`, adminDigest.ts) and receipted to the requester
 * (`find_helper_requests.ts`/`my_submissions`), but neither has ever asked
 * "did that actually help?". This job is that missing push: once a day (in
 * practice, every 6h `startTrackedJob` tick — idempotency comes from the
 * atomic claim below, not from the tick cadence), it DMs the REQUESTER ONLY
 * a fixed `CONNECTION_OUTCOME_FOLLOWUP_DELAY_DAYS` after their own handoff,
 * naming the row id `rate_connection_outcome` needs. Never contacts the
 * matched helper/project owner — `connection_outcomes` stores no such
 * identity to leak, preserving both tools' own non-disclosure guarantees
 * (social.ts).
 *
 * `claimDueConnectionOutcomeFollowups` atomically claims AND stamps
 * `followup_sent_at` in one statement (issue #1354 acceptance criterion 2):
 * a row it returns here can never be returned to a later run, regardless of
 * whether the DM that follows actually lands — so a WhatsApp recipient
 * outside their 24h window (issue #1354's own review flagged this as the one
 * real risk: a 3-day-later follow-up will usually be outside it) is queued
 * via `queueForWindowReopen`, never force-sent, and `followup_sent_at` stays
 * stamped either way (acceptance criterion 3). A row whose platform has no
 * connected adapter right now is best-effort skipped — the same
 * no-retry-on-missing-adapter posture `find_helper`/`request_project_connection`
 * themselves already have for a candidate/owner with no reachable adapter
 * (social.ts's `adapterFor` checks) — rather than left permanently
 * reconsiderable, since the claim above has already stamped it.
 */
export function makeDefaultConnectionOutcomeFollowupRun(
  adapters: readonly PlatformAdapter[],
  claimDue: (
    cutoff: Date,
    limit?: number,
  ) => Promise<DueConnectionOutcomeFollowup[]> = claimDueConnectionOutcomeFollowups,
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
    // the send. Reimplemented locally (not imported), same as
    // interestMatchAlert.ts's own identical local copy — this job file
    // never reaches into agent/tools/, jobs and tools are separate
    // extension points in this module.
    const language = await getLanguagePreference(platform, userId).catch(() => 'auto' as const);
    const style: ResponseStyle | undefined =
      language === 'mi'
        ? undefined
        : await getResponseStyle(platform, userId).catch(() => 'standard' as const);
    return { language, style };
  },
): () => Promise<void> {
  return async () => {
    const cutoff = new Date(Date.now() - CONNECTION_OUTCOME_FOLLOWUP_DELAY_DAYS * 24 * 3_600_000);
    const due = await claimDue(cutoff, CONNECTION_OUTCOME_FOLLOWUP_BATCH_LIMIT);
    for (const row of due) {
      // SECURITY (issue #1354 acceptance criterion 2): the DM target is
      // resolved from the row's OWN requester_platform/requester_user_id
      // only — connection_outcomes stores no other identity, so there is
      // nothing here that could ever address the matched helper/project
      // owner instead.
      const adapter = adapters.find((a) => a.platform === row.requesterPlatform && a.isConnected());
      if (!adapter) continue;
      try {
        const { language, style } = await resolveNoticeSelection(row.requesterPlatform, row.requesterUserId);
        // Fixed copy plus the row's own (non-sensitive, caller-owned) id —
        // no topic/project content, no other member's identity (social.ts's
        // non-disclosure guarantee, preserved here).
        const message = notice('connectionOutcomeFollowupMessage', { language, style })(row.id);
        try {
          await adapter.sendDirectMessage(row.requesterUserId, message);
        } catch (err) {
          if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
            adapter.queueForWindowReopen(row.requesterUserId, message, 'low');
            logger.warn(
              { platform: row.requesterPlatform, id: row.requesterUserId },
              "Connection outcome follow-up: recipient's window is closed, queued for reopen",
            );
          } else {
            logger.warn(
              { err, platform: row.requesterPlatform, id: row.requesterUserId },
              'Connection outcome follow-up: per-row send failed',
            );
          }
        }
      } catch (err) {
        // Mirrors interestMatchAlert.ts's per-member isolation: one row's
        // transient read failure must never abort the tick for every other
        // due row.
        logger.warn(
          { err, platform: row.requesterPlatform, id: row.requesterUserId },
          'Connection outcome follow-up: per-row processing failed',
        );
      }
    }
  };
}

/**
 * The requester-only outcome follow-up (issue #1354). Unconditionally
 * enabled, like every sibling stale/crossing-latch alert job: no new env
 * var, no config-schema change. Routed through the shared `startTrackedJob`
 * (same cadence as every other job in the registry) so a throwing `runOnce`
 * gets the same consecutive-failure alerting for free.
 */
export function startConnectionOutcomeFollowup(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultConnectionOutcomeFollowupRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('connection-outcome-followup', adapters, true, runOnce);
}

// Registry entry (see src/module/jobs/registry.ts) — always on, no enable flag.
export const connectionOutcomeFollowupJob: JobSpec = {
  name: 'connection-outcome-followup',
  enabled: () => true,
  start: (adapters) => startConnectionOutcomeFollowup(adapters),
};
