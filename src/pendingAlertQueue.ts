import type { Platform } from './platforms/types.js';

// Shared best-effort queue for super-admin alerts that couldn't be delivered
// live because every relevant adapter was disconnected. Originally owned by
// health.ts (issue #534); extracted into this leaf module (no imports from
// health.ts/backgroundJobs.ts/tools.ts) so those three producers can share
// one bounded queue instead of each dropping the alert on the floor (issue
// #545). Flushing stays health.ts's job — it owns the reconnect-detection
// logic (`flushPendingAlerts`) that drains this queue. `platforms/types.ts`
// is imported for the `Platform` type only — it's dependency-free itself, so
// this doesn't reintroduce the health.ts/backgroundJobs.ts/tools.ts cycle the
// comment above guards against.
//
// `recipients` (issue #625) lets a producer with a distinct, non-superAdmin
// audience (`tools.ts`'s `notifyAdmins`, sourced from `listAdmins()`) queue an
// entry that preserves that recipient set through a total-outage window
// instead of silently dropping. Every other producer omits it, and
// `flushPendingAlerts` keeps flushing those entries to `superAdminIds()`
// exactly as before — this is additive, not a behaviour change for anyone
// else. The set is frozen at queue time (not re-resolved at flush) — see
// health.ts's `flushPendingAlerts` for why.

// Bounded so a persistently-disconnected deployment can't accumulate an
// unbounded backlog; on overflow an entry is evicted per the priority rule in
// queuePendingAlert. Shared across all producers combined, not per-producer.
export const PENDING_ALERT_QUEUE_CAP = 5;

// Trust level of the alert's PRODUCER, which decides eviction when the shared
// queue is full (issue #545 review). Sharing one FIFO-capped queue between a
// member-reachable producer and the system alerts introduced a priority
// inversion: `tools.ts`'s `notifySuperAdmins` is reachable from member-tier
// tools (`report_content` — capped at exactly PENDING_ALERT_QUEUE_CAP/day — and
// `appeal_moderation`), so during an outbound outage a single member filing
// their daily reports could evict, via the old oldest-dropped policy, the
// disconnect / job-failure alerts admins most need during exactly that
// incident. Priority closes that: a 'low' alert can never displace a 'system'
// alert.
//   'system' — health.ts disconnect + backgroundJobs.ts job-failure alerts,
//              only ever triggered by the bot's own health/job machinery.
//   'low'    — tools.ts `notifySuperAdmins`, reachable from member-tier tools.
export type AlertPriority = 'system' | 'low';

/** A single recipient, platform-qualified since a queued entry's audience may span platforms. */
export interface PendingAlertRecipient {
  platform: Platform;
  platformUserId: string;
}

export interface PendingAlert {
  message: string;
  priority: AlertPriority;
  // Absent (the common case) = today's superAdminIds(adapter.platform) flush
  // behaviour. Present = deliver only to these recipients, filtered to the
  // reconnected adapter's platform (issue #625).
  recipients?: PendingAlertRecipient[];
}

// Messages that couldn't be delivered live because every adapter was
// disconnected. Flushed through the first adapter to reconnect (see
// health.ts's `flushPendingAlerts`), then cleared. In-memory only — clears on
// restart, same as every other best-effort notification convention in this
// codebase. Insertion order is preserved so the flush delivers roughly FIFO.
const pendingAlerts: PendingAlert[] = [];

export function queuePendingAlert(
  message: string,
  priority: AlertPriority,
  recipients?: PendingAlertRecipient[],
): void {
  if (pendingAlerts.length < PENDING_ALERT_QUEUE_CAP) {
    pendingAlerts.push({ message, priority, recipients });
    return;
  }
  // Full. Evict the OLDEST 'low' (member-reachable) entry to make room — so a
  // 'system' alert never displaces another 'system' alert while a 'low' one
  // could be dropped instead, and (crucially) a 'low' alert never displaces a
  // 'system' alert.
  const oldestLow = pendingAlerts.findIndex((a) => a.priority === 'low');
  if (oldestLow !== -1) {
    pendingAlerts.splice(oldestLow, 1);
    pendingAlerts.push({ message, priority, recipients });
    return;
  }
  // The queue is entirely 'system' alerts (a genuine multi-failure outage). A
  // new 'system' alert still bounds the backlog by dropping the oldest (FIFO,
  // as before). A new 'low' alert is REJECTED rather than evicting a system
  // alert — this is the core inversion fix; the dropped 'low' alert is no worse
  // off than it was pre-#545, when tools.ts alerts were dropped outright.
  if (priority === 'system') {
    pendingAlerts.shift();
    pendingAlerts.push({ message, priority, recipients });
  }
}

/** Shallow copy of the queued MESSAGES for read — tests can inspect the queue without mutating it. */
export function getPendingAlertsForTests(): readonly string[] {
  return pendingAlerts.map((a) => a.message);
}

/**
 * Shallow copy of the full queued ENTRIES (including `recipients`) for read
 * — tests can assert a recipient-less producer's entries carry no
 * `recipients` field without draining (and thereby clearing) the queue.
 * `getPendingAlertsForTests` above is left returning message-only strings so
 * every existing deepEqual-against-strings test stays byte-identical.
 */
export function getPendingAlertEntriesForTests(): readonly PendingAlert[] {
  return pendingAlerts.map((a) => ({ ...a }));
}

export function resetPendingAlertsForTests(): void {
  pendingAlerts.length = 0;
}

/**
 * Drains and returns every queued entry, clearing the queue. Exported so
 * health.ts's `flushPendingAlerts` can consume the shared queue without
 * reaching into this module's private array. Returns the full structured
 * entry (not just the message) so flush can see `recipients`.
 */
export function drainPendingAlerts(): PendingAlert[] {
  return pendingAlerts.splice(0, pendingAlerts.length);
}
