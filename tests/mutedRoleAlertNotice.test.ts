import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldNotifyMutedRoleOverwriteFailed } from '../src/mutedRoleAlertNotice.js';

const WINDOW_MS = 900_000;

test('shouldNotifyMutedRoleOverwriteFailed: no prior notice always notifies', () => {
  assert.equal(shouldNotifyMutedRoleOverwriteFailed(undefined, 0, WINDOW_MS), true);
});

test('shouldNotifyMutedRoleOverwriteFailed: a second failure within the window does not re-notify', () => {
  const notifiedAt = 1_000;
  assert.equal(
    shouldNotifyMutedRoleOverwriteFailed(notifiedAt, notifiedAt + WINDOW_MS - 1, WINDOW_MS),
    false,
  );
});

test('shouldNotifyMutedRoleOverwriteFailed: exactly one notice across a burst of failures at the same instant', () => {
  const now = () => 0;
  let lastNotifiedAt: number | undefined;
  let notices = 0;
  for (let i = 0; i < 20; i += 1) {
    if (shouldNotifyMutedRoleOverwriteFailed(lastNotifiedAt, now(), WINDOW_MS)) {
      notices += 1;
      lastNotifiedAt = now();
    }
  }
  assert.equal(notices, 1, 'a burst of failures yields exactly one notice');
});

test('shouldNotifyMutedRoleOverwriteFailed: re-arms once the window elapses', () => {
  const notifiedAt = 1_000;
  assert.equal(shouldNotifyMutedRoleOverwriteFailed(notifiedAt, notifiedAt + WINDOW_MS + 1, WINDOW_MS), true);
});
