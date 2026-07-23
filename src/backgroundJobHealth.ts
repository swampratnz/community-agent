/**
 * Pure consecutive-scheduled-failure debounce tracker, mirroring
 * healthState.ts's `stepDisconnectTracker` shape exactly: kept free of
 * config/HTTP/DB imports so it's directly unit-testable. Wired up by
 * backgroundJobs.ts to alert super admins once per outage when an opt-in
 * background job (context builder, knowledge refresh, docs ingest) fails on
 * consecutive scheduled ticks — see issue #263.
 */

export interface JobFailureTracker {
  consecutiveFailures: number;
  alerted: boolean;
}

export function initialJobFailureTracker(): JobFailureTracker {
  return { consecutiveFailures: 0, alerted: false };
}

/**
 * A success resets `consecutiveFailures` to 0 and `alerted` to false
 * (silent recovery, same convention as every existing tracker in this
 * repo). A failure increments the counter; `shouldAlert` fires exactly once
 * when the counter reaches `threshold` and stays false on every subsequent
 * consecutive failure until a success re-arms it — one DM per outage, not
 * one per tick, identical to `stepDisconnectTracker`/`stepUsageAlertTracker`.
 */
export function stepJobFailureTracker(
  tracker: JobFailureTracker,
  failed: boolean,
  threshold: number,
): { tracker: JobFailureTracker; shouldAlert: boolean } {
  if (!failed) {
    return { tracker: initialJobFailureTracker(), shouldAlert: false };
  }
  const consecutiveFailures = tracker.consecutiveFailures + 1;
  const shouldAlert = consecutiveFailures >= threshold && !tracker.alerted;
  return {
    tracker: { consecutiveFailures, alerted: tracker.alerted || shouldAlert },
    shouldAlert,
  };
}

export type BackgroundJobName =
  | 'context-builder'
  | 'knowledge-refresh'
  | 'docs-ingest'
  | 'knowledge-link-check'
  | 'interaction-retention-purge'
  | 'roster-retention-purge'
  | 'anthropic-status-check'
  | 'embedding-model'
  | 'admin-digest'
  | 'usage-alert'
  | 'dev-team-watch'
  | 'departed-admin-alert'
  | 'usage-cost-digest'
  | 'engagement-alert'
  | 'member-digest'
  | 'background-job-cost-alert';

/**
 * Fixed, non-leaking alert template — deliberately excludes the caught
 * error's `.message`/stack, following the same "never echo the raw error"
 * convention `upstreamFailure.ts` already established for its own
 * super-admin DM (an internal error string can incidentally contain a file
 * path, a query fragment, or other operational detail nobody intended to
 * broadcast). `jobName` is always one of the fixed enum values above, never
 * derived from anything dynamic.
 */
export function buildJobFailureAlert(
  jobName: BackgroundJobName,
  consecutiveFailures: number,
  lastSuccessAt: number | null,
): string {
  const lastSuccess = lastSuccessAt === null ? 'never this run' : new Date(lastSuccessAt).toISOString();
  return (
    `⚠️ Background job '${jobName}' has failed ${consecutiveFailures} consecutive times ` +
    `(last success: ${lastSuccess}). Check server logs for details.`
  );
}

/**
 * In-memory snapshot of a job's latest tracker state (issue #467) — a second
 * place to stash the exact same fields every `startTrackedJob`/inlined-tracker
 * call site already computes, so `/healthz` (via `healthState.ts`) has
 * something queryable beyond the one-time debounced chat DM above. Never
 * stores the caught error's message/stack, same convention as
 * `buildJobFailureAlert`.
 */
export interface JobHealthSnapshot {
  consecutiveFailures: number;
  alerted: boolean;
  lastRunAt: number;
  lastSuccessAt: number | null;
}

const jobHealthRegistry = new Map<BackgroundJobName, JobHealthSnapshot>();

/** Called by every tracker call site right after it steps its own tracker. */
export function recordJobRun(
  jobName: BackgroundJobName,
  tracker: JobFailureTracker,
  lastRunAt: number,
  lastSuccessAt: number | null,
): void {
  jobHealthRegistry.set(jobName, {
    consecutiveFailures: tracker.consecutiveFailures,
    alerted: tracker.alerted,
    lastRunAt,
    lastSuccessAt,
  });
}

/** Shallow copy for read — callers can never mutate the shared registry. */
export function getJobHealthSnapshot(): Partial<Record<BackgroundJobName, JobHealthSnapshot>> {
  return Object.fromEntries(jobHealthRegistry);
}

export function resetJobHealthRegistryForTests(): void {
  jobHealthRegistry.clear();
}
