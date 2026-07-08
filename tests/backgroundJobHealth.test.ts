import { test } from 'node:test';
import assert from 'node:assert/strict';
// backgroundJobHealth.ts is deliberately free of config/HTTP/DB imports (see
// its header) so this file needs no dummy env setup, unlike most tests here.
import {
  buildJobFailureAlert,
  initialJobFailureTracker,
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
