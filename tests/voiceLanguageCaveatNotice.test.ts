import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VOICE_LANGUAGE_CAVEAT_TEXT,
  VOICE_LANGUAGE_CAVEAT_TEXT_MI,
  shouldNotify,
} from '../src/voiceLanguageCaveatNotice.js';

const WINDOW_MS = 60_000;

test('shouldNotify: no prior notice always notifies', () => {
  assert.equal(shouldNotify(undefined, 0, WINDOW_MS), true);
});

test('shouldNotify: exactly at the debounce boundary (now - lastNotifiedAt === windowMs) does not re-notify', () => {
  const notifiedAt = 1_000;
  assert.equal(shouldNotify(notifiedAt, notifiedAt + WINDOW_MS, WINDOW_MS), false);
});

test('shouldNotify: one tick past the debounce boundary (> windowMs) re-notifies', () => {
  const notifiedAt = 1_000;
  assert.equal(shouldNotify(notifiedAt, notifiedAt + WINDOW_MS + 1, WINDOW_MS), true);
});

test('shouldNotify: a second voice note within the window does not re-notify', () => {
  const notifiedAt = 1_000;
  assert.equal(shouldNotify(notifiedAt, notifiedAt + WINDOW_MS - 1, WINDOW_MS), false);
});

test('VOICE_LANGUAGE_CAVEAT_TEXT / _MI: short, generic, static strings (no user content echoed)', () => {
  assert.equal(typeof VOICE_LANGUAGE_CAVEAT_TEXT, 'string');
  assert.ok(VOICE_LANGUAGE_CAVEAT_TEXT.length > 0 && VOICE_LANGUAGE_CAVEAT_TEXT.length < 250);
  assert.equal(typeof VOICE_LANGUAGE_CAVEAT_TEXT_MI, 'string');
  assert.ok(VOICE_LANGUAGE_CAVEAT_TEXT_MI.length > 0 && VOICE_LANGUAGE_CAVEAT_TEXT_MI.length < 250);
  assert.notEqual(VOICE_LANGUAGE_CAVEAT_TEXT, VOICE_LANGUAGE_CAVEAT_TEXT_MI);
});
