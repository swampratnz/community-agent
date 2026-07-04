import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextDigest } from '../src/storage/repository.js';

// The renderer is pure (digests in, markdown out), so the issue #53 egress
// invariants are pinned here without a database or network.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { renderCommunityContextExport, scrubPII } = await import('../src/context/export.js');

function digest(overrides: Partial<ContextDigest>): ContextDigest {
  return {
    id: 1,
    periodStart: new Date('2026-07-01T00:00:00Z'),
    periodEnd: new Date('2026-07-02T00:00:00Z'),
    platform: null,
    topic: 'General topic',
    summary: 'People discussed a general theme.',
    exampleRefs: [111, 222],
    distinctUsers: 4,
    questionCount: 7,
    createdAt: new Date('2026-07-02T01:00:00Z'),
    ...overrides,
  };
}

const OPTS = { generatedAt: new Date('2026-07-03T13:00:00Z'), windowDays: 30, minDistinctUsers: 3 };

test('SECURITY: a topic backed by fewer than K distinct users is excluded from the export (issue #53)', () => {
  const singleUserNiche = digest({
    id: 2,
    topic: 'One person building an X integration for a named Wellington agency',
    summary: 'A single member kept asking about their niche integration.',
    distinctUsers: 1,
  });
  const belowFloor = digest({ id: 3, topic: 'Two-person topic', distinctUsers: 2 });
  const clears = digest({ id: 4, topic: 'Widely shared topic', distinctUsers: 3 });

  const { markdown, included, droppedBelowFloor } = renderCommunityContextExport(
    [singleUserNiche, belowFloor, clears],
    OPTS,
  );

  assert.ok(!markdown.includes('Wellington agency'), 'SECURITY: the single-user niche topic is excluded');
  assert.ok(!markdown.includes('Two-person topic'), 'a below-floor (K=3) topic is excluded');
  assert.ok(markdown.includes('Widely shared topic'), 'a topic at/above the floor is included');
  assert.equal(included, 1);
  assert.equal(droppedBelowFloor, 2, 'drops are counted (and logged by the writer), never hidden');
});

test('SECURITY: the export contains only aggregate fields — no user ids, display names, conversation ids, refs, or raw content (issue #53)', () => {
  const d = digest({
    topic: 'Claude API onboarding',
    summary: 'Multiple people asked how to get started with the API.',
    exampleRefs: [987654321, 123456789],
  });
  const { markdown } = renderCommunityContextExport([d], OPTS);

  // Interaction refs are internal DB ids and must never be rendered.
  assert.ok(!markdown.includes('987654321') && !markdown.includes('123456789'), 'refs never rendered');
  // Nothing but the aggregate fields appears: topic, counts, period, summary.
  assert.match(markdown, /Claude API onboarding/);
  assert.match(markdown, /7 message\(s\) from 4 distinct people/);
  assert.match(markdown, /2026-07-01\.\.2026-07-02/);
  // Freshness stamps so a stale export is visible.
  assert.match(markdown, /Generated: 2026-07-03T13:00:00\.000Z/);
  assert.match(markdown, /last 30 day\(s\)/);
  assert.match(markdown, /Anonymity floor: topics need >= 3 distinct authors/);
});

test('SECURITY: PII-shaped tokens in model-written summaries are scrubbed before the export is written (issue #53)', () => {
  const d = digest({
    topic: 'Contact sharing gone wrong @someharvester',
    summary:
      'Reach jane.doe@example.co.nz or +64 21 123 4567, ping @jane_doe, or use ' +
      'https://example.com/reset?token=SECRETTOKEN123 to follow up.',
  });
  const { markdown } = renderCommunityContextExport([d], OPTS);

  assert.ok(!markdown.includes('jane.doe@example.co.nz'), 'emails scrubbed');
  assert.ok(!markdown.includes('21 123 4567'), 'phone numbers scrubbed');
  assert.ok(!markdown.includes('@jane_doe') && !markdown.includes('@someharvester'), 'handles scrubbed');
  assert.ok(!markdown.includes('token=SECRETTOKEN123'), 'URL query strings (token carriers) scrubbed');
  assert.ok(markdown.includes('https://example.com/reset'), 'the URL origin/path may remain');
  assert.match(markdown, /\[email\]/);
  assert.match(markdown, /\[phone\]/);
  assert.match(markdown, /\[handle\]/);
});

test('SECURITY: tokens embedded in URL paths (not just query strings) are scrubbed (issue #53)', () => {
  const scrubbed = scrubPII(
    'Use https://example.com/reset/AbCdEfGhIjKlMnOpQrStUv12 or https://example.com/docs/getting-started to continue.',
  );
  assert.ok(!scrubbed.includes('AbCdEfGhIjKlMnOpQrStUv12'), 'a long token-shaped path segment is redacted');
  assert.ok(scrubbed.includes('https://example.com/reset/[token]'), 'the URL shape survives redaction');
  assert.ok(
    scrubbed.includes('https://example.com/docs/getting-started'),
    'ordinary short path segments are untouched',
  );
});

test('scrubPII leaves ordinary prose, years, and short counts alone', () => {
  const text = 'In 2026 about 400 members asked 12 questions across 3 channels.';
  assert.equal(scrubPII(text), text);
});

test('an export with nothing above the floor says so instead of rendering nothing', () => {
  const { markdown, included } = renderCommunityContextExport([digest({ distinctUsers: 1 })], OPTS);
  assert.equal(included, 0);
  assert.match(markdown, /No topics cleared the export floor/);
});
