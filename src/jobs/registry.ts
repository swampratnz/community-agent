import {
  anthropicStatusCheckJob,
  contextBuilderJob,
  devTeamWatchJob,
  docsIngestJob,
  embeddingHealthCheckJob,
  knowledgeLinkCheckJob,
  knowledgeRefreshJob,
} from '../backgroundJobs.js';
import {
  accessRequestRetentionPurgeJob,
  interactionRetentionPurgeJob,
  rosterRetentionPurgeJob,
} from '../retention.js';
import { disconnectAlertsJob } from '../health.js';
import { usageAlertJob } from '../usageAlert.js';
import { usageCostDigestJob } from '../usageCostDigest.js';
import { backgroundJobCostAlertJob } from '../backgroundJobCostAlert.js';
import { adminDigestJob } from '../adminDigest.js';
import { departedAdminAlertJob } from '../departedAdminAlert.js';
import { engagementAlertJob } from '../engagementAlert.js';
import { adminLeverageAlertJob } from '../adminLeverageAlert.js';
import { memberDigestJob } from '../memberDigest.js';
import type { JobSpec, JobTimer } from './types.js';
import type { PlatformAdapter } from '../platforms/types.js';

/**
 * Every background job in the process, replacing `index.ts`'s hand-wired
 * `startX()` calls and their hand-mirrored `clearInterval` shutdown list
 * (agent-base plan, Phase 1 item 5). Each spec lives with its owning module;
 * only the ORDER lives here.
 *
 * ORDER IS PINNED: this is exactly the start order the old `index.ts` steps
 * 4b–4g used, and `tests/jobsRegistry.test.ts` asserts it. Nothing is known
 * to *depend* on the order, but "known" is doing a lot of work in a process
 * where every job fires an immediate first run against the same DB —
 * reordering is a deliberate change with its own review, never a side effect
 * of adding an entry. Add new jobs at the END.
 */
export const JOB_REGISTRY: readonly JobSpec[] = [
  interactionRetentionPurgeJob,
  rosterRetentionPurgeJob,
  accessRequestRetentionPurgeJob,
  disconnectAlertsJob,
  embeddingHealthCheckJob,
  usageAlertJob,
  usageCostDigestJob,
  backgroundJobCostAlertJob,
  contextBuilderJob,
  knowledgeRefreshJob,
  docsIngestJob,
  knowledgeLinkCheckJob,
  anthropicStatusCheckJob,
  adminDigestJob,
  departedAdminAlertJob,
  engagementAlertJob,
  adminLeverageAlertJob,
  memberDigestJob,
  devTeamWatchJob,
];

export interface StartedJob {
  name: string;
  /** `null` when the job's own gate was off — the sweep skips it. */
  timer: JobTimer | null;
}

/**
 * Starts every registered job in registry order. Deliberately does NOT
 * consult `spec.enabled()` — every starter self-gates internally exactly as
 * it did before the registry existed, so a drifted declarative gate could
 * mislabel a job but never start or suppress one (`enabled` is pinned
 * against the real gates by `tests/jobsRegistry.test.ts`).
 */
export function startRegisteredJobs(adapters: readonly PlatformAdapter[]): StartedJob[] {
  return JOB_REGISTRY.map((spec) => ({ name: spec.name, timer: spec.start(adapters) }));
}

/**
 * The single shutdown sweep over whatever `startRegisteredJobs` returned —
 * the old one-line-per-job `clearInterval` list in `index.ts` (which had to
 * mirror the start list by hand) is gone. Clearing is idempotent and every
 * timer is `unref()`ed by its starter, so sweep order doesn't matter; it
 * runs in start order for want of a reason to differ.
 */
export function stopRegisteredJobs(started: readonly StartedJob[]): void {
  for (const { timer } of started) {
    if (timer) clearInterval(timer);
  }
}
