import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';
import { fakePolicyStore } from './support/fakePolicyStore.js';
import type { OutgoingMessage, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/appealStaleAlert.test.ts. This job is always-on (no
// enable flag), so no *_ENABLED var is needed here. ACCESS_MODE_DISCORD/
// ACCESS_MODE_WHATSAPP are left unset — both default to 'gated', which is
// what every test in this file needs; the 'open'-mode suppression
// (acceptance criterion 5) is asserted in its own file
// (rosterStaleAlertOpenMode.test.ts) because config is a process-wide
// singleton loaded once at import time.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const {
  ROSTER_STALE_ALERT_THRESHOLD_HOURS,
  ROSTER_STALE_ALERT_SCAN_LIMIT,
  formatRosterStaleAlertMessage,
  makeDefaultRosterStaleAlertRun,
  startRosterStaleAlert,
} = await import('../src/module/rosterStaleAlert.js');
const { WindowClosedError } = await import('@swampratnz/agent-base/platforms/whatsapp/cloudAdapter.js');
const { ROSTER_STALE_ALERT_POLICY_KEY } = await import('../src/module/storage/policies.js');

type Platform = 'discord' | 'whatsapp';
type RosterEntry = {
  userId: string;
  displayName: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  rejoinedCount: number;
  isMember: boolean;
};
type AdminIdentity = { platform: Platform; platformUserId: string };

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

function rosterRow(overrides: Partial<RosterEntry> & { ageHours: number }): RosterEntry {
  const { ageHours, ...rest } = overrides;
  return {
    userId: 'guest-1',
    displayName: 'Some Guest',
    joinedAt: hoursAgo(ageHours),
    leftAt: null,
    rejoinedCount: 0,
    isMember: false,
    ...rest,
  };
}

function admins(entries: Array<Partial<AdminIdentity>>): AdminIdentity[] {
  return entries.map((e, i) => ({ platform: 'discord', platformUserId: `admin-${i}`, ...e }));
}

function makeAdapter(
  platform: Platform = 'discord',
  connected = true,
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

/** Mirrors tests/appealStaleAlert.test.ts's makeCloudAdapter. */
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

test('formatRosterStaleAlertMessage: fixed template with the bare count and oldest-age-in-hours only', () => {
  assert.equal(
    formatRosterStaleAlertMessage(1, 200),
    '🆕 1 guest(s) have been waiting more than 168h to be added as a member (oldest: 200h) — ' +
      'run `list_roster` (filter: not_members) to review.',
  );
  assert.equal(
    formatRosterStaleAlertMessage(4, 999),
    '🆕 4 guest(s) have been waiting more than 168h to be added as a member (oldest: 999h) — ' +
      'run `list_roster` (filter: not_members) to review.',
  );
});

test('SECURITY: formatRosterStaleAlertMessage never contains anything beyond the fixed template + two integers, for any count/age', () => {
  for (const [count, age] of [
    [0, 0],
    [1, 168],
    [7, 9999],
  ]) {
    const message = formatRosterStaleAlertMessage(count, age);
    assert.match(
      message,
      /^🆕 \d+ guest\(s\) have been waiting more than 168h to be added as a member \(oldest: \d+h\) — run `list_roster` \(filter: not_members\) to review\.$/,
    );
  }
});

test('SECURITY: the crossing-tick alert DM contains no guest display name, user id, or joinedAt timestamp string, even when the stale set contains them', async () => {
  const { adapter, dms } = makeAdapter();
  const secretUserId = 'secret-user-id-4f2a';
  const secretDisplayName = 'secret-display-name';
  // Built EAGERLY, before runOnce() captures its clock — see the identical
  // comment in tests/appealStaleAlert.test.ts for why (PR #1071's flake):
  // constructing the fixture before the job reads Date.now() guarantees the
  // measured age floors to exactly 200h on every run, loaded CI runner or not.
  const staleRows = [rosterRow({ ageHours: 200, userId: secretUserId, displayName: secretDisplayName })];
  const listNotMembers = async () => staleRows;
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultRosterStaleAlertRun(
    [adapter],
    listNotMembers,
    listAdminIdentities,
    fakePolicyStore(),
  );

  await runOnce();

  assert.equal(dms.length, 1);
  const body = dms[0].text;
  assert.ok(!body.includes(secretUserId), 'user id must never appear in the alert DM');
  assert.ok(!body.includes(secretDisplayName), 'display name must never appear in the alert DM');
  assert.ok(
    !body.includes(staleRows[0].joinedAt.toISOString()),
    'a joinedAt timestamp string must never appear in the alert DM',
  );
  assert.equal(
    body,
    '🆕 1 guest(s) have been waiting more than 168h to be added as a member (oldest: 200h) — ' +
      'run `list_roster` (filter: not_members) to review.',
  );
});

test('makeDefaultRosterStaleAlertRun: a not_members set with no row older than the threshold never alerts', async () => {
  const { adapter, dms } = makeAdapter();
  const listNotMembers = async () => [
    rosterRow({ ageHours: 1 }),
    rosterRow({ ageHours: ROSTER_STALE_ALERT_THRESHOLD_HOURS - 1 }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultRosterStaleAlertRun(
    [adapter],
    listNotMembers,
    listAdminIdentities,
    fakePolicyStore(),
  );

  await runOnce();

  assert.equal(dms.length, 0, 'nothing older than the threshold must never trip the alert');
});

test('makeDefaultRosterStaleAlertRun: alerts exactly once on the tick the stale count first becomes >0, then stays silent while it remains >0 — including a partial decrease that never reaches 0', async () => {
  const { adapter, dms } = makeAdapter();
  let staleCount = 0;
  const listNotMembers = async () =>
    Array.from({ length: staleCount }, (_, i) => rosterRow({ ageHours: 200, userId: `guest-${i}` }));
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultRosterStaleAlertRun(
    [adapter],
    listNotMembers,
    listAdminIdentities,
    fakePolicyStore(),
  );

  await runOnce(); // 0 -> no alert
  assert.equal(dms.length, 0);

  staleCount = 1;
  await runOnce(); // 0 -> 1, crosses
  assert.equal(dms.length, 1, 'exactly one alert on the tick the stale count first becomes >0');

  staleCount = 3;
  await runOnce(); // stays >0
  assert.equal(dms.length, 1, 'no repeat alert while the stale count stays >0 (latch, not a nag)');

  staleCount = 1;
  await runOnce(); // partial decrease, 3 -> 1, never reaches 0
  assert.equal(dms.length, 1, 'a partial decrease (3 -> 1) must not re-arm the latch');
});

test('makeDefaultRosterStaleAlertRun: the latch re-arms once the stale count returns to exactly 0, and a later crossing alerts again', async () => {
  const { adapter, dms } = makeAdapter();
  let staleCount = 2;
  const listNotMembers = async () =>
    Array.from({ length: staleCount }, (_, i) => rosterRow({ ageHours: 200, userId: `guest-${i}` }));
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultRosterStaleAlertRun(
    [adapter],
    listNotMembers,
    listAdminIdentities,
    fakePolicyStore(),
  );

  await runOnce(); // 0 -> 2, crosses
  assert.equal(dms.length, 1);

  staleCount = 0;
  await runOnce(); // drops to exactly 0 — silent re-arm
  assert.equal(dms.length, 1, 'dropping to exactly 0 must not itself alert');

  staleCount = 1;
  await runOnce(); // crosses again
  assert.equal(dms.length, 2, 'a fresh crossing after returning to 0 fires a second, distinct alert');
});

// --- persisted latch (issue #1198) ------------------------------------------

test('makeDefaultRosterStaleAlertRun: writes the active marker to the policy store only AFTER the alertAdmins fan-out returns, on the tick that crosses', async () => {
  const { adapter } = makeAdapter();
  const store = fakePolicyStore();
  const listNotMembers = async () => [rosterRow({ ageHours: 200 })];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultRosterStaleAlertRun([adapter], listNotMembers, listAdminIdentities, store);

  assert.equal(store.written.length, 0, 'no write before the tick runs');
  await runOnce();

  assert.deepEqual(store.written, [
    { key: ROSTER_STALE_ALERT_POLICY_KEY, value: 'true', updatedBy: 'system' },
  ]);
});

test('makeDefaultRosterStaleAlertRun: restart-safety — a fresh factory seeded with the active marker AND a still-stale count on its first tick does not re-alert, and leaves the marker active', async () => {
  const { adapter, dms } = makeAdapter();
  const store = fakePolicyStore({ [ROSTER_STALE_ALERT_POLICY_KEY]: 'true' });
  const listNotMembers = async () => [
    rosterRow({ ageHours: 200 }),
    rosterRow({ ageHours: 300, userId: 'guest-2' }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultRosterStaleAlertRun([adapter], listNotMembers, listAdminIdentities, store);

  await runOnce();
  assert.equal(dms.length, 0, 'a restart mid-backlog must not re-fire a duplicate DM');

  await runOnce();
  assert.equal(dms.length, 0, 'a later tick with the same still-stale backlog must not fire either');
  assert.equal(store.written.length, 0, 'the already-active marker is never rewritten while nothing crosses');
});

test('makeDefaultRosterStaleAlertRun: re-arm survives a restart — the marker clears to "" when the count returns to 0, and a fresh factory alerts again on the next crossing', async () => {
  const { adapter, dms } = makeAdapter();
  const store = fakePolicyStore({ [ROSTER_STALE_ALERT_POLICY_KEY]: 'true' });
  const listAdminIdentities = async () => admins([{}]);

  const firstProcess = makeDefaultRosterStaleAlertRun([adapter], async () => [], listAdminIdentities, store);
  await firstProcess(); // count drops to 0 -> re-arm
  assert.equal(dms.length, 0);
  assert.deepEqual(store.written, [{ key: ROSTER_STALE_ALERT_POLICY_KEY, value: '', updatedBy: 'system' }]);

  const secondProcess = makeDefaultRosterStaleAlertRun(
    [adapter],
    async () => [rosterRow({ ageHours: 200 })],
    listAdminIdentities,
    store,
  );
  await secondProcess();
  assert.equal(dms.length, 1, 'a fresh crossing after the persisted re-arm alerts again');
  assert.deepEqual(store.written, [
    { key: ROSTER_STALE_ALERT_POLICY_KEY, value: '', updatedBy: 'system' },
    { key: ROSTER_STALE_ALERT_POLICY_KEY, value: 'true', updatedBy: 'system' },
  ]);
});

test('SECURITY: makeDefaultRosterStaleAlertRun never threads a member/admin identifier into updatePolicy — the actor is always the fixed "system" string', async () => {
  const { adapter } = makeAdapter();
  const store = fakePolicyStore();
  const secretAdminId = 'admin-should-never-be-the-actor';
  const listNotMembers = async () => [rosterRow({ ageHours: 200 })];
  const listAdminIdentities = async () => admins([{ platformUserId: secretAdminId }]);
  const runOnce = makeDefaultRosterStaleAlertRun([adapter], listNotMembers, listAdminIdentities, store);

  await runOnce();

  assert.ok(store.written.length > 0);
  for (const write of store.written) {
    assert.equal(write.updatedBy, 'system');
    assert.notEqual(write.updatedBy, secretAdminId);
  }
});

test('makeDefaultRosterStaleAlertRun: a guest added as a member before crossing the threshold never contributes to the count or triggers an alert for that guest', async () => {
  const { adapter, dms } = makeAdapter();
  // The guest is present but young at tick 1 (no alert either way), then
  // "added as a member" before tick 2 — simulated the way the real
  // listRoster('not_members', ...) query would behave: add_member removes
  // the row from the not_members result set entirely, it never appears with
  // isMember: true, so this job never has a chance to count it stale.
  let guestIsMember = false;
  const listNotMembers = async () =>
    guestIsMember ? [] : [rosterRow({ ageHours: 1, userId: 'guest-added-early' })];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultRosterStaleAlertRun(
    [adapter],
    listNotMembers,
    listAdminIdentities,
    fakePolicyStore(),
  );

  await runOnce();
  assert.equal(dms.length, 0, 'young guest, no alert yet');

  guestIsMember = true;
  await runOnce();
  assert.equal(dms.length, 0, 'guest added as a member before crossing 168h never triggers an alert');
});

test('makeDefaultRosterStaleAlertRun: combines the stale count across every gated platform into one crossing latch, and reports the oldest age across all of them', async () => {
  const { adapter: discordAdapter } = makeAdapter('discord');
  const { adapter: whatsappAdapter, dms: whatsappDms } = makeAdapter('whatsapp');
  // Built EAGERLY, before runOnce() captures its clock — same reason as the
  // fixture above and in tests/appealStaleAlert.test.ts (PR #1071's flake).
  // Dating these inside the awaited callback stamps them LATER than the job's
  // own `now`, so the measured age lands just under 300h and Math.floor
  // renders "299h". Sub-millisecond on an idle machine; a loaded CI runner
  // deschedules between the two often enough to fail (it did, on this PR).
  const discordRows = [rosterRow({ ageHours: 200, userId: 'discord-guest' })];
  const whatsappRows = [rosterRow({ ageHours: 300, userId: 'whatsapp-guest' })];
  const listNotMembers = async (platform: Platform) => (platform === 'discord' ? discordRows : whatsappRows);
  const listAdminIdentities = async () => admins([{ platform: 'whatsapp', platformUserId: 'admin-0' }]);
  const runOnce = makeDefaultRosterStaleAlertRun(
    [discordAdapter, whatsappAdapter],
    listNotMembers,
    listAdminIdentities,
    fakePolicyStore(),
  );

  await runOnce();

  assert.equal(whatsappDms.length, 1);
  assert.equal(
    whatsappDms[0].text,
    '🆕 2 guest(s) have been waiting more than 168h to be added as a member (oldest: 300h) — ' +
      'run `list_roster` (filter: not_members) to review.',
    'the count sums both gated platforms and the oldest age is the max across them',
  );
});

test('alertAdmins recipient isolation: a WindowClosedError from sendDirectMessage for one admin is queued via queueForWindowReopen and does not block delivery to the rest', async () => {
  const { adapter, dms, queued } = makeCloudAdapter({
    'admin-closed': new WindowClosedError('admin-closed'),
  });
  const listNotMembers = async () => [rosterRow({ ageHours: 200 })];
  const listAdminIdentities = async () =>
    admins([
      { platform: 'whatsapp', platformUserId: 'admin-open' },
      { platform: 'whatsapp', platformUserId: 'admin-closed' },
    ]);
  const runOnce = makeDefaultRosterStaleAlertRun(
    [adapter],
    listNotMembers,
    listAdminIdentities,
    fakePolicyStore(),
  );

  await runOnce();

  assert.deepEqual(
    dms.map((d) => d.userId),
    ['admin-open'],
    'the open-window admin is still delivered live',
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0].userId, 'admin-closed');
  assert.equal(queued[0].priority, 'low');
});

test('startRosterStaleAlert: always-on, no enable flag — creates a timer even with no *_ENABLED env set', () => {
  const timer = startRosterStaleAlert([], async () => {});
  assert.notEqual(timer, null, 'this job is unconditionally enabled by design');
  if (timer) clearInterval(timer);
});

// --- the scan bound (mirrors tests/appealStaleAlert.test.ts's equivalent) ---

test(
  'the default listNotMembers asks listRoster for ROSTER_STALE_ALERT_SCAN_LIMIT, never its 50-row default ' +
    '— that default is ordered COALESCE(left_at, joined_at) DESC, so a bare call hands this job the MOST ' +
    'RECENTLY joined not-yet-members and then filters them for the OLDEST, going quiet exactly as the ' +
    'onboarding backlog worsens',
  async () => {
    // Asserted against the SOURCE, deliberately — same technique and same
    // reasoning as tests/appealStaleAlert.test.ts's equivalent case: the
    // argument only exists inside a default parameter, so every other test
    // in this file injects listNotMembers and bypasses the limit entirely.
    const source = await readFile(
      fileURLToPath(new URL('../src/module/rosterStaleAlert.ts', import.meta.url)),
      'utf8',
    );
    assert.match(
      source,
      /listRoster\(platform,\s*'not_members',\s*ROSTER_STALE_ALERT_SCAN_DAYS,\s*ROSTER_STALE_ALERT_SCAN_LIMIT\)/,
      "the job must scan with the explicit constant — a bare listRoster(platform, 'not_members') silently takes 50 rows",
    );
    assert.doesNotMatch(
      source,
      /listRoster\(platform,\s*'not_members'\)/,
      'no bare, unbounded-looking call may remain',
    );
    assert.equal(
      ROSTER_STALE_ALERT_SCAN_LIMIT,
      200,
      "200 is listRoster's own hard clamp — a larger value here would be a claim the repository does not honour",
    );
  },
);
