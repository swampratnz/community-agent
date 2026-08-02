import { embed } from '../storage/embeddings.js';
import { makeSlidingWindowReserver } from '../util/rateReservation.js';

/**
 * The WebSearch guard (issues #412, #589, #706), extracted from `tools.ts`:
 * WebSearch is a built-in SDK tool rather than one of the MCP tools
 * `tools.ts` hosts, so it is gated via a `PreToolUse` hook in `core.ts`
 * instead of inline in a tool handler. This module owns everything that hook
 * needs — the per-conversation volume cap, the query-level dedup (exact
 * match, then embedding similarity), and the per-conversation lock that
 * keeps the check-then-record critical section atomic.
 */

/**
 * Reserve one WebSearch slot for `conversationId` against a rolling hourly
 * cap (`config.llm.webSearchRateLimitPerHour`, issue #412) — the shared
 * `makeSlidingWindowReserver` primitive, per-conversation-keyed like the
 * tool caps in `tools.ts`. Returns false without reserving if the
 * conversation already hit `limit` within the last hour. Called by
 * `core.ts`'s `buildQueryOptions` PreToolUse hook.
 */
export const reserveWebSearchSlot = makeSlidingWindowReserver(60 * 60 * 1000);

/** Trim, collapse internal whitespace, and casefold a WebSearch query for exact-match dedup comparison. */
function normalizeWebSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Cosine similarity of two `embed()`-produced (already L2-normalized) vectors — dot product suffices. Local per-file copy, same duplicated-not-shared convention as repository.ts/context/builder.ts's own `cosineSim`. */
function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Recent (normalized query, timestamp, embedding) triples per conversation,
 * for WebSearch query-level dedup (issue #589, embedding-similarity upgrade
 * #706). In-memory only — same durability class as the volume cap right
 * above: a restart just forgets recent queries, harmless. Deliberately holds
 * nothing but the normalized query text, its timestamp, and its embedding
 * vector; never written to `interactions`/`admin_audit` or logged (this
 * module has no DB handle in scope, and the caller in `core.ts` only ever
 * logs `{ err, conversationId }` on failure, never the query or its
 * embedding).
 */
const webSearchQueryHistoryByConversation = new Map<
  string,
  Array<{ query: string; ts: number; embedding: number[] }>
>();

/**
 * Per-conversation serialization queue for the dedup check-then-record
 * critical section (adversarial review on issue #706). Before that PR, the
 * whole `PreToolUse` hook body ran with no `await` at all, so JS
 * run-to-completion semantics meant two "parallel" tool-use invocations for
 * the same turn could never interleave — one hook call always finished
 * (check AND record) before the next began. Adding `await embed()` inside
 * `isDuplicateWebSearchQuery` introduced a genuine yield point: without this
 * lock, two near-simultaneous WebSearch calls in one turn could both read
 * `recent` before either recorded, both compute embeddings concurrently, and
 * neither would see the other as a duplicate — defeating even the
 * exact-match short-circuit for the race window. `withWebSearchDedupLock`
 * restores the pre-#706 atomicity: the caller in `core.ts` wraps the entire
 * check -> volume-reserve -> record sequence in this lock, so a second
 * invocation for the same `conversationId` cannot start its own check until
 * the first has fully finished (recorded or not). Chained via a promise
 * queue rather than a real mutex library since Node has no built-in one;
 * the stored continuation always resolves (never rejects) so one failed
 * turn's error can't wedge the queue for the rest of the conversation, while
 * the promise returned to the caller still propagates `fn`'s own
 * rejection/return value untouched. Never cleared, same as every other
 * per-conversation map in this module — a restart just forgets, harmless.
 */
const webSearchDedupLocks = new Map<string, Promise<void>>();

export function withWebSearchDedupLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prior = webSearchDedupLocks.get(conversationId) ?? Promise.resolve();
  const settled = prior.catch(() => {});
  const result = settled.then(fn);
  webSearchDedupLocks.set(
    conversationId,
    result.then(
      () => {},
      () => {},
    ),
  );
  return result;
}

/**
 * Returns `{ duplicate: true }` if `query` either (a) once normalized,
 * exactly matches one of the queries recorded for `conversationId` within
 * `windowMs`, or (b) embeds above `similarityThreshold` cosine similarity
 * against one of those queries' stored embeddings — the "search, get an
 * unsatisfying result, reformulate almost identically (or exactly),
 * search again" agentic-loop failure mode (issue #589; embedding upgrade
 * #706, the growth path #589 itself named).
 *
 * The exact-match check runs FIRST and short-circuits before any `embed()`
 * call — same true-short-circuit discipline already proven for
 * `candidateTopicAlreadyReviewed` (`repository.ts`, issue #503 AC1): a
 * verbatim repeat never pays for an embedding. Only when no exact match is
 * found does this embed the (normalized) query and compare it against the
 * window's stored embeddings. The returned `embedding` is the vector this
 * call computed (or `null` when the exact-match path short-circuited, or
 * the query normalized to empty) — callers reuse it for `recordWebSearchQuery`
 * instead of embedding a second time, same reuse-not-recompute discipline as
 * `candidateTopicAlreadyReviewed`/`insertKnowledgeCandidate` (issue #503).
 *
 * Pure check otherwise: it prunes window-expired entries (so the stored
 * history doesn't grow unboundedly across calls that never record) but
 * never itself records `query` — a genuine repeat is therefore also never
 * re-recorded, so its timestamp keeps anchoring the original window instead
 * of extending it. An empty/non-string query (normalizes to `''`) never
 * matches, so a missing `tool_input.query` can't wedge the guard.
 *
 * A thrown/rejected `embed()` call is deliberately NOT caught here — it
 * propagates to the caller's own fail-closed try/catch (`core.ts`'s
 * `PreToolUse` hook, issue #412 AC-5 / #589 review), denying the call rather
 * than silently falling back to exact-match-only (issue #706 SECURITY
 * criterion).
 *
 * Recording is a SEPARATE step (`recordWebSearchQuery`) that callers must
 * invoke only once the call is actually going to proceed — i.e. AFTER
 * `reserveWebSearchSlot` also confirms it, not just after this check passes.
 * Recording here unconditionally (as an earlier version of this guard did)
 * let a query that was later denied by the volume cap poison the dedup
 * history: a retry of that exact query would then be wrongly denied as
 * "already searched" even though no search ever ran (issue #589 review).
 */
export async function isDuplicateWebSearchQuery(
  conversationId: string,
  query: string,
  windowMs: number,
  similarityThreshold: number,
): Promise<{ duplicate: boolean; embedding: number[] | null }> {
  const normalized = normalizeWebSearchQuery(query);
  const now = Date.now();
  const recent = (webSearchQueryHistoryByConversation.get(conversationId) ?? []).filter(
    (entry) => now - entry.ts < windowMs,
  );
  webSearchQueryHistoryByConversation.set(conversationId, recent);
  if (normalized.length === 0) return { duplicate: false, embedding: null };
  if (recent.some((entry) => entry.query === normalized)) {
    return { duplicate: true, embedding: null };
  }

  const embedding = await embed(normalized);
  const duplicate = recent.some((entry) => cosineSim(embedding, entry.embedding) >= similarityThreshold);
  return { duplicate, embedding };
}

/**
 * Record `query` as seen for `conversationId`, trimmed to the last
 * `historySize` entries (oldest evicted first). `embedding` must be the
 * SAME vector `isDuplicateWebSearchQuery` already computed for this exact
 * call — passed through rather than re-embedded (issue #706, mirroring
 * `candidateTopicAlreadyReviewed`/`insertKnowledgeCandidate`'s reuse
 * discipline, issue #503). Callers must only call this once a WebSearch
 * call is confirmed to actually proceed (after BOTH `isDuplicateWebSearchQuery`
 * returns `duplicate: false` AND `reserveWebSearchSlot` returns true) — see
 * the ordering note on `isDuplicateWebSearchQuery`. An empty/non-string query
 * (normalizes to `''`) is never recorded, so a missing `tool_input.query`
 * can't wedge the guard.
 */
export function recordWebSearchQuery(
  conversationId: string,
  query: string,
  windowMs: number,
  historySize: number,
  embedding: number[] | null,
): void {
  const normalized = normalizeWebSearchQuery(query);
  if (normalized.length === 0) return;
  const now = Date.now();
  const recent = (webSearchQueryHistoryByConversation.get(conversationId) ?? []).filter(
    (entry) => now - entry.ts < windowMs,
  );
  // `embedding` is only ever `null` from `isDuplicateWebSearchQuery` when `normalized` was
  // already empty (this function's own early return above already excludes that) or on an
  // exact-match duplicate (which the caller never proceeds to record) — so this `?? []` is
  // defensive against the parameter's type, not a reachable runtime path.
  recent.push({ query: normalized, ts: now, embedding: embedding ?? [] });
  while (recent.length > historySize) recent.shift();
  webSearchQueryHistoryByConversation.set(conversationId, recent);
}
