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
} from '@swampratnz/agent-base/retention.js';
import { disconnectAlertsJob } from '@swampratnz/agent-base/health.js';
import { usageAlertJob } from '@swampratnz/agent-base/usageAlert.js';
import { usageCostDigestJob } from '../usageCostDigest.js';
import { backgroundJobCostAlertJob } from '@swampratnz/agent-base/backgroundJobCostAlert.js';
import { adminDigestJob } from '../adminDigest.js';
import { accessRequestStaleAlertJob } from '../accessRequestStaleAlert.js';
import { appealStaleAlertJob } from '../appealStaleAlert.js';
import { departedAdminAlertJob } from '../departedAdminAlert.js';
import { engagementAlertJob } from '../engagementAlert.js';
import { adminLeverageAlertJob } from '../adminLeverageAlert.js';
import { knowledgeCandidateStaleAlertJob } from '../knowledgeCandidateStaleAlert.js';
import { memberDigestJob } from '../memberDigest.js';
import { reportStaleAlertJob } from '../reportStaleAlert.js';
import { rosterStaleAlertJob } from '../rosterStaleAlert.js';
import { suggestionStaleAlertJob } from '../suggestionStaleAlert.js';
import type { JobSpec } from '@swampratnz/agent-base/jobs/types.js';

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
  appealStaleAlertJob,
  knowledgeCandidateStaleAlertJob,
  reportStaleAlertJob,
  suggestionStaleAlertJob,
  accessRequestStaleAlertJob,
  rosterStaleAlertJob,
];
