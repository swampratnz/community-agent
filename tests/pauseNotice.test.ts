import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PAUSE_NOTICE_TEXT, shouldNotifyPaused } from '../src/pauseNotice.js';

const WINDOW_MS = 3_600_000;

test('shouldNotifyPaused: no prior notice always notifies', () => {
  assert.equal(shouldNotifyPaused(undefined, 0, WINDOW_MS), true);
});

test('shouldNotifyPaused: a second addressed message within the window does not re-notify', () => {
  const notifiedAt = 1_000;
  assert.equal(shouldNotifyPaused(notifiedAt, notifiedAt + WINDOW_MS - 1, WINDOW_MS), false);
});

test('shouldNotifyPaused: exactly one notice per burst of addressed messages during a pause', () => {
  const now = () => 0; // single point in time; burst is many messages at ~the same instant
  let lastNotifiedAt: number | undefined;
  let notices = 0;
  for (let i = 0; i < 20; i += 1) {
    if (shouldNotifyPaused(lastNotifiedAt, now(), WINDOW_MS)) {
      notices += 1;
      lastNotifiedAt = now();
    }
  }
  assert.equal(notices, 1, 'a burst of messages during one pause yields exactly one notice');
});

test('shouldNotifyPaused: re-arms once the window elapses', () => {
  const notifiedAt = 1_000;
  assert.equal(shouldNotifyPaused(notifiedAt, notifiedAt + WINDOW_MS + 1, WINDOW_MS), true);
});

test('PAUSE_NOTICE_TEXT: is a short, generic, static string (no user content echoed)', () => {
  assert.equal(typeof PAUSE_NOTICE_TEXT, 'string');
  assert.ok(PAUSE_NOTICE_TEXT.length > 0 && PAUSE_NOTICE_TEXT.length < 120);
});
