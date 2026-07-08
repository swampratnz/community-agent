import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage as HttpRequest, ServerResponse } from 'node:http';
import type { CloudInboundMessage } from '../src/platforms/whatsapp/cloudWire.js';

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

/** Exposes the adapter's private webhook-dedup internals for direct testing. */
function dedupInternals(adapter: InstanceType<typeof WhatsAppCloudAdapter>) {
  return adapter as unknown as {
    onCloudMessage(msg: CloudInboundMessage): Promise<void>;
    handleWebhook(req: HttpRequest, res: ServerResponse): Promise<void>;
    seenMessageIds: Map<string, number>;
    sweepLastInboundAt(): void;
  };
}

function cloudMessage(overrides: Partial<CloudInboundMessage> = {}): CloudInboundMessage {
  return {
    from: '64211234567',
    id: 'wamid.DEFAULT',
    timestampMs: Date.now(),
    text: 'hi',
    name: 'User',
    ...overrides,
  };
}

/** A minimal fake `http.IncomingMessage` that emits a fixed body, for exercising `handleWebhook` without a real socket. */
function fakeRequest(body: Buffer, headers: Record<string, string>): HttpRequest {
  const req = new EventEmitter();
  (req as unknown as { headers: Record<string, string> }).headers = headers;
  setImmediate(() => {
    req.emit('data', body);
    req.emit('end');
  });
  return req as unknown as HttpRequest;
}

/** A minimal fake `http.ServerResponse` that just records the status code passed to `writeHead`. */
function fakeResponse(): { res: ServerResponse; getStatus: () => number } {
  let status = 0;
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end() {
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, getStatus: () => status };
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

test('sendTypingIndicator: posts the mark-as-read + typing_indicator payload for the inbound wamid', async () => {
  const adapter = new WhatsAppCloudAdapter();
  const { calls, fetchMock } = mockFetch([{ ok: true }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await adapter.sendTypingIndicator({
      platform: 'whatsapp',
      conversationId: '64211234567',
      userId: '64211234567',
      userName: 'User',
      text: 'hi',
      isDirect: true,
      addressedToBot: true,
      timestamp: Date.now(),
      raw: { from: '64211234567', id: 'wamid.ABC123', timestampMs: Date.now(), text: 'hi', name: 'User' },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.status, 'read');
  assert.equal(body.message_id, 'wamid.ABC123');
  assert.deepEqual(body.typing_indicator, { type: 'text' });
});

test('sendTypingIndicator: a message with no wamid on `raw` is a silent no-op (no Graph API call)', async () => {
  const adapter = new WhatsAppCloudAdapter();
  const { calls, fetchMock } = mockFetch([{ ok: true }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await adapter.sendTypingIndicator({
      platform: 'whatsapp',
      conversationId: '64211234567',
      userId: '64211234567',
      userName: 'User',
      text: 'hi',
      isDirect: true,
      addressedToBot: true,
      timestamp: Date.now(),
      // no raw — e.g. a synthetic message with no underlying inbound wamid.
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 0);
});

test('sendTypingIndicator: a Graph API failure throws — the router treats this as best-effort and swallows it', async () => {
  const adapter = new WhatsAppCloudAdapter();
  const { fetchMock } = mockFetch([{ ok: false, status: 400 }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await assert.rejects(() =>
      adapter.sendTypingIndicator({
        platform: 'whatsapp',
        conversationId: '64211234567',
        userId: '64211234567',
        userName: 'User',
        text: 'hi',
        isDirect: true,
        addressedToBot: true,
        timestamp: Date.now(),
        raw: { from: '64211234567', id: 'wamid.X', timestampMs: Date.now(), text: 'hi', name: 'User' },
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('isConnected(): true before start() ever succeeds is not claimed — but stays true after fewer than the threshold of consecutive send failures', async () => {
  const adapter = new WhatsAppCloudAdapter();
  (adapter as unknown as { server: object }).server = {};
  markInboundNow(adapter, '64211234567');
  const { fetchMock } = mockFetch([
    { ok: false, status: 500 },
    { ok: false, status: 500 },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await assert.rejects(() => adapter.sendDirectMessage('64211234567', 'a'));
    await assert.rejects(() => adapter.sendDirectMessage('64211234567', 'b'));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    adapter.isConnected(),
    true,
    'below-threshold consecutive failures must not flip isConnected()',
  );
});

test('isConnected(): flips false once SEND_FAILURE_THRESHOLD (3) consecutive send failures are reached', async () => {
  const adapter = new WhatsAppCloudAdapter();
  (adapter as unknown as { server: object }).server = {};
  markInboundNow(adapter, '64211234567');
  const { fetchMock } = mockFetch([{ ok: false, status: 500 }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => adapter.sendDirectMessage('64211234567', `attempt ${i}`));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(adapter.isConnected(), false, 'isConnected() must flip false once the threshold is crossed');
});

test('isConnected(): a REJECTED fetch (network error, not a non-OK response) also counts toward the failure threshold (issue #218)', async () => {
  // A DNS/TCP/TLS failure or timeout rejects the fetch promise rather than
  // returning res.ok===false. Before #218 that path skipped the failure
  // counter entirely, so a total Graph API outage (every send rejecting)
  // left isConnected() stuck true and the disconnect alert never fired.
  const adapter = new WhatsAppCloudAdapter();
  (adapter as unknown as { server: object }).server = {};
  markInboundNow(adapter, '64211234567');
  const rejectingFetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND graph.facebook.com');
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = rejectingFetch;
  try {
    for (let i = 0; i < 3; i++) {
      // The original network error is re-thrown, not masked.
      await assert.rejects(() => adapter.sendDirectMessage('64211234567', `attempt ${i}`), /ENOTFOUND/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    adapter.isConnected(),
    false,
    'consecutive rejected fetches must flip isConnected() just like consecutive non-OK responses',
  );
});

test('isConnected(): a single successful send after crossing the threshold resets the counter and restores isConnected()', async () => {
  const adapter = new WhatsAppCloudAdapter();
  (adapter as unknown as { server: object }).server = {};
  markInboundNow(adapter, '64211234567');
  const originalFetch = globalThis.fetch;
  try {
    let { fetchMock } = mockFetch([{ ok: false, status: 500 }]);
    globalThis.fetch = fetchMock as typeof fetch;
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => adapter.sendDirectMessage('64211234567', `attempt ${i}`));
    }
    assert.equal(adapter.isConnected(), false, 'sanity check: threshold crossed');

    ({ fetchMock } = mockFetch([{ ok: true }]));
    globalThis.fetch = fetchMock as typeof fetch;
    await adapter.sendDirectMessage('64211234567', 'recovered');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    adapter.isConnected(),
    true,
    'a successful send must reset the failure counter and restore isConnected()',
  );
});

test('isConnected(): a failure to one recipient followed by a success to a different recipient does not trip the threshold', async () => {
  const adapter = new WhatsAppCloudAdapter();
  (adapter as unknown as { server: object }).server = {};
  markInboundNow(adapter, '64211111111');
  markInboundNow(adapter, '64222222222');
  const originalFetch = globalThis.fetch;
  try {
    for (let i = 0; i < 5; i++) {
      const { fetchMock: failMock } = mockFetch([{ ok: false, status: 500 }]);
      globalThis.fetch = failMock as typeof fetch;
      await assert.rejects(() => adapter.sendDirectMessage('64211111111', `attempt ${i}`));

      const { fetchMock: okMock } = mockFetch([{ ok: true }]);
      globalThis.fetch = okMock as typeof fetch;
      await adapter.sendDirectMessage('64222222222', `attempt ${i}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    adapter.isConnected(),
    true,
    'a success to any recipient resets the process-wide counter, so an alternating pattern never trips the threshold',
  );
});

test('sendTypingIndicator failures never drive isConnected() — only real message sends (sendChunk) do', async () => {
  const adapter = new WhatsAppCloudAdapter();
  (adapter as unknown as { server: object }).server = {};
  const { fetchMock } = mockFetch([{ ok: false, status: 500 }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() =>
        adapter.sendTypingIndicator({
          platform: 'whatsapp',
          conversationId: '64211234567',
          userId: '64211234567',
          userName: 'User',
          text: 'hi',
          isDirect: true,
          addressedToBot: true,
          timestamp: Date.now(),
          raw: { from: '64211234567', id: `wamid.${i}`, timestampMs: Date.now(), text: 'hi', name: 'User' },
        }),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    adapter.isConnected(),
    true,
    'typing-indicator failures are best-effort and must never flip the connectivity signal',
  );
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

test('webhook dedup: two deliveries with the identical message id result in exactly one handler call', async () => {
  const adapter = new WhatsAppCloudAdapter();
  let handlerCalls = 0;
  adapter.onMessage(async () => {
    handlerCalls++;
  });
  const internal = dedupInternals(adapter);
  const msg = cloudMessage({ id: 'wamid.DUP' });
  await internal.onCloudMessage(msg);
  await internal.onCloudMessage(msg);
  assert.equal(handlerCalls, 1, 'a repeated delivery of the same message id must not be processed twice');
});

test('SECURITY: dedup check happens before any await — a retry arriving mid-turn still yields exactly one handler call', async () => {
  // The race that matters isn't two sequential deliveries — it's a retry
  // landing WHILE the first delivery's turn is still in flight. This proves
  // the check-and-insert is synchronous (no await before it), not just that
  // dedup works when the two deliveries never overlap.
  const adapter = new WhatsAppCloudAdapter();
  let handlerCalls = 0;
  let releaseHandler: () => void = () => {};
  const handlerGate = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  adapter.onMessage(async () => {
    handlerCalls++;
    await handlerGate;
  });
  const internal = dedupInternals(adapter);
  const msg = cloudMessage({ id: 'wamid.RETRY' });

  const first = internal.onCloudMessage(msg); // starts, blocks mid-turn on handlerGate
  const second = internal.onCloudMessage(msg); // retry arrives before the first turn finishes
  releaseHandler();
  await Promise.all([first, second]);

  assert.equal(
    handlerCalls,
    1,
    'a mid-turn retry must still be suppressed, not just a post-completion duplicate',
  );
});

test('webhook dedup: two deliveries with different message ids are both processed (no over-suppression)', async () => {
  const adapter = new WhatsAppCloudAdapter();
  let handlerCalls = 0;
  adapter.onMessage(async () => {
    handlerCalls++;
  });
  const internal = dedupInternals(adapter);
  await internal.onCloudMessage(cloudMessage({ id: 'wamid.A' }));
  await internal.onCloudMessage(cloudMessage({ id: 'wamid.B' }));
  assert.equal(handlerCalls, 2, 'distinct message ids must never be suppressed as duplicates of each other');
});

test('webhook dedup: the sweep prunes ids older than the dedup window, and a duplicate of an evicted id is treated as new', async () => {
  const adapter = new WhatsAppCloudAdapter();
  let handlerCalls = 0;
  adapter.onMessage(async () => {
    handlerCalls++;
  });
  const internal = dedupInternals(adapter);
  const staleId = 'wamid.STALE';
  // Simulate an entry that aged past the dedup window (well past 5 minutes),
  // without waiting on a real timer.
  internal.seenMessageIds.set(staleId, Date.now() - 10 * 60_000);

  internal.sweepLastInboundAt();
  assert.equal(
    internal.seenMessageIds.has(staleId),
    false,
    'sweep must evict entries older than the dedup window',
  );

  await internal.onCloudMessage(cloudMessage({ id: staleId }));
  assert.equal(
    handlerCalls,
    1,
    'a message id that aged out of the dedup window is treated as new, not silently suppressed forever',
  );
});

test('SECURITY: a payload that fails verifySignature never reaches the dedup set or the handler', async () => {
  const adapter = new WhatsAppCloudAdapter();
  let handlerCalls = 0;
  adapter.onMessage(async () => {
    handlerCalls++;
  });
  const internal = dedupInternals(adapter);

  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: '64211234567',
                  id: 'wamid.UNSIGNED',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'hi' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  // Deliberately wrong signature — WHATSAPP_CLOUD_APP_SECRET is 'test-app-secret'.
  const req = fakeRequest(rawBody, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) });
  const { res, getStatus } = fakeResponse();

  await internal.handleWebhook(req, res);

  assert.equal(getStatus(), 401, 'an invalid signature must be rejected with 401');
  assert.equal(handlerCalls, 0, 'an unauthenticated payload must never reach the message handler');
  assert.equal(
    internal.seenMessageIds.size,
    0,
    'an unauthenticated payload must never populate the dedup set — the guard sits strictly after auth',
  );
});

test('SECURITY: the dedup set stores only the opaque wamid and a timestamp, never message content', async () => {
  const adapter = new WhatsAppCloudAdapter();
  adapter.onMessage(async () => {});
  const internal = dedupInternals(adapter);
  const secretText = 'this is the actual message body and must never be stored in the dedup set';

  await internal.onCloudMessage(cloudMessage({ id: 'wamid.CONTENT', text: secretText }));

  assert.equal(internal.seenMessageIds.size, 1);
  const [[key, value]] = internal.seenMessageIds.entries();
  assert.equal(key, 'wamid.CONTENT', 'the stored key must be the opaque message id, nothing else');
  assert.equal(typeof value, 'number', 'the stored value must be a first-seen timestamp, not the message');
  for (const storedKey of internal.seenMessageIds.keys()) {
    assert.ok(!storedKey.includes(secretText), 'message content must never leak into the dedup set');
  }
});

test('messageId parity: onCloudMessage sets IncomingMessage.messageId to the Meta wamid (parity with baileysAdapter.ts)', async () => {
  const adapter = new WhatsAppCloudAdapter();
  let received: { messageId?: string } | undefined;
  adapter.onMessage(async (message) => {
    received = message;
  });
  const internal = dedupInternals(adapter);

  await internal.onCloudMessage(cloudMessage({ id: 'wamid.PARITY' }));

  assert.equal(received?.messageId, 'wamid.PARITY');
});
