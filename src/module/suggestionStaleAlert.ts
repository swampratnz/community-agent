import { logger } from '@swampratnz/agent-base/logger.js';
import { startTrackedJob } from '@swampratnz/agent-base/jobs/trackedJob.js';
import { initialUsageAlertTracker, stepUsageAlertTracker } from '@swampratnz/agent-base/usageAlert.js';
import {
  listAdmins,
  listSuggestions,
  type AdminIdentity,
  type Suggestion,
} from '@swampratnz/agent-base/storage/repository.js';
import { alertAdmins } from './appealStaleAlert.js';
import type { JobSpec } from '@swampratnz/agent-base/jobs/types.js';
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/**
 * Staleness threshold (issue #1091, mirroring `appealStaleAlert.ts`'s #1020
 * pattern for a different guild-wide, unscoped queue). 168h (7 days) —
 * `knowledgeCandidateStaleAlert.ts`'s (#1073) precedent, not appeals' 72h: a
 * member-contributed suggestion has no fairness/mute-duration urgency, so the
 * slower cadence is the right fit rather than a new number invented for this
 * proposal. Fixed, not configurable: a new env var would be a config-schema
 * (agent-base) change, same discipline #1020/#1073 were explicitly scoped to
 * avoid.
 */
export const SUGGESTION_STALE_ALERT_THRESHOLD_HOURS = 168;

/**
 * How many pending suggestions one tick scans. `listSuggestions`'s own hard
 * clamp is 200 (`Math.min(Math.max(trunc(limit) || 50, 1), 200)`), so this is
 * the widest a caller can ask for — the default of 50 is far too narrow for a
 * backlog signal. Like `listAppeals` (and unlike `listKnowledgeCandidates`,
 * which supports `oldestFirst`), `listSuggestions` has no ordering override
 * and always returns `created_at DESC` — newest first — so a bare call would
 * hand this job the 50 NEWEST pending suggestions and then filter them for
 * the OLDEST, going quiet exactly as the backlog it exists to report gets
 * worse. See `makeDefaultSuggestionStaleAlertRun`'s doc comment.
 */
export const SUGGESTION_STALE_ALERT_SCAN_LIMIT = 200;

/**
 * Bare count + oldest-age-in-hours DM template — deliberately excludes every
 * suggestion's id, content, `userId`/`displayName`, and platform, matching
 * every other digest/alert signal's "bare integers only" convention in this
 * codebase (see `formatAppealStaleAlertMessage`/
 * `formatKnowledgeCandidateStaleAlertMessage`). The signature accepts only
 * `(count, oldestAgeHours)`, so a suggestion field is unrepresentable by
 * construction.
 */
export function formatSuggestionStaleAlertMessage(count: number, oldestAgeHours: number): string {
  return (
    `💡 ${count} pending suggestion(s) have been waiting more than ` +
    `${SUGGESTION_STALE_ALERT_THRESHOLD_HOURS}h (7d) for review (oldest: ${oldestAgeHours}h) — ` +
    'run `list_suggestions` to review.'
  );
}

/** Pure: pending suggestions -> the subset older than the threshold, at instant `now`. */
function staleSuggestions(suggestions: readonly Suggestion[], now: number): Suggestion[] {
  const thresholdMs = SUGGESTION_STALE_ALERT_THRESHOLD_HOURS * 3_600_000;
  return suggestions.filter((suggestion) => now - suggestion.createdAt.getTime() >= thresholdMs);
}

/**
 * Builds the default `runOnce` for `startSuggestionStaleAlert`: a guild-wide
 * crossing latch (`stepUsageAlertTracker`, imported by reference exactly like
 * `appealStaleAlert.ts`/`knowledgeCandidateStaleAlert.ts` do) over the COUNT
 * of pending (`status = 'new'`) suggestions older than
 * `SUGGESTION_STALE_ALERT_THRESHOLD_HOURS`, computed fresh each tick from a
 * bounded `listSuggestions` scan. Alerts once on the tick the stale count
 * first leaves 0, stays silent while it remains >=1 (including a partial
 * decrease that never reaches 0), and re-arms once every stale suggestion is
 * resolved (`resolve_suggestion` to `reviewed`/`declined`/`done`) and the
 * count returns to 0 — the identical semantics `appealStaleAlert.ts`/
 * `knowledgeCandidateStaleAlert.ts` ship with, accepted here as the same
 * explicit tradeoff for needing zero persistence. `listOpenSuggestions`/
 * `listAdminIdentities` are injectable so tests can drive the latch across
 * ticks with no real DB and no timers.
 *
 * The explicit `SUGGESTION_STALE_ALERT_SCAN_LIMIT` is load-bearing, not
 * decoration — see that constant's doc comment for why a bare call would be
 * backwards. 200 is `listSuggestions`' own hard clamp
 * (`Math.min(..., 200)`), so it is the widest scan available from here; above
 * 200 pending suggestions the count still understates, the same bounded,
 * precedent-accepted tradeoff `appealStaleAlert.ts` ships with.
 */
export function makeDefaultSuggestionStaleAlertRun(
  adapters: readonly PlatformAdapter[],
  listOpenSuggestions: () => Promise<Suggestion[]> = () =>
    listSuggestions('new', SUGGESTION_STALE_ALERT_SCAN_LIMIT),
  listAdminIdentities: () => Promise<AdminIdentity[]> = listAdmins,
): () => Promise<void> {
  let tracker = initialUsageAlertTracker();
  return async () => {
    const now = Date.now();
    const suggestions = await listOpenSuggestions();
    const stale = staleSuggestions(suggestions, now);
    const step = stepUsageAlertTracker(tracker, stale.length, 1);
    tracker = step.tracker;
    if (!step.shouldAlert) return;

    const oldestAgeHours = Math.floor(
      Math.max(...stale.map((suggestion) => now - suggestion.createdAt.getTime())) / 3_600_000,
    );
    logger.warn(
      { count: stale.length, oldestAgeHours },
      'Suggestion stale alert: stale pending-suggestion count crossed zero',
    );
    await alertAdmins(
      adapters,
      formatSuggestionStaleAlertMessage(stale.length, oldestAgeHours),
      listAdminIdentities,
    );
  };
}

/**
 * Stale-suggestion admin nudge (issue #1091) — the always-on push complement
 * to `list_suggestions`' pull-only view and the weekly
 * `oldestPendingSuggestionAgeDays` digest line (#193/#450). Unconditionally
 * enabled, like `appealStaleAlertJob`/`knowledgeCandidateStaleAlertJob`: no
 * new env var, no config-schema change. Routed through the shared
 * `startTrackedJob` (same 6h cadence as every other job in the registry) so a
 * throwing `runOnce` (e.g. a DB error from `listSuggestions`) gets the same
 * consecutive-failure alerting for free.
 */
export function startSuggestionStaleAlert(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultSuggestionStaleAlertRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('suggestion-stale-alert', adapters, true, runOnce);
}

// Registry entry (see src/module/jobs/registry.ts) — always on, no enable flag.
export const suggestionStaleAlertJob: JobSpec = {
  name: 'suggestion-stale-alert',
  enabled: () => true,
  start: (adapters) => startSuggestionStaleAlert(adapters),
};
