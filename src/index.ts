import { config } from './config.js';
import { logger } from './logger.js';
import { configureSubscriptionAuth } from './agent/auth.js';
import { Router } from './router.js';
import { closeDb, healthcheck } from './storage/db.js';
import { purgeOldInteractions, verifyEmbeddingDim } from './storage/repository.js';
import { startDisconnectAlerts, startHealthServer } from './health.js';
import type { PlatformAdapter } from './platforms/types.js';
import { DiscordAdapter } from './platforms/discord/adapter.js';
import { BaileysAdapter } from './platforms/whatsapp/baileysAdapter.js';
import { WhatsAppCloudAdapter } from './platforms/whatsapp/cloudAdapter.js';

const DAY_MS = 24 * 60 * 60_000;

/**
 * Age-based purge of raw `interactions` (SECURITY.md retention policy). Off
 * unless INTERACTION_RETENTION_DAYS is set. Runs once immediately (so
 * operators see it working without waiting a day) and then daily.
 */
function startRetentionPurge(): ReturnType<typeof setInterval> | null {
  const days = config.behaviour.interactionRetentionDays;
  if (days <= 0) return null;
  const run = () => {
    purgeOldInteractions(days)
      .then((count) => logger.info({ days, count }, 'Purged old interactions (retention policy)'))
      .catch((err) => logger.error({ err }, 'Interaction retention purge failed'));
  };
  run();
  const timer = setInterval(run, DAY_MS);
  timer.unref();
  return timer;
}

async function main(): Promise<void> {
  logger.info('Starting Community Agent');

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

  // 4b. Optional age-based retention purge (disabled unless configured).
  const retentionTimer = startRetentionPurge();

  // 4c. Sustained-disconnect super-admin alerting (always on; no user-facing
  //     surface to disable) and the optional /healthz endpoint.
  const disconnectAlertTimer = startDisconnectAlerts(adapters);
  const healthServer = await startHealthServer(adapters);

  // 5. Graceful shutdown.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    if (retentionTimer) clearInterval(retentionTimer);
    clearInterval(disconnectAlertTimer);
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
