import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';
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
  KNOWLEDGE_CANDIDATE_STALE_ALERT_THRESHOLD_HOURS,
  KNOWLEDGE_CANDIDATE_STALE_ALERT_SCAN_LIMIT,
  formatKnowledgeCandidateStaleAlertMessage,
  makeDefaultKnowledgeCandidateStaleAlertRun,
  startKnowledgeCandidateStaleAlert,
} = await import('../src/module/knowledgeCandidateStaleAlert.js');
const { WindowClosedError } = await import('@swampratnz/agent-base/platforms/whatsapp/cloudAdapter.js');

type Platform = 'discord' | 'whatsapp';
type KnowledgeCandidateStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn';
type KnowledgeCandidate = {
  id: number;
  digestId: number | null;
  topic: string;
  title: string;
  content: string;
  status: KnowledgeCandidateStatus;
  createdAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  sourcePlatform: Platform | null;
  sourceUserId: string | null;
  retrievalCount: number | null;
};
type AdminIdentity = { platform: Platform; platformUserId: string };

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

function candidate(overrides: Partial<KnowledgeCandidate> & { ageHours: number }): KnowledgeCandidate {
  const { ageHours, ...rest } = overrides;
  return {
    id: 1,
    digestId: null,
    topic: 'Some topic',
    title: 'Some title',
    content: 'Some content',
    status: 'pending',
    createdAt: hoursAgo(ageHours),
    reviewedBy: null,
    reviewedAt: null,
    sourcePlatform: 'discord',
    sourceUserId: 'user-1',
    retrievalCount: null,
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

test('formatKnowledgeCandidateStaleAlertMessage: fixed template with the bare count and oldest-age-in-hours only', () => {
  assert.equal(
    formatKnowledgeCandidateStaleAlertMessage(1, 200),
    '📚 1 pending knowledge candidate(s) have been waiting more than 168h (7d) for review (oldest: 200h) — ' +
      'run `list_knowledge_candidates` to review.',
  );
  assert.equal(
    formatKnowledgeCandidateStaleAlertMessage(4, 999),
    '📚 4 pending knowledge candidate(s) have been waiting more than 168h (7d) for review (oldest: 999h) — ' +
      'run `list_knowledge_candidates` to review.',
  );
});

test('SECURITY: formatKnowledgeCandidateStaleAlertMessage never contains anything beyond the fixed template + two integers, for any count/age', () => {
  for (const [count, age] of [
    [0, 0],
    [1, 168],
    [7, 999],
  ]) {
    const message = formatKnowledgeCandidateStaleAlertMessage(count, age);
    assert.match(
      message,
      /^📚 \d+ pending knowledge candidate\(s\) have been waiting more than 168h \(7d\) for review \(oldest: \d+h\) — run `list_knowledge_candidates` to review\.$/,
    );
  }
});

test('SECURITY: the crossing-tick alert DM contains no candidate id, title, content, topic, sourcePlatform, or sourceUserId, even when the stale set contains them', async () => {
  const { adapter, dms } = makeAdapter();
  const secretUserId = 'secret-user-id-4f2a';
  const secretTitle = 'secret-candidate-title';
  const secretContent = 'secret-candidate-content-text';
  const secretTopic = 'secret-candidate-topic';
  const listOpenCandidates = async () => [
    candidate({
      ageHours: 200,
      id: 999,
      title: secretTitle,
      content: secretContent,
      topic: secretTopic,
      sourcePlatform: 'discord',
      sourceUserId: secretUserId,
    }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultKnowledgeCandidateStaleAlertRun(
    [adapter],
    listOpenCandidates,
    listAdminIdentities,
  );

  await runOnce();

  assert.equal(dms.length, 1);
  const body = dms[0].text;
  assert.ok(!body.includes('999'), 'candidate id must never appear in the alert DM');
  assert.ok(!body.includes(secretUserId), 'source user id must never appear in the alert DM');
  assert.ok(!body.includes(secretTitle), 'title must never appear in the alert DM');
  assert.ok(!body.includes(secretContent), 'content must never appear in the alert DM');
  assert.ok(!body.includes(secretTopic), 'topic must never appear in the alert DM');
  assert.ok(!body.includes('discord'), 'source platform string must never appear in the alert DM');
  assert.equal(
    body,
    '📚 1 pending knowledge candidate(s) have been waiting more than 168h (7d) for review (oldest: 200h) — ' +
      'run `list_knowledge_candidates` to review.',
  );
});

test('makeDefaultKnowledgeCandidateStaleAlertRun: a pending-candidate set with none older than the threshold never alerts', async () => {
  const { adapter, dms } = makeAdapter();
  const listOpenCandidates = async () => [
    candidate({ ageHours: 1 }),
    candidate({ ageHours: KNOWLEDGE_CANDIDATE_STALE_ALERT_THRESHOLD_HOURS - 1 }),
  ];
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultKnowledgeCandidateStaleAlertRun(
    [adapter],
    listOpenCandidates,
    listAdminIdentities,
  );

  await runOnce();

  assert.equal(dms.length, 0, 'nothing older than the threshold must never trip the alert');
});

test('makeDefaultKnowledgeCandidateStaleAlertRun: alerts exactly once on the tick the stale count first becomes >0, then stays silent while it remains >0 — including a partial decrease that never reaches 0', async () => {
  const { adapter, dms } = makeAdapter();
  let staleCount = 0;
  const listOpenCandidates = async () =>
    Array.from({ length: staleCount }, (_, i) => candidate({ ageHours: 200, id: i }));
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultKnowledgeCandidateStaleAlertRun(
    [adapter],
    listOpenCandidates,
    listAdminIdentities,
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

test('makeDefaultKnowledgeCandidateStaleAlertRun: the latch re-arms once the stale count returns to exactly 0, and a later crossing alerts again', async () => {
  const { adapter, dms } = makeAdapter();
  let staleCount = 2;
  const listOpenCandidates = async () =>
    Array.from({ length: staleCount }, (_, i) => candidate({ ageHours: 200, id: i }));
  const listAdminIdentities = async () => admins([{}]);
  const runOnce = makeDefaultKnowledgeCandidateStaleAlertRun(
    [adapter],
    listOpenCandidates,
    listAdminIdentities,
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

test('SECURITY: a WindowClosedError for one admin is queued via queueForWindowReopen (not dropped) and does not block delivery to the rest', async () => {
  const { adapter, dms, queued } = makeCloudAdapter({
    'admin-closed': new WindowClosedError('admin-closed'),
  });
  const listOpenCandidates = async () => [candidate({ ageHours: 200 })];
  const listAdminIdentities = async () =>
    admins([
      { platform: 'whatsapp', platformUserId: 'admin-open' },
      { platform: 'whatsapp', platformUserId: 'admin-closed' },
    ]);
  const runOnce = makeDefaultKnowledgeCandidateStaleAlertRun(
    [adapter],
    listOpenCandidates,
    listAdminIdentities,
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

test('startKnowledgeCandidateStaleAlert: always-on, no enable flag — creates a timer even with no *_ENABLED env set', () => {
  const timer = startKnowledgeCandidateStaleAlert([], async () => {});
  assert.notEqual(timer, null, 'this job is unconditionally enabled by design');
  if (timer) clearInterval(timer);
});

// --- the scan bound ---------------------------------------------------------

test('the default listOpenCandidates asks listKnowledgeCandidates for KNOWLEDGE_CANDIDATE_STALE_ALERT_SCAN_LIMIT, oldest-first', async () => {
  // Asserted against the SOURCE, deliberately — same technique as
  // tests/appealStaleAlert.test.ts's own scan-bound test: the argument only
  // exists inside a default parameter, so the sole runtime observation
  // point is the real `listKnowledgeCandidates` binding, resolved at
  // import time. Every other test in this file injects `listOpenCandidates`
  // and therefore bypasses the limit entirely.
  const source = await readFile(
    fileURLToPath(new URL('../src/module/knowledgeCandidateStaleAlert.ts', import.meta.url)),
    'utf8',
  );
  assert.match(
    source,
    /listKnowledgeCandidates\('pending',\s*KNOWLEDGE_CANDIDATE_STALE_ALERT_SCAN_LIMIT,\s*true\)/,
    'the job must scan with the explicit constant and oldestFirst:true — a bare call would silently miss the oldest rows',
  );
  assert.equal(
    KNOWLEDGE_CANDIDATE_STALE_ALERT_SCAN_LIMIT,
    200,
    "200 is listKnowledgeCandidates' own hard clamp — a larger value here would be a claim the repository does not honour",
  );
});
