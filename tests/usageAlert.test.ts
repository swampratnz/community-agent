import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. USAGE_ALERT_DAILY_REPLIES is
// deliberately left unset so it exercises the disabled-by-default path.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { initialUsageAlertTracker, stepUsageAlertTracker, startUsageAlert } = await import('../src/usageAlert.js');

const THRESHOLD = 100;

test('startUsageAlert: USAGE_ALERT_DAILY_REPLIES unset (default) creates no timer', () => {
  const timer = startUsageAlert([]);
  assert.equal(timer, null, 'disabled by default — no timer, no extra queries');
});

test('stepUsageAlertTracker: under the threshold never alerts', () => {
  const { tracker, shouldAlert } = stepUsageAlertTracker(initialUsageAlertTracker(), THRESHOLD - 1, THRESHOLD);
  assert.deepEqual(tracker, { crossed: false });
  assert.equal(shouldAlert, false);
});

test('stepUsageAlertTracker: crossing the threshold alerts exactly once', () => {
  let tracker = initialUsageAlertTracker();
  const first = stepUsageAlertTracker(tracker, THRESHOLD, THRESHOLD);
  assert.equal(first.shouldAlert, true, 'alert fires the first tick at/over the threshold');
  tracker = first.tracker;

  const stillOver = stepUsageAlertTracker(tracker, THRESHOLD + 5, THRESHOLD);
  assert.equal(stillOver.shouldAlert, false, 'debounced: no repeat alert while still over');
  assert.equal(stillOver.tracker.crossed, true);
});

test('SECURITY/correctness: oscillating just above the threshold across ticks yields exactly one alert', () => {
  let tracker = initialUsageAlertTracker();
  let alerts = 0;
  const ticks = [THRESHOLD, THRESHOLD + 1, THRESHOLD, THRESHOLD + 2, THRESHOLD];
  for (const outbound of ticks) {
    const step = stepUsageAlertTracker(tracker, outbound, THRESHOLD);
    tracker = step.tracker;
    if (step.shouldAlert) alerts += 1;
  }
  assert.equal(alerts, 1, 'no re-fire per tick while oscillating above the threshold without ever dropping below');
});

test('stepUsageAlertTracker: dropping back below the threshold clears the latch silently (no alert)', () => {
  let tracker = initialUsageAlertTracker();
  ({ tracker } = stepUsageAlertTracker(tracker, THRESHOLD, THRESHOLD)); // crossed = true

  const dropped = stepUsageAlertTracker(tracker, THRESHOLD - 1, THRESHOLD);
  assert.equal(dropped.shouldAlert, false, 'clearing the latch is silent, not an alert');
  assert.deepEqual(dropped.tracker, { crossed: false });
});

test('stepUsageAlertTracker: re-arms only after dropping below and crossing again', () => {
  let tracker = initialUsageAlertTracker();
  ({ tracker } = stepUsageAlertTracker(tracker, THRESHOLD, THRESHOLD)); // first alert, crossed = true
  ({ tracker } = stepUsageAlertTracker(tracker, THRESHOLD - 1, THRESHOLD)); // drops below, re-arms

  const secondCrossing = stepUsageAlertTracker(tracker, THRESHOLD, THRESHOLD);
  assert.equal(secondCrossing.shouldAlert, true, 'a fresh crossing after dropping below can alert again');
});
