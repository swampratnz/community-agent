import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  extractMessages,
  isAllowedSender,
  parseVerificationRequest,
  timingSafeEqualString,
  verifySignature,
} from '../src/platforms/whatsapp/cloudWire.js';

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

test('verifySignature: valid signature over the exact raw body', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const secret = 'app-secret';
  assert.equal(verifySignature(body, sign(body.toString(), secret), secret), true);
});

test('SECURITY: verifySignature rejects a mismatched signature', () => {
  const body = Buffer.from('{"a":1}');
  const secret = 'app-secret';
  const wrongSig = sign('{"a":2}', secret);
  assert.equal(verifySignature(body, wrongSig, secret), false);
});

test('SECURITY: verifySignature rejects a signature computed with the wrong secret', () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature(body, sign('{"a":1}', 'wrong-secret'), 'app-secret'), false);
});

test('SECURITY: verifySignature rejects missing header, missing secret, and malformed prefixes', () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature(body, undefined, 'app-secret'), false);
  assert.equal(verifySignature(body, sign('{"a":1}', 'app-secret'), ''), false);
  assert.equal(verifySignature(body, 'not-a-real-signature', 'app-secret'), false);
  assert.equal(verifySignature(body, 'sha256=not-hex!!', 'app-secret'), false);
});

test('SECURITY: verifySignature rejects a hex signature of the wrong length', () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature(body, 'sha256=deadbeef', 'app-secret'), false);
});

test('timingSafeEqualString: identical strings match', () => {
  assert.equal(timingSafeEqualString('verify-token', 'verify-token'), true);
  assert.equal(timingSafeEqualString('a', 'a'), true);
});

test('SECURITY: timingSafeEqualString rejects a wrong token, including near-misses that share a prefix', () => {
  // A prefix-sharing near-miss is exactly what a byte-at-a-time `===` would
  // distinguish by timing; all of these must simply be false.
  assert.equal(timingSafeEqualString('verify-token', 'verify-toke'), false);
  assert.equal(timingSafeEqualString('verify-token', 'verify-tokenn'), false);
  assert.equal(timingSafeEqualString('verify-token', 'Verify-token'), false);
  assert.equal(timingSafeEqualString('verify-token', 'wrong'), false);
});

test('SECURITY: timingSafeEqualString handles length mismatches without throwing — hashing keeps the compared buffers fixed-width', () => {
  // timingSafeEqual() itself throws on differing buffer lengths, so a naive
  // implementation would turn an attacker-chosen length into a 500 (and an
  // observable oracle). Both directions, including a very long input.
  assert.equal(timingSafeEqualString('short', 'a'.repeat(10_000)), false);
  assert.equal(timingSafeEqualString('a'.repeat(10_000), 'short'), false);
});

test('SECURITY: timingSafeEqualString never matches when either side is empty — an unset secret cannot be satisfied by an empty parameter', () => {
  assert.equal(timingSafeEqualString('', ''), false);
  assert.equal(timingSafeEqualString('', 'verify-token'), false);
  assert.equal(timingSafeEqualString('verify-token', ''), false);
});

test('parseVerificationRequest: valid Meta handshake', () => {
  const url = new URL('http://localhost/webhook?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=1234');
  assert.deepEqual(parseVerificationRequest(url), { mode: 'subscribe', token: 'tok', challenge: '1234' });
});

test('parseVerificationRequest: missing params yields null', () => {
  assert.equal(parseVerificationRequest(new URL('http://localhost/webhook?hub.mode=subscribe')), null);
  assert.equal(parseVerificationRequest(new URL('http://localhost/webhook')), null);
});

test('extractMessages: normalises a well-formed text message', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: 'Jamie' }, wa_id: '64211234567' }],
              messages: [
                {
                  from: '64211234567',
                  id: 'wamid.1',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'kia ora' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  assert.deepEqual(extractMessages(payload), [
    { from: '64211234567', id: 'wamid.1', timestampMs: 1700000000000, text: 'kia ora', name: 'Jamie' },
  ]);
});

test('extractMessages: ignores non-text message types (image, status updates, etc)', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          { value: { messages: [{ from: '64211234567', id: 'wamid.1', type: 'image', timestamp: '1' }] } },
          { value: { statuses: [{ id: 'wamid.2', status: 'delivered' }] } },
        ],
      },
    ],
  };
  assert.deepEqual(extractMessages(payload), []);
});

test('extractMessages: missing contact profile falls back to empty name', () => {
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
                  id: 'wamid.1',
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
  assert.deepEqual(extractMessages(payload), [
    { from: '64211234567', id: 'wamid.1', timestampMs: 1700000000000, text: 'hi', name: '' },
  ]);
});

test('isAllowedSender: empty allowlist admits everyone', () => {
  assert.equal(isAllowedSender('64211234567', []), true);
});

test('isAllowedSender: matches a bare-digit entry', () => {
  assert.equal(isAllowedSender('64211234567', ['64211234567']), true);
  assert.equal(isAllowedSender('64299999999', ['64211234567']), false);
});

test('SECURITY: isAllowedSender matches a full Baileys-style JID entry (shared WHATSAPP_ALLOWED_JIDS config)', () => {
  // The allowlist is shared with BaileysAdapter, whose entries are full JIDs
  // ('...@s.whatsapp.net', '...@g.us') rather than bare digits — an operator
  // reusing the same list for the Cloud adapter must not be silently locked
  // out because the formats don't match.
  assert.equal(isAllowedSender('64211234567', ['64211234567@s.whatsapp.net']), true);
  assert.equal(isAllowedSender('64211234567', ['999@g.us', '64211234567@s.whatsapp.net']), true);
  assert.equal(isAllowedSender('64299999999', ['64211234567@s.whatsapp.net']), false);
});

// --- issue #891: image message extraction -----------------------------

function imagePayload(image: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: 'Jamie' }, wa_id: '64211234567' }],
              messages: [
                {
                  from: '64211234567',
                  id: 'wamid.IMG1',
                  timestamp: '1700000000',
                  type: 'image',
                  image,
                  ...overrides,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

test('extractMessages: a well-formed captioned image is extracted with text left empty and the caption on the new image field (issue #891)', () => {
  const result = extractMessages(
    imagePayload({ id: 'media-123', mime_type: 'image/png', caption: "what's this error?" }),
  );
  assert.deepEqual(result, [
    {
      from: '64211234567',
      id: 'wamid.IMG1',
      timestampMs: 1700000000000,
      text: '',
      name: 'Jamie',
      image: { mediaId: 'media-123', mimeType: 'image/png', caption: "what's this error?" },
    },
  ]);
});

test('extractMessages: an uncaptioned image is extracted with image.caption undefined, not an empty string', () => {
  const result = extractMessages(imagePayload({ id: 'media-456', mime_type: 'image/jpeg' }));
  assert.equal(result.length, 1);
  assert.equal(result[0].image?.caption, undefined);
  assert.equal(result[0].text, '');
});

test("extractMessages: an image message missing Meta's own media id is treated as malformed and skipped, exactly like the pre-#891 baseline", () => {
  assert.deepEqual(extractMessages(imagePayload({ mime_type: 'image/png', caption: 'no id here' })), []);
});

test('extractMessages: an image with no declared mime_type still extracts (mimeType falls back to an empty string, refused downstream by the MIME allowlist rather than crashing here)', () => {
  const result = extractMessages(imagePayload({ id: 'media-789' }));
  assert.equal(result.length, 1);
  assert.equal(result[0].image?.mimeType, '');
});

test('extractMessages: a plain text message is byte-identical to before #891 — image handling is additive, not a rewrite of the text path', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: 'Jamie' }, wa_id: '64211234567' }],
              messages: [
                {
                  from: '64211234567',
                  id: 'wamid.TXT1',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'kia ora' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  assert.deepEqual(extractMessages(payload), [
    { from: '64211234567', id: 'wamid.TXT1', timestampMs: 1700000000000, text: 'kia ora', name: 'Jamie' },
  ]);
});

test('extractMessages: non-text, non-image, non-audio message types (document, sticker, status, etc.) remain silently skipped, as does a malformed audio entry with no audio object', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: '64211234567', id: 'wamid.AUD1', type: 'audio', timestamp: '1' },
                { from: '64211234567', id: 'wamid.DOC1', type: 'document', timestamp: '1' },
                { from: '64211234567', id: 'wamid.STK1', type: 'sticker', timestamp: '1' },
              ],
            },
          },
          { value: { statuses: [{ id: 'wamid.2', status: 'delivered' }] } },
        ],
      },
    ],
  };
  assert.deepEqual(extractMessages(payload), []);
});

// --- issue #910: audio (voice note) message extraction -----------------

function audioPayload(audio: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: 'Jamie' }, wa_id: '64211234567' }],
              messages: [
                {
                  from: '64211234567',
                  id: 'wamid.AUD2',
                  timestamp: '1700000000',
                  type: 'audio',
                  audio,
                  ...overrides,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

test('extractMessages: a well-formed audio message is extracted with text left empty and the media id/mime type on the new voice field (issue #910)', () => {
  const result = extractMessages(audioPayload({ id: 'media-aud-1', mime_type: 'audio/ogg' }));
  assert.deepEqual(result, [
    {
      from: '64211234567',
      id: 'wamid.AUD2',
      timestampMs: 1700000000000,
      text: '',
      name: 'Jamie',
      voice: { mediaId: 'media-aud-1', mimeType: 'audio/ogg' },
    },
  ]);
});

test("extractMessages: an audio message missing Meta's own media id is treated as malformed and skipped, mirroring the image gate", () => {
  assert.deepEqual(extractMessages(audioPayload({ mime_type: 'audio/ogg' })), []);
});

test('extractMessages: an audio message with no declared mime_type still extracts (mimeType falls back to an empty string)', () => {
  const result = extractMessages(audioPayload({ id: 'media-aud-2' }));
  assert.equal(result.length, 1);
  assert.equal(result[0].voice?.mimeType, '');
});

test('extractMessages: malformed or unrelated payloads yield an empty array', () => {
  assert.deepEqual(extractMessages(null), []);
  assert.deepEqual(extractMessages({}), []);
  assert.deepEqual(extractMessages({ object: 'page' }), []);
  assert.deepEqual(extractMessages({ object: 'whatsapp_business_account' }), []);
  assert.deepEqual(extractMessages({ object: 'whatsapp_business_account', entry: 'not-an-array' }), []);
});
