import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The deployment's DISPLAY_TIMEZONE/DISPLAY_LOCALE surface (agent-base package
 * flip). `formatEventTime` — minute-granularity rendering for event start/end
 * times shown to members and admins (issue #577) — used to be
 * `formatNzEventTime`, with `Pacific/Auckland`/`en-NZ` hardcoded in the base
 * util. agent-base made both CONFIG, defaulting to `UTC`/`en-GB`, because a
 * framework cannot assume a deployment's timezone.
 *
 * So this file no longer tests the formatter (agent-base's own
 * tests/eventTime.test.ts does, passing the pair explicitly). It tests THIS
 * deployment: that the environment it ships with still renders NZ local time,
 * which is the property the flip had to preserve. `src/module/agentModule.ts`'s
 * `init()` refuses to boot if the two settings say anything else; this pins the
 * rendering they produce.
 */
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
// The deployment's own values, exactly as .env.example and deploy/ set them.
process.env.DISPLAY_TIMEZONE = 'Pacific/Auckland';
process.env.DISPLAY_LOCALE = 'en-NZ';

const { formatEventTime } = await import('@swampratnz/agent-base/util/eventTime.js');

/** What the pre-flip `formatNzEventTime` produced, byte for byte. */
function nzEventTime(instant: string): string {
  return new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(instant));
}

test('the configured display settings render event times exactly as the pre-flip NZ formatter did', () => {
  for (const iso of ['2026-07-14T19:00:00.000Z', '2026-01-05T11:30:00.000Z', '2099-06-01T21:00:00.000Z']) {
    assert.equal(formatEventTime(iso), nzEventTime(iso), iso);
  }
});

test('formatEventTime renders the same instant from both an ISO string and a Date (issue #577)', () => {
  const iso = '2026-07-14T19:00:00.000Z';
  const fromString = formatEventTime(iso);
  assert.equal(fromString, formatEventTime(new Date(iso)));
  assert.doesNotMatch(fromString, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'must not be a raw ISO timestamp');
  assert.doesNotMatch(fromString, /Z(?=[.\s]|$)/, 'must not be a bare Z-suffixed UTC timestamp');
});

test('the NZST/NZDT transition is handled by Intl, not a hard-coded offset (issue #577)', () => {
  // Same UTC wall-clock time-of-day (11:30 UTC): one NZST (winter, UTC+12)
  // instant and one NZDT (summer, UTC+13) instant. A hard-coded fixed offset
  // could not produce a different local time-of-day from the same UTC input.
  assert.notEqual(
    formatEventTime('2026-07-05T11:30:00.000Z'),
    formatEventTime('2026-01-05T11:30:00.000Z'),
    'winter (NZST) and summer (NZDT) must render different local times',
  );
});
