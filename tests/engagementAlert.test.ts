import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. ENGAGEMENT_ALERT_ENABLED is
// deliberately left unset so any use of startEngagementAlert() here
// exercises the disabled-by-default path (the enabled path's consecutive-
// failure alerting is covered by tests/backgroundJobs.test.ts and
// tests/backgroundJobsDisabled.test.ts, which pin the flag per-process like
// every other opt-in job) — this file focuses on the pure message builder
// and the weekly-cadence run function, neither of which reads the enabled
// flag.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';

const { formatEngagementAlertMessage, makeDefaultEngagementAlertRun, startEngagementAlert } =
  await import('../src/engagementAlert.js');

type EngagementStats = {
  total: number;
  engaged: number;
  percentage: number;
  byPlatform: Array<{ platform: 'discord' | 'whatsapp'; total: number; engaged: number; percentage: number }>;
};

function makeAdapter(): { adapter: PlatformAdapter; dms: Array<{ userId: string; text: string }> } {
  const dms: Array<{ userId: string; text: string }> = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
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

// alertSuperAdmins is fire-and-forget (`void alertSuperAdmins(...)`, no
// await), so give the microtask queue a turn before asserting — same
// technique as tests/departedAdminAlert.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function stats(overrides: Partial<EngagementStats> = {}): EngagementStats {
  return {
    total: 10,
    engaged: 4,
    percentage: 40,
    byPlatform: [{ platform: 'discord', total: 10, engaged: 4, percentage: 40 }],
    ...overrides,
  };
}

test('formatEngagementAlertMessage: wraps formatEngagementStats verbatim (no member identity, no reimplemented math)', () => {
  const message = formatEngagementAlertMessage(stats());
  assert.match(message, /4\/10 present members have posted at least once \(40%\)/);
  assert.match(message, /- discord: 4\/10 \(40%\)/);
});

// Binding acceptance criterion 4 (issue #568 adversarial review): the
// empty-roster fallback must be byte-identical to engagement_stats' own
// fallback text — never a divide-by-zero or NaN%.
test("formatEngagementAlertMessage: empty-roster fallback is byte-identical to engagement_stats' own fallback text", () => {
  const message = formatEngagementAlertMessage(
    stats({ total: 0, engaged: 0, percentage: 0, byPlatform: [] }),
  );
  assert.equal(
    message,
    '📊 Weekly engagement snapshot:\nNo currently-present roster members to measure engagement against.',
  );
  assert.ok(!message.includes('NaN'), 'SECURITY: an empty roster must never render NaN%');
});

test('SECURITY: formatEngagementAlertMessage never contains anything beyond aggregate integers/a percentage and the fixed fallback string', () => {
  for (const s of [stats(), stats({ total: 0, engaged: 0, percentage: 0, byPlatform: [] })]) {
    const message = formatEngagementAlertMessage(s);
    assert.doesNotMatch(message, /[a-zA-Z]{2,}#\d+/, 'no display-name-shaped token');
    assert.ok(!/\b\d{15,}\b/.test(message), 'no platform-user-id-shaped long numeric token');
  }
});

test('makeDefaultEngagementAlertRun: on the first eligible tick (no prior send), every super admin on every connected adapter is DMed once with the current percentage, and the send is recorded', async () => {
  const { adapter, dms } = makeAdapter();
  let recordedPercentage: number | null = null;
  const runOnce = makeDefaultEngagementAlertRun(
    [adapter],
    async () => stats({ percentage: 42 }),
    async () => false,
    async (percentage) => {
      recordedPercentage = percentage;
    },
  );

  await runOnce();
  await flush();

  assert.equal(dms.length, 1, 'exactly one super admin is DMed');
  assert.equal(dms[0].userId, 'super-1');
  assert.match(dms[0].text, /42%/);
  assert.equal(recordedPercentage, 42, 'the send is recorded with the current percentage');
});

test('makeDefaultEngagementAlertRun: restart-safe cadence — a tick within the freshness window sends nothing further', async () => {
  const { adapter, dms } = makeAdapter();
  let recordCalls = 0;
  const runOnce = makeDefaultEngagementAlertRun(
    [adapter],
    async () => stats(),
    async () => true, // already sent recently
    async () => {
      recordCalls += 1;
    },
  );

  await runOnce();
  await flush();

  assert.equal(dms.length, 0, 'no DM within the freshness window');
  assert.equal(recordCalls, 0, 'no send is recorded when the tick is not eligible');
});

// SECURITY (binding acceptance criterion 7): the fan-out must target exactly
// superAdminIds(platform) per connected adapter, never leaking into a
// community_users admin's DM, and must skip a disconnected adapter.
test('SECURITY: makeDefaultEngagementAlertRun delivers only to super admins on connected adapters, never a community_users admin, and skips a disconnected adapter', async () => {
  const { adapter: connected, dms: connectedDms } = makeAdapter();
  const disconnected: PlatformAdapter = {
    ...connected,
    isConnected: () => false,
  };
  const disconnectedDms: Array<{ userId: string; text: string }> = [];
  disconnected.sendDirectMessage = async (userId: string, text: string) => {
    disconnectedDms.push({ userId, text });
  };

  const runOnce = makeDefaultEngagementAlertRun(
    [connected, disconnected],
    async () => stats(),
    async () => false,
    async () => {},
  );

  await runOnce();
  await flush();

  assert.deepEqual(
    connectedDms.map((d) => d.userId),
    ['super-1'],
    'only the configured super admin is DMed on the connected adapter',
  );
  assert.equal(disconnectedDms.length, 0, 'a disconnected adapter is never sent through');
});

test('startEngagementAlert: ENGAGEMENT_ALERT_ENABLED unset (default) creates no timer', () => {
  const timer = startEngagementAlert([]);
  assert.equal(timer, null, 'disabled by default — no timer, no extra queries');
});
