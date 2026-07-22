import { config } from './config.js';
import { logger } from './logger.js';
import { installCrashHandlers } from './crashHandlers.js';
import { configureSubscriptionAuth } from './agent/auth.js';
import { Router } from './router.js';
import { closeDb, healthcheck } from './storage/db.js';
import { verifyEmbeddingDim } from './storage/repository.js';
import { startRetentionPurge } from './interactionRetention.js';
import { startRosterRetentionPurge } from './rosterRetention.js';
import {
  startContextBuilder,
  startKnowledgeRefresh,
  startDocsIngest,
  startKnowledgeLinkCheck,
  startStatusCheck,
  startEmbeddingHealthCheckJob,
  startDevTeamWatchPoller,
} from './backgroundJobs.js';
import { startDisconnectAlerts, startHealthServer } from './health.js';
import { startUsageAlert } from './usageAlert.js';
import { startUsageCostDigest } from './usageCostDigest.js';
import { startAdminDigest } from './adminDigest.js';
import { startMemberDigest } from './memberDigest.js';
import { startDepartedAdminAlert } from './departedAdminAlert.js';
import { startEngagementAlert } from './engagementAlert.js';
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

  // 4c-bis. Embedding-model health check (always on — zero-cost local
  //         self-test, no enabled flag, same convention as
  //         startDisconnectAlerts; issue #376).
  const embeddingHealthTimer = startEmbeddingHealthCheckJob(adapters);

  // 4d. Optional proactive usage alert (disabled unless configured).
  const usageAlertTimer = startUsageAlert(adapters);

  // 4d-bis. Optional weekly super-admin cost-trend DM (disabled unless configured).
  const usageCostDigestTimer = startUsageCostDigest(adapters);

  // 4e. Optional offline context builder (disabled unless configured).
  const contextBuilderTimer = startContextBuilder(adapters);

  // 4e-bis. Optional daily knowledge refresh (disabled unless configured).
  const knowledgeRefreshTimer = startKnowledgeRefresh(adapters);

  // 4e-ter. Optional weekly docs ingest (disabled unless configured).
  const docsIngestTimer = startDocsIngest(adapters);

  // 4e-ter-bis. Optional weekly knowledge link-rot check (disabled unless configured).
  const knowledgeLinkCheckTimer = startKnowledgeLinkCheck(adapters);

  // 4e-quater. Optional Anthropic status check poll (disabled unless
  //            configured). Routed through backgroundJobs.ts's startStatusCheck
  //            for consecutive-failure alerting (issue #321), hence the
  //            `adapters` argument.
  const statusCheckTimer = startStatusCheck(adapters);

  // 4f. Optional weekly admin recurring-questions digest (disabled unless configured).
  const adminDigestTimer = startAdminDigest(adapters);

  // 4f-bis. Optional departed-admin visibility alert (disabled unless configured).
  const departedAdminAlertTimer = startDepartedAdminAlert(adapters);

  // 4f-ter. Optional weekly engagement-percentage alert (disabled unless configured).
  const engagementAlertTimer = startEngagementAlert(adapters);

  // 4f-quater. Optional weekly member-facing digest channel post (disabled unless configured).
  const memberDigestTimer = startMemberDigest(adapters);

  // 4g. Optional dev-team completion-DM poller (disabled unless DEV_TEAM_ENABLED):
  //     DMs the requester when a dispatched ~20-min job finishes.
  const devTeamWatchTimer = startDevTeamWatchPoller(adapters);

  // 5. Graceful shutdown.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    if (retentionTimer) clearInterval(retentionTimer);
    if (rosterRetentionTimer) clearInterval(rosterRetentionTimer);
    clearInterval(disconnectAlertTimer);
    if (embeddingHealthTimer) clearInterval(embeddingHealthTimer);
    if (usageAlertTimer) clearInterval(usageAlertTimer);
    if (usageCostDigestTimer) clearInterval(usageCostDigestTimer);
    if (contextBuilderTimer) clearInterval(contextBuilderTimer);
    if (knowledgeRefreshTimer) clearInterval(knowledgeRefreshTimer);
    if (docsIngestTimer) clearInterval(docsIngestTimer);
    if (knowledgeLinkCheckTimer) clearInterval(knowledgeLinkCheckTimer);
    if (statusCheckTimer) clearInterval(statusCheckTimer);
    if (adminDigestTimer) clearInterval(adminDigestTimer);
    if (memberDigestTimer) clearInterval(memberDigestTimer);
    if (departedAdminAlertTimer) clearInterval(departedAdminAlertTimer);
    if (engagementAlertTimer) clearInterval(engagementAlertTimer);
    if (devTeamWatchTimer) clearInterval(devTeamWatchTimer);
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
