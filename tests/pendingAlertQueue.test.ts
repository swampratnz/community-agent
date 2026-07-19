import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  queuePendingAlert,
  getPendingAlertsForTests,
  resetPendingAlertsForTests,
  drainPendingAlerts,
  PENDING_ALERT_QUEUE_CAP,
} from '../src/pendingAlertQueue.js';

// Pure leaf module (no config/env) — reset the shared singleton before each case.
function fresh() {
  resetPendingAlertsForTests();
}

test('queuePendingAlert: under the cap, entries are kept in insertion order regardless of priority', () => {
  fresh();
  queuePendingAlert('sys-1', 'system');
  queuePendingAlert('low-1', 'low');
  queuePendingAlert('sys-2', 'system');
  assert.deepEqual(getPendingAlertsForTests(), ['sys-1', 'low-1', 'sys-2']);
});

test('queuePendingAlert: at cap with an all-system queue, a new system alert drops the OLDEST (FIFO) — unchanged bound', () => {
  fresh();
  for (let i = 1; i <= PENDING_ALERT_QUEUE_CAP; i++) queuePendingAlert(`sys-${i}`, 'system');
  queuePendingAlert('sys-new', 'system');
  const msgs = getPendingAlertsForTests();
  assert.equal(msgs.length, PENDING_ALERT_QUEUE_CAP, 'still bounded at the cap');
  assert.ok(!msgs.includes('sys-1'), 'the oldest system alert was dropped');
  assert.ok(msgs.includes('sys-new'), 'the new system alert was enqueued');
});

test('SECURITY: a member-reachable (low) alert never evicts a system alert — a full system queue rejects the low alert (issue #545)', () => {
  fresh();
  // A genuine multi-failure outage fills the queue with system alerts.
  for (let i = 1; i <= PENDING_ALERT_QUEUE_CAP; i++) queuePendingAlert(`sys-${i}`, 'system');
  const before = getPendingAlertsForTests();

  // A member spamming report_content (rate-capped at exactly the queue cap)
  // floods low-priority alerts. NONE may displace a system alert.
  for (let i = 1; i <= PENDING_ALERT_QUEUE_CAP * 2; i++) queuePendingAlert(`low-flood-${i}`, 'low');

  const after = getPendingAlertsForTests();
  assert.deepEqual(
    after,
    before,
    'every system alert survives; no low-flood alert entered the full system queue',
  );
  assert.ok(
    after.every((m) => m.startsWith('sys-')),
    'the queue still contains only the system alerts',
  );
});

test('SECURITY: at cap, a new alert evicts the OLDEST low entry first, preserving all system alerts (issue #545)', () => {
  fresh();
  // Mixed queue, low alerts oldest so FIFO-oldest would have dropped a low
  // first anyway — but interleave to prove it targets low, not merely oldest.
  queuePendingAlert('low-old', 'low');
  queuePendingAlert('sys-a', 'system');
  queuePendingAlert('low-mid', 'low');
  queuePendingAlert('sys-b', 'system');
  queuePendingAlert('sys-c', 'system'); // now at cap (5): [low-old, sys-a, low-mid, sys-b, sys-c]

  queuePendingAlert('sys-new', 'system'); // full → evict oldest low (low-old)
  let msgs = getPendingAlertsForTests();
  assert.deepEqual(
    msgs,
    ['sys-a', 'low-mid', 'sys-b', 'sys-c', 'sys-new'],
    'oldest low (low-old) evicted, systems kept',
  );

  queuePendingAlert('sys-newer', 'system'); // full → evict the remaining low (low-mid)
  msgs = getPendingAlertsForTests();
  assert.ok(!msgs.includes('low-mid'), 'the last low entry is evicted before any system alert');
  assert.ok(
    ['sys-a', 'sys-b', 'sys-c', 'sys-new', 'sys-newer'].every((m) => msgs.includes(m)),
    'no system alert was ever evicted while a low entry remained',
  );
});

test('drainPendingAlerts returns the messages and clears the queue; getPendingAlertsForTests reflects it', () => {
  fresh();
  queuePendingAlert('a', 'system');
  queuePendingAlert('b', 'low');
  const drained = drainPendingAlerts();
  assert.deepEqual(drained, ['a', 'b']);
  assert.deepEqual(getPendingAlertsForTests(), [], 'the queue is empty after draining');
});
