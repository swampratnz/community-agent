import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
// backgroundJobHealth.ts is deliberately free of config/HTTP/DB imports (see
// its header) so this file needs no dummy env setup, unlike most tests here.
import {
  buildJobFailureAlert,
  getJobHealthSnapshot,
  initialJobFailureTracker,
  recordJobRun,
  resetJobHealthRegistryForTests,
  stepJobFailureTracker,
} from '../src/backgroundJobHealth.js';

const THRESHOLD = 3;

test('stepJobFailureTracker: three consecutive failures yields shouldAlert true exactly on the third; a fourth consecutive failure yields shouldAlert false (no repeat spam)', () => {
  let tracker = initialJobFailureTracker();

  const first = stepJobFailureTracker(tracker, true, THRESHOLD);
  assert.equal(first.shouldAlert, false, '1st consecutive failure does not alert');
  tracker = first.tracker;

  const second = stepJobFailureTracker(tracker, true, THRESHOLD);
  assert.equal(second.shouldAlert, false, '2nd consecutive failure does not alert');
  tracker = second.tracker;

  const third = stepJobFailureTracker(tracker, true, THRESHOLD);
  assert.equal(third.shouldAlert, true, '3rd consecutive failure (== threshold) alerts');
  tracker = third.tracker;

  const fourth = stepJobFailureTracker(tracker, true, THRESHOLD);
  assert.equal(fourth.shouldAlert, false, '4th consecutive failure stays silent — no repeat spam');
});

test('stepJobFailureTracker: a success resets consecutiveFailures to 0 and alerted to false, and re-arms alerting for a subsequent streak of failures', () => {
  let tracker = initialJobFailureTracker();
  for (let i = 0; i < THRESHOLD; i++) {
    ({ tracker } = stepJobFailureTracker(tracker, true, THRESHOLD));
  }
  assert.deepEqual(tracker, { consecutiveFailures: THRESHOLD, alerted: true });

  const recovered = stepJobFailureTracker(tracker, false, THRESHOLD);
  assert.equal(recovered.shouldAlert, false, 'recovery itself never alerts');
  assert.deepEqual(recovered.tracker, { consecutiveFailures: 0, alerted: false });
  tracker = recovered.tracker;

  let alertedAgain = false;
  for (let i = 0; i < THRESHOLD; i++) {
    const step = stepJobFailureTracker(tracker, true, THRESHOLD);
    tracker = step.tracker;
    if (step.shouldAlert) alertedAgain = true;
  }
  assert.equal(
    alertedAgain,
    true,
    'a fresh streak of threshold failures after recovery alerts again — not a one-shot latch',
  );
});

test('stepJobFailureTracker: an oscillating pattern that never reaches the threshold consecutively never alerts (fail, fail, succeed, fail, fail at threshold=3)', () => {
  let tracker = initialJobFailureTracker();
  let alerts = 0;
  const ticks = [true, true, false, true, true];
  for (const failed of ticks) {
    const step = stepJobFailureTracker(tracker, failed, THRESHOLD);
    tracker = step.tracker;
    if (step.shouldAlert) alerts += 1;
  }
  assert.equal(alerts, 0, 'oscillating below the threshold never alerts');
});

test('buildJobFailureAlert: fixed template names the job, the consecutive-failure count, and "never this run" when there has been no success yet', () => {
  const message = buildJobFailureAlert('docs-ingest', 3, null);
  assert.equal(
    message,
    "⚠️ Background job 'docs-ingest' has failed 3 consecutive times (last success: never this run). Check server logs for details.",
  );
});

test('buildJobFailureAlert: a known last-success time is rendered as an ISO timestamp', () => {
  const lastSuccessAt = Date.UTC(2026, 0, 1, 0, 0, 0);
  const message = buildJobFailureAlert('context-builder', 5, lastSuccessAt);
  assert.ok(
    message.includes(new Date(lastSuccessAt).toISOString()),
    'the last-success time is ISO-formatted in the message',
  );
  assert.match(message, /^⚠️ Background job 'context-builder' has failed 5 consecutive times/);
});

// --- issue #467: the in-memory job-health registry `/healthz` reads from.
// Reset before each test so these are independent of ordering/pollution from
// each other (and from any other module in this same test process that
// happens to import backgroundJobHealth.js).

beforeEach(() => {
  resetJobHealthRegistryForTests();
});

test('getJobHealthSnapshot: empty registry (nothing has recorded a run yet) returns an empty object', () => {
  assert.deepEqual(getJobHealthSnapshot(), {});
});

test('recordJobRun + getJobHealthSnapshot: records the exact tracker fields plus lastRunAt/lastSuccessAt for the given job, leaving other jobs untouched', () => {
  const tracker = { consecutiveFailures: 2, alerted: false };
  recordJobRun('docs-ingest', tracker, 1_000, 500);
  assert.deepEqual(getJobHealthSnapshot(), {
    'docs-ingest': { consecutiveFailures: 2, alerted: false, lastRunAt: 1_000, lastSuccessAt: 500 },
  });
});

test('recordJobRun: a later call for the same job overwrites its snapshot rather than accumulating', () => {
  recordJobRun('embedding-model', { consecutiveFailures: 1, alerted: false }, 100, null);
  recordJobRun('embedding-model', { consecutiveFailures: 0, alerted: false }, 200, 200);
  assert.deepEqual(getJobHealthSnapshot(), {
    'embedding-model': { consecutiveFailures: 0, alerted: false, lastRunAt: 200, lastSuccessAt: 200 },
  });
});

test('recordJobRun: distinct jobs keep independent snapshots', () => {
  recordJobRun('admin-digest', { consecutiveFailures: 3, alerted: true }, 100, null);
  recordJobRun('usage-alert', { consecutiveFailures: 0, alerted: false }, 200, 200);
  assert.deepEqual(getJobHealthSnapshot(), {
    'admin-digest': { consecutiveFailures: 3, alerted: true, lastRunAt: 100, lastSuccessAt: null },
    'usage-alert': { consecutiveFailures: 0, alerted: false, lastRunAt: 200, lastSuccessAt: 200 },
  });
});

test('getJobHealthSnapshot: returns a shallow copy — mutating the returned object never affects a later read', () => {
  recordJobRun('context-builder', { consecutiveFailures: 0, alerted: false }, 100, 100);
  const snapshot = getJobHealthSnapshot();
  delete snapshot['context-builder'];
  assert.ok(
    getJobHealthSnapshot()['context-builder'],
    'the registry itself is untouched by mutating a prior read',
  );
});

test('SECURITY: JobHealthSnapshot never carries an error message or stack — recordJobRun only ever accepts the fixed tracker shape (consecutiveFailures/alerted) plus numeric timestamps, so there is no parameter through which a caught error could reach the registry', () => {
  const sentinel = 'sentinel-secret-path-or-query-fragment-registry';
  // The only inputs recordJobRun accepts are a JobFailureTracker (two fixed
  // fields) and two numeric/null timestamps — there is no string parameter
  // for an error message to flow through, so this asserts the registry's
  // recorded shape has exactly those keys and nothing else, for every job.
  recordJobRun('docs-ingest', { consecutiveFailures: 3, alerted: true }, 100, null);
  const snapshot = getJobHealthSnapshot()['docs-ingest']!;
  assert.deepEqual(
    new Set(Object.keys(snapshot)),
    new Set(['consecutiveFailures', 'alerted', 'lastRunAt', 'lastSuccessAt']),
  );
  assert.ok(
    !JSON.stringify(snapshot).includes(sentinel),
    'no dynamic string can appear in the recorded snapshot',
  );
});
