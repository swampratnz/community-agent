import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelPendingAction,
  classifyConfirmReply,
  hasPendingAction,
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
