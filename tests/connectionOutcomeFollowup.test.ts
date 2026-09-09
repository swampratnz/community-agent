import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
// connectionOutcomeFollowupMessage is rendered via notice(), same reason
// tests/interestMatchAlert.test.ts needs it.
import './support/registerNotices.js';
import type { OutgoingMessage, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/interestMatchAlert.test.ts. This job is always-on (no
// enable flag), so no *_ENABLED var is needed here.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const {
  CONNECTION_OUTCOME_FOLLOWUP_DELAY_DAYS,
  makeDefaultConnectionOutcomeFollowupRun,
  startConnectionOutcomeFollowup,
} = await import('../src/module/connectionOutcomeFollowup.js');
const { WindowClosedError } = await import('@swampratnz/agent-base/platforms/whatsapp/cloudAdapter.js');

type Platform = 'discord' | 'whatsapp';
type DueRow = { id: number; requesterPlatform: Platform; requesterUserId: string };

function due(entries: Array<Partial<DueRow>>): DueRow[] {
  return entries.map((e, i) => ({
    id: i + 1,
    requesterPlatform: 'discord',
    requesterUserId: `member-${i}`,
    ...e,
  }));
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

/** Mirrors tests/interestMatchAlert.test.ts's makeCloudAdapter. */
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

const englishSelection = async () => ({ language: 'en' as const, style: undefined });

test('CONNECTION_OUTCOME_FOLLOWUP_DELAY_DAYS is the proposal-named fixed window (issue #1354)', () => {
  assert.equal(CONNECTION_OUTCOME_FOLLOWUP_DELAY_DAYS, 3);
});

test('makeDefaultConnectionOutcomeFollowupRun: DMs the requester for every claimed row, using the row-supplied identity', async () => {
  const { adapter, dms } = makeAdapter();
  const claimDue = async () => due([{ requesterUserId: 'member-a' }, { requesterUserId: 'member-b' }]);
  const runOnce = makeDefaultConnectionOutcomeFollowupRun([adapter], claimDue, englishSelection);

  await runOnce();

  assert.deepEqual(
    dms.map((d) => d.userId),
    ['member-a', 'member-b'],
  );
});

test('SECURITY: no claimed rows means no scan and no DM', async () => {
  const { adapter, dms } = makeAdapter();
  const claimDue = async () => [];
  const runOnce = makeDefaultConnectionOutcomeFollowupRun([adapter], claimDue, englishSelection);

  await runOnce();

  assert.equal(dms.length, 0);
});

test("SECURITY: the DM target is resolved from the claimed row's own requesterPlatform/requesterUserId only, and the rendered DM contains no topic/project content — only the fixed copy and the row's own id", async () => {
  const { adapter, dms } = makeAdapter();
  const claimDue = async () => [
    { id: 42, requesterPlatform: 'discord' as const, requesterUserId: 'member-only-target' },
  ];
  const runOnce = makeDefaultConnectionOutcomeFollowupRun([adapter], claimDue, englishSelection);

  await runOnce();

  assert.equal(dms.length, 1);
  assert.equal(dms[0].userId, 'member-only-target');
  assert.match(dms[0].text, /42/, "the row's own id is named so rate_connection_outcome can be called");
  assert.equal(
    dms[0].text,
    "Did the connection from your recent find_helper/request_project_connection ask actually help? Reply and I'll record it with rate_connection_outcome (outcome id 42).",
  );
});

test('a claimed row on a platform with no connected adapter is silently skipped, never throws', async () => {
  const { adapter } = makeAdapter(false);
  const claimDue = async () => due([{}]);
  const runOnce = makeDefaultConnectionOutcomeFollowupRun([adapter], claimDue, englishSelection);

  await assert.doesNotReject(runOnce());
});

test('SECURITY: a WindowClosedError for one row is queued via queueForWindowReopen (not dropped) and does not block delivery to the rest', async () => {
  const { adapter, dms, queued } = makeCloudAdapter({
    'member-closed': new WindowClosedError('member-closed'),
  });
  const claimDue = async () =>
    due([
      { requesterPlatform: 'whatsapp', requesterUserId: 'member-open' },
      { requesterPlatform: 'whatsapp', requesterUserId: 'member-closed' },
    ]);
  const runOnce = makeDefaultConnectionOutcomeFollowupRun([adapter], claimDue, englishSelection);

  await runOnce();

  assert.deepEqual(
    dms.map((d) => d.userId),
    ['member-open'],
    'the open-window recipient is still delivered live',
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0].userId, 'member-closed');
  assert.equal(queued[0].priority, 'low');
});

test('SECURITY: a throwing per-row notice-selection read never aborts the tick — every other claimed row is still processed', async () => {
  const { adapter, dms } = makeAdapter();
  const claimDue = async () =>
    due([{ requesterUserId: 'member-broken' }, { requesterUserId: 'member-fine' }]);
  const resolveNoticeSelection = async (_platform: string, userId: string) => {
    if (userId === 'member-broken') throw new Error('transient DB blip');
    return { language: 'en' as const, style: undefined };
  };
  const runOnce = makeDefaultConnectionOutcomeFollowupRun([adapter], claimDue, resolveNoticeSelection);

  await assert.doesNotReject(runOnce());

  assert.deepEqual(
    dms.map((d) => d.userId),
    ['member-fine'],
    "the broken row's read failure must not suppress the DM to the other, healthy row",
  );
});

test('startConnectionOutcomeFollowup: always-on, no enable flag — creates a timer even with no *_ENABLED env set', () => {
  const timer = startConnectionOutcomeFollowup([], async () => {});
  assert.notEqual(timer, null, 'this job is unconditionally enabled by design');
  if (timer) clearInterval(timer);
});
