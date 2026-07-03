import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthzPayload, initialTracker, stepDisconnectTracker } from '../src/healthState.js';

const AFTER_MS = 5 * 60_000; // 5 minutes

test('stepDisconnectTracker: connected never alerts', () => {
  const { tracker, shouldAlert, justReconnected } = stepDisconnectTracker(
    initialTracker(),
    true,
    0,
    AFTER_MS,
  );
  assert.deepEqual(tracker, { disconnectedSince: null, alerted: false });
  assert.equal(shouldAlert, false);
  assert.equal(justReconnected, false);
});

test('stepDisconnectTracker: disconnect under the threshold does not alert', () => {
  let tracker = initialTracker();
  ({ tracker } = stepDisconnectTracker(tracker, false, 0, AFTER_MS));
  const step = stepDisconnectTracker(tracker, false, AFTER_MS - 1, AFTER_MS);
  assert.equal(step.shouldAlert, false);
  assert.equal(step.tracker.disconnectedSince, 0);
});

test('stepDisconnectTracker: disconnect past the threshold alerts exactly once', () => {
  let tracker = initialTracker();
  ({ tracker } = stepDisconnectTracker(tracker, false, 0, AFTER_MS)); // disconnect begins at t=0
  const firstOver = stepDisconnectTracker(tracker, false, AFTER_MS, AFTER_MS);
  assert.equal(firstOver.shouldAlert, true, 'alert fires once the threshold is crossed');
  tracker = firstOver.tracker;

  // SECURITY/correctness: still down on the next tick — must NOT alert again.
  const stillDown = stepDisconnectTracker(tracker, false, AFTER_MS + 30_000, AFTER_MS);
  assert.equal(stillDown.shouldAlert, false, 'debounced: no repeat alert while still down');
  assert.equal(stillDown.tracker.alerted, true);
});

test('stepDisconnectTracker: reconnecting resets the tracker and reports justReconnected, without alerting', () => {
  let tracker = initialTracker();
  ({ tracker } = stepDisconnectTracker(tracker, false, 0, AFTER_MS));
  ({ tracker } = stepDisconnectTracker(tracker, false, AFTER_MS, AFTER_MS)); // alerted = true now

  const reconnect = stepDisconnectTracker(tracker, true, AFTER_MS + 1_000, AFTER_MS);
  assert.equal(reconnect.shouldAlert, false);
  assert.equal(reconnect.justReconnected, true);
  assert.deepEqual(reconnect.tracker, { disconnectedSince: null, alerted: false });
});

test('stepDisconnectTracker: a fresh disconnect after recovery can alert again', () => {
  let tracker = initialTracker();
  ({ tracker } = stepDisconnectTracker(tracker, false, 0, AFTER_MS));
  ({ tracker } = stepDisconnectTracker(tracker, false, AFTER_MS, AFTER_MS)); // alerted
  ({ tracker } = stepDisconnectTracker(tracker, true, AFTER_MS + 1_000, AFTER_MS)); // recovered

  // New outage starting fresh.
  ({ tracker } = stepDisconnectTracker(tracker, false, AFTER_MS + 2_000, AFTER_MS));
  const secondOutageAlert = stepDisconnectTracker(tracker, false, AFTER_MS + 2_000 + AFTER_MS, AFTER_MS);
  assert.equal(secondOutageAlert.shouldAlert, true, 'a new outage after recovery can alert again');
});

test('buildHealthzPayload: ok when db and all adapters are up', () => {
  assert.deepEqual(buildHealthzPayload(true, { discord: true, whatsapp: true }), {
    status: 'ok',
    db: true,
    adapters: { discord: true, whatsapp: true },
  });
});

test('buildHealthzPayload: degraded when db is down, even if adapters are up', () => {
  const payload = buildHealthzPayload(false, { discord: true });
  assert.equal(payload.status, 'degraded');
  assert.equal(payload.db, false);
});

test('buildHealthzPayload: degraded when any single adapter is down', () => {
  const payload = buildHealthzPayload(true, { discord: true, whatsapp: false });
  assert.equal(payload.status, 'degraded');
});

test('buildHealthzPayload: no message content or user identifiers in the shape', () => {
  const payload = buildHealthzPayload(true, { discord: true, whatsapp: true });
  const keys = new Set(Object.keys(payload));
  assert.deepEqual(keys, new Set(['status', 'db', 'adapters']));
});
