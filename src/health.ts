import { createServer, type Server, type ServerResponse } from 'node:http';
import { config } from './config.js';
import { logger } from './logger.js';
import { superAdminIds } from './auth/roles.js';
import { healthcheck } from './storage/db.js';
import {
  buildHealthzPayload,
  buildReadyzPayload,
  initialTracker,
  stepDisconnectTracker,
  type DisconnectTracker,
} from './healthState.js';
import type { PlatformAdapter } from './platforms/types.js';

const CHECK_INTERVAL_MS = 30_000;

/**
 * Periodic check across all registered adapters; on a sustained disconnect
 * past HEALTH_ALERT_AFTER_MINUTES, DMs configured super admins via whichever
 * adapter(s) are still connected and logs at error level. Debounced (see
 * healthState.ts) so a long outage produces exactly one alert.
 */
export function startDisconnectAlerts(adapters: readonly PlatformAdapter[]): ReturnType<typeof setInterval> {
  const afterMs = config.behaviour.healthAlertAfterMinutes * 60_000;
  const trackers = new Map<PlatformAdapter, DisconnectTracker>(adapters.map((a) => [a, initialTracker()]));

  const check = () => {
    const now = Date.now();
    for (const adapter of adapters) {
      const { tracker, shouldAlert, justReconnected } = stepDisconnectTracker(
        trackers.get(adapter) ?? initialTracker(),
        adapter.isConnected(),
        now,
        afterMs,
      );
      trackers.set(adapter, tracker);
      if (justReconnected) {
        logger.info({ platform: adapter.platform }, 'Platform reconnected');
      }
      if (shouldAlert) {
        logger.error(
          { platform: adapter.platform, afterMinutes: config.behaviour.healthAlertAfterMinutes },
          'Platform sustained disconnect',
        );
        void alertSuperAdmins(
          adapters,
          `🔴 ${adapter.platform} has been disconnected for over ${config.behaviour.healthAlertAfterMinutes} minute(s).`,
        );
      }
    }
  };
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref();
  return timer;
}

async function alertSuperAdmins(adapters: readonly PlatformAdapter[], message: string): Promise<void> {
  for (const adapter of adapters) {
    if (!adapter.isConnected()) continue; // can't send through a dead connection
    for (const id of superAdminIds(adapter.platform)) {
      adapter
        .sendDirectMessage(id, message)
        .catch((err) => logger.warn({ err, platform: adapter.platform, id }, 'Health alert DM failed'));
    }
  }
}

/**
 * Health endpoints (native http, no auth, booleans only — no message content
 * or user ids). Disabled unless HEALTH_PORT is set. Binds to HEALTH_HOST,
 * which defaults to loopback so the unauthenticated server isn't reachable
 * off-box (issue #220); front it with a reverse proxy or set HEALTH_HOST to
 * expose it.
 *
 *   GET /healthz -> {status, db, adapters} — adapter-aware; degraded (503) if
 *                   any chat adapter is disconnected. For monitoring.
 *   GET /readyz  -> {status, db} — liveness + DB only, independent of adapter
 *                   connectivity (issue #216). Point the deploy HEALTH_URL
 *                   here so a reconnecting socket can't roll a good build back.
 */
export function startHealthServer(adapters: readonly PlatformAdapter[]): Promise<Server | null> {
  const port = config.behaviour.healthPort;
  if (!port) return Promise.resolve(null);
  const host = config.behaviour.healthHost;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const path = req.url ? new URL(req.url, 'http://localhost').pathname : '/';
      if (req.method !== 'GET' || (path !== '/healthz' && path !== '/readyz')) {
        res.writeHead(404).end();
        return;
      }
      const handler = path === '/readyz' ? handleReadyz(res) : handleHealthz(adapters, res);
      handler.catch((err) => {
        logger.error({ err }, 'Health check failed');
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      logger.info({ port, host }, 'Health endpoint listening');
      resolve(server);
    });
  });
}

async function handleHealthz(adapters: readonly PlatformAdapter[], res: ServerResponse): Promise<void> {
  let dbOk = true;
  try {
    await healthcheck();
  } catch {
    dbOk = false;
  }
  const adapterStatus: Record<string, boolean> = {};
  for (const adapter of adapters) adapterStatus[adapter.platform] = adapter.isConnected();

  const payload = buildHealthzPayload(dbOk, adapterStatus);
  res
    .writeHead(payload.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' })
    .end(JSON.stringify(payload));
}

async function handleReadyz(res: ServerResponse): Promise<void> {
  let dbOk = true;
  try {
    await healthcheck();
  } catch {
    dbOk = false;
  }
  const payload = buildReadyzPayload(dbOk);
  res
    .writeHead(payload.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' })
    .end(JSON.stringify(payload));
}
