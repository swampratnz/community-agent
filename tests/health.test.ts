import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// (including WHATSAPP_PROVIDER=cloud config) before importing anything that
// (transitively) loads it. A short HEALTH_ALERT_AFTER_MINUTES keeps the fake
// clock advance below small and readable.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER = 'cloud';
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID ??= 'test-phone-id';
process.env.WHATSAPP_CLOUD_ACCESS_TOKEN ??= 'test-access-token';
process.env.WHATSAPP_CLOUD_VERIFY_TOKEN ??= 'test-verify-token';
process.env.WHATSAPP_CLOUD_APP_SECRET ??= 'test-app-secret';
process.env.HEALTH_ALERT_AFTER_MINUTES = '1';

const { startDisconnectAlerts } = await import('../src/health.js');
const { WhatsAppCloudAdapter } = await import('../src/platforms/whatsapp/cloudAdapter.js');
const { logger } = await import('../src/logger.js');

test('a WhatsApp Cloud adapter whose consecutive-send-failure counter has crossed the threshold is reported disconnected, and health.ts still fires the sustained-disconnect error log even with no other adapter to DM through', (t) => {
  const adapter = new WhatsAppCloudAdapter();
  // Simulate `start()` having succeeded (listener up) and 3 consecutive
  // real-message send failures (e.g. a revoked access token), without
  // spinning up a real HTTP server or making real Graph API calls.
  (adapter as unknown as { server: object }).server = {};
  (adapter as unknown as { consecutiveSendFailures: number }).consecutiveSendFailures = 3;
  assert.equal(
    adapter.isConnected(),
    false,
    'isConnected() must reflect the crossed threshold so health.ts has something real to alert on',
  );

  const errorLogs: unknown[][] = [];
  t.mock.method(logger, 'error', (...args: unknown[]) => {
    errorLogs.push(args);
  });
  // alertSuperAdmins DMs through connected adapters only; with a single,
  // disconnected adapter there is nothing to send through, but the error
  // log below must still fire as the backstop so the outage is never silent.
  t.mock.method(adapter, 'sendDirectMessage', async () => {
    throw new Error('unreachable: the only adapter is reported disconnected, so no DM should be attempted');
  });

  // health.ts's check() reads Date.now() internally, so the fake clock must
  // move Date along with the interval timer or the debounce math (`now -
  // disconnectedSince`) still sees real wall-clock time.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const timer = startDisconnectAlerts([adapter]);
  try {
    t.mock.timers.tick(30_000); // first 30s check: disconnect begins
    t.mock.timers.tick(60_000); // past HEALTH_ALERT_AFTER_MINUTES=1
  } finally {
    clearInterval(timer);
  }

  assert.ok(
    errorLogs.some((args) => args[1] === 'Platform sustained disconnect'),
    'the error-level log must fire as a backstop even when no adapter is connected to DM through',
  );
});
