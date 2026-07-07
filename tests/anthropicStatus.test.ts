import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Anthropic status check (issue #206). Pure — no DB, no network (fetchText
// is always injected).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const {
  parseStatusSummary,
  pollAnthropicStatus,
  formatStatusMessage,
  getStatusCache,
  resetStatusCacheForTests,
} = await import('../src/status/anthropicStatus.js');

const ALL_OPERATIONAL_BODY = JSON.stringify({
  page: { id: 'abc' },
  status: { indicator: 'none', description: 'All Systems Operational' },
  incidents: [],
});

const INCIDENT_BODY = JSON.stringify({
  page: { id: 'abc' },
  status: { indicator: 'major', description: 'Major System Outage' },
  incidents: [
    {
      name: 'Elevated errors on the Messages API',
      impact: 'major',
      status: 'investigating',
      updated_at: '2026-07-07T00:00:00.000Z',
    },
  ],
});

beforeEach(() => {
  resetStatusCacheForTests();
});

// --- parseStatusSummary (pure) ----------------------------------------------

test('parseStatusSummary parses an "all operational" summary with zero incidents', () => {
  const summary = parseStatusSummary(ALL_OPERATIONAL_BODY);
  assert.equal(summary.indicator, 'none');
  assert.equal(summary.description, 'All Systems Operational');
  assert.deepEqual(summary.incidents, []);
});

test('parseStatusSummary parses a summary with an unresolved incident (name, impact, status, updated time)', () => {
  const summary = parseStatusSummary(INCIDENT_BODY);
  assert.equal(summary.indicator, 'major');
  assert.equal(summary.incidents.length, 1);
  assert.equal(summary.incidents[0].name, 'Elevated errors on the Messages API');
  assert.equal(summary.incidents[0].impact, 'major');
  assert.equal(summary.incidents[0].status, 'investigating');
  assert.equal(summary.incidents[0].updatedAt, '2026-07-07T00:00:00.000Z');
});

test('parseStatusSummary drops a resolved incident even if upstream still lists it', () => {
  const body = JSON.stringify({
    status: { indicator: 'none', description: 'All Systems Operational' },
    incidents: [
      { name: 'Old incident', impact: 'minor', status: 'resolved', updated_at: '2026-01-01T00:00:00.000Z' },
    ],
  });
  const summary = parseStatusSummary(body);
  assert.deepEqual(summary.incidents, []);
});

test('SECURITY: parseStatusSummary throws on a malformed/unexpected body shape rather than returning a false "operational" reading', () => {
  assert.throws(() => parseStatusSummary(JSON.stringify({ nope: true })));
  assert.throws(() => parseStatusSummary('not json'));
  assert.throws(() => parseStatusSummary(JSON.stringify({ status: 'not an object' })));
});

// --- pollAnthropicStatus (fetch injected) -----------------------------------

test('pollAnthropicStatus populates the cache on a successful fetch', async () => {
  await pollAnthropicStatus(async () => ALL_OPERATIONAL_BODY);
  const cache = getStatusCache();
  assert.ok(cache);
  assert.equal(cache?.summary.indicator, 'none');
});

test('SECURITY: pollAnthropicStatus preserves the last-known-good cache on a fetch failure — never clears it', async () => {
  await pollAnthropicStatus(async () => INCIDENT_BODY);
  const before = getStatusCache();
  assert.ok(before);

  await pollAnthropicStatus(async () => {
    throw new Error('network down');
  });
  const after = getStatusCache();
  assert.deepEqual(after, before, 'a fetch failure must not clear or alter the existing cache');
});

test('SECURITY: pollAnthropicStatus preserves the last-known-good cache on a malformed 200 response — never throws into the caller', async () => {
  await pollAnthropicStatus(async () => ALL_OPERATIONAL_BODY);
  const before = getStatusCache();

  await assert.doesNotReject(() => pollAnthropicStatus(async () => 'this is not the expected shape'));
  const after = getStatusCache();
  assert.deepEqual(after, before, 'a malformed body must degrade like a fetch failure, not clear the cache');
});

// --- formatStatusMessage (pure) ---------------------------------------------

test('SECURITY: formatStatusMessage reports "not yet checked" before any successful fetch, never a false "all operational"', () => {
  const msg = formatStatusMessage(null, Date.now());
  assert.match(msg, /haven't been able to check/i);
  assert.doesNotMatch(msg, /operational/i);
});

test('formatStatusMessage reports no known incidents, with age, and does not blame the member', () => {
  const now = Date.parse('2026-07-07T00:05:00.000Z');
  const msg = formatStatusMessage(
    {
      fetchedAt: new Date('2026-07-07T00:02:00.000Z'),
      summary: { indicator: 'none', description: 'ok', incidents: [] },
    },
    now,
  );
  assert.match(msg, /No known Anthropic incidents/);
  assert.match(msg, /3 minutes ago/);
  assert.doesNotMatch(msg, /your (fault|bug)/i);
});

test('formatStatusMessage names an active incident with its impact, status, and age', () => {
  const now = Date.parse('2026-07-07T00:15:00.000Z');
  const msg = formatStatusMessage(
    {
      fetchedAt: new Date('2026-07-07T00:14:00.000Z'),
      summary: {
        indicator: 'major',
        description: 'Major System Outage',
        incidents: [
          {
            name: 'Elevated errors on the Messages API',
            impact: 'major',
            status: 'investigating',
            updatedAt: '2026-07-07T00:03:00.000Z',
          },
        ],
      },
    },
    now,
  );
  assert.match(msg, /Elevated errors on the Messages API/);
  assert.match(msg, /major impact/);
  assert.match(msg, /investigating/);
  assert.match(msg, /12 minutes ago/);
  assert.match(msg, /checked 1 minute ago/);
});
