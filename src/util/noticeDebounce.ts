/**
 * The one shared "at most once per rolling window" notice debounce: notify
 * when there is no prior notice, or when the window has fully elapsed since
 * the last one. Every debounced notice in this codebase (per-user rate-limit
 * and pause notices, the process-wide budget-check-failure and muted-role
 * alerts, the WhatsApp/Discord voice-language caveat) re-exports this under
 * its own domain name — the caller keeps a readable, purpose-named predicate
 * while the semantics live in exactly one place. Callers own their timestamp
 * state and pass `now` in, so the predicate stays pure and clock-injectable
 * for tests.
 */
export function shouldNotifyAfterWindow(
  lastNotifiedAt: number | undefined,
  now: number,
  windowMs: number,
): boolean {
  return lastNotifiedAt === undefined || now - lastNotifiedAt > windowMs;
}
