import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Regression coverage for issue #593's binding acceptance criterion 6:
// tools.ts's notifyAdmins and router.ts's notifyAccessRequest source
// recipients from the broader, guild-wide listAdmins() rather than
// superAdminIds(), and (at the time) the shared pending-alert queue's
// bare-string entries couldn't preserve that distinct recipient set on flush
// (issue #571's rejection rationale) — so #593 deliberately did NOT extend
// the queue to either site.
//
// Issue #625 closes that gap for notifyAdmins specifically, via a structured
// queue entry that carries its own recipient set (see src/pendingAlertQueue.ts
// and src/health.ts's flushPendingAlerts) — the reviewer-named fix #571 was
// rejected for lacking. notifyAccessRequest (router.ts) is an explicit,
// scoped-out growth path and stays unchanged/passing below.
//
// listAdmins() is a static import inside agent/tools.ts, so it must be
// mocked before anything imports that module (same trap as
// tests/usageAlertFailureTracker.test.ts).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
// Deliberately disjoint from the mocked admin roster below (admin-1/admin-2/
// admin-wa) so the disjoint-roster SECURITY test can assert super admins
// never receive a flushed notifyAdmins alert.
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1,super-2';

let listAdminsCalls = 0;

let modulesPromise: Promise<{
  notifyAdmins: typeof import('../src/agent/tools.js').notifyAdmins;
  notifyAccessRequest: typeof import('../src/router.js').notifyAccessRequest;
  flushPendingAlerts: typeof import('../src/health.js').flushPendingAlerts;
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
          listAdmins: async () => {
            listAdminsCalls++;
            return [
              { platform: 'discord' as const, platformUserId: 'admin-1' },
              { platform: 'discord' as const, platformUserId: 'admin-2' },
              { platform: 'whatsapp' as const, platformUserId: 'admin-wa' },
            ];
          },
        },
      });
      const [{ notifyAdmins }, { notifyAccessRequest }, { flushPendingAlerts }, pendingAlertQueue] =
        await Promise.all([
          import('../src/agent/tools.js'),
          import('../src/router.js'),
          import('../src/health.js'),
          import('../src/pendingAlertQueue.js'),
        ]);
      return {
        notifyAdmins,
        notifyAccessRequest,
        flushPendingAlerts,
        getPendingAlertsForTests: pendingAlertQueue.getPendingAlertsForTests,
        resetPendingAlertsForTests: pendingAlertQueue.resetPendingAlertsForTests,
      };
    })();
  }
  return modulesPromise;
}

function makeAdapter(
  platform: 'discord' | 'whatsapp',
  connected: boolean,
): {
  adapter: PlatformAdapter;
  dms: Array<{ userId: string; text: string }>;
} {
  const dms: Array<{ userId: string; text: string }> = [];
  const adapter: PlatformAdapter = {
    platform,
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => connected,
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

function makeDisconnectedAdapter(): {
  adapter: PlatformAdapter;
  dms: Array<{ userId: string; text: string }>;
} {
  return makeAdapter('discord', false);
}

test('notifyAdmins: with every resolved admin’s adapter disconnected, queues the alert with the resolved recipient set instead of dropping it (issue #625 acceptance criterion 2)', async (t) => {
  const { notifyAdmins, getPendingAlertsForTests, resetPendingAlertsForTests } = await modules(t);
  resetPendingAlertsForTests();
  const { adapter: discordDown } = makeAdapter('discord', false);
  const { adapter: whatsappDown } = makeAdapter('whatsapp', false);

  await notifyAdmins(
    (platform) => (platform === 'discord' ? discordDown : whatsappDown),
    'admin-audience alert',
    '',
  );

  const queued = getPendingAlertsForTests();
  assert.equal(queued.length, 1, 'the escalation must be queued, not dropped');
  assert.match(queued[0] ?? '', /admin-audience alert/);
  resetPendingAlertsForTests();
});

test(
  'SECURITY: notifyAdmins — a queued alert is flushed through the reconnected adapter to exactly the ' +
    "resolved recipients, filtered to that adapter's platform, and never to superAdminIds() (issue #625 " +
    'acceptance criteria 3–4)',
  async (t) => {
    const { notifyAdmins, flushPendingAlerts, resetPendingAlertsForTests } = await modules(t);
    resetPendingAlertsForTests();
    const { adapter: discordDown } = makeAdapter('discord', false);
    const { adapter: whatsappDown } = makeAdapter('whatsapp', false);

    await notifyAdmins(
      (platform) => (platform === 'discord' ? discordDown : whatsappDown),
      'disjoint-roster alert',
      '',
    );

    const { adapter: reconnectedDiscord, dms } = makeAdapter('discord', true);
    await flushPendingAlerts(reconnectedDiscord);

    assert.deepEqual(
      dms.map((d) => d.userId).sort(),
      ['admin-1', 'admin-2'],
      'only the resolved discord admins receive the flush — not the whatsapp admin (wrong platform) and ' +
        'not either super admin',
    );
    resetPendingAlertsForTests();
  },
);

test('SECURITY: notifyAdmins — excludeUserId is honoured on the flush path (issue #625 acceptance criterion 5)', async (t) => {
  const { notifyAdmins, flushPendingAlerts, resetPendingAlertsForTests } = await modules(t);
  resetPendingAlertsForTests();
  const { adapter: discordDown } = makeAdapter('discord', false);
  const { adapter: whatsappDown } = makeAdapter('whatsapp', false);

  await notifyAdmins(
    (platform) => (platform === 'discord' ? discordDown : whatsappDown),
    'exclude-triggering-admin alert',
    'admin-2',
  );

  const { adapter: reconnectedDiscord, dms } = makeAdapter('discord', true);
  await flushPendingAlerts(reconnectedDiscord);

  assert.deepEqual(
    dms.map((d) => d.userId),
    ['admin-1'],
    'the excluded admin (the escalation trigger) never receives their own flushed DM',
  );
  resetPendingAlertsForTests();
});

test(
  'SECURITY: notifyAdmins — the flushed recipient set is frozen at queue time, not re-resolved via ' +
    'listAdmins() on flush (issue #625 acceptance criterion 6)',
  async (t) => {
    const { notifyAdmins, flushPendingAlerts, resetPendingAlertsForTests } = await modules(t);
    resetPendingAlertsForTests();
    const { adapter: discordDown } = makeAdapter('discord', false);
    const { adapter: whatsappDown } = makeAdapter('whatsapp', false);

    const callsBeforeQueue = listAdminsCalls;
    await notifyAdmins(
      (platform) => (platform === 'discord' ? discordDown : whatsappDown),
      'frozen-set alert',
      '',
    );
    assert.equal(
      listAdminsCalls,
      callsBeforeQueue + 1,
      'notifyAdmins resolves listAdmins() exactly once, at queue time',
    );

    const { adapter: reconnectedDiscord, dms } = makeAdapter('discord', true);
    await flushPendingAlerts(reconnectedDiscord);

    assert.equal(
      listAdminsCalls,
      callsBeforeQueue + 1,
      'flushPendingAlerts must NOT re-resolve listAdmins() — the flushed set is exactly the one captured at queue time',
    );
    assert.deepEqual(dms.map((d) => d.userId).sort(), ['admin-1', 'admin-2']);
    resetPendingAlertsForTests();
  },
);

test(
  'SECURITY: notifyAdmins — when at least one resolved admin’s adapter is connected, behaviour is ' +
    'byte-identical to today: an individually-disconnected admin is still just skipped, and nothing is ' +
    'queued (issue #625 acceptance criterion 7)',
  async (t) => {
    const { notifyAdmins, getPendingAlertsForTests, resetPendingAlertsForTests } = await modules(t);
    resetPendingAlertsForTests();
    const { adapter: discordUp, dms } = makeAdapter('discord', true);

    await notifyAdmins(
      (platform) => (platform === 'discord' ? discordUp : undefined),
      'mixed-connectivity alert',
      '',
    );

    assert.deepEqual(
      dms.map((d) => d.userId).sort(),
      ['admin-1', 'admin-2'],
      'both discord admins are still delivered live',
    );
    assert.deepEqual(
      getPendingAlertsForTests(),
      [],
      'the whatsapp admin (no registered/connected adapter) is individually skipped, exactly as before — nothing is queued',
    );
    resetPendingAlertsForTests();
  },
);

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
