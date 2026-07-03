import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// (including WHATSAPP_PROVIDER=cloud config) before importing anything that
// (transitively) loads it. DATABASE_URL points nowhere; policy reads fail
// and fall back to defaults (see src/storage/policies.ts), so no real DB is
// needed for this adapter-level test.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER = 'cloud';
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID ??= 'test-phone-id';
process.env.WHATSAPP_CLOUD_ACCESS_TOKEN ??= 'test-access-token';
process.env.WHATSAPP_CLOUD_VERIFY_TOKEN ??= 'test-verify-token';
process.env.WHATSAPP_CLOUD_APP_SECRET ??= 'test-app-secret';

const { WhatsAppCloudAdapter } = await import('../src/platforms/whatsapp/cloudAdapter.js');

/** Records every Graph API call this adapter would have made. */
function mockFetch(responses: Array<{ ok: boolean; status?: number }>) {
  const calls: Array<{ url: string; body: string }> = [];
  let i = 0;
  const fetchMock = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : '' });
    const resp = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 500),
      text: async () => (resp.ok ? '' : 'graph error'),
    } as Response;
  };
  return { calls, fetchMock };
}

/** Marks `userId` as within the 24h customer-service window without a real webhook round-trip. */
function markInboundNow(adapter: InstanceType<typeof WhatsAppCloudAdapter>, userId: string) {
  (adapter as unknown as { lastInboundAt: Map<string, number> }).lastInboundAt.set(userId, Date.now());
}

test('sendDirectMessage: short text sends exactly one Graph API call, unchanged from today', async () => {
  const adapter = new WhatsAppCloudAdapter();
  markInboundNow(adapter, '64211234567');
  const { calls, fetchMock } = mockFetch([{ ok: true }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await adapter.sendDirectMessage('64211234567', 'kia ora, all sorted');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].body).text.body, 'kia ora, all sorted');
});

test('sendDirectMessage: a reply over 4096 chars is chunked into multiple sequential Graph API calls', async () => {
  const adapter = new WhatsAppCloudAdapter();
  markInboundNow(adapter, '64211234567');
  const longText = 'line of reply text\n'.repeat(400); // well over 4096 chars
  const { calls, fetchMock } = mockFetch([{ ok: true }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await adapter.sendDirectMessage('64211234567', longText);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(calls.length > 1, 'expected multiple chunked sends');
  const bodies = calls.map((c) => JSON.parse(c.body).text.body as string);
  for (const body of bodies) assert.ok(body.length <= 4096);
  assert.equal(bodies.join(''), longText, 'round-trip: chunks reassemble to the original text exactly');
});

test('SECURITY: filtering runs once on the whole message before chunking, so a secret cannot straddle a chunk boundary and leak', async () => {
  const adapter = new WhatsAppCloudAdapter();
  markInboundNow(adapter, '64211234567');
  // No newlines near the 4096 boundary, so chunkText hard-cuts at exactly
  // position 4096 — which falls in the middle of the secret below. If
  // filtering ran per-chunk AFTER splitting instead of once before, the
  // split secret would evade the whole-string regex in both halves and leak.
  // A space (non-word char) surrounds the secret so the pattern's `\b` word
  // boundaries actually match — filler alone would run word-to-word.
  const prefix = 'x'.repeat(4089) + ' ';
  const secret = 'sk-ant-' + 'y'.repeat(30);
  const suffix = ' ' + 'z'.repeat(200);
  const text = prefix + secret + suffix;
  assert.ok(
    prefix.length < 4096 && prefix.length + secret.length > 4096,
    'test setup: secret must straddle the boundary',
  );

  const { calls, fetchMock } = mockFetch([{ ok: true }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await adapter.sendDirectMessage('64211234567', text);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const bodies = calls.map((c) => JSON.parse(c.body).text.body as string);
  for (const body of bodies)
    assert.ok(!body.includes('sk-ant-'), 'no raw secret fragment may reach any chunk');
  // The chunk boundary can still cosmetically split the "[redacted]" marker
  // itself (same accepted cosmetic risk as a word/fence split — see PR
  // discussion); check the reassembled reply, not any single chunk.
  assert.ok(
    bodies.join('').includes('[redacted]'),
    'the secret must have been redacted, not silently dropped',
  );
});

test('sendDirectMessage: Discord-style markdown is converted to WhatsApp formatting before sending', async () => {
  const adapter = new WhatsAppCloudAdapter();
  markInboundNow(adapter, '64211234567');
  const { calls, fetchMock } = mockFetch([{ ok: true }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await adapter.sendDirectMessage('64211234567', '**Answer:**\n# Heading\n- one\n- two');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].body).text.body as string;
  assert.equal(body, '*Answer:*\n*Heading*\n• one\n• two');
});

test('partial-failure semantics: a mid-sequence Graph API failure delivers earlier chunks then throws (parity with Discord)', async () => {
  const adapter = new WhatsAppCloudAdapter();
  markInboundNow(adapter, '64211234567');
  const longText = 'line of reply text\n'.repeat(400);
  const { calls, fetchMock } = mockFetch([{ ok: true }, { ok: false, status: 400 }, { ok: true }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await assert.rejects(
      () => adapter.sendDirectMessage('64211234567', longText),
      /WhatsApp Cloud send failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 2, 'the first chunk should have been sent before the second one failed');
});

test('outside the 24h customer-service window: throws before any Graph API call, regardless of message length', async () => {
  const adapter = new WhatsAppCloudAdapter();
  // No markInboundNow — this user has no recent inbound message.
  const { calls, fetchMock } = mockFetch([{ ok: true }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await assert.rejects(
      () => adapter.sendDirectMessage('64299999999', 'line of reply text\n'.repeat(400)),
      /outside the 24h customer-service window/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 0);
});
