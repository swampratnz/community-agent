import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/strings/notices.js';

import { shouldNotifyAfterWindow } from '../src/util/noticeDebounce.js';
import { shouldNotifyRateLimited } from '../src/rateLimitNotice.js';
import { shouldNotifyPaused } from '../src/pauseNotice.js';
import { shouldNotifyBudgetCheckFailed } from '../src/budgetCheckFailureNotice.js';
import { shouldNotifyMutedRoleOverwriteFailed } from '../src/mutedRoleAlertNotice.js';
import { shouldNotify as shouldNotifyVoiceLanguageCaveat } from '../src/voiceLanguageCaveatNotice.js';

const WINDOW_MS = 60_000;

test('shouldNotifyAfterWindow: no prior notice always notifies', () => {
  assert.equal(shouldNotifyAfterWindow(undefined, 0, WINDOW_MS), true);
});

test('shouldNotifyAfterWindow: within the window does not re-notify, including at the exact boundary', () => {
  const notifiedAt = 1_000;
  assert.equal(shouldNotifyAfterWindow(notifiedAt, notifiedAt + WINDOW_MS - 1, WINDOW_MS), false);
  assert.equal(shouldNotifyAfterWindow(notifiedAt, notifiedAt + WINDOW_MS, WINDOW_MS), false);
});

test('shouldNotifyAfterWindow: re-arms once the window elapses', () => {
  const notifiedAt = 1_000;
  assert.equal(shouldNotifyAfterWindow(notifiedAt, notifiedAt + WINDOW_MS + 1, WINDOW_MS), true);
});

test('every notice module re-exports the one shared debounce, not a drifted copy', () => {
  for (const alias of [
    shouldNotifyRateLimited,
    shouldNotifyPaused,
    shouldNotifyBudgetCheckFailed,
    shouldNotifyMutedRoleOverwriteFailed,
    shouldNotifyVoiceLanguageCaveat,
  ]) {
    assert.equal(alias, shouldNotifyAfterWindow);
  }
});
