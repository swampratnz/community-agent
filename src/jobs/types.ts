import type { Config } from '../config.js';
import type { PlatformAdapter } from '../platforms/types.js';

/** The interval handle every job starter returns (`null` when its gate is off). */
export type JobTimer = ReturnType<typeof setInterval>;

/**
 * One background job, as registered in `src/jobs/registry.ts` (agent-base
 * plan §3, the `jobs: JobSpec[]` extension point). Deliberately thin: the
 * spec does NOT own the cadence — today's jobs are a mix of
 * `startTrackedJob`'s shared 6h tick + per-job freshness guards, bespoke
 * fixed intervals (disconnect alerts 30s, usage alert hourly) and
 * configurable pollers (status check, dev-team watch), and forcing those
 * into one `intervalMs` field would misdescribe most of them. Each job's
 * `start()` keeps its exact pre-registry cadence mechanism, freshness
 * guard and failure-tracker wiring.
 */
export interface JobSpec {
  /**
   * Open string, not a closed union (agent-base plan §3: `BackgroundJobName`
   * becomes an open string so a module can register jobs the base never
   * heard of). Every name in THIS repo is a fixed literal in the job's
   * owning module — never derived from message content or any runtime
   * value. Names that feed `background_job_costs.job` are a different,
   * deliberately CLOSED type (`BackgroundJob` in
   * `src/storage/repository/adminStats.ts`) because a DB CHECK constrains
   * them — see the note there.
   */
  name: string;
  /**
   * Declarative form of the gate `start()` already enforces internally.
   * The registry does NOT consult it at startup (the starters self-gate,
   * byte-for-byte as before the registry existed); it exists so the gate is
   * inspectable/testable without starting timers, and it is pinned against
   * the starter's own behaviour by `tests/jobsRegistry.test.ts` +
   * `tests/backgroundJobsDisabled.test.ts`.
   */
  enabled(cfg: Config): boolean;
  /** Starts the job (or returns `null` when its own gate is off). */
  start(adapters: readonly PlatformAdapter[]): JobTimer | null;
}
