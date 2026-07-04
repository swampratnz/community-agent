import { config } from './config.js';
import { logger } from './logger.js';
import { configureSubscriptionAuth } from './agent/auth.js';
import { Router } from './router.js';
import { closeDb, healthcheck } from './storage/db.js';
import { latestContextDigestAt, purgeOldInteractions, verifyEmbeddingDim } from './storage/repository.js';
import { startRosterRetentionPurge } from './rosterRetention.js';
import { runContextBuilder, shouldRunContextBuilder } from './context/builder.js';
import { writeCommunityContextExport } from './context/export.js';
import { startDisconnectAlerts, startHealthServer } from './health.js';
import { startUsageAlert } from './usageAlert.js';
import { startAdminDigest } from './adminDigest.js';
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

/**
 * Offline context builder (issue #51). Off unless CONTEXT_BUILDER_ENABLED.
 * Ticks every 6h but the ~daily freshness guard (based on the last digest's
 * created_at) makes it effectively one run per day — restart-safe, so the
 * nightly redeploy can't double-run it.
 */
function startContextBuilder(): ReturnType<typeof setInterval> | null {
  if (!config.contextBuilder.enabled) return null;
  const run = async () => {
    try {
      const latest = await latestContextDigestAt();
      if (!shouldRunContextBuilder(latest, Date.now())) return;
      const result = await runContextBuilder();
      logger.info(result, 'Context builder run complete');
      // Regenerate the anonymised export after a producing run (issue #53).
      // Writing the file is automatic; COMMITTING it stays a human step.
      if (config.contextExport.enabled && result.digests > 0) {
        await writeCommunityContextExport();
      }
    } catch (err) {
      logger.error({ err }, 'Context builder run failed');
    }
  };
  void run();
  const timer = setInterval(() => void run(), 6 * 3_600_000);
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

  // 4b. Optional age-based retention purges (each independently disabled
  //     unless configured — neither's disabled state suppresses the other).
  const retentionTimer = startRetentionPurge();
  const rosterRetentionTimer = startRosterRetentionPurge();

  // 4c. Sustained-disconnect super-admin alerting (always on; no user-facing
  //     surface to disable) and the optional /healthz endpoint.
  const disconnectAlertTimer = startDisconnectAlerts(adapters);
  const healthServer = await startHealthServer(adapters);

  // 4d. Optional proactive usage alert (disabled unless configured).
  const usageAlertTimer = startUsageAlert(adapters);

  // 4e. Optional offline context builder (disabled unless configured).
  const contextBuilderTimer = startContextBuilder();

  // 4f. Optional weekly admin recurring-questions digest (disabled unless configured).
  const adminDigestTimer = startAdminDigest(adapters);

  // 5. Graceful shutdown.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    if (retentionTimer) clearInterval(retentionTimer);
    if (rosterRetentionTimer) clearInterval(rosterRetentionTimer);
    clearInterval(disconnectAlertTimer);
    if (usageAlertTimer) clearInterval(usageAlertTimer);
    if (contextBuilderTimer) clearInterval(contextBuilderTimer);
    if (adminDigestTimer) clearInterval(adminDigestTimer);
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
