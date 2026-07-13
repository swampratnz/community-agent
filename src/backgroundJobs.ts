import { config } from './config.js';
import { logger } from './logger.js';
import { superAdminIds } from './auth/roles.js';
import { embed } from './storage/embeddings.js';
import { latestContextDigestAt } from './storage/repository.js';
import { runContextBuilder, shouldRunContextBuilder, type ClusterSummarizer } from './context/builder.js';
import {
  latestRefreshAt,
  runKnowledgeRefresh,
  shouldRunKnowledgeRefresh,
  type TopicResearcher,
} from './context/knowledgeRefresh.js';
import { latestDocsIngestAt, runDocsIngest, shouldRunDocsIngest } from './context/docsIngest.js';
import {
  latestLinkCheckAt,
  runKnowledgeLinkCheck,
  shouldRunKnowledgeLinkCheck,
  type ClassifyDeps,
} from './context/linkCheck.js';
import { writeCommunityContextExport } from './context/export.js';
import { pollAnthropicStatus } from './status/anthropicStatus.js';
import {
  listUnnotifiedDevTeamWatches,
  markDevTeamWatchNotified,
  type DevTeamWatch,
} from './storage/repository.js';
import { devTeamField, jobStatus, type JobStatus } from './devTeam/client.js';
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
 * (issue #263). Exported (issue #426) so `usageAlert.ts` can reuse the same
 * threshold for its own inlined tracker instead of redefining it.
 */
export const BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD = 3;

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

/**
 * `summarize` is injectable (tests only) so the consecutive-failure alerting
 * can be exercised end to end through the REAL total-failure detection below,
 * without a real model call — production always uses runContextBuilder's own
 * default. See issue #335.
 */
export async function defaultContextBuilderRun(summarize?: ClusterSummarizer): Promise<void> {
  const latest = await latestContextDigestAt();
  if (!shouldRunContextBuilder(latest, Date.now())) return;
  const result = summarize ? await runContextBuilder(summarize) : await runContextBuilder();
  logger.info(result, 'Context builder run complete');
  // Regenerate the anonymised export after a producing run (issue #53).
  // Writing the file is automatic; COMMITTING it stays a human step.
  if (config.contextExport.enabled && result.digests > 0) {
    await writeCommunityContextExport();
  }
  // Total failure only: every cluster this run actually attempted (post
  // distinct-user floor and maxSummaries cap — see BuilderResult.attempted)
  // failed to summarise. A partial failure, or a legitimate zero-attempt run
  // (nothing due, nothing eligible), must never throw (issue #335).
  if (result.attempted > 0 && result.failed === result.attempted) {
    throw new Error(`Context builder: all ${result.attempted} attempted clusters failed to summarise`);
  }
}

/**
 * `research` is injectable (tests only) — see defaultContextBuilderRun above.
 */
export async function defaultKnowledgeRefreshRun(research?: TopicResearcher): Promise<void> {
  const latest = await latestRefreshAt();
  if (!shouldRunKnowledgeRefresh(latest, Date.now())) return;
  const result = research ? await runKnowledgeRefresh(research) : await runKnowledgeRefresh();
  logger.info(result, 'Knowledge refresh run complete');
  // Total failure only: every fixed topic errored. A partial failure (some
  // topics ok, e.g. NO_UPDATE) must never throw (issue #335).
  if (result.topics > 0 && result.failed === result.topics) {
    throw new Error(`Knowledge refresh: all ${result.topics} topics failed`);
  }
}

/**
 * `fetchText` is injectable (tests only) — see defaultContextBuilderRun above.
 */
export async function defaultDocsIngestRun(fetchText?: (url: string) => Promise<string>): Promise<void> {
  const latest = await latestDocsIngestAt();
  if (!shouldRunDocsIngest(latest, Date.now())) return;
  const result = fetchText ? await runDocsIngest(fetchText) : await runDocsIngest();
  logger.info(result, 'Docs ingest run complete');
  // Total failure, stage 1: the llms.txt index itself failed to fetch. A
  // zero-URL parse (index reachable, lists nothing) must never throw
  // (issue #335).
  if (result.indexFetchFailed) {
    throw new Error('Docs ingest: index fetch failed');
  }
  // Total failure, stage 2: the index was reachable and listed pages, but
  // EVERY page fetch attempted this run failed (e.g. the docs host blocks
  // the bot's user-agent, or a network partition to that host) — the index
  // fetch succeeding told us nothing about whether the pages themselves are
  // reachable.
  if (result.pages > 0 && result.fetched === 0) {
    throw new Error(`Docs ingest: all ${result.pages} page fetches failed`);
  }
  // Total failure, stage 3: pages fetched fine, but EVERY resulting chunk
  // upsert threw (e.g. the DB rejects every write) — zero created/updated/
  // unchanged/skipped means nothing about this run's chunk stage succeeded
  // OR was a benign skip, so whatever chunks it attempted must all have
  // errored.
  if (
    result.chunks > 0 &&
    result.created === 0 &&
    result.updated === 0 &&
    result.unchanged === 0 &&
    result.skipped === 0
  ) {
    throw new Error(`Docs ingest: all ${result.chunks} chunk upserts failed`);
  }
}

/**
 * `deps` is injectable (tests only) — see defaultContextBuilderRun above.
 */
export async function defaultKnowledgeLinkCheckRun(deps?: ClassifyDeps): Promise<void> {
  const latest = await latestLinkCheckAt();
  if (!shouldRunKnowledgeLinkCheck(latest, Date.now())) return;
  const result = await runKnowledgeLinkCheck(deps);
  logger.info(result, 'Knowledge link check run complete');
  // Total failure only: every entry this run actually attempted (candidates
  // minus 'refused' — an SSRF-guard-blocked entry was never attempted, see
  // src/context/linkCheck.ts) ended in a thrown failure. A partial failure,
  // or a legitimate zero-attempt run (nothing to check, or everything
  // refused), must never throw (issue #335's convention).
  const attempted = result.candidates - result.refused;
  if (attempted > 0 && result.failed === attempted) {
    throw new Error(`Knowledge link check: all ${attempted} attempted entries failed`);
  }
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

/**
 * Weekly knowledge link-rot check (off unless KNOWLEDGE_LINK_CHECK_ENABLED).
 * Ticks every 6h but a ~weekly freshness guard (max source_checked_at across
 * `knowledge`) makes it effectively one run per week and redeploy-safe. See
 * src/context/linkCheck.ts for the SSRF-hardened fetch/classify logic.
 */
export function startKnowledgeLinkCheck(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = defaultKnowledgeLinkCheckRun,
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('knowledge-link-check', adapters, config.knowledgeLinkCheck.enabled, runOnce);
}

/**
 * Fixed, non-content probe string for the embedding-model health check
 * below (issue #376) — never a member's query, knowledge content, or any
 * per-user identifier, matching `buildJobFailureAlert`'s own "no leaked
 * content" convention for its DM template.
 */
const EMBEDDING_HEALTH_PROBE = 'embedding-model-health-check-probe';

export async function defaultEmbeddingHealthCheckRun(): Promise<void> {
  await embed(EMBEDDING_HEALTH_PROBE);
}

/**
 * Embedding-model health check (issue #376). `getExtractor()` in
 * src/storage/embeddings.ts used to wedge permanently — until a full
 * process restart — the first time the model's async load rejected; that's
 * now fixed to retry on the next call, but a genuinely *sustained* outage
 * (disk full, OOM) will still fail every retry, silently disabling
 * knowledge_search/memory recall/save_knowledge bot-wide with zero operator
 * signal. Unlike the other jobs above, this one is unconditional — no
 * enabled flag — since it's a zero-cost local self-test, not a feature that
 * needs its own on/off switch (same convention as `startDisconnectAlerts`).
 * Reuses `startTrackedJob`'s existing threshold/cadence rather than
 * introducing either a new constant or a faster bespoke poller.
 */
export function startEmbeddingHealthCheckJob(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = defaultEmbeddingHealthCheckRun,
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('embedding-model', adapters, true, runOnce);
}

/**
 * Cadence-scaled failure threshold (issue #321): roughly one hour of
 * consecutive failures before the first alert, regardless of the configured
 * poll interval — floored at 3 so a very fast interval can't page on a
 * single blip. Kept separate from `BACKGROUND_JOB_FAILURE_ALERT_THRESHOLD`
 * because status check's own poll cadence (`STATUS_CHECK_POLL_MINUTES`,
 * default 5 min) is configurable and much faster than the fixed 6h
 * `TICK_INTERVAL_MS` the other jobs above share.
 */
export function statusCheckAlertThreshold(pollMinutes: number): number {
  return Math.max(3, Math.ceil(60 / pollMinutes));
}

/**
 * Anthropic status check poller (off unless STATUS_CHECK_ENABLED; see
 * src/status/anthropicStatus.ts). Deliberately NOT routed through
 * `startTrackedJob`: that helper hardcodes a 6h tick, but this job's own
 * interval is configurable and defaults to 5 minutes — reusing the wrapper
 * unmodified would silently slow status polling to 6h (issue #321).
 * Inlines the same tracker/alert primitives at this job's own cadence and a
 * cadence-scaled threshold instead. `pollAnthropicStatus` itself never
 * throws (it degrades to the last-known-good cache on failure) — its
 * boolean return, not a thrown error, drives the tracker here; the
 * try/catch below is only a defensive backstop against an unexpected throw.
 */
export function startStatusCheck(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<boolean> = pollAnthropicStatus,
): ReturnType<typeof setInterval> | null {
  if (!config.statusCheck.enabled) return null;

  let tracker: JobFailureTracker = initialJobFailureTracker();
  let lastSuccessAt: number | null = null;
  const threshold = statusCheckAlertThreshold(config.statusCheck.pollMinutes);

  const run = async () => {
    let succeeded = false;
    try {
      succeeded = await runOnce();
    } catch (err) {
      logger.error({ err }, 'Anthropic status check run failed');
    }
    if (succeeded) lastSuccessAt = Date.now();
    const step = stepJobFailureTracker(tracker, !succeeded, threshold);
    tracker = step.tracker;
    if (step.shouldAlert) {
      void alertSuperAdmins(
        adapters,
        buildJobFailureAlert('anthropic-status-check', tracker.consecutiveFailures, lastSuccessAt),
      );
    }
  };
  void run();
  const timer = setInterval(() => void run(), config.statusCheck.pollMinutes * 60_000);
  timer.unref();
  return timer;
}

/** A terminal job state — the poller sends the completion DM only for these. */
function isTerminalDevTeamState(state: string): boolean {
  return state === 'succeeded' || state === 'failed';
}

/**
 * The completion-DM text for a finished dev-team job. Fixed template over
 * identity + job metadata + terminal state only (the error is capped); the
 * full artifact is on the dashboard, reachable via `dev_team_result`.
 */
export function formatDevTeamCompletionDm(watch: DevTeamWatch, status: JobStatus): string {
  const verdict = status.state === 'succeeded' ? 'succeeded ✅' : 'failed ❌';
  const cost = typeof status.cost_usd === 'number' ? ` Cost $${status.cost_usd.toFixed(2)}.` : '';
  // The error is service-originated free text — bracket/newline-neutralize it
  // (and the watch's identifier fields, which trace back to tool-call args a
  // super-admin turn shaped) exactly like the dev_team_* chat formatters in
  // tools.ts, so an injected value can't add lines to an unprompted DM.
  const err =
    status.state === 'failed' && status.error
      ? ` Error: ${devTeamField(String(status.error).slice(0, 200))}.`
      : '';
  const mode = devTeamField(watch.mode);
  const jobId = devTeamField(watch.jobId);
  const repo = devTeamField(watch.repo);
  return (
    `Your dev-team ${mode} job ${jobId} on ${repo} ${verdict}.${cost}${err} ` +
    `Use \`dev_team_result ${jobId}\` for the full result (dashboard has the complete report).`
  );
}

/**
 * Injectable dependencies for one pass of the dev-team completion-DM poller —
 * every side effect (DB read, service GET, adapter DM, DB write) is overridable
 * so the pass can be exercised without a real DB, network, or timers.
 */
export interface DevTeamWatchDeps {
  adapters: readonly PlatformAdapter[];
  listWatches?: () => Promise<DevTeamWatch[]>;
  getStatus?: (id: string) => Promise<JobStatus>;
  markNotified?: (jobId: string) => Promise<void>;
}

/**
 * One pass of the completion-DM poller: read every unnotified watch, GET its
 * job status over the tailnet, and for each job that has reached a terminal
 * state DM the requester on their own platform, then stamp it notified so it is
 * never sent twice. A failed status GET or a failed DM leaves the row
 * unnotified for the next tick (best-effort retry); a missing/disconnected
 * adapter is silently skipped, matching the AdapterLookup convention. Never
 * throws — a single bad watch can't wedge the rest of the pass.
 */
export async function runDevTeamWatchOnce(deps: DevTeamWatchDeps): Promise<void> {
  const listWatches = deps.listWatches ?? listUnnotifiedDevTeamWatches;
  const getStatus =
    deps.getStatus ??
    ((id: string) => jobStatus(config.devTeam.endpointUrl ?? '', config.devTeam.authToken ?? '', id));
  const markNotified = deps.markNotified ?? markDevTeamWatchNotified;
  const byPlatform = new Map(deps.adapters.map((a) => [a.platform, a]));

  const watches = await listWatches();
  for (const watch of watches) {
    let status: JobStatus;
    try {
      status = await getStatus(watch.jobId);
    } catch (err) {
      logger.warn({ err, jobId: watch.jobId }, 'dev-team watch: status check failed; will retry next tick');
      continue;
    }
    if (!isTerminalDevTeamState(status.state)) continue;

    const adapter = byPlatform.get(watch.requesterPlatform);
    // No registered/connected adapter for the requester's platform: skip
    // WITHOUT marking notified, so a later reconnect can still deliver the DM.
    if (!adapter || !adapter.isConnected()) continue;

    try {
      await adapter.sendDirectMessage(watch.requesterUserId, formatDevTeamCompletionDm(watch, status));
    } catch (err) {
      logger.warn({ err, jobId: watch.jobId }, 'dev-team watch: completion DM failed; will retry next tick');
      continue; // leave unnotified so the next tick retries
    }
    try {
      await markNotified(watch.jobId);
    } catch (err) {
      // The DM went out; failing to stamp only risks a rare duplicate DM on a
      // later tick, which is far less bad than losing the completion signal.
      logger.warn({ err, jobId: watch.jobId }, 'dev-team watch: mark-notified failed after sending DM');
    }
  }
}

/**
 * Dev-team completion-DM poller (off unless DEV_TEAM_ENABLED). Re-checks
 * unnotified job watches every DEV_TEAM_WATCH_POLL_MINUTES (default 1 min) and
 * DMs the requester when a ~20-min run finishes. `runOnce` is injectable for
 * tests; production uses the DB- and client-backed default. Unlike the tracked
 * jobs above it has no consecutive-failure alerting — a transient service blip
 * is expected and simply retried on the next tick.
 */
export function startDevTeamWatchPoller(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = () => runDevTeamWatchOnce({ adapters }),
): ReturnType<typeof setInterval> | null {
  if (!config.devTeam.enabled) return null;

  const run = async () => {
    try {
      await runOnce();
    } catch (err) {
      logger.error({ err }, 'dev-team watch poller run failed');
    }
  };
  void run();
  const timer = setInterval(() => void run(), config.devTeam.watchPollMinutes * 60_000);
  timer.unref();
  return timer;
}
