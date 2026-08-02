/**
 * The three in-memory rate-reservation primitives behind every keyed cap in
 * this codebase, extracted from `agent/tools.ts`'s per-cap copies. All three
 * share the same posture: in-memory only (a restart forgets the window —
 * accepted everywhere these are used), reservations are never refunded on a
 * later failure (a failed attempt still spent the resource being bounded, and
 * refunds would let induced-failure retry spam bypass the cap), and each
 * factory call owns a private map, so distinct caps can never consume each
 * other's budget. Keys are caller-chosen; anything per-user crossing
 * platforms MUST be platform-qualified (e.g. `` `discord:${senderId}` ``) so
 * colliding ids on different platforms don't share a bucket (issue #732).
 */

/**
 * Rolling sliding-window reserver: at most `limit` reservations per `key`
 * within the trailing `windowMs`. Returns false without reserving once a key
 * is at its limit; expired timestamps are pruned on every call, so no
 * external sweep is needed. Callers that treat `limit` 0 as "unlimited" must
 * skip the call themselves (the voice-transcription cap's documented
 * contract) — a literal `limit` of 0 here refuses everything, which is what
 * the tool caps want.
 */
export function makeSlidingWindowReserver(windowMs: number): (key: string, limit: number) => boolean {
  const timestampsByKey = new Map<string, number[]>();
  return (key: string, limit: number): boolean => {
    const now = Date.now();
    const recent = (timestampsByKey.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      timestampsByKey.set(key, recent);
      return false;
    }
    recent.push(now);
    timestampsByKey.set(key, recent);
    return true;
  };
}

/**
 * UTC-calendar-day reserver: at most `limit` reservations per `key` per UTC
 * day, resetting at midnight UTC (not a rolling 24h window). A `limit` of 0
 * or below means unlimited — the daily caps' existing contract, opposite to
 * the sliding-window reserver above, so callers pick the primitive whose
 * zero-semantics they documented.
 */
export function makeCalendarDayReserver(): (key: string, limit: number) => boolean {
  const dailyByKey = new Map<string, { day: string; count: number }>();
  return (key: string, limit: number): boolean => {
    if (limit <= 0) return true;
    const today = new Date().toISOString().slice(0, 10);
    const entry = dailyByKey.get(key);
    if (!entry || entry.day !== today) {
      dailyByKey.set(key, { day: today, count: 1 });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  };
}

/**
 * Per-key cooldown reserver: one reservation per `key` per trailing
 * `windowMs`, re-arming only once the full window has elapsed since the last
 * successful reservation. Unlike the sliding-window reserver this stores a
 * single timestamp per key, so a refused attempt never extends the cooldown.
 */
export function makeCooldownReserver(): (key: string, windowMs: number) => boolean {
  const lastAtByKey = new Map<string, number>();
  return (key: string, windowMs: number): boolean => {
    const now = Date.now();
    const last = lastAtByKey.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    lastAtByKey.set(key, now);
    return true;
  };
}
