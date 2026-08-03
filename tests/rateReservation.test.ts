import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  makeCalendarDayReserver,
  makeCooldownReserver,
  makeSlidingWindowReserver,
} from '../src/base/util/rateReservation.js';

const HOUR_MS = 60 * 60 * 1000;

test('SECURITY: makeSlidingWindowReserver enforces the per-key limit inside the window', () => {
  const reserve = makeSlidingWindowReserver(HOUR_MS);
  assert.equal(reserve('conv-1', 2), true);
  assert.equal(reserve('conv-1', 2), true);
  assert.equal(reserve('conv-1', 2), false, 'the third reservation inside the window is refused');
});

test('SECURITY: makeSlidingWindowReserver never refunds — a refused attempt does not consume, a successful one is never returned', () => {
  const reserve = makeSlidingWindowReserver(HOUR_MS);
  assert.equal(reserve('conv-1', 1), true);
  assert.equal(reserve('conv-1', 1), false);
  assert.equal(reserve('conv-1', 2), true, 'the refusal left only one timestamp in the window');
  assert.equal(reserve('conv-1', 2), false, 'both successes still count against the raised limit');
});

test('makeSlidingWindowReserver: keys and factory instances are independent buckets', () => {
  const a = makeSlidingWindowReserver(HOUR_MS);
  const b = makeSlidingWindowReserver(HOUR_MS);
  assert.equal(a('conv-1', 1), true);
  assert.equal(a('conv-1', 1), false, 'conv-1 is exhausted in window a');
  assert.equal(a('conv-2', 1), true, 'a different key has its own budget');
  assert.equal(b('conv-1', 1), true, "window b is unaffected by window a's reservations");
});

test('makeSlidingWindowReserver: an expired window re-arms', async () => {
  const reserve = makeSlidingWindowReserver(1);
  assert.equal(reserve('conv-1', 1), true);
  await sleep(25);
  assert.equal(reserve('conv-1', 1), true, 'the old timestamp aged out of the 1ms window');
});

test('SECURITY: makeCalendarDayReserver enforces the per-key daily limit', () => {
  const reserve = makeCalendarDayReserver();
  assert.equal(reserve('user-1', 2), true);
  assert.equal(reserve('user-1', 2), true);
  assert.equal(reserve('user-1', 2), false, 'the third reservation today is refused');
  assert.equal(reserve('user-2', 2), true, 'a different key has its own daily budget');
});

test('makeCalendarDayReserver: a limit of 0 or below means unlimited (the daily caps’ documented contract)', () => {
  const reserve = makeCalendarDayReserver();
  for (let i = 0; i < 50; i += 1) {
    assert.equal(reserve('user-1', 0), true);
    assert.equal(reserve('user-1', -1), true);
  }
});

test('SECURITY: makeCooldownReserver refuses a second reservation inside the cooldown, and a refused attempt does not extend it', async () => {
  const reserve = makeCooldownReserver();
  assert.equal(reserve('caller-1', HOUR_MS), true);
  assert.equal(reserve('caller-1', HOUR_MS), false, 'still cooling down');
  assert.equal(reserve('caller-2', HOUR_MS), true, 'a different key has its own cooldown');

  const rearm = makeCooldownReserver();
  assert.equal(rearm('caller-1', 1), true);
  await sleep(25);
  assert.equal(rearm('caller-1', 1), true, 'the cooldown re-arms once the window elapses');
});
