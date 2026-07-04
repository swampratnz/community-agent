import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialUsageLimitTracker,
  isUsageLimitFailure,
  stepUsageLimitTracker,
} from '../src/agent/upstreamFailure.js';

test('isUsageLimitFailure matches the documented usage-limit/overload patterns, case-insensitively', () => {
  const positives = [
    'rate_limit_error: Number of request tokens has exceeded your per-minute rate limit',
    'RATE LIMIT exceeded',
    'You have hit your usage limit for this billing period',
    'request failed with status code 429',
    'overloaded_error: Overloaded',
    'daily quota exceeded',
  ];
  for (const msg of positives) {
    assert.ok(isUsageLimitFailure(msg), `expected a match for: ${msg}`);
  }
});

test('isUsageLimitFailure does NOT match unrelated errors (no regression on the existing fallback)', () => {
  const negatives = [
    'ECONNRESET',
    'session not found',
    'unexpected token in JSON at position 4',
    'spawn ENOENT',
  ];
  for (const msg of negatives) {
    assert.ok(!isUsageLimitFailure(msg), `expected no match for: ${msg}`);
  }
});

test('stepUsageLimitTracker: alerts once, stays silent while the condition persists, re-arms on recovery', () => {
  let tracker = initialUsageLimitTracker();

  const first = stepUsageLimitTracker(tracker, true);
  assert.equal(first.shouldAlert, true, 'first usage-limit failure alerts');
  tracker = first.tracker;

  const second = stepUsageLimitTracker(tracker, true);
  assert.equal(second.shouldAlert, false, 'still within the same ongoing window — no repeat alert');
  tracker = second.tracker;

  const recovered = stepUsageLimitTracker(tracker, false);
  assert.equal(recovered.shouldAlert, false, 'recovery itself never alerts');
  tracker = recovered.tracker;

  const third = stepUsageLimitTracker(tracker, true);
  assert.equal(third.shouldAlert, true, 'a new window after recovery alerts again');
});
