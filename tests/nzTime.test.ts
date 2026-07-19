import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNzEventTime } from '../src/util/nzTime.js';

// formatNzEventTime (issue #577): minute-granularity Pacific/Auckland
// rendering for event start/end times shown to members and admins — sibling
// to systemPrompt.ts's day-granularity NZ_DATE_FORMAT (issue #169), which
// only grounds the model's own relative-time reasoning and is never applied
// to event timestamps themselves.

test('formatNzEventTime renders the same NZ-local instant from both an ISO string and a Date (issue #577)', () => {
  const iso = '2026-07-14T19:00:00.000Z';
  const fromString = formatNzEventTime(iso);
  const fromDate = formatNzEventTime(new Date(iso));
  assert.equal(fromString, fromDate, 'string and Date input for the same instant must render identically');
  assert.doesNotMatch(fromString, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'must not be a raw ISO timestamp');
  assert.doesNotMatch(fromString, /Z(?=[.\s]|$)/, 'must not be a bare Z-suffixed UTC timestamp');
});

test('the NZST/NZDT transition is handled by Intl, not a hard-coded offset (issue #577)', () => {
  // Same UTC wall-clock time-of-day (11:30 UTC): one NZST (winter, UTC+12)
  // instant and one NZDT (summer, UTC+13) instant. A hard-coded fixed offset
  // could not produce a different local time-of-day from the same UTC input.
  const winter = formatNzEventTime('2026-07-05T11:30:00.000Z');
  const summer = formatNzEventTime('2026-01-05T11:30:00.000Z');
  assert.notEqual(winter, summer, 'winter (NZST) and summer (NZDT) must render different local times');

  const expectedWinter = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date('2026-07-05T11:30:00.000Z'));
  const expectedSummer = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date('2026-01-05T11:30:00.000Z'));
  assert.equal(winter, expectedWinter);
  assert.equal(summer, expectedSummer);
});
