import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RATE_LIMIT_NOTICE_TEXT, shouldNotifyRateLimited } from '../src/rateLimitNotice.js';

const WINDOW_MS = 60_000;

test('shouldNotifyRateLimited: no prior notice always notifies', () => {
  assert.equal(shouldNotifyRateLimited(undefined, 0, WINDOW_MS), true);
});

test('shouldNotifyRateLimited: a second over-limit message within the window does not re-notify', () => {
  const notifiedAt = 1_000;
  assert.equal(shouldNotifyRateLimited(notifiedAt, notifiedAt + WINDOW_MS - 1, WINDOW_MS), false);
});

test('shouldNotifyRateLimited: exactly one notice per episode across a burst', () => {
  const now = () => 0; // single point in time; burst is many messages at ~the same instant
  let lastNotifiedAt: number | undefined;
  let notices = 0;
  for (let i = 0; i < 20; i += 1) {
    if (shouldNotifyRateLimited(lastNotifiedAt, now(), WINDOW_MS)) {
      notices += 1;
      lastNotifiedAt = now();
    }
  }
  assert.equal(notices, 1, 'a burst of over-limit messages yields exactly one notice');
});

test('shouldNotifyRateLimited: re-arms once the window elapses', () => {
  const notifiedAt = 1_000;
  assert.equal(shouldNotifyRateLimited(notifiedAt, notifiedAt + WINDOW_MS + 1, WINDOW_MS), true);
});

test('RATE_LIMIT_NOTICE_TEXT: is a short, generic, static string (no user content echoed)', () => {
  assert.equal(typeof RATE_LIMIT_NOTICE_TEXT, 'string');
  assert.ok(RATE_LIMIT_NOTICE_TEXT.length > 0 && RATE_LIMIT_NOTICE_TEXT.length < 120);
});
