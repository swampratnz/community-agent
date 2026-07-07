/**
 * Pure health-check logic (disconnect debounce, /healthz payload shape).
 * Kept free of config/HTTP/adapter imports so it is unit-testable.
 */

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

export interface HealthzPayload {
  status: 'ok' | 'degraded';
  db: boolean;
  adapters: Record<string, boolean>;
}

export function buildHealthzPayload(dbOk: boolean, adapterStatus: Record<string, boolean>): HealthzPayload {
  const allOk = dbOk && Object.values(adapterStatus).every(Boolean);
  return { status: allOk ? 'ok' : 'degraded', db: dbOk, adapters: adapterStatus };
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
