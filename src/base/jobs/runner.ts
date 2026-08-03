import type { JobSpec, JobTimer } from './types.js';
import type { PlatformAdapter } from '../platforms/types.js';

// The base job-runner MECHANISM (agent-base plan §Phase-2 Stage 3a): the
// generic start/stop sweeps over whatever spec list the composition root
// passes in. The community job list itself — and its pinned order — lives in
// `registry.ts` (JOB_REGISTRY), which this file deliberately never imports:
// `src/index.ts` composes `startRegisteredJobs(JOB_REGISTRY, adapters)`.

export interface StartedJob {
  name: string;
  /** `null` when the job's own gate was off — the sweep skips it. */
  timer: JobTimer | null;
}

/**
 * Starts every job in `specs`, in list order (registry order, for the
 * JOB_REGISTRY list index.ts passes). Deliberately does NOT consult
 * `spec.enabled()` — every starter self-gates internally exactly as it did
 * before the registry existed, so a drifted declarative gate could mislabel
 * a job but never start or suppress one (`enabled` is pinned against the
 * real gates by `tests/jobsRegistry.test.ts`).
 */
export function startRegisteredJobs(
  specs: readonly JobSpec[],
  adapters: readonly PlatformAdapter[],
): StartedJob[] {
  return specs.map((spec) => ({ name: spec.name, timer: spec.start(adapters) }));
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
