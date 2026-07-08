import { config } from './config.js';
import { logger } from './logger.js';
import { superAdminIds } from './auth/roles.js';
import { latestContextDigestAt } from './storage/repository.js';
import { runContextBuilder, shouldRunContextBuilder } from './context/builder.js';
import {
  latestRefreshAt,
  runKnowledgeRefresh,
  shouldRunKnowledgeRefresh,
} from './context/knowledgeRefresh.js';
import { latestDocsIngestAt, runDocsIngest, shouldRunDocsIngest } from './context/docsIngest.js';
import { writeCommunityContextExport } from './context/export.js';
import {
  buildJobFailureAlert,
  initialJobFailureTracker,
  stepJobFailureTracker,
  type BackgroundJobName,
  type JobFailureTracker,
} from './backgroundJobHealth.js';
import type { PlatformAdapter } from './platforms/types.js';

const TICK_INTERVAL_MS = 6 * 3_600_000;

/**
 * Three consecutive failed *scheduled* runs before the first alert — given
 * each job's own freshness guard, that's roughly 3 days of brokenness for
 * the daily jobs before an operator is DMed. No env var: alerting is
 * automatic whenever the corresponding job's own enable flag is already on
 * (issue #263).
 */
const BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD = 3;

/**
 * Wires a job's tracker + threshold-alert plumbing around an injectable
 * `runOnce`, closing a `JobFailureTracker` and `lastSuccessAt` over the
 * timer (same pattern `usageAlert.ts` uses for its own closed-over
 * `tracker` variable). `runOnce` resolving (including a no-op "not due
 * yet" skip) counts as success and silently resets the tracker; throwing
 * counts as a failure and steps it, DMing super admins via the same
 * `sendDirectMessage` + `superAdminIds` path `usageAlert.ts`/`health.ts`
 * already use once the threshold is reached.
 *
 * Exported (issue #291) so the two retention purges (src/interactionRetention.ts,
 * src/rosterRetention.ts) can wire through the same tracker/alert plumbing
 * from their own files, instead of duplicating it.
 */
export function startTrackedJob(
  jobName: BackgroundJobName,
  adapters: readonly PlatformAdapter[],
  enabled: boolean,
  runOnce: () => Promise<void>,
): ReturnType<typeof setInterval> | null {
  if (!enabled) return null;

  let tracker: JobFailureTracker = initialJobFailureTracker();
  let lastSuccessAt: number | null = null;

  const run = async () => {
    try {
      await runOnce();
      lastSuccessAt = Date.now();
      tracker = stepJobFailureTracker(tracker, false, BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD).tracker;
    } catch (err) {
      logger.error({ err, job: jobName }, 'Background job run failed');
      const step = stepJobFailureTracker(tracker, true, BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD);
      tracker = step.tracker;
      if (step.shouldAlert) {
        void alertSuperAdmins(
          adapters,
          buildJobFailureAlert(jobName, tracker.consecutiveFailures, lastSuccessAt),
        );
      }
    }
  };
  void run();
  const timer = setInterval(() => void run(), TICK_INTERVAL_MS);
  timer.unref();
  return timer;
}

async function alertSuperAdmins(adapters: readonly PlatformAdapter[], message: string): Promise<void> {
  for (const adapter of adapters) {
    if (!adapter.isConnected()) continue; // can't send through a dead connection
    for (const id of superAdminIds(adapter.platform)) {
      adapter
        .sendDirectMessage(id, message)
        .catch((err) =>
          logger.warn({ err, platform: adapter.platform, id }, 'Background job failure alert DM failed'),
        );
    }
  }
}

async function defaultContextBuilderRun(): Promise<void> {
  const latest = await latestContextDigestAt();
  if (!shouldRunContextBuilder(latest, Date.now())) return;
  const result = await runContextBuilder();
  logger.info(result, 'Context builder run complete');
  // Regenerate the anonymised export after a producing run (issue #53).
  // Writing the file is automatic; COMMITTING it stays a human step.
  if (config.contextExport.enabled && result.digests > 0) {
    await writeCommunityContextExport();
  }
}

async function defaultKnowledgeRefreshRun(): Promise<void> {
  const latest = await latestRefreshAt();
  if (!shouldRunKnowledgeRefresh(latest, Date.now())) return;
  const result = await runKnowledgeRefresh();
  logger.info(result, 'Knowledge refresh run complete');
}

async function defaultDocsIngestRun(): Promise<void> {
  const latest = await latestDocsIngestAt();
  if (!shouldRunDocsIngest(latest, Date.now())) return;
  const result = await runDocsIngest();
  logger.info(result, 'Docs ingest run complete');
}

/**
 * Offline context builder (issue #51). Off unless CONTEXT_BUILDER_ENABLED.
 * Ticks every 6h but the ~daily freshness guard (based on the last digest's
 * created_at) makes it effectively one run per day — restart-safe, so the
 * nightly redeploy can't double-run it. `runOnce` is injectable so tests can
 * exercise the consecutive-failure alerting without a real DB or real
 * timers (issue #263); production always uses the default.
 */
export function startContextBuilder(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = defaultContextBuilderRun,
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('context-builder', adapters, config.contextBuilder.enabled, runOnce);
}

/**
 * Daily knowledge refresh (off unless KNOWLEDGE_REFRESH_ENABLED). Ticks
 * every 6h but a ~daily freshness guard (last auto-entry's updated_at)
 * makes it effectively one run per day and restart-safe, so frequent
 * redeploys can't re-trigger the web research. Unlike the review-gated
 * context builder, this writes straight to the knowledge base — see
 * src/context/knowledgeRefresh.ts.
 */
export function startKnowledgeRefresh(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = defaultKnowledgeRefreshRun,
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('knowledge-refresh', adapters, config.knowledgeRefresh.enabled, runOnce);
}

/**
 * Docs ingest (off unless DOCS_INGEST_ENABLED). Ticks every 6h but a
 * ~weekly freshness guard makes it effectively one run per week and
 * redeploy-safe. It fetches Anthropic's official docs and diff-upserts them
 * into knowledge — see src/context/docsIngest.ts.
 */
export function startDocsIngest(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = defaultDocsIngestRun,
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('docs-ingest', adapters, config.docsIngest.enabled, runOnce);
}
