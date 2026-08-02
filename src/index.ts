import { config } from './config.js';
import { logger } from './logger.js';
import { installCrashHandlers } from './crashHandlers.js';
import { configureSubscriptionAuth } from './agent/auth.js';
import { Router } from './router.js';
import { closeDb, healthcheck } from './storage/db.js';
import { verifyEmbeddingDim } from './storage/repository.js';
import { startRegisteredJobs, stopRegisteredJobs } from './jobs/registry.js';
import { startHealthServer } from './health.js';
import type { PlatformAdapter } from './platforms/types.js';
import { DiscordAdapter } from './platforms/discord/adapter.js';
import { BaileysAdapter } from './platforms/whatsapp/baileysAdapter.js';
import { WhatsAppCloudAdapter } from './platforms/whatsapp/cloudAdapter.js';

async function main(): Promise<void> {
  logger.info('Starting Community Agent');

  // 0. Global crash handlers first, so an unhandled rejection / uncaught throw
  //    anywhere below is logged (not silent) and an uncaught exception triggers
  //    a clean systemd restart rather than an undefined-state hang.
  installCrashHandlers(logger);

  // 1. Auth: force subscription-based Claude auth.
  configureSubscriptionAuth();

  // 2. Database must be reachable and the vector schema must match config
  //    before we accept traffic.
  await healthcheck();
  await verifyEmbeddingDim(config.db.embeddingDim);
  logger.info('Database reachable, embedding dimension verified');

  // 3. Build platform adapters from config.
  const router = new Router();
  const adapters: PlatformAdapter[] = [];

  adapters.push(new DiscordAdapter());

  if (config.whatsapp.provider === 'baileys') {
    adapters.push(new BaileysAdapter());
  } else if (config.whatsapp.provider === 'cloud') {
    adapters.push(new WhatsAppCloudAdapter());
  } else {
    logger.warn('WhatsApp provider disabled');
  }

  for (const adapter of adapters) {
    router.register(adapter);
  }

  // 4. Start all adapters.
  await Promise.all(adapters.map((a) => a.start()));
  logger.info({ platforms: adapters.map((a) => a.platform) }, 'Community Agent running');

  // 4b. Background jobs — every periodic timer in the process, started in
  //     the registry's pinned order (src/jobs/registry.ts, which preserves
  //     the old hand-wired startX() sequence exactly). Each spec keeps its
  //     own enable gate, cadence mechanism and failure-tracker wiring; a
  //     disabled job contributes a null timer that the shutdown sweep skips.
  const jobs = startRegisteredJobs(adapters);

  // 4c. The optional /healthz endpoint. Deliberately NOT a registry job: it
  //     is an HTTP server, not a timer — no cadence, no failure tracker, and
  //     its close belongs AFTER the drain below so health probes keep
  //     answering while in-flight turns finish. (Pre-registry it started
  //     between disconnect-alerts and the embedding health check; starting
  //     it after the sweep instead is behaviour-neutral — nothing couples
  //     the passive server to job start timing.)
  const healthServer = await startHealthServer(adapters);

  // 5. Graceful shutdown.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    // ONE sweep over the same registry the timers came from — the old
    // hand-mirrored one-clearInterval-per-job list (which had to be kept in
    // sync with the start list by eye) is gone.
    stopRegisteredJobs(jobs);
    // Drain in-flight per-conversation turns BEFORE stopping any adapter, so
    // a reply generated during the drain window can still be sent on a live
    // connection (issue #210). Bounded by SHUTDOWN_DRAIN_TIMEOUT_MS so a
    // stuck turn can't hang shutdown past systemd's TimeoutStopSec.
    await router.drain(config.behaviour.shutdownDrainTimeoutMs);
    if (healthServer) await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await Promise.allSettled(adapters.map((a) => a.stop()));
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
