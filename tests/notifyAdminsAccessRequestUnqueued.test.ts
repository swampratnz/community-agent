import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Regression coverage for issue #593's binding acceptance criterion 6:
// tools.ts's notifyAdmins and router.ts's notifyAccessRequest source
// recipients from the broader, guild-wide listAdmins() rather than
// superAdminIds(), and the shared pending-alert queue's bare-string entries
// can't preserve that distinct recipient set on flush (issue #571's
// rejection rationale) — so #593 deliberately does NOT extend the queue to
// either site. This file pins that they still drop-on-full-disconnect,
// unqueued, so a future change can't silently narrow #571's rejected scope
// back in.
//
// listAdmins() is a static import inside agent/tools.ts, so it must be
// mocked before anything imports that module (same trap as
// tests/usageAlertFailureTracker.test.ts).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

let modulesPromise: Promise<{
  notifyAdmins: typeof import('../src/agent/tools.js').notifyAdmins;
  notifyAccessRequest: typeof import('../src/router.js').notifyAccessRequest;
  getPendingAlertsForTests: typeof import('../src/pendingAlertQueue.js').getPendingAlertsForTests;
  resetPendingAlertsForTests: typeof import('../src/pendingAlertQueue.js').resetPendingAlertsForTests;
}> | null = null;
async function modules(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!modulesPromise) {
    modulesPromise = (async () => {
      const realRepo = await import('../src/storage/repository.js');
      t.mock.module('../src/storage/repository.js', {
        namedExports: {
          ...realRepo,
          listAdmins: async () => [{ platform: 'discord' as const, platformUserId: 'admin-1' }],
        },
      });
      const [{ notifyAdmins }, { notifyAccessRequest }, pendingAlertQueue] = await Promise.all([
        import('../src/agent/tools.js'),
        import('../src/router.js'),
        import('../src/pendingAlertQueue.js'),
      ]);
      return {
        notifyAdmins,
        notifyAccessRequest,
        getPendingAlertsForTests: pendingAlertQueue.getPendingAlertsForTests,
        resetPendingAlertsForTests: pendingAlertQueue.resetPendingAlertsForTests,
      };
    })();
  }
  return modulesPromise;
}

function makeDisconnectedAdapter(): {
  adapter: PlatformAdapter;
  dms: Array<{ userId: string; text: string }>;
} {
  const dms: Array<{ userId: string; text: string }> = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => false,
    onMessage() {},
    async sendMessage(_out: OutgoingMessage) {},
    async sendDirectMessage(userId: string, text: string) {
      dms.push({ userId, text });
    },
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return { adapter, dms };
}

test('SECURITY: notifyAdmins (tools.ts) with every adapter disconnected still drops the alert — never queued (issue #571/#593)', async (t) => {
  const { notifyAdmins, getPendingAlertsForTests, resetPendingAlertsForTests } = await modules(t);
  resetPendingAlertsForTests();
  const { adapter, dms } = makeDisconnectedAdapter();

  await notifyAdmins(
    (platform) => (platform === 'discord' ? adapter : undefined),
    'admin-audience alert',
    '',
  );

  assert.equal(dms.length, 0, 'no send is attempted through the disconnected adapter');
  assert.deepEqual(
    getPendingAlertsForTests(),
    [],
    'notifyAdmins must remain drop-on-full-disconnect — its listAdmins() recipient set cannot survive the shared bare-string queue',
  );
  resetPendingAlertsForTests();
});

test('SECURITY: notifyAccessRequest (router.ts) with every adapter disconnected still drops the alert — never queued (issue #571/#593)', async (t) => {
  const { notifyAccessRequest, getPendingAlertsForTests, resetPendingAlertsForTests } = await modules(t);
  resetPendingAlertsForTests();
  const { adapter, dms } = makeDisconnectedAdapter();

  await notifyAccessRequest((platform) => (platform === 'discord' ? adapter : undefined), {
    platform: 'discord',
    userId: 'guest-1',
    userName: 'Guest',
  });

  assert.equal(dms.length, 0, 'no send is attempted through the disconnected adapter');
  assert.deepEqual(
    getPendingAlertsForTests(),
    [],
    'notifyAccessRequest must remain drop-on-full-disconnect — its listAdmins() recipient set cannot survive the shared bare-string queue',
  );
  resetPendingAlertsForTests();
});
