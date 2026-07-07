import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelPendingAction,
  classifyConfirmReply,
  CONFIRM_TTL_MS,
  hasPendingAction,
  peekPendingAction,
  registerPendingAction,
  sweepExpiredPendingActions,
  takePendingAction,
} from '../src/agent/pendingActions.js';

test('confirm reply classification', () => {
  assert.equal(classifyConfirmReply('CONFIRM'), 'confirm');
  assert.equal(classifyConfirmReply('  confirm  '), 'confirm');
  assert.equal(classifyConfirmReply('cancel'), 'cancel');
  assert.equal(classifyConfirmReply('please confirm the kick'), null);
  assert.equal(classifyConfirmReply('yes'), null);
});

test('SECURITY: confirm works when the bot is @-mentioned (WhatsApp groups)', () => {
  // In a group the admin must mention the bot to address it; the mention
  // token must not break classification.
  assert.equal(classifyConfirmReply('@64211234567 CONFIRM'), 'confirm');
  assert.equal(classifyConfirmReply('@64211234567 @6421000000 confirm'), 'confirm');
  assert.equal(classifyConfirmReply('@64211234567 cancel'), 'cancel');
  // But a mention alone, or mention + other text, is not a confirmation.
  assert.equal(classifyConfirmReply('@64211234567'), null);
  assert.equal(classifyConfirmReply('@64211234567 kick them'), null);
});

test('pending action executes exactly once via take', async () => {
  let runs = 0;
  registerPendingAction('discord', 'chan1', 'admin1', {
    description: 'kick user X',
    minTier: 'admin',
    execute: async () => {
      runs += 1;
      return 'done';
    },
  });

  assert.ok(hasPendingAction('discord', 'chan1', 'admin1'));
  const taken = takePendingAction('discord', 'chan1', 'admin1');
  assert.ok(taken);
  assert.equal(taken.minTier, 'admin');
  assert.equal(await taken.execute(), 'done');
  assert.equal(runs, 1);

  // Second take returns nothing — a replayed CONFIRM cannot re-run it.
  assert.equal(takePendingAction('discord', 'chan1', 'admin1'), null);
});

test('SECURITY: pending action is bound to actor AND conversation', () => {
  registerPendingAction('discord', 'chan1', 'admin1', {
    description: 'kick user X',
    minTier: 'admin',
    execute: async () => 'done',
  });
  // A different user confirming in the same conversation gets nothing.
  assert.equal(takePendingAction('discord', 'chan1', 'other-user'), null);
  // The same admin confirming in a different conversation gets nothing.
  assert.equal(takePendingAction('discord', 'chan2', 'admin1'), null);
  // Platform must match too.
  assert.equal(takePendingAction('whatsapp', 'chan1', 'admin1'), null);
  // The original binding still works.
  assert.ok(takePendingAction('discord', 'chan1', 'admin1'));
});

test('cancel removes the pending action', () => {
  registerPendingAction('whatsapp', 'g@g.us', '6421', {
    description: 'purge',
    minTier: 'super_admin',
    execute: async () => 'done',
  });
  assert.ok(cancelPendingAction('whatsapp', 'g@g.us', '6421'));
  assert.equal(takePendingAction('whatsapp', 'g@g.us', '6421'), null);
});

test('re-registering replaces the previous pending action', async () => {
  registerPendingAction('discord', 'c', 'a', {
    description: 'first',
    minTier: 'admin',
    execute: async () => 'first',
  });
  registerPendingAction('discord', 'c', 'a', {
    description: 'second',
    minTier: 'admin',
    execute: async () => 'second',
  });
  const taken = takePendingAction('discord', 'c', 'a');
  assert.equal(await taken!.execute(), 'second');
});

test('SECURITY: a pending CONFIRM expires at CONFIRM_TTL_MS — an expired destructive action is discarded, never executed late', () => {
  // A CONFIRM that arrives after the TTL must not run the stored destructive
  // executor: otherwise an admin could register `purge`, walk away, have their
  // role revoked, and a stale CONFIRM minutes later would still fire. Drive a
  // mocked clock across the exact boundary rather than sleeping 60s.
  const base = 1_000_000;
  const nowMock = mock.method(Date, 'now', () => base);
  try {
    let runs = 0;
    registerPendingAction('discord', 'c-ttl', 'admin1', {
      description: 'purge all data',
      minTier: 'super_admin',
      execute: async () => {
        runs += 1;
        return 'RAN';
      },
    });

    // Fresh 1ms before the TTL: present to has/peek.
    nowMock.mock.mockImplementation(() => base + CONFIRM_TTL_MS - 1);
    assert.ok(hasPendingAction('discord', 'c-ttl', 'admin1'), 'still fresh 1ms before the TTL');
    assert.ok(peekPendingAction('discord', 'c-ttl', 'admin1'), 'peek still sees it before the TTL');

    // One tick past the TTL: stale everywhere, and take must refuse it.
    nowMock.mock.mockImplementation(() => base + CONFIRM_TTL_MS + 1);
    assert.equal(hasPendingAction('discord', 'c-ttl', 'admin1'), false, 'not present past the TTL');
    assert.equal(peekPendingAction('discord', 'c-ttl', 'admin1'), null, 'peek returns null past the TTL');
    assert.equal(
      takePendingAction('discord', 'c-ttl', 'admin1'),
      null,
      'an expired CONFIRM must never return the stored destructive action',
    );
    assert.equal(runs, 0, 'the expired executor is never invoked');
  } finally {
    nowMock.mock.restore();
  }
});

test('sweep drops an expired pending action', () => {
  const base = 2_000_000;
  const nowMock = mock.method(Date, 'now', () => base);
  try {
    registerPendingAction('discord', 'c-sweep-exp', 'a', {
      description: 'stale',
      minTier: 'admin',
      execute: async () => 'ok',
    });
    nowMock.mock.mockImplementation(() => base + CONFIRM_TTL_MS + 1);
    sweepExpiredPendingActions();
    // Back to "now" being inside the TTL window relative to a fresh register
    // would matter, but the entry is already gone — take finds nothing.
    assert.equal(takePendingAction('discord', 'c-sweep-exp', 'a'), null, 'sweep removed the expired entry');
  } finally {
    nowMock.mock.restore();
  }
});

test('sweep drops nothing that is still fresh', () => {
  registerPendingAction('discord', 'c-sweep', 'a', {
    description: 'fresh',
    minTier: 'member',
    execute: async () => 'ok',
  });
  sweepExpiredPendingActions();
  assert.ok(hasPendingAction('discord', 'c-sweep', 'a'));
  cancelPendingAction('discord', 'c-sweep', 'a');
});
