import { config } from './config.js';
import { logger } from './logger.js';
import { installCrashHandlers } from './crashHandlers.js';
import { configureSubscriptionAuth } from './agent/auth.js';
import { Router } from './router.js';
import { closeDb, healthcheck } from './storage/db.js';
import { verifyEmbeddingDim } from './storage/repository.js';
import { startRetentionPurge } from './interactionRetention.js';
import { startRosterRetentionPurge } from './rosterRetention.js';
import { startContextBuilder, startKnowledgeRefresh, startDocsIngest } from './backgroundJobs.js';
import { pollAnthropicStatus } from './status/anthropicStatus.js';
import { startDisconnectAlerts, startHealthServer } from './health.js';
import { startUsageAlert } from './usageAlert.js';
import { startAdminDigest } from './adminDigest.js';
import type { PlatformAdapter } from './platforms/types.js';
import { DiscordAdapter } from './platforms/discord/adapter.js';
import { BaileysAdapter } from './platforms/whatsapp/baileysAdapter.js';
import { WhatsAppCloudAdapter } from './platforms/whatsapp/cloudAdapter.js';

/**
 * Anthropic status check (off unless STATUS_CHECK_ENABLED). Polls Anthropic's
 * own public status page on a fixed interval and caches the result in memory
 * for check_status to read — a member's turn never triggers a live fetch.
 * See src/status/anthropicStatus.ts.
 */
function startStatusCheck(): ReturnType<typeof setInterval> | null {
  if (!config.statusCheck.enabled) return null;
  const run = () => {
    pollAnthropicStatus().catch((err) => logger.error({ err }, 'Anthropic status check run failed'));
  };
  run();
  const timer = setInterval(run, config.statusCheck.pollMinutes * 60_000);
  timer.unref();
  return timer;
}

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

  // 4b. Optional age-based retention purges (each independently disabled
  //     unless configured — neither's disabled state suppresses the other).
  //     Routed through startTrackedJob for consecutive-failure alerting
  //     (issue #291), hence the `adapters` argument.
  const retentionTimer = startRetentionPurge(adapters);
  const rosterRetentionTimer = startRosterRetentionPurge(adapters);

  // 4c. Sustained-disconnect super-admin alerting (always on; no user-facing
  //     surface to disable) and the optional /healthz endpoint.
  const disconnectAlertTimer = startDisconnectAlerts(adapters);
  const healthServer = await startHealthServer(adapters);

  // 4d. Optional proactive usage alert (disabled unless configured).
  const usageAlertTimer = startUsageAlert(adapters);

  // 4e. Optional offline context builder (disabled unless configured).
  const contextBuilderTimer = startContextBuilder(adapters);

  // 4e-bis. Optional daily knowledge refresh (disabled unless configured).
  const knowledgeRefreshTimer = startKnowledgeRefresh(adapters);

  // 4e-ter. Optional weekly docs ingest (disabled unless configured).
  const docsIngestTimer = startDocsIngest(adapters);

  // 4e-quater. Optional Anthropic status check poll (disabled unless configured).
  const statusCheckTimer = startStatusCheck();

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
    if (knowledgeRefreshTimer) clearInterval(knowledgeRefreshTimer);
    if (docsIngestTimer) clearInterval(docsIngestTimer);
    if (statusCheckTimer) clearInterval(statusCheckTimer);
    if (adminDigestTimer) clearInterval(adminDigestTimer);
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
