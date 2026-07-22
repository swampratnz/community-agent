import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// Issue #644: #602 gave notifySuperAdmins/notifyAdmins a recovery path for
// the WhatsApp Cloud API's connected-but-this-recipient's-24h-window-is-
// closed failure (WindowClosedError), queuing via the adapter's optional
// queueForWindowReopen instead of logging and dropping the DM — but that fix
// was deliberately scoped to admin/super-admin alerts (see
// tests/notifyAdminsWindowReopenQueue.test.ts). This file extends the same
// coverage to the 4 MEMBER-facing resolution DMs that never got it:
// notifyMemberApproved, notifySuggestionResolved, notifyReportResolved, and
// notifyAppealResolved (all in src/agent/tools.ts).
//
// Unlike tools.ts's admin-alert path, none of these 4 functions touch
// listAdmins() or any other static repository import — they take the
// adapter and userId directly — so, unlike
// tests/notifyAdminsWindowReopenQueue.test.ts, no module-mocking trap
// applies here; a plain top-level import is safe.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { notifyMemberApproved, notifySuggestionResolved, notifyReportResolved, notifyAppealResolved } =
  await import('../src/agent/tools.js');
const { WhatsAppCloudAdapter, WindowClosedError } = await import('../src/platforms/whatsapp/cloudAdapter.js');

/**
 * Reflection helper into the REAL WhatsAppCloudAdapter's private
 * per-recipient window-reopen queue, same convention as
 * tests/whatsappCloudAdapter.test.ts's own `windowReopenQueueInternals` —
 * used so the SECURITY test below exercises the actual production eviction
 * logic (`queueForWindowReopen`), not a re-implementation of it.
 */
function windowReopenQueueInternals(adapter: InstanceType<typeof WhatsAppCloudAdapter>) {
  return adapter as unknown as {
    windowReopenQueue: Map<string, { message: string; priority: 'system' | 'low' }[]>;
  };
}

/**
 * A fake Cloud-like adapter, same shape as
 * tests/notifyAdminsWindowReopenQueue.test.ts's makeFakeCloudAdapter:
 * `sendDirectMessage` rejects with whatever `rejection` names (or succeeds if
 * absent), and `queueForWindowReopen` records what was queued for assertion.
 */
function makeFakeCloudAdapter(rejection?: Error) {
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
      if (rejection !== undefined) throw rejection;
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
function makeAdapterWithoutQueueMethod(rejection?: Error) {
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
      if (rejection !== undefined) throw rejection;
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

test('notifyMemberApproved: a WindowClosedError rejection queues via queueForWindowReopen at low priority and resolves true, instead of only logging and resolving false (acceptance criteria 1, 3)', async () => {
  const { adapter, sends, queued } = makeFakeCloudAdapter(new WindowClosedError('member-1'));

  const delivered = await notifyMemberApproved(adapter, 'member-1', false, 'whatsapp');

  assert.deepEqual(sends, [], 'the live send was never recorded as succeeding');
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.userId, 'member-1');
  assert.equal(queued[0]?.priority, 'low');
  assert.match(
    queued[0]?.message ?? '',
    /approved/i,
    'the queued text is the same templated approval message',
  );
  assert.equal(
    delivered,
    true,
    "queued-for-reopen counts as delivered, not a DM failure (issue #556's signal)",
  );
});

test('notifyMemberApproved: a non-WindowClosedError rejection is unaffected — still logged-and-dropped, resolves false (regression, acceptance criterion 2)', async () => {
  const { adapter, queued } = makeFakeCloudAdapter(new Error('DMs closed'));

  const delivered = await notifyMemberApproved(adapter, 'member-1', false, 'whatsapp');

  assert.deepEqual(queued, [], 'a generic rejection must never populate the window-reopen queue');
  assert.equal(delivered, false);
});

test('notifySuggestionResolved: a WindowClosedError rejection queues via queueForWindowReopen at low priority with the byte-identical message (acceptance criteria 1, 4)', async () => {
  const { adapter, queued } = makeFakeCloudAdapter(new WindowClosedError('member-2'));

  await notifySuggestionResolved(adapter, 'member-2', 'done', 'add dark mode', 'whatsapp');

  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.userId, 'member-2');
  assert.equal(queued[0]?.priority, 'low');
  assert.match(queued[0]?.message ?? '', /add dark mode/);
});

test('notifySuggestionResolved: a non-WindowClosedError rejection is unaffected (regression, acceptance criterion 2)', async () => {
  const { adapter, queued } = makeFakeCloudAdapter(new Error('502 from Graph API'));

  await assert.doesNotReject(
    notifySuggestionResolved(adapter, 'member-2', 'done', 'add dark mode', 'whatsapp'),
  );

  assert.deepEqual(queued, []);
});

test('notifyReportResolved: a WindowClosedError rejection queues via queueForWindowReopen at low priority with the byte-identical message (acceptance criteria 1, 4)', async () => {
  const { adapter, queued } = makeFakeCloudAdapter(new WindowClosedError('member-3'));

  await notifyReportResolved(adapter, 'member-3', 'resolved', 'someone was rude', 'whatsapp');

  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.userId, 'member-3');
  assert.equal(queued[0]?.priority, 'low');
  assert.match(queued[0]?.message ?? '', /someone was rude/);
});

test('notifyReportResolved: a non-WindowClosedError rejection is unaffected (regression, acceptance criterion 2)', async () => {
  const { adapter, queued } = makeFakeCloudAdapter(new Error('missing config'));

  await assert.doesNotReject(
    notifyReportResolved(adapter, 'member-3', 'resolved', 'someone was rude', 'whatsapp'),
  );

  assert.deepEqual(queued, []);
});

test('notifyAppealResolved: a WindowClosedError rejection queues via queueForWindowReopen at low priority with the byte-identical message (acceptance criteria 1, 4)', async () => {
  const { adapter, queued } = makeFakeCloudAdapter(new WindowClosedError('member-4'));

  await notifyAppealResolved(adapter, 'member-4', 'resolved', 'my mute was a mistake', 'whatsapp');

  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.userId, 'member-4');
  assert.equal(queued[0]?.priority, 'low');
  assert.match(queued[0]?.message ?? '', /my mute was a mistake/);
});

test('notifyAppealResolved: a non-WindowClosedError rejection is unaffected (regression, acceptance criterion 2)', async () => {
  const { adapter, queued } = makeFakeCloudAdapter(new Error('502 from Graph API'));

  await assert.doesNotReject(
    notifyAppealResolved(adapter, 'member-4', 'resolved', 'my mute was a mistake', 'whatsapp'),
  );

  assert.deepEqual(queued, []);
});

test('an adapter with no queueForWindowReopen (Discord/Baileys shape) falls through to log-and-drop for a WindowClosedError rejection from any of the 4 producers — no crash, byte-identical drop behavior', async () => {
  const approved = makeAdapterWithoutQueueMethod(new WindowClosedError('member-1'));
  const delivered = await notifyMemberApproved(approved.adapter, 'member-1', false, 'discord');
  assert.equal(delivered, false, 'no queueForWindowReopen to fall back to, so this is a plain drop');

  const suggestion = makeAdapterWithoutQueueMethod(new WindowClosedError('member-2'));
  await assert.doesNotReject(
    notifySuggestionResolved(suggestion.adapter, 'member-2', 'done', 'add dark mode', 'discord'),
  );

  const report = makeAdapterWithoutQueueMethod(new WindowClosedError('member-3'));
  await assert.doesNotReject(
    notifyReportResolved(report.adapter, 'member-3', 'resolved', 'reason', 'discord'),
  );

  const appeal = makeAdapterWithoutQueueMethod(new WindowClosedError('member-4'));
  await assert.doesNotReject(
    notifyAppealResolved(appeal.adapter, 'member-4', 'resolved', 'reason', 'discord'),
  );
});

test(
  "SECURITY: a 'low'-priority entry produced by any of the 4 new member-facing producers can never evict a " +
    "'system'-priority entry queued for the same recipient — extends #602/#545's priority-eviction invariant " +
    'to these new producers, exercised against the REAL WhatsAppCloudAdapter.queueForWindowReopen ' +
    '(acceptance criterion 5)',
  async () => {
    // Same per-recipient cap tests/whatsappCloudAdapter.test.ts's own tests use
    // literally (WINDOW_REOPEN_QUEUE_CAP isn't exported).
    const CAP = 3;

    async function assertLowNeverEvictsSystem(
      run: (adapter: InstanceType<typeof WhatsAppCloudAdapter>) => Promise<unknown>,
      recipientId: string,
    ) {
      const adapter = new WhatsAppCloudAdapter();
      // Every live send rejects as window-closed, regardless of recipient —
      // this test is only exercising the queue side, never a real Graph API call.
      adapter.sendDirectMessage = async () => {
        throw new WindowClosedError(recipientId);
      };

      // Fill the recipient's queue with 'system' entries up to the cap, via the
      // REAL queueForWindowReopen — as if admin-action audits/escalations were
      // already queued for this same window-closed recipient.
      for (let i = 0; i < CAP; i++) {
        adapter.queueForWindowReopen(recipientId, `sys-${i}`, 'system');
      }
      const { windowReopenQueue } = windowReopenQueueInternals(adapter);
      const before = windowReopenQueue.get(recipientId)?.map((e) => e.message);
      assert.equal(before?.length, CAP, 'precondition: the recipient queue is full of system entries');

      await run(adapter);

      assert.deepEqual(
        windowReopenQueue.get(recipientId)?.map((e) => e.message),
        before,
        'every system entry survives untouched — the low enqueue from this producer was dropped, not appended',
      );
      assert.ok(
        windowReopenQueue.get(recipientId)?.every((e) => e.priority === 'system'),
        'no low-priority entry ever entered the full system queue',
      );
    }

    await assertLowNeverEvictsSystem(
      (adapter) => notifyMemberApproved(adapter, 'r1', false, 'whatsapp'),
      'r1',
    );
    await assertLowNeverEvictsSystem(
      (adapter) => notifySuggestionResolved(adapter, 'r2', 'done', 'add dark mode', 'whatsapp'),
      'r2',
    );
    await assertLowNeverEvictsSystem(
      (adapter) => notifyReportResolved(adapter, 'r3', 'resolved', 'reason', 'whatsapp'),
      'r3',
    );
    await assertLowNeverEvictsSystem(
      (adapter) => notifyAppealResolved(adapter, 'r4', 'resolved', 'reason', 'whatsapp'),
      'r4',
    );
  },
);
