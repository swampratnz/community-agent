import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldNotifyBudgetCheckFailed } from '../src/budgetCheckFailureNotice.js';

const WINDOW_MS = 900_000;

test('shouldNotifyBudgetCheckFailed: no prior notice always notifies', () => {
  assert.equal(shouldNotifyBudgetCheckFailed(undefined, 0, WINDOW_MS), true);
});

test('shouldNotifyBudgetCheckFailed: a second failure within the window does not re-notify', () => {
  const notifiedAt = 1_000;
  assert.equal(shouldNotifyBudgetCheckFailed(notifiedAt, notifiedAt + WINDOW_MS - 1, WINDOW_MS), false);
});

test('shouldNotifyBudgetCheckFailed: exactly one notice across a burst of failures at the same instant', () => {
  const now = () => 0;
  let lastNotifiedAt: number | undefined;
  let notices = 0;
  for (let i = 0; i < 20; i += 1) {
    if (shouldNotifyBudgetCheckFailed(lastNotifiedAt, now(), WINDOW_MS)) {
      notices += 1;
      lastNotifiedAt = now();
    }
  }
  assert.equal(notices, 1, 'a burst of failures yields exactly one notice');
});

test('shouldNotifyBudgetCheckFailed: re-arms once the window elapses', () => {
  const notifiedAt = 1_000;
  assert.equal(shouldNotifyBudgetCheckFailed(notifiedAt, notifiedAt + WINDOW_MS + 1, WINDOW_MS), true);
});
