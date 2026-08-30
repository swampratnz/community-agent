import { logger } from '@swampratnz/agent-base/logger.js';
import { startTrackedJob } from '@swampratnz/agent-base/jobs/trackedJob.js';
import {
  listAdmins,
  listKnowledgeCandidates,
  type AdminIdentity,
  type KnowledgeCandidate,
} from '@swampratnz/agent-base/storage/repository.js';
import { alertAdmins } from './appealStaleAlert.js';
import { persistedCrossingLatch, type CrossingLatchDeps } from './crossingLatch.js';
import { KNOWLEDGE_CANDIDATE_STALE_ALERT_POLICY_KEY } from './storage/policies.js';
import type { JobSpec } from '@swampratnz/agent-base/jobs/types.js';
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/**
 * Staleness threshold (issue #1073, mirroring `appealStaleAlert.ts`'s #1020
 * pattern for a different guild-wide, unscoped queue). 168h (7 days) —
 * deliberately longer than appeals' 72h SLA, since a contributed tip is
 * lower-urgency than an active moderation appeal, and 7 days means the admin
 * has already had at least one full weekly-digest cycle to act on the
 * pull-only `review_queue` line before this push fires. Fixed, not
 * configurable: a new env var would be a config-schema (agent-base) change,
 * same discipline #1020 was explicitly scoped to avoid.
 */
export const KNOWLEDGE_CANDIDATE_STALE_ALERT_THRESHOLD_HOURS = 168;

/**
 * How many pending candidates one tick scans. `listKnowledgeCandidates`'s own
 * hard clamp is 200, so this is the widest a caller can ask for. Unlike
 * `appealStaleAlert.ts`'s scan (which must pass `listAppeals`' own default
 * `created_at DESC` order and correct for it), this job always passes
 * `oldestFirst: true` explicitly, so a bounded scan here is correct by
 * construction — the truly-oldest rows are exactly the ones returned.
 */
export const KNOWLEDGE_CANDIDATE_STALE_ALERT_SCAN_LIMIT = 200;

/**
 * Bare count + oldest-age-in-hours DM template — deliberately excludes every
 * candidate's id, title, content, topic, sourcePlatform, and sourceUserId,
 * matching every other digest/alert signal's "bare integers only" convention
 * in this codebase (see `formatAppealStaleAlertMessage`). The signature
 * accepts only `(count, oldestAgeHours)`, so a candidate field is
 * unrepresentable by construction.
 */
export function formatKnowledgeCandidateStaleAlertMessage(count: number, oldestAgeHours: number): string {
  return (
    `📚 ${count} pending knowledge candidate(s) have been waiting more than ` +
    `${KNOWLEDGE_CANDIDATE_STALE_ALERT_THRESHOLD_HOURS}h (7d) for review (oldest: ${oldestAgeHours}h) — ` +
    'run `list_knowledge_candidates` to review.'
  );
}

/** Pure: pending candidates -> the subset older than the threshold, at instant `now`. */
function staleKnowledgeCandidates(
  candidates: readonly KnowledgeCandidate[],
  now: number,
): KnowledgeCandidate[] {
  const thresholdMs = KNOWLEDGE_CANDIDATE_STALE_ALERT_THRESHOLD_HOURS * 3_600_000;
  return candidates.filter((candidate) => now - candidate.createdAt.getTime() >= thresholdMs);
}

/**
 * Builds the default `runOnce` for `startKnowledgeCandidateStaleAlert`: a
 * guild-wide crossing latch (`persistedCrossingLatch`, shared verbatim by
 * every sibling alert — issue #1198) over the COUNT of pending knowledge
 * candidates older than `KNOWLEDGE_CANDIDATE_STALE_ALERT_THRESHOLD_HOURS`,
 * computed fresh each tick from a bounded, oldest-first
 * `listKnowledgeCandidates` scan. Alerts once on the tick the stale count
 * first leaves 0, stays silent while it remains >=1 (including a partial
 * decrease that never reaches 0), and re-arms once every stale candidate is
 * reviewed and the count returns to 0. Unlike the pre-#1198 in-memory-only
 * latch, this state now survives a process restart: see
 * `persistedCrossingLatch`'s own doc comment. `listOpenCandidates`/
 * `listAdminIdentities`/`latchDeps` are injectable so tests can drive the
 * latch across ticks with no real DB and no timers.
 */
export function makeDefaultKnowledgeCandidateStaleAlertRun(
  adapters: readonly PlatformAdapter[],
  listOpenCandidates: () => Promise<KnowledgeCandidate[]> = () =>
    listKnowledgeCandidates('pending', KNOWLEDGE_CANDIDATE_STALE_ALERT_SCAN_LIMIT, true),
  listAdminIdentities: () => Promise<AdminIdentity[]> = listAdmins,
  latchDeps?: CrossingLatchDeps,
): () => Promise<void> {
  const latch = persistedCrossingLatch(KNOWLEDGE_CANDIDATE_STALE_ALERT_POLICY_KEY, latchDeps);
  return async () => {
    const now = Date.now();
    const candidates = await listOpenCandidates();
    const stale = staleKnowledgeCandidates(candidates, now);
    const step = await latch.step(stale.length);
    if (!step.shouldAlert) return;

    const oldestAgeHours = Math.floor(
      Math.max(...stale.map((candidate) => now - candidate.createdAt.getTime())) / 3_600_000,
    );
    logger.warn(
      { count: stale.length, oldestAgeHours },
      'Knowledge candidate stale alert: stale pending-candidate count crossed zero',
    );
    await alertAdmins(
      adapters,
      formatKnowledgeCandidateStaleAlertMessage(stale.length, oldestAgeHours),
      listAdminIdentities,
    );
    await step.commit();
  };
}

/**
 * Stale-knowledge-candidate admin nudge (issue #1073) — the always-on push
 * complement to `list_knowledge_candidates`' pull-only view and the weekly
 * `oldestPendingCandidateAgeDays` digest line (#801). Unconditionally
 * enabled, like `appealStaleAlertJob`: no new env var, no config-schema
 * change. Routed through the shared `startTrackedJob` (same 6h cadence as
 * every other job in the registry) so a throwing `runOnce` (e.g. a DB error
 * from `listKnowledgeCandidates`) gets the same consecutive-failure alerting
 * for free.
 */
export function startKnowledgeCandidateStaleAlert(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultKnowledgeCandidateStaleAlertRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('knowledge-candidate-stale-alert', adapters, true, runOnce);
}

// Registry entry (see src/module/jobs/registry.ts) — always on, no enable flag.
export const knowledgeCandidateStaleAlertJob: JobSpec = {
  name: 'knowledge-candidate-stale-alert',
  enabled: () => true,
  start: (adapters) => startKnowledgeCandidateStaleAlert(adapters),
};
