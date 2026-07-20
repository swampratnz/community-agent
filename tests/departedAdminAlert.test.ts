import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. DEPARTED_ADMIN_ALERT_ENABLED is
// deliberately left unset so any use of startDepartedAdminAlert() here
// exercises the disabled-by-default path (the enabled path's consecutive-
// failure/rearm behaviour is covered by tests/backgroundJobs.test.ts and
// tests/backgroundJobsDisabled.test.ts, which pin the flag per-process like
// every other opt-in job) — this file focuses on the pure message builder
// and the latch (`makeDefaultDepartedAdminAlertRun`), neither of which reads
// the enabled flag.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';

const {
  formatDepartedAdminAlertMessage,
  makeDefaultDepartedAdminAlertRun,
  startDepartedAdminAlert,
  alertSuperAdmins,
} = await import('../src/departedAdminAlert.js');
const { getPendingAlertsForTests, resetPendingAlertsForTests, queuePendingAlert, PENDING_ALERT_QUEUE_CAP } =
  await import('../src/pendingAlertQueue.js');

type AdminRosterEntry = {
  platform: 'discord' | 'whatsapp';
  platformUserId: string;
  displayName: string | null;
  leftServer: boolean;
};

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

// alertSuperAdmins is fire-and-forget (`void alertSuperAdmins(...)`, no
// await), so give the microtask queue a turn before asserting — same
// technique as tests/backgroundJobs.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function roster(entries: Array<Partial<AdminRosterEntry>>): AdminRosterEntry[] {
  return entries.map((e, i) => ({
    platform: 'discord',
    platformUserId: `admin-${i}`,
    displayName: `Admin ${i}`,
    leftServer: false,
    ...e,
  }));
}

test('formatDepartedAdminAlertMessage: fixed template with only the bare count, at zero/one/many', () => {
  assert.equal(
    formatDepartedAdminAlertMessage(0),
    '⚠️ 0 admin(s) have left the server/group but still hold bot-admin privilege — ' +
      'run `list_admins` to review and `revoke_admin` if appropriate.',
  );
  assert.equal(
    formatDepartedAdminAlertMessage(1),
    '⚠️ 1 admin(s) have left the server/group but still hold bot-admin privilege — ' +
      'run `list_admins` to review and `revoke_admin` if appropriate.',
  );
  assert.equal(
    formatDepartedAdminAlertMessage(4),
    '⚠️ 4 admin(s) have left the server/group but still hold bot-admin privilege — ' +
      'run `list_admins` to review and `revoke_admin` if appropriate.',
  );
});

test('SECURITY: formatDepartedAdminAlertMessage never contains anything beyond the fixed template + integer, for any count', () => {
  for (const count of [0, 1, 2, 7]) {
    const message = formatDepartedAdminAlertMessage(count);
    assert.match(
      message,
      /^⚠️ \d+ admin\(s\) have left the server\/group but still hold bot-admin privilege — run `list_admins` to review and `revoke_admin` if appropriate\.$/,
    );
  }
});

test('SECURITY: makeDefaultDepartedAdminAlertRun never leaks a display name, platform user id, or platform string into the alert DM even when the roster contains them', async () => {
  const { adapter, dms } = makeAdapter();
  const secretName = 'secret-display-name-should-never-leak';
  const secretId = 'secret-platform-user-id-9f3a';
  const listRoster = async () =>
    roster([{ leftServer: true, displayName: secretName, platformUserId: secretId, platform: 'discord' }]);
  const runOnce = makeDefaultDepartedAdminAlertRun([adapter], listRoster);

  await runOnce();
  await flush();

  assert.equal(dms.length, 1, 'the crossing tick alerts once');
  const body = dms[0].text;
  assert.ok(!body.includes(secretName), 'display name must never appear in the alert DM');
  assert.ok(!body.includes(secretId), 'platform user id must never appear in the alert DM');
  assert.ok(!body.includes('discord'), 'platform string must never appear in the alert DM');
  assert.equal(
    body,
    '⚠️ 1 admin(s) have left the server/group but still hold bot-admin privilege — ' +
      'run `list_admins` to review and `revoke_admin` if appropriate.',
  );
});

test('makeDefaultDepartedAdminAlertRun: a roster with zero leftServer===true entries never alerts, even when the roster is non-empty overall', async () => {
  const { adapter, dms } = makeAdapter();
  const listRoster = async () =>
    roster([{ leftServer: false }, { leftServer: false }, { leftServer: false }]);
  const runOnce = makeDefaultDepartedAdminAlertRun([adapter], listRoster);

  await runOnce();
  await flush();

  assert.equal(dms.length, 0, 'present-but-not-departed admins must never trip the alert');
});

test('makeDefaultDepartedAdminAlertRun: alerts exactly once on the tick the departed count first becomes >0, then stays silent while it remains >0', async () => {
  const { adapter, dms } = makeAdapter();
  let count = 0;
  const listRoster = async () => roster(Array.from({ length: count }, () => ({ leftServer: true })));
  const runOnce = makeDefaultDepartedAdminAlertRun([adapter], listRoster);

  await runOnce(); // count 0 -> no alert
  await flush();
  assert.equal(dms.length, 0, 'no alert while the count stays at 0');

  count = 1;
  await runOnce(); // 0 -> 1, crosses
  await flush();
  assert.equal(dms.length, 1, 'exactly one alert on the tick the count first becomes >0');

  count = 2;
  await runOnce(); // stays >0
  await flush();
  assert.equal(
    dms.length,
    1,
    'no repeat alert on a subsequent tick while the count stays >0 (latch, not a nag)',
  );
});

test('makeDefaultDepartedAdminAlertRun: the latch re-arms only once the count returns to exactly 0, and a partial decrease never re-arms', async () => {
  const { adapter, dms } = makeAdapter();
  let count = 3;
  const listRoster = async () => roster(Array.from({ length: count }, () => ({ leftServer: true })));
  const runOnce = makeDefaultDepartedAdminAlertRun([adapter], listRoster);

  await runOnce(); // 0 -> 3, crosses, alerts
  await flush();
  assert.equal(dms.length, 1, 'first crossing alerts once');

  count = 1;
  await runOnce(); // partial decrease, 3 -> 1, never reaches 0
  await flush();
  assert.equal(dms.length, 1, 'a partial decrease (3 -> 1) must not re-arm the latch');

  count = 0;
  await runOnce(); // drops to exactly 0
  await flush();
  assert.equal(dms.length, 1, 'dropping to exactly 0 silently re-arms — it is not itself an alert');

  count = 1;
  await runOnce(); // crosses again
  await flush();
  assert.equal(dms.length, 2, 'a fresh crossing after returning to 0 fires a second, distinct alert');
});

test('startDepartedAdminAlert: DEPARTED_ADMIN_ALERT_ENABLED unset (default) creates no timer', () => {
  const timer = startDepartedAdminAlert([]);
  assert.equal(timer, null, 'disabled by default — no timer, no extra queries');
});

// --- Shared pending-alert queue extension (issue #593) ---

test('alertSuperAdmins: with zero connected adapters, the message is queued exactly once instead of dropped (issue #593)', async () => {
  resetPendingAlertsForTests();
  const { adapter, dms } = makeAdapter(false);

  await alertSuperAdmins([adapter], 'departed-admin alert while disconnected');

  assert.equal(dms.length, 0, 'no send is attempted through the disconnected adapter');
  assert.deepEqual(
    getPendingAlertsForTests(),
    ['departed-admin alert while disconnected'],
    'the alert is queued exactly once, not dropped',
  );
  resetPendingAlertsForTests();
});

test('alertSuperAdmins: with at least one connected adapter, behaviour is byte-identical to before #593 — live send, nothing queued', async () => {
  resetPendingAlertsForTests();
  const { adapter, dms } = makeAdapter(true);

  await alertSuperAdmins([adapter], 'departed-admin alert while connected');

  assert.equal(dms.length, 1, 'the connected adapter still receives the alert as before');
  assert.equal(dms[0].text, 'departed-admin alert while connected');
  assert.deepEqual(
    getPendingAlertsForTests(),
    [],
    'nothing is queued when at least one adapter is connected',
  );
  resetPendingAlertsForTests();
});

test('SECURITY: alertSuperAdmins queues the message byte-identical to what a live send would have received, at "system" priority, surviving a low-priority flood (issue #593)', async () => {
  resetPendingAlertsForTests();
  const { adapter } = makeAdapter(false);
  const message = 'departed-admin alert — byte-identical check';

  await alertSuperAdmins([adapter], message);
  assert.deepEqual(getPendingAlertsForTests(), [message]);

  // Simulate tools.ts's notifySuperAdmins (member-reachable, 'low' priority)
  // flooding the shared queue past its cap — the departed-admin alert, queued
  // at 'system' priority, must never be evicted (issue #545's fix).
  for (let i = 0; i < PENDING_ALERT_QUEUE_CAP * 2; i++) queuePendingAlert(`low-flood-${i}`, 'low');

  assert.ok(
    getPendingAlertsForTests().includes(message),
    'the system-priority departed-admin alert survives a low-priority flood',
  );
  resetPendingAlertsForTests();
});
