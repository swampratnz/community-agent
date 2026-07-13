import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHealthzPayload,
  buildReadyzPayload,
  initialTracker,
  stepDisconnectTracker,
} from '../src/healthState.js';
import type { JobHealthSnapshot } from '../src/backgroundJobHealth.js';

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

// --- issue #467: the optional `jobs` field on /healthz.

function snapshot(overrides: Partial<JobHealthSnapshot> = {}): JobHealthSnapshot {
  return { consecutiveFailures: 0, alerted: false, lastRunAt: 1_000, lastSuccessAt: 1_000, ...overrides };
}

test('buildHealthzPayload: with no optional background jobs enabled (jobHealth omitted), the payload is byte-identical to the pre-#467 shape — no `jobs` key at all', () => {
  const withoutArg = buildHealthzPayload(true, { discord: true });
  const withEmptyObject = buildHealthzPayload(true, { discord: true }, {});
  const expected = { status: 'ok', db: true, adapters: { discord: true } };
  assert.deepEqual(withoutArg, expected);
  assert.deepEqual(withEmptyObject, expected);
  assert.ok(!('jobs' in withoutArg), 'no jobs key present when jobHealth is omitted');
  assert.ok(!('jobs' in withEmptyObject), 'no jobs key present when jobHealth is an empty object');
});

test('buildHealthzPayload: with job health present, each entry is projected to consecutiveFailures/lastRunAt/lastSuccessAt as ISO timestamps — never the raw alerted flag or a null lastRunAt', () => {
  const payload = buildHealthzPayload(
    true,
    { discord: true },
    { 'docs-ingest': snapshot({ consecutiveFailures: 2, lastRunAt: 1_000, lastSuccessAt: 500 }) },
  );
  assert.deepEqual(payload.jobs, {
    'docs-ingest': {
      consecutiveFailures: 2,
      lastRunAt: new Date(1_000).toISOString(),
      lastSuccessAt: new Date(500).toISOString(),
    },
  });
});

test('buildHealthzPayload: a job that has never succeeded projects lastSuccessAt as null (not an ISO string of 0/epoch)', () => {
  const payload = buildHealthzPayload(
    true,
    { discord: true },
    { 'context-builder': snapshot({ consecutiveFailures: 5, lastSuccessAt: null }) },
  );
  assert.equal(payload.jobs!['context-builder'].lastSuccessAt, null);
});

test('buildHealthzPayload: a job whose tracker has crossed its own alert threshold (alerted === true) flips top-level status to degraded, even when db and every adapter are healthy', () => {
  const payload = buildHealthzPayload(
    true,
    { discord: true, whatsapp: true },
    { 'knowledge-refresh': snapshot({ consecutiveFailures: 3, alerted: true }) },
  );
  assert.equal(payload.status, 'degraded');
});

test('buildHealthzPayload: a single sub-threshold failure (alerted === false) never flips status, however high consecutiveFailures reads', () => {
  const payload = buildHealthzPayload(
    true,
    { discord: true },
    { 'knowledge-refresh': snapshot({ consecutiveFailures: 1, alerted: false }) },
  );
  assert.equal(payload.status, 'ok');
});

test('buildHealthzPayload: a recovered job (consecutiveFailures reset to 0, alerted false again) no longer contributes to degraded — same silent-recovery convention as every other tracker', () => {
  const payload = buildHealthzPayload(
    true,
    { discord: true },
    { 'knowledge-refresh': snapshot({ consecutiveFailures: 0, alerted: false }) },
  );
  assert.equal(payload.status, 'ok');
});

test('buildHealthzPayload: one alerted job among several degrades status even though every other job and adapter is healthy', () => {
  const payload = buildHealthzPayload(
    true,
    { discord: true },
    {
      'docs-ingest': snapshot({ alerted: false }),
      'admin-digest': snapshot({ alerted: true, consecutiveFailures: 3 }),
      'usage-alert': snapshot({ alerted: false }),
    },
  );
  assert.equal(payload.status, 'degraded');
  assert.equal(
    Object.keys(payload.jobs!).length,
    3,
    'all three jobs are still reported, not just the alerted one',
  );
});

test('SECURITY: across every reachable tracker state (fresh, success, sub-threshold failure, alerted, recovered), each jobs[] entry contains only consecutiveFailures/lastRunAt/lastSuccessAt — never an error message, stack, or the internal alerted flag', () => {
  const sentinel = 'sentinel-secret-path-or-query-fragment-healthz-jobs';
  const states: Record<string, JobHealthSnapshot> = {
    fresh: snapshot({ consecutiveFailures: 0, alerted: false, lastSuccessAt: null }),
    'sub-threshold-failure': snapshot({ consecutiveFailures: 1, alerted: false }),
    alerted: snapshot({ consecutiveFailures: 3, alerted: true }),
    recovered: snapshot({ consecutiveFailures: 0, alerted: false }),
  };
  const payload = buildHealthzPayload(true, { discord: true }, states);
  for (const [name, entry] of Object.entries(payload.jobs!)) {
    assert.deepEqual(
      new Set(Object.keys(entry)),
      new Set(['consecutiveFailures', 'lastRunAt', 'lastSuccessAt']),
      `${name}: jobs[] entry must expose exactly these three fields, never 'alerted' or anything dynamic`,
    );
  }
  assert.ok(
    !JSON.stringify(payload).includes(sentinel),
    'no dynamic string can appear anywhere in the payload',
  );
});

test('buildReadyzPayload: unaffected by job health — takes db only and its shape never grows a jobs field', () => {
  const ok = buildReadyzPayload(true);
  assert.deepEqual(ok, { status: 'ok', db: true });
  assert.ok(!('jobs' in ok), 'buildReadyzPayload never accepts or emits job health');

  const degraded = buildReadyzPayload(false);
  assert.deepEqual(degraded, { status: 'degraded', db: false });
});
