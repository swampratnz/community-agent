// Shared best-effort queue for super-admin alerts that couldn't be delivered
// live because every relevant adapter was disconnected. Originally owned by
// health.ts (issue #534); extracted into this leaf module (no imports from
// health.ts/backgroundJobs.ts/tools.ts) so those three producers can share
// one bounded queue instead of each dropping the alert on the floor (issue
// #545). Flushing stays health.ts's job — it owns the reconnect-detection
// logic (`flushPendingAlerts`) that drains this queue.

// Bounded so a persistently-disconnected deployment can't accumulate an
// unbounded backlog; oldest is dropped once full (see queuePendingAlert).
// Shared across all producers combined, not per-producer.
export const PENDING_ALERT_QUEUE_CAP = 5;

// Messages that couldn't be delivered live because every adapter was
// disconnected. Flushed through the first adapter to reconnect (see
// health.ts's `flushPendingAlerts`), then cleared. In-memory only — clears on
// restart, same as every other best-effort notification convention in this
// codebase.
const pendingAlerts: string[] = [];

export function queuePendingAlert(message: string): void {
  pendingAlerts.push(message);
  if (pendingAlerts.length > PENDING_ALERT_QUEUE_CAP) pendingAlerts.shift();
}

/** Shallow copy for read — tests can inspect the queue without mutating it. */
export function getPendingAlertsForTests(): readonly string[] {
  return [...pendingAlerts];
}

export function resetPendingAlertsForTests(): void {
  pendingAlerts.length = 0;
}

/**
 * Drains and returns every queued message, clearing the queue. Exported so
 * health.ts's `flushPendingAlerts` can consume the shared queue without
 * reaching into this module's private array.
 */
export function drainPendingAlerts(): string[] {
  return pendingAlerts.splice(0, pendingAlerts.length);
}
