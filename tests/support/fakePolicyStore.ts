import type { CrossingLatchDeps } from '../../src/module/crossingLatch.js';

/**
 * An in-memory fake of the policy store's `readPolicy`/`updatePolicy` pair,
 * for every crossing-latch stale-alert job's test suite (issue #1198).
 *
 * Every stale-alert test file sets a dummy, unreachable `DATABASE_URL`
 * (matching `tests/departedAdminAlert.test.ts`'s convention), so a job
 * factory called with no `latchDeps` argument would hit the REAL policy
 * store — `readPolicy` would throw `unknown policy key` (never registered in
 * this process), and even if it were registered, would still try a live
 * Postgres connection. Injecting this fake in every call, rather than
 * leaving `latchDeps` undefined, is what keeps these "unit" tests off live
 * Postgres (`docs/STANDARDS.md` → "Injected deps must be all-or-nothing").
 *
 * A fresh, empty store's `readPolicy` resolves `null` for any key — the same
 * "never set" value `COMMUNITY_POLICY_KEYS` registers as every latch key's
 * default — so a test that doesn't care about persistence (every pre-#1198
 * test in these files) sees byte-identical latch behaviour to the old
 * in-memory-only tracker, with no other change needed at its call site.
 */
export function fakePolicyStore(initial: Readonly<Record<string, unknown>> = {}): CrossingLatchDeps & {
  readonly written: ReadonlyArray<{ key: string; value: unknown; updatedBy: string }>;
} {
  const store = new Map<string, unknown>(Object.entries(initial));
  const written: Array<{ key: string; value: unknown; updatedBy: string }> = [];
  return {
    written,
    async readPolicy(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    async updatePolicy(key: string, value: unknown, updatedBy: string) {
      store.set(key, value);
      written.push({ key, value, updatedBy });
    },
  };
}
