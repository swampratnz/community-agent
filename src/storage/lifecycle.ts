import type { Platform } from '../platforms/types.js';
import type { Queryable } from './repository/shared.js';

/**
 * Storage lifecycle registries (AGENT-BASE-PLAN Phase 1 item 4) — the seam
 * that lets each repository/ domain module own ITS rows' part of the
 * cross-cutting storage lifecycles (privacy purge, interaction
 * deletion/edit coherence, membership removal, roster departure) instead of
 * budgetsPrivacy.ts/members.ts/roster.ts hard-coding every domain's tables.
 *
 * SECURITY: this file is part of the purge path — `forget_me`/
 * `purge_user_data`'s erasure promise is only as complete as the contributor
 * set registered here. Registration happens at module load of each owning
 * domain file, and every one of those files is loaded by `repository.ts`'s
 * `export *` lines (re-exporting executes the module), so ANY consumer that
 * imports through the barrel gets the full set. Do not call
 * `purgeUserData`/`getMyDataSummary` from code that imports
 * `repository/budgetsPrivacy.js` directly without also loading the barrel —
 * a partially-registered process would silently purge less than promised
 * (tests/storageLifecycle.test.ts pins the full roster).
 *
 * Iteration order is EXPLICIT, never load order: each registration carries an
 * `order` and the accessors sort by it, so the statement sequence inside the
 * purge/removal transactions is byte-for-byte the sequence the old inline code
 * ran, regardless of which module happened to load first.
 */

/** The (platform, userId) identity a lifecycle event is about. */
export interface LifecycleIdentity {
  platform: Platform;
  userId: string;
}

// --- Purge contributors (forget_me / purge_user_data) ------------------------

/**
 * One domain's share of `purgeSingleIdentity`'s transaction. `purge` runs
 * inside the caller's open transaction (`tx`) and returns the number of rows
 * it deleted — that return value is summed into the purge's user-facing count,
 * so an uncounted statement (e.g. an authorship-NULLing UPDATE) must simply
 * not contribute to the returned number. `summarize` is the read-only
 * `my_data` counterpart: it returns the partial `MyDataSummary` counts this
 * domain contributes, and is deliberately OPTIONAL — the summary's table set
 * is intentionally narrower than the purge's (see getMyDataSummary's doc
 * comment for the deliberate omissions).
 */
export interface PurgeContributor {
  /** Stable name (the table it purges) — pinned, with the order, by tests/storageLifecycle.test.ts. */
  name: string;
  /** Position in the purge transaction; contributors run sorted ascending. */
  order: number;
  purge(id: LifecycleIdentity, tx: Queryable): Promise<number>;
  summarize?(id: LifecycleIdentity, db: Queryable): Promise<Record<string, number>>;
}

const purgeContributorRegistry: PurgeContributor[] = [];

export function registerPurgeContributor(contributor: PurgeContributor): void {
  purgeContributorRegistry.push(contributor);
}

/** Every registered contributor, in transaction order (ascending `order`). */
export function purgeContributors(): readonly PurgeContributor[] {
  return [...purgeContributorRegistry].sort((a, b) => a.order - b.order);
}

/**
 * Run every contributor's `purge` inside the caller's transaction, in order,
 * summing the counted deletions. Propagating: a contributor failure aborts the
 * caller's transaction, exactly as the old inline statements did.
 */
export async function runPurgeContributors(id: LifecycleIdentity, tx: Queryable): Promise<number> {
  let total = 0;
  for (const contributor of purgeContributors()) {
    total += await contributor.purge(id, tx);
  }
  return total;
}

/**
 * Merge every contributor's `summarize` counts (contributors without one are
 * skipped — the my_data omissions). Values for the same key are summed so the
 * caller can aggregate across linked identities by calling this per identity.
 */
export async function runPurgeSummaries(
  id: LifecycleIdentity,
  db: Queryable,
): Promise<Record<string, number>> {
  const merged: Record<string, number> = {};
  for (const contributor of purgeContributors()) {
    if (!contributor.summarize) continue;
    for (const [key, value] of Object.entries(await contributor.summarize(id, db))) {
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return merged;
}

// --- Interactions-invalidated hooks (delete/edit honouring + purge) ----------

export type OnInteractionsInvalidated = (interactionIds: number[], db?: Queryable) => Promise<number>;

interface InteractionsInvalidatedHook {
  order: number;
  run: OnInteractionsInvalidated;
}

const interactionsInvalidatedRegistry: InteractionsInvalidatedHook[] = [];

/**
 * Register a hook to run whenever stored interactions are invalidated —
 * hard-deleted by a platform revoke, content-replaced by a platform edit, or
 * erased by a privacy purge. The base digest-coherence sweep
 * (`invalidateDigestsForInteractions`, registered by repository/shared.ts at
 * order 0) is always first. Deliberately NOT run by the age-based retention
 * sweep `purgeOldInteractions` — see the comment there.
 */
export function registerOnInteractionsInvalidated(run: OnInteractionsInvalidated, order = 100): void {
  interactionsInvalidatedRegistry.push({ order, run });
}

export function onInteractionsInvalidatedHooks(): readonly OnInteractionsInvalidated[] {
  return [...interactionsInvalidatedRegistry].sort((a, b) => a.order - b.order).map((h) => h.run);
}

/**
 * Run every hook, awaited and PROPAGATING (the purge path: a failed
 * invalidation must abort the purge transaction, not leave digests alive over
 * erased rows), summing their returns. The delete/edit honouring paths instead
 * iterate `onInteractionsInvalidatedHooks()` themselves with per-hook
 * `.catch(warn)` isolation — see repository/interactions.ts.
 */
export async function runInteractionsInvalidated(interactionIds: number[], db?: Queryable): Promise<number> {
  let total = 0;
  for (const hook of onInteractionsInvalidatedHooks()) {
    total += await hook(interactionIds, db);
  }
  return total;
}

// --- Member-removed hooks (removeMember's transaction) -----------------------

export type OnMemberRemoved = (id: LifecycleIdentity, tx: Queryable) => Promise<void>;

interface MemberRemovedHook {
  order: number;
  run: OnMemberRemoved;
}

const memberRemovedRegistry: MemberRemovedHook[] = [];

/**
 * Register a hook to run inside `removeMember`'s transaction, between the
 * `community_users` delete and the person-group dissolution. Propagating: a
 * hook failure rolls the whole removal back (membership and its dependent
 * cleanups commit together or not at all).
 */
export function registerOnMemberRemoved(run: OnMemberRemoved, order = 100): void {
  memberRemovedRegistry.push({ order, run });
}

export function onMemberRemovedHooks(): readonly OnMemberRemoved[] {
  return [...memberRemovedRegistry].sort((a, b) => a.order - b.order).map((h) => h.run);
}

// --- Roster-leave hooks (markRosterLeave, no transaction) ---------------------

export interface RosterLeaveHook {
  /**
   * Stable name, interpolated into the failure log line as
   * `Roster-leave ${name} cleanup failed` — the four founding hooks' names are
   * exactly their table names so those lines stay byte-identical to the old
   * inline `.catch(warn)` messages.
   */
  name: string;
  order: number;
  run: (id: LifecycleIdentity) => Promise<void>;
}

const rosterLeaveRegistry: RosterLeaveHook[] = [];

/**
 * Register a departed-member cleanup for `markRosterLeave` to run. No
 * transaction, matching the pre-registry behaviour: each hook is awaited
 * individually and `.catch(warn)`-isolated by the caller, and `markRosterLeave`
 * still returns `left` unconditionally — a cleanup failure never turns a real
 * departure into a reported no-op.
 */
export function registerOnRosterLeave(hook: RosterLeaveHook): void {
  rosterLeaveRegistry.push(hook);
}

export function onRosterLeaveHooks(): readonly RosterLeaveHook[] {
  return [...rosterLeaveRegistry].sort((a, b) => a.order - b.order);
}
