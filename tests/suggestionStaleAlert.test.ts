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
// enable flag), so no *_ENABLED var is needed here.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const {
  SUGGESTION_STALE_ALERT_THRESHOLD_HOURS,
  SUGGESTION_STALE_ALERT_SCAN_LIMIT,
  formatSuggestionStaleAlertMessage,
  makeDefaultSuggestionStaleAlertRun,
  startSuggestionStaleAlert,
} = await import('../src/module/suggestionStaleAlert.js');
const { WindowClosedError } = await import('@swampratnz/agent-base/platforms/whatsapp/cloudAdapter.js');
const { SUGGESTION_STALE_ALERT_POLICY_KEY } = await import('../src/module/storage/policies.js');

type Platform = 'discord' | 'whatsapp';
type SuggestionStatus = 'new' | 'reviewed' | 'declined' | 'done';
type Suggestion = {
  id: number;
  platform: Platform;
  userId: string;
  displayName: string | null;
  content: string;
  status: SuggestionStatus;
  createdAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
};
type AdminIdentity = { platform: Platform; platformUserId: string };

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

function suggestion(overrides: Partial<Suggestion> & { ageHours: number }): Suggestion {
  const { ageHours, ...rest } = overrides;
  return {
    id: 1,
    platform: 'discord',
    userId: 'user-1',
    displayName: 'Some Member',
    content: 'Please add a feature',
    status: 'new',
    createdAt: hoursAgo(ageHours),
    reviewedBy: null,
    reviewedAt: null,
    ...rest,
  };
}

function admins(entries: Array<Partial<AdminIdentity>>): AdminIdentity[] {
  return entries.map((e, i) => ({ platform: 'discord', platformUserId: `admin-${i}`, ...e }));
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

test('formatSuggestionStaleAlertMessage: fixed template with the bare count and oldest-age-in-hours only', () => {
  assert.equal(
    formatSuggestionStaleAlertMessage(1, 200),
    '💡 1 pending suggestion(s) have been waiting more than 168h (7d) for review (oldest: 200h) — ' +
      'run `list_suggestions` to review.',
  );
  assert.equal(
    formatSuggestionStaleAlertMessage(4, 999),
    '💡 4 pending suggestion(s) have been waiting more than 168h (7d) for review (oldest: 999h) — ' +
      'run `list_suggestions` to review.',
  );
});

test('SECURITY: formatSuggestionStaleAlertMessage never contains anything beyond the fixed template + two integers, for any count/age', () => {
  for (const [count, age] of [
    [0, 0],
    [1, 168],
    [7, 999],
  ]) {
    const message = formatSuggestionStaleAlertMessage(count, age);
    assert.match(
      message,
      /^💡 \d+ pending suggestion\(s\) have been waiting more than 168h \(7d\) for review \(oldest: \d+h\) — run `list_suggestions` to review\.$/,
    );
  }
});

test('SECURITY: the crossing-tick alert DM contains no suggestion id, content, userId, displayName, or platform, even when the stale set contains them', async () => {
  const { adapter, dms } = makeAdapter();
  const secretUserId = 'secret-user-id-4f2a';
  const secretDisplayName = 'secret-display-name';
  const secretContent = 'secret-suggestion-content-text';
  // Built EAGERLY, before runOnce() captures its clock — see
  // tests/appealStaleAlert.test.ts's identical comment (issue #1071): the job
  // reads `Date.now()` first and only then awaits listOpenSuggestions(), so a
  // fixture dated INSIDE that lazy callback stamps createdAt later than
  // `now`, undershooting the intended age by a hair and flooring "200h" to
  // "199h" often enough on a loaded CI runner to redden this exact assertion.
  const staleSuggestions = [
    suggestion({
      ageHours: 200,
      id: 999,
      userId: secretUserId,
      displayName: secretDisplayName,
      content: secretContent,
      platform: 'discord',
    }),
  ];
  const listOpenSuggestions = async () => staleSuggestions;
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultSuggestionStaleAlertRun(
    [adapter],
    listOpenSuggestions,
    listAdminIdentities,
    fakePolicyStore(),
  );

  await runOnce();

  assert.equal(dms.length, 1);
  const body = dms[0].text;
  assert.ok(!body.includes('999'), 'suggestion id must never appear in the alert DM');
  assert.ok(!body.includes(secretUserId), 'user id must never appear in the alert DM');
  assert.ok(!body.includes(secretDisplayName), 'display name must never appear in the alert DM');
  assert.ok(!body.includes(secretContent), 'content must never appear in the alert DM');
  assert.ok(!body.includes('discord'), 'platform string must never appear in the alert DM');
  assert.equal(
    body,
    '💡 1 pending suggestion(s) have been waiting more than 168h (7d) for review (oldest: 200h) — ' +
      'run `list_suggestions` to review.',
  );
});

test('makeDefaultSuggestionStaleAlertRun: a pending-suggestion set with none older than the threshold never alerts', async () => {
  const { adapter, dms } = makeAdapter();
  const listOpenSuggestions = async () => [
    suggestion({ ageHours: 1 }),
    suggestion({ ageHours: SUGGESTION_STALE_ALERT_THRESHOLD_HOURS - 1 }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultSuggestionStaleAlertRun(
    [adapter],
    listOpenSuggestions,
    listAdminIdentities,
    fakePolicyStore(),
  );

  await runOnce();

  assert.equal(dms.length, 0, 'nothing older than the threshold must never trip the alert');
});

test('makeDefaultSuggestionStaleAlertRun: alerts exactly once on the tick the stale count first becomes >0, then stays silent while it remains >0 — including a partial decrease that never reaches 0', async () => {
  const { adapter, dms } = makeAdapter();
  let staleCount = 0;
  const listOpenSuggestions = async () =>
    Array.from({ length: staleCount }, (_, i) => suggestion({ ageHours: 200, id: i }));
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultSuggestionStaleAlertRun(
    [adapter],
    listOpenSuggestions,
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

test('makeDefaultSuggestionStaleAlertRun: the latch re-arms once the stale count returns to exactly 0, and a later crossing alerts again', async () => {
  const { adapter, dms } = makeAdapter();
  let staleCount = 2;
  const listOpenSuggestions = async () =>
    Array.from({ length: staleCount }, (_, i) => suggestion({ ageHours: 200, id: i }));
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultSuggestionStaleAlertRun(
    [adapter],
    listOpenSuggestions,
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

test('makeDefaultSuggestionStaleAlertRun: writes the active marker to the policy store only AFTER the alertAdmins fan-out returns, on the tick that crosses', async () => {
  const { adapter } = makeAdapter();
  const store = fakePolicyStore();
  const listOpenSuggestions = async () => [suggestion({ ageHours: 200 })];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultSuggestionStaleAlertRun(
    [adapter],
    listOpenSuggestions,
    listAdminIdentities,
    store,
  );

  assert.equal(store.written.length, 0, 'no write before the tick runs');
  await runOnce();

  assert.deepEqual(store.written, [
    { key: SUGGESTION_STALE_ALERT_POLICY_KEY, value: 'true', updatedBy: 'system' },
  ]);
});

test('makeDefaultSuggestionStaleAlertRun: restart-safety — a fresh factory seeded with the active marker AND a still-stale count on its first tick does not re-alert, and leaves the marker active', async () => {
  const { adapter, dms } = makeAdapter();
  const store = fakePolicyStore({ [SUGGESTION_STALE_ALERT_POLICY_KEY]: 'true' });
  const listOpenSuggestions = async () => [
    suggestion({ ageHours: 200 }),
    suggestion({ ageHours: 300, id: 2 }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultSuggestionStaleAlertRun(
    [adapter],
    listOpenSuggestions,
    listAdminIdentities,
    store,
  );

  await runOnce();
  assert.equal(dms.length, 0, 'a restart mid-backlog must not re-fire a duplicate DM');

  await runOnce();
  assert.equal(dms.length, 0, 'a later tick with the same still-stale backlog must not fire either');
  assert.equal(store.written.length, 0, 'the already-active marker is never rewritten while nothing crosses');
});

test('makeDefaultSuggestionStaleAlertRun: re-arm survives a restart — the marker clears to "" when the count returns to 0, and a fresh factory alerts again on the next crossing', async () => {
  const { adapter, dms } = makeAdapter();
  const store = fakePolicyStore({ [SUGGESTION_STALE_ALERT_POLICY_KEY]: 'true' });
  const listAdminIdentities = async () => admins([{}]);

  const firstProcess = makeDefaultSuggestionStaleAlertRun(
    [adapter],
    async () => [],
    listAdminIdentities,
    store,
  );
  await firstProcess(); // count drops to 0 -> re-arm
  assert.equal(dms.length, 0);
  assert.deepEqual(store.written, [
    { key: SUGGESTION_STALE_ALERT_POLICY_KEY, value: '', updatedBy: 'system' },
  ]);

  const secondProcess = makeDefaultSuggestionStaleAlertRun(
    [adapter],
    async () => [suggestion({ ageHours: 200 })],
    listAdminIdentities,
    store,
  );
  await secondProcess();
  assert.equal(dms.length, 1, 'a fresh crossing after the persisted re-arm alerts again');
  assert.deepEqual(store.written, [
    { key: SUGGESTION_STALE_ALERT_POLICY_KEY, value: '', updatedBy: 'system' },
    { key: SUGGESTION_STALE_ALERT_POLICY_KEY, value: 'true', updatedBy: 'system' },
  ]);
});

test('SECURITY: makeDefaultSuggestionStaleAlertRun never threads a member/admin identifier into updatePolicy — the actor is always the fixed "system" string', async () => {
  const { adapter } = makeAdapter();
  const store = fakePolicyStore();
  const secretAdminId = 'admin-should-never-be-the-actor';
  const listOpenSuggestions = async () => [suggestion({ ageHours: 200 })];
  const listAdminIdentities = async () => admins([{ platformUserId: secretAdminId }]);
  const runOnce = makeDefaultSuggestionStaleAlertRun(
    [adapter],
    listOpenSuggestions,
    listAdminIdentities,
    store,
  );

  await runOnce();

  assert.ok(store.written.length > 0);
  for (const write of store.written) {
    assert.equal(write.updatedBy, 'system');
    assert.notEqual(write.updatedBy, secretAdminId);
  }
});

test('a suggestion resolved before crossing the threshold never contributes to the stale count and never triggers an alert', async () => {
  const { adapter, dms } = makeAdapter();
  // listOpenSuggestions models listSuggestions('new', ...) — a resolved
  // suggestion (reviewed/declined/done) is excluded by the DB query itself,
  // so a run that never observes it must never alert, even if it would have
  // crossed the threshold had it stayed pending.
  const listOpenSuggestions = async () => [];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultSuggestionStaleAlertRun(
    [adapter],
    listOpenSuggestions,
    listAdminIdentities,
    fakePolicyStore(),
  );

  await runOnce();

  assert.equal(dms.length, 0, 'a resolved suggestion (absent from the pending scan) never triggers an alert');
});

test('SECURITY: a WindowClosedError for one admin is queued via queueForWindowReopen (not dropped) and does not block delivery to the rest', async () => {
  const { adapter, dms, queued } = makeCloudAdapter({
    'admin-closed': new WindowClosedError('admin-closed'),
  });
  const listOpenSuggestions = async () => [suggestion({ ageHours: 200 })];
  const listAdminIdentities = async () =>
    admins([
      { platform: 'whatsapp', platformUserId: 'admin-open' },
      { platform: 'whatsapp', platformUserId: 'admin-closed' },
    ]);
  const runOnce = makeDefaultSuggestionStaleAlertRun(
    [adapter],
    listOpenSuggestions,
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

test('startSuggestionStaleAlert: always-on, no enable flag — creates a timer even with no *_ENABLED env set', () => {
  const timer = startSuggestionStaleAlert([], async () => {});
  assert.notEqual(timer, null, 'this job is unconditionally enabled by design');
  if (timer) clearInterval(timer);
});

// --- the scan bound ---------------------------------------------------------

test(
  'the default listOpenSuggestions asks listSuggestions for SUGGESTION_STALE_ALERT_SCAN_LIMIT, never its ' +
    '50-row default — listSuggestions is ordered created_at DESC with no ordering override, so a bare call ' +
    'hands this job the NEWEST pending suggestions and then filters them for the OLDEST, going quiet exactly ' +
    'as the backlog worsens',
  async () => {
    // Asserted against the SOURCE, deliberately — same technique as
    // tests/appealStaleAlert.test.ts's own scan-bound test: the argument only
    // exists inside a default parameter, so the sole runtime observation
    // point is the real `listSuggestions` binding, resolved at import time.
    // Every other test in this file injects `listOpenSuggestions` and
    // therefore bypasses the limit entirely.
    const source = await readFile(
      fileURLToPath(new URL('../src/module/suggestionStaleAlert.ts', import.meta.url)),
      'utf8',
    );
    assert.match(
      source,
      /listSuggestions\('new',\s*SUGGESTION_STALE_ALERT_SCAN_LIMIT\)/,
      "the job must scan with the explicit constant — a bare listSuggestions('new') silently takes 50 rows",
    );
    assert.doesNotMatch(source, /listSuggestions\('new'\)/, 'no bare, unbounded-looking call may remain');
    assert.equal(
      SUGGESTION_STALE_ALERT_SCAN_LIMIT,
      200,
      "200 is listSuggestions' own hard clamp — a larger value here would be a claim the repository does not honour",
    );
  },
);
