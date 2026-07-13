/**
 * Pure health-check logic (disconnect debounce, /healthz payload shape).
 * Kept free of config/HTTP/adapter imports so it is unit-testable.
 */

import type { BackgroundJobName, JobHealthSnapshot } from './backgroundJobHealth.js';

export interface DisconnectTracker {
  disconnectedSince: number | null;
  alerted: boolean;
}

export function initialTracker(): DisconnectTracker {
  return { disconnectedSince: null, alerted: false };
}

/**
 * Pure state transition for the sustained-disconnect debounce: an alert
 * fires once per outage (not once per check interval), and reconnecting
 * clears the tracker silently so recovery never itself alerts.
 */
export function stepDisconnectTracker(
  tracker: DisconnectTracker,
  connected: boolean,
  now: number,
  afterMs: number,
): { tracker: DisconnectTracker; shouldAlert: boolean; justReconnected: boolean } {
  if (connected) {
    return {
      tracker: initialTracker(),
      shouldAlert: false,
      justReconnected: tracker.disconnectedSince !== null,
    };
  }
  const disconnectedSince = tracker.disconnectedSince ?? now;
  const shouldAlert = now - disconnectedSince >= afterMs && !tracker.alerted;
  return {
    tracker: { disconnectedSince, alerted: tracker.alerted || shouldAlert },
    shouldAlert,
    justReconnected: false,
  };
}

/** JSON-friendly (ISO timestamp) projection of a JobHealthSnapshot for the wire — see buildHealthzPayload. */
export interface JobHealthPayload {
  consecutiveFailures: number;
  lastRunAt: string;
  lastSuccessAt: string | null;
}

export interface HealthzPayload {
  status: 'ok' | 'degraded';
  db: boolean;
  adapters: Record<string, boolean>;
  jobs?: Record<string, JobHealthPayload>;
}

/**
 * `jobHealth` is optional and, when empty/omitted, the payload is
 * byte-identical to the pre-#467 shape (no `jobs` key at all) — a deployment
 * with every optional background job disabled sees no change. When present, a
 * job whose tracker has crossed its own alert threshold (`alerted === true` —
 * a CONFIRMED outage, not a single sub-threshold blip) also flips the
 * top-level `status` to `"degraded"`, the same signal `db`/`adapters` already
 * contribute. Never widen this beyond the fixed enum key + integer + ISO
 * timestamp fields below: `/healthz` is unauthenticated and world-reachable if
 * `HEALTH_HOST` is opened, so no dynamic string (an error message, a stack)
 * may ever reach this payload.
 */
export function buildHealthzPayload(
  dbOk: boolean,
  adapterStatus: Record<string, boolean>,
  jobHealth?: Partial<Record<BackgroundJobName, JobHealthSnapshot>>,
): HealthzPayload {
  const entries = jobHealth ? Object.entries(jobHealth) : [];
  const anyJobAlerted = entries.some(([, snapshot]) => snapshot.alerted);
  const allOk = dbOk && Object.values(adapterStatus).every(Boolean) && !anyJobAlerted;
  const payload: HealthzPayload = { status: allOk ? 'ok' : 'degraded', db: dbOk, adapters: adapterStatus };
  if (entries.length > 0) {
    payload.jobs = Object.fromEntries(
      entries.map(([name, snapshot]) => [
        name,
        {
          consecutiveFailures: snapshot.consecutiveFailures,
          lastRunAt: new Date(snapshot.lastRunAt).toISOString(),
          lastSuccessAt:
            snapshot.lastSuccessAt === null ? null : new Date(snapshot.lastSuccessAt).toISOString(),
        },
      ]),
    );
  }
  return payload;
}

export interface ReadyzPayload {
  status: 'ok' | 'degraded';
  db: boolean;
}

/**
 * Readiness/liveness payload for /readyz: process is up AND the DB is
 * reachable, deliberately independent of chat-adapter connectivity. A
 * WhatsApp/Discord reconnect (which /healthz reports as degraded) must NOT
 * make a deploy health-check roll the release back — the new build is running
 * fine, it just hasn't finished reconnecting a socket (issue #216). Point the
 * redeploy HEALTH_URL at /readyz; keep /healthz for adapter-aware monitoring.
 */
export function buildReadyzPayload(dbOk: boolean): ReadyzPayload {
  return { status: dbOk ? 'ok' : 'degraded', db: dbOk };
}
