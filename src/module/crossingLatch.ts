import {
  readPolicy as readPolicyDefault,
  updatePolicy as updatePolicyDefault,
} from '@swampratnz/agent-base/storage/policyStore.js';
import { stepUsageAlertTracker, type UsageAlertTracker } from '@swampratnz/agent-base/usageAlert.js';

/**
 * The fixed, non-identifying marker values every persisted key this module
 * writes ever holds — "the latch is currently closed" / "the latch is
 * currently open", never an id, name, platform, or content string (issue
 * #1198's acceptance criterion 7). `initialUsageAlertTracker()`'s own
 * `{ crossed: false }` shape has no third state, so there is nothing else a
 * caller could ask this module to persist.
 */
export const CROSSING_LATCH_ACTIVE_MARKER = 'true';
export const CROSSING_LATCH_INACTIVE_MARKER = '';

/**
 * These jobs run on a timer, not behind a member/admin turn, so they have no
 * caller identity to thread into `updatePolicy`'s `updatedBy` argument.
 * `'system'` is this codebase's existing convention for a bot-originated
 * write that must never be attributed to a member or admin — see
 * `agent/tools/context.ts`'s `audited()`, which uses the same literal for its
 * privileged-action super-admin alert.
 */
const SYSTEM_ACTOR = 'system';

/**
 * `readPolicy`/`updatePolicy` as an all-or-nothing pair (`docs/STANDARDS.md`
 * → "Injected deps must be all-or-nothing"): production omits `deps` entirely
 * to get the real policy store, and a test passes a complete fake pair. A
 * type allowing just one field would let a test stub the read and silently
 * leave the write pointed at live Postgres (or vice versa).
 */
export interface CrossingLatchDeps {
  readPolicy: (key: string) => Promise<unknown>;
  updatePolicy: (key: string, value: unknown, updatedBy: string) => Promise<void>;
}

const defaultDeps: CrossingLatchDeps = { readPolicy: readPolicyDefault, updatePolicy: updatePolicyDefault };

export interface CrossingLatchStep {
  readonly shouldAlert: boolean;
  /**
   * Persist the "latch is open" marker. Call this ONLY when `shouldAlert` is
   * true, and only AFTER the caller's own admin-delivery fan-out (`alertAdmins`/
   * `alertSuperAdmins`) has returned — matching acceptance criterion 3.
   */
  commit(): Promise<void>;
}

export interface PersistedCrossingLatch {
  step(count: number): Promise<CrossingLatchStep>;
}

/**
 * Wraps agent-base's pure `initialUsageAlertTracker`/`stepUsageAlertTracker`
 * guild-wide crossing latch with `readPolicy`/`updatePolicy` persistence
 * keyed by `policyKey` — the buildable fix (issue #1198) for the explicit
 * zero-persistence tradeoff issue #1020 accepted, now revisited with the
 * policy store as the already-shipped, already-module-callable third option
 * neither #1016 nor #1020 considered. Used identically by all six
 * guild-wide/roster crossing-latch alert jobs (`appealStaleAlert.ts`,
 * `suggestionStaleAlert.ts`, `knowledgeCandidateStaleAlert.ts`,
 * `accessRequestStaleAlert.ts`, `rosterStaleAlert.ts`,
 * `departedAdminAlert.ts`) rather than reimplemented per job — the repo's
 * established "parity series, one shared helper" shape.
 *
 * `policyKey` must already carry a `null` default in `COMMUNITY_POLICY_KEYS`
 * (`storage/policies.ts`) — an unregistered key throws (`policyStore`'s
 * fail-loud guard), the same discipline every other policy caller in this
 * module already relies on.
 *
 * The in-memory tracker is seeded lazily, from exactly one `readPolicy` call
 * on the first `step()`, rather than always starting from
 * `initialUsageAlertTracker()`'s "never crossed" state: a process that
 * restarts mid-backlog seeds `{ crossed: true }` when the stored marker is
 * `CROSSING_LATCH_ACTIVE_MARKER`, and `stepUsageAlertTracker`'s own existing
 * logic then computes `shouldAlert: false` for a still->=1 count on that very
 * first tick — restart-safety (acceptance criterion 4) falls out of reusing
 * the unmodified pure latch, not a bespoke restart branch. Every later tick
 * re-reads nothing; the seeded tracker is kept in-memory exactly like every
 * job's own pre-#1198 `let tracker` variable was.
 *
 * On a crossing back to 0 (re-arm), the marker is cleared to
 * `CROSSING_LATCH_INACTIVE_MARKER` synchronously inside `step()` — there is
 * no admin fan-out to wait for on that branch — so a later crossing back to
 * >=1 alerts again and re-writes the active marker (acceptance criterion 5).
 */
export function persistedCrossingLatch(
  policyKey: string,
  deps: CrossingLatchDeps = defaultDeps,
): PersistedCrossingLatch {
  let tracker: UsageAlertTracker | null = null;

  async function seeded(): Promise<UsageAlertTracker> {
    if (tracker === null) {
      const stored = await deps.readPolicy(policyKey);
      tracker = { crossed: stored === CROSSING_LATCH_ACTIVE_MARKER };
    }
    return tracker;
  }

  return {
    async step(count: number): Promise<CrossingLatchStep> {
      const before = await seeded();
      const result = stepUsageAlertTracker(before, count, 1);
      tracker = result.tracker;

      if (before.crossed && !result.tracker.crossed) {
        await deps.updatePolicy(policyKey, CROSSING_LATCH_INACTIVE_MARKER, SYSTEM_ACTOR);
      }

      return {
        shouldAlert: result.shouldAlert,
        commit: async () => {
          await deps.updatePolicy(policyKey, CROSSING_LATCH_ACTIVE_MARKER, SYSTEM_ACTOR);
        },
      };
    },
  };
}
