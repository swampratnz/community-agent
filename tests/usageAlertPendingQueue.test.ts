import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/module/strings/notices.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/base/platforms/types.js';

// Shared pending-alert queue extension for usageAlert.ts (issue #593). Own
// process because USAGE_ALERT_DAILY_REPLIES must be pinned ON here, and
// usageStats must be mocked before anything imports storage/repository.js —
// neither can share a process with tests/usageAlert.test.ts (deliberately
// disabled-by-default) or tests/usageAlertFailureTracker.test.ts (its own
// failure-tracker focus), same file-split convention as those two.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS ??= 'admin-open,admin-closed';
process.env.USAGE_ALERT_DAILY_REPLIES = '10';

const POLL_MS = 60 * 60_000; // usageAlert.ts's fixed hourly CHECK_INTERVAL_MS

type UsageStats = Awaited<ReturnType<typeof import('../src/base/storage/repository.js').usageStats>>;

const BASE_STATS: Omit<UsageStats, 'outbound'> = {
  inbound: 10,
  costUsd: 0,
  topUsers: [],
  costByRole: [],
  backgroundCostUsd: 0,
  shortcutHits: { total: 0, byKind: [] },
  backgroundCostByJob: [],
  cacheUsage: { readTokens: 0, creationTokens: 0 },
  autoAnswerUsage: { count: 0, costUsd: 0 },
};

let outbound = 15; // over the configured threshold (10) — crosses on the first tick

async function mockUsageStats(): Promise<UsageStats> {
  return { ...BASE_STATS, outbound };
}

// usageStats is a static import inside usageAlert.ts, so once that module has
// been imported anywhere in this process the binding is fixed (same trap as
// tests/usageAlertFailureTracker.test.ts) — install the mock once and reuse
// the cached import across every test in this file.
let modulesPromise: Promise<{
  startUsageAlert: typeof import('../src/base/usageAlert.js').startUsageAlert;
  getPendingAlertsForTests: typeof import('../src/base/pendingAlertQueue.js').getPendingAlertsForTests;
  getPendingAlertEntriesForTests: typeof import('../src/base/pendingAlertQueue.js').getPendingAlertEntriesForTests;
  resetPendingAlertsForTests: typeof import('../src/base/pendingAlertQueue.js').resetPendingAlertsForTests;
  queuePendingAlert: typeof import('../src/base/pendingAlertQueue.js').queuePendingAlert;
  PENDING_ALERT_QUEUE_CAP: number;
}> | null = null;
async function modules(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!modulesPromise) {
    modulesPromise = (async () => {
      const realRepo = await import('../src/base/storage/repository.js');
      t.mock.module('../src/base/storage/repository.js', {
        namedExports: { ...realRepo, usageStats: mockUsageStats },
      });
      const [
        { startUsageAlert },
        {
          getPendingAlertsForTests,
          getPendingAlertEntriesForTests,
          resetPendingAlertsForTests,
          queuePendingAlert,
          PENDING_ALERT_QUEUE_CAP,
        },
      ] = await Promise.all([
        import('../src/base/usageAlert.js'),
        import('../src/base/pendingAlertQueue.js'),
      ]);
      return {
        startUsageAlert,
        getPendingAlertsForTests,
        getPendingAlertEntriesForTests,
        resetPendingAlertsForTests,
        queuePendingAlert,
        PENDING_ALERT_QUEUE_CAP,
      };
    })();
  }
  return modulesPromise;
}

function makeAdapter(connected = true): {
  adapter: PlatformAdapter;
  dms: Array<{ userId: string; text: string }>;
} {
  const dms: Array<{ userId: string; text: string }> = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
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

/**
 * A fake Cloud-like adapter (mirrors `tests/notifyAdminsWindowReopenQueue.test.ts`'s
 * `makeFakeCloudAdapter`): `sendDirectMessage` rejects with whatever
 * `rejections[userId]` names, and `queueForWindowReopen` records what was
 * queued, per-recipient, for assertion (issue #888).
 */
function makeCloudAdapter(rejections: Record<string, unknown>): {
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
    isConnected: () => true,
    onMessage() {},
    async sendMessage(_out: OutgoingMessage) {},
    async sendDirectMessage(userId: string, text: string) {
      if (userId in rejections) throw rejections[userId];
      dms.push({ userId, text });
    },
    queueForWindowReopen(userId: string, message: string, priority: 'system' | 'low') {
      queued.push({ userId, message, priority });
    },
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return { adapter, dms, queued };
}

// check()'s alert path is fire-and-forget (`void alertSuperAdmins(...)`, no
// await), so give the microtask queue a turn after each tick before
// asserting — same technique as tests/usageAlertFailureTracker.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('startUsageAlert: with zero connected adapters, a threshold-crossing alert is queued exactly once instead of dropped (issue #593)', async (t) => {
  const {
    startUsageAlert,
    getPendingAlertsForTests,
    getPendingAlertEntriesForTests,
    resetPendingAlertsForTests,
  } = await modules(t);
  resetPendingAlertsForTests();
  outbound = 15;
  const { adapter, dms } = makeAdapter(false);

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startUsageAlert([adapter]);
  try {
    await flush();
    assert.equal(dms.length, 0, 'no send is attempted through the disconnected adapter');
    assert.equal(
      getPendingAlertsForTests().length,
      1,
      'the threshold-crossing alert is queued exactly once, not dropped',
    );
    assert.match(getPendingAlertsForTests()[0] ?? '', /Usage alert/);
  } finally {
    clearInterval(timer!);
    resetPendingAlertsForTests();
  }
});

test('SECURITY: startUsageAlert queues an entry with no `recipients` field — issue #625 only added an opt-in recipient set for notifyAdmins; usageAlert.ts is unaffected and still flushes to superAdminIds()', async (t) => {
  const { startUsageAlert, getPendingAlertEntriesForTests, resetPendingAlertsForTests } = await modules(t);
  resetPendingAlertsForTests();
  outbound = 15;
  const { adapter } = makeAdapter(false);

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startUsageAlert([adapter]);
  try {
    await flush();
    const entries = getPendingAlertEntriesForTests();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.recipients, undefined);
  } finally {
    clearInterval(timer!);
    resetPendingAlertsForTests();
  }
});

test('startUsageAlert: with at least one connected adapter, behaviour is byte-identical to before #593 — live send, nothing queued', async (t) => {
  const { startUsageAlert, getPendingAlertsForTests, resetPendingAlertsForTests } = await modules(t);
  resetPendingAlertsForTests();
  outbound = 15;
  const { adapter, dms } = makeAdapter(true);

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startUsageAlert([adapter]);
  try {
    await flush();
    assert.equal(dms.length, 1, 'the connected adapter still receives the alert live, as before');
    assert.deepEqual(
      getPendingAlertsForTests(),
      [],
      'nothing is queued when at least one adapter is connected',
    );
  } finally {
    clearInterval(timer!);
    resetPendingAlertsForTests();
  }
});

test('SECURITY: usageAlert.ts queues the message byte-identical to what a live send would have received, at "system" priority, surviving a low-priority flood (issue #593)', async (t) => {
  const {
    startUsageAlert,
    getPendingAlertsForTests,
    resetPendingAlertsForTests,
    queuePendingAlert,
    PENDING_ALERT_QUEUE_CAP,
  } = await modules(t);
  resetPendingAlertsForTests();
  outbound = 15;
  const { adapter: disconnected } = makeAdapter(false);
  const { adapter: connected, dms: connectedDms } = makeAdapter(true);

  // Each startUsageAlert() call gets its own fresh, function-local tracker
  // (crossed: false), so a connected-adapter call and a disconnected-adapter
  // call both independently cross the threshold on their first tick — no
  // re-arming needed between them.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const liveTimer = startUsageAlert([connected]);
  await flush();
  const liveText = connectedDms[0]?.text;
  assert.ok(liveText, 'a live send happened to capture the exact text');
  clearInterval(liveTimer!);

  const queueTimer = startUsageAlert([disconnected]);
  try {
    await flush();
    assert.deepEqual(
      getPendingAlertsForTests(),
      [liveText],
      'queued text is byte-identical to the live text',
    );

    // Simulate tools.ts's notifySuperAdmins (member-reachable, 'low'
    // priority) flooding the shared queue past its cap — the usage alert,
    // queued at 'system' priority, must never be evicted (issue #545's fix).
    for (let i = 0; i < PENDING_ALERT_QUEUE_CAP * 2; i++) queuePendingAlert(`low-flood-${i}`, 'low');
    assert.ok(
      getPendingAlertsForTests().includes(liveText),
      'the system-priority usage alert survives a low-priority flood',
    );
  } finally {
    clearInterval(queueTimer!);
    resetPendingAlertsForTests();
  }
});

// --- Per-recipient window-reopen queue extension (issue #888) ---

test("startUsageAlert: a WindowClosedError rejection queues via queueForWindowReopen at 'system' priority instead of only logging (issue #888 acceptance criterion 1/2)", async (t) => {
  const { startUsageAlert } = await modules(t);
  outbound = 15;
  const { WindowClosedError } = await import('../src/base/platforms/whatsapp/cloudAdapter.js');
  const { adapter, dms, queued } = makeCloudAdapter({
    'admin-closed': new WindowClosedError('admin-closed'),
  });

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startUsageAlert([adapter]);
  try {
    await flush();
    assert.deepEqual(
      dms.map((d) => d.userId),
      ['admin-open'],
      'the open-window recipient is still delivered live',
    );
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.userId, 'admin-closed');
    assert.equal(queued[0]?.priority, 'system');
    assert.match(queued[0]?.message ?? '', /Usage alert/);
  } finally {
    clearInterval(timer!);
  }
});

test('SECURITY: startUsageAlert — a rejection that is NOT a WindowClosedError is never queued via queueForWindowReopen; it stays logged-and-dropped (issue #888 acceptance criterion 4)', async (t) => {
  const { startUsageAlert } = await modules(t);
  outbound = 15;
  const { adapter, dms, queued } = makeCloudAdapter({ 'admin-closed': new Error('502 from Graph API') });

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startUsageAlert([adapter]);
  try {
    await flush();
    assert.deepEqual(
      dms.map((d) => d.userId),
      ['admin-open'],
    );
    assert.deepEqual(
      queued,
      [],
      'a non-WindowClosedError rejection must never populate the window-reopen queue',
    );
  } finally {
    clearInterval(timer!);
  }
});

test('startUsageAlert: an adapter with no queueForWindowReopen (Discord/Baileys shape) falls through to log-and-drop for a WindowClosedError rejection — no crash, byte-identical to today (issue #888 acceptance criterion 5)', async (t) => {
  const { startUsageAlert } = await modules(t);
  outbound = 15;
  const { WindowClosedError } = await import('../src/base/platforms/whatsapp/cloudAdapter.js');
  const { adapter } = makeAdapter(true);
  adapter.sendDirectMessage = async () => {
    throw new WindowClosedError('super-1');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  let timer: ReturnType<typeof setInterval> | null = null;
  await assert.doesNotReject(async () => {
    timer = startUsageAlert([adapter]);
    await flush();
  });
  clearInterval(timer!);
});
