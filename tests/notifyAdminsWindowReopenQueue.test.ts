import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// Issue #602: WhatsApp Cloud admin/super-admin real-time alerts (escalations,
// report_content/appeal_moderation notices) silently vanished for a recipient
// whose 24h customer-service window was closed, even though the adapter
// itself stayed connected — a distinct failure class from the existing
// zero-connected-adapter case (#534/#545/#593). tools.ts's `notifySuperAdmins`/
// `notifyAdmins` now tell that failure apart (via the adapter throwing an
// exported `WindowClosedError`) and queue via the adapter's optional
// `queueForWindowReopen` instead of only logging and dropping.
//
// listAdmins() is a static import inside agent/tools.ts, so it must be mocked
// before anything imports that module (same trap as
// tests/notifyAdminsAccessRequestUnqueued.test.ts).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS ??= 'super-1,super-2';

let modulesPromise: Promise<{
  notifyAdmins: typeof import('../src/agent/tools.js').notifyAdmins;
  notifyReportFiled: typeof import('../src/agent/tools.js').notifyReportFiled;
  WindowClosedError: typeof import('../src/platforms/whatsapp/cloudAdapter.js').WindowClosedError;
}> | null = null;
async function modules(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!modulesPromise) {
    modulesPromise = (async () => {
      const realRepo = await import('../src/storage/repository.js');
      t.mock.module('../src/storage/repository.js', {
        namedExports: {
          ...realRepo,
          listAdmins: async () => [
            { platform: 'whatsapp' as const, platformUserId: 'admin-open' },
            { platform: 'whatsapp' as const, platformUserId: 'admin-closed' },
            { platform: 'discord' as const, platformUserId: 'admin-discord' },
          ],
        },
      });
      const [{ notifyAdmins, notifyReportFiled }, { WindowClosedError }] = await Promise.all([
        import('../src/agent/tools.js'),
        import('../src/platforms/whatsapp/cloudAdapter.js'),
      ]);
      return { notifyAdmins, notifyReportFiled, WindowClosedError };
    })();
  }
  return modulesPromise;
}

/**
 * A fake Cloud-like adapter (issue #602's acceptance criterion 1 calls for
 * exactly this shape): `sendDirectMessage` rejects with whatever error
 * `rejections[userId]` names (or succeeds if absent), and `queueForWindowReopen`
 * records what was queued, per-recipient, for assertion.
 */
function makeFakeCloudAdapter(rejections: Record<string, unknown>) {
  const sends: Array<{ userId: string; text: string }> = [];
  const queued: Array<{ userId: string; message: string; priority: 'system' | 'low' }> = [];
  const adapter: PlatformAdapter = {
    platform: 'whatsapp',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage() {},
    async sendMessage() {},
    async sendDirectMessage(userId: string, text: string) {
      if (userId in rejections) throw rejections[userId];
      sends.push({ userId, text });
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
  return { adapter, sends, queued };
}

/** A stub with no `queueForWindowReopen` — the shape of Discord/Baileys today. */
function makeAdapterWithoutQueueMethod(rejections: Record<string, unknown>) {
  const sends: Array<{ userId: string; text: string }> = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage() {},
    async sendMessage() {},
    async sendDirectMessage(userId: string, text: string) {
      if (userId in rejections) throw rejections[userId];
      sends.push({ userId, text });
    },
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return { adapter, sends };
}

test('notifySuperAdmins (via notifyReportFiled): a WindowClosedError rejection queues via queueForWindowReopen instead of only logging, while the other recipient is still delivered live (acceptance criterion 1)', async (t) => {
  const { notifyReportFiled, WindowClosedError } = await modules(t);
  const { adapter, sends, queued } = makeFakeCloudAdapter({
    'super-2': new WindowClosedError('super-2'),
  });

  await notifyReportFiled((platform) => (platform === 'whatsapp' ? adapter : undefined), {
    id: 602,
    reporterUserId: 'reporter-1',
    reporterName: 'Reporter One',
    conversationId: 'convo-1',
    reason: 'window-closed recipient',
  });

  assert.deepEqual(
    sends.map((s) => s.userId),
    ['super-1'],
    'the open-window recipient is still delivered live',
  );
  assert.equal(queued.length, 1, 'exactly one recipient was queued');
  assert.equal(queued[0]?.userId, 'super-2');
  assert.match(
    queued[0]?.message ?? '',
    /#602/,
    'the queued text is the same alert that would have been sent live',
  );
});

test('notifyAdmins: a WindowClosedError rejection queues via queueForWindowReopen instead of only logging (acceptance criterion 1)', async (t) => {
  const { notifyAdmins, WindowClosedError } = await modules(t);
  const { adapter, sends, queued } = makeFakeCloudAdapter({
    'admin-closed': new WindowClosedError('admin-closed'),
  });

  await notifyAdmins((platform) => (platform === 'whatsapp' ? adapter : undefined), 'escalation alert', '');

  assert.deepEqual(
    sends.map((s) => s.userId),
    ['admin-open'],
    'the open-window admin is still delivered live',
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.userId, 'admin-closed');
  assert.match(queued[0]?.message ?? '', /escalation alert/);
});

test("SECURITY: the producer's trust level is threaded to queueForWindowReopen so the per-recipient queue can enforce #545 — a member-reachable report_content alert queues 'low', a bot-originated escalation queues 'system' (issue #602)", async (t) => {
  const { notifyReportFiled, notifyAdmins, WindowClosedError } = await modules(t);

  // report_content → notifyReportFiled → notifySuperAdmins: member-reachable, must be 'low'.
  const report = makeFakeCloudAdapter({ 'super-2': new WindowClosedError('super-2') });
  await notifyReportFiled((platform) => (platform === 'whatsapp' ? report.adapter : undefined), {
    id: 700,
    reporterUserId: 'reporter-1',
    reporterName: 'Reporter One',
    conversationId: 'convo-1',
    reason: 'member-reachable low alert',
  });
  assert.deepEqual(
    report.queued.map((q) => ({ userId: q.userId, priority: q.priority })),
    [{ userId: 'super-2', priority: 'low' }],
    "a member-tier report_content alert is queued 'low' so it can never evict a system alert",
  );

  // escalation → notifyAdmins: bot/router-originated, must be 'system'.
  const escalation = makeFakeCloudAdapter({ 'admin-closed': new WindowClosedError('admin-closed') });
  await notifyAdmins(
    (platform) => (platform === 'whatsapp' ? escalation.adapter : undefined),
    'escalation alert',
    '',
  );
  assert.deepEqual(
    escalation.queued.map((q) => ({ userId: q.userId, priority: q.priority })),
    [{ userId: 'admin-closed', priority: 'system' }],
    "a bot-originated escalation is queued 'system' so a member's queued report can never evict it",
  );
});

test('SECURITY: notifyAdmins — a rejection that is NOT a WindowClosedError (a generic Graph API failure) is never queued via queueForWindowReopen; it stays logged-and-dropped exactly as today (acceptance criterion 6)', async (t) => {
  const { notifyAdmins } = await modules(t);
  const { adapter, sends, queued } = makeFakeCloudAdapter({
    'admin-closed': new Error('502 from Graph API'),
  });

  await notifyAdmins((platform) => (platform === 'whatsapp' ? adapter : undefined), 'unrelated failure', '');

  assert.deepEqual(
    sends.map((s) => s.userId),
    ['admin-open'],
  );
  assert.deepEqual(
    queued,
    [],
    'a non-WindowClosedError rejection must never populate the per-recipient window-reopen queue',
  );
});

test('SECURITY: notifySuperAdmins (via notifyReportFiled) — a rejection that is NOT a WindowClosedError is never queued via queueForWindowReopen (acceptance criterion 6)', async (t) => {
  const { notifyReportFiled } = await modules(t);
  const { adapter, sends, queued } = makeFakeCloudAdapter({
    'super-2': new Error('missing config'),
  });

  await notifyReportFiled((platform) => (platform === 'whatsapp' ? adapter : undefined), {
    id: 603,
    reporterUserId: 'reporter-1',
    reporterName: 'Reporter One',
    conversationId: 'convo-1',
    reason: 'genuine failure, not a closed window',
  });

  assert.deepEqual(
    sends.map((s) => s.userId),
    ['super-1'],
  );
  assert.deepEqual(queued, [], 'a non-WindowClosedError rejection must never be queued');
});

test('notifyAdmins: an adapter with no queueForWindowReopen (Discord/Baileys shape) falls through to log-and-drop for any rejection, including a WindowClosedError instance — no crash, byte-identical drop behavior (acceptance criterion 8)', async (t) => {
  const { notifyAdmins, WindowClosedError } = await modules(t);
  const { adapter, sends } = makeAdapterWithoutQueueMethod({
    'admin-discord': new WindowClosedError('admin-discord'),
  });

  await assert.doesNotReject(
    notifyAdmins((platform) => (platform === 'discord' ? adapter : undefined), 'escalation alert', ''),
  );

  assert.deepEqual(
    sends,
    [],
    "the discord admin's send rejected (a WindowClosedError instance, which can't really happen on " +
      'Discord, but the wiring must not assume it can only come from a Cloud-capable adapter) and there is ' +
      'no queueForWindowReopen to fall back to, so it is simply logged-and-dropped — no crash, no queue',
  );
});
