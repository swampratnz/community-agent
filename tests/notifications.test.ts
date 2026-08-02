import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/backgroundJobCostAlert.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS = 'super-1';

const { alertSuperAdmins, makeAlertSlotReserver } = await import('../src/notifications.js');
const { getPendingAlertEntriesForTests, resetPendingAlertsForTests } =
  await import('../src/pendingAlertQueue.js');
const { WindowClosedError } = await import('../src/platforms/types.js');

/**
 * A fake Cloud-like adapter (mirrors `tests/backgroundJobCostAlert.test.ts`'s
 * shape): `sendDirectMessage` rejects with whatever `rejections[userId]`
 * names, and `queueForWindowReopen` records what was queued, per-recipient,
 * for assertion.
 */
function makeAdapter(opts: { connected: boolean; rejections?: Record<string, Error> }): {
  adapter: PlatformAdapter;
  dms: Array<{ userId: string; text: string }>;
  queued: Array<{ userId: string; message: string; priority: 'system' | 'low' }>;
} {
  const dms: Array<{ userId: string; text: string }> = [];
  const queued: Array<{ userId: string; message: string; priority: 'system' | 'low' }> = [];
  const adapter: PlatformAdapter = {
    platform: 'whatsapp',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => opts.connected,
    onMessage() {},
    async sendMessage(_out: OutgoingMessage) {},
    async sendDirectMessage(userId: string, text: string) {
      const rejection = opts.rejections?.[userId];
      if (rejection !== undefined) throw rejection;
      dms.push({ userId, text });
    },
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
    queueForWindowReopen(userId: string, message: string, priority: 'system' | 'low') {
      queued.push({ userId, message, priority });
    },
  };
  return { adapter, dms, queued };
}

// alertSuperAdmins sends fire-and-forget per recipient, so give the
// microtask queue a turn before asserting — same technique as
// tests/usageCostDigest.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('alertSuperAdmins: delivers to super admins through connected adapters only', async () => {
  resetPendingAlertsForTests();
  const live = makeAdapter({ connected: true });
  const dead = makeAdapter({ connected: false });

  await alertSuperAdmins([live.adapter, dead.adapter], 'hello', {
    label: 'Test alert',
    queueWhenDisconnected: true,
  });
  await flush();

  assert.deepEqual(live.dms, [{ userId: 'super-1', text: 'hello' }]);
  assert.equal(dead.dms.length, 0, 'nothing is sent through a disconnected adapter');
  assert.equal(getPendingAlertEntriesForTests().length, 0, 'nothing is queued while an adapter is live');
});

test("alertSuperAdmins: queueWhenDisconnected=true queues at 'system' priority when every adapter is down", async () => {
  resetPendingAlertsForTests();
  const dead = makeAdapter({ connected: false });

  await alertSuperAdmins([dead.adapter], 'outage alert', {
    label: 'Test alert',
    queueWhenDisconnected: true,
  });
  await flush();

  assert.equal(dead.dms.length, 0);
  const pending = getPendingAlertEntriesForTests();
  assert.equal(pending.length, 1, 'the alert is queued for flush on reconnect');
  assert.equal(pending[0].message, 'outage alert');
  assert.equal(pending[0].priority, 'system', "super-admin alerts queue at 'system' priority (#545)");
  resetPendingAlertsForTests();
});

test('alertSuperAdmins: queueWhenDisconnected=false drops silently when every adapter is down', async () => {
  resetPendingAlertsForTests();
  const dead = makeAdapter({ connected: false });

  await alertSuperAdmins([dead.adapter], 'stale digest', {
    label: 'Test digest',
    queueWhenDisconnected: false,
  });
  await flush();

  assert.equal(dead.dms.length, 0);
  assert.equal(getPendingAlertEntriesForTests().length, 0, 'a periodic digest is dropped, never queued');
});

test('alertSuperAdmins: a WindowClosedError rejection queues that recipient for reopen instead of dropping', async () => {
  resetPendingAlertsForTests();
  const { adapter, queued } = makeAdapter({
    connected: true,
    rejections: { 'super-1': new WindowClosedError('super-1') },
  });

  await alertSuperAdmins([adapter], 'window test', {
    label: 'Test alert',
    queueWhenDisconnected: true,
  });
  await flush();

  assert.deepEqual(queued, [{ userId: 'super-1', message: 'window test', priority: 'system' }]);
  assert.equal(
    getPendingAlertEntriesForTests().length,
    0,
    'reopen queueing is per-recipient, not the outage queue',
  );
});

test('alertSuperAdmins: a non-window send failure is swallowed (logged), never thrown', async () => {
  resetPendingAlertsForTests();
  const { adapter, queued } = makeAdapter({
    connected: true,
    rejections: { 'super-1': new Error('boom') },
  });

  await alertSuperAdmins([adapter], 'failure test', {
    label: 'Test alert',
    queueWhenDisconnected: true,
  });
  await flush();

  assert.equal(queued.length, 0, 'a generic failure does not use the reopen queue');
});

test('makeAlertSlotReserver: enforces the limit inside a rolling hour', () => {
  const reserve = makeAlertSlotReserver();
  assert.equal(reserve(2), true);
  assert.equal(reserve(2), true);
  assert.equal(reserve(2), false, 'the third reservation inside the hour is refused');
});

test('makeAlertSlotReserver: each factory call is an independent window', () => {
  const a = makeAlertSlotReserver();
  const b = makeAlertSlotReserver();
  assert.equal(a(1), true);
  assert.equal(a(1), false, 'window a is exhausted');
  assert.equal(b(1), true, "window b is unaffected by window a's reservations");
});

test('makeAlertSlotReserver: a refused reservation does not consume a slot', () => {
  const reserve = makeAlertSlotReserver();
  assert.equal(reserve(1), true);
  assert.equal(reserve(1), false);
  assert.equal(reserve(2), true, 'the refused attempt left only one timestamp in the window');
});
