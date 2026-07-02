import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { extractMessages, parseVerificationRequest, verifySignature } from '../src/platforms/whatsapp/cloudWire.js';

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
                { from: '64211234567', id: 'wamid.1', timestamp: '1700000000', type: 'text', text: { body: 'kia ora' } },
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
                { from: '64211234567', id: 'wamid.1', timestamp: '1700000000', type: 'text', text: { body: 'hi' } },
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

test('extractMessages: malformed or unrelated payloads yield an empty array', () => {
  assert.deepEqual(extractMessages(null), []);
  assert.deepEqual(extractMessages({}), []);
  assert.deepEqual(extractMessages({ object: 'page' }), []);
  assert.deepEqual(extractMessages({ object: 'whatsapp_business_account' }), []);
  assert.deepEqual(extractMessages({ object: 'whatsapp_business_account', entry: 'not-an-array' }), []);
});
