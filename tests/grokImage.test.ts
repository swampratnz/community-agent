import { test } from 'node:test';
import assert from 'node:assert/strict';

// grokImage.ts imports config.ts, which validates env at import time.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { sniffImageType, parseSessionId, buildGrokArgs } = await import('../src/media/grokImage.js');

test('sniffImageType detects JPEG / PNG / WebP from magic bytes', () => {
  assert.deepEqual(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), {
    mimeType: 'image/jpeg',
    ext: 'jpg',
  });
  assert.deepEqual(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), {
    mimeType: 'image/png',
    ext: 'png',
  });
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
  assert.deepEqual(sniffImageType(webp), { mimeType: 'image/webp', ext: 'webp' });
});

test('sniffImageType returns null for non-image or empty bytes (never mislabels)', () => {
  assert.equal(sniffImageType(Buffer.from('this is not an image, it is an error message')), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
  // A near-miss that shares no full signature must not be treated as an image.
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0x00])), null);
});

test('SECURITY: buildGrokArgs locks the CLI to the image tool so --always-approve is safe', () => {
  const args = buildGrokArgs('draw a cat');
  // The allowlist that removes Bash/file/exec — without it, --always-approve
  // becomes a host-code-execution surface. --tools must be immediately followed
  // by exactly GenerateImage.
  const i = args.indexOf('--tools');
  assert.ok(i >= 0, '--tools must be present');
  assert.equal(args[i + 1], 'GenerateImage');
  assert.ok(args.includes('--always-approve'));
  assert.ok(args.includes('--disable-web-search'));
  // The free-text prompt is the value of -p, an argv element (never a shell string).
  const p = args.indexOf('-p');
  assert.ok(p >= 0);
  assert.equal(args[p + 1], 'draw a cat');
});

test('parseSessionId reads the session id from grok JSON stdout', () => {
  const sid = '019f33c3-4797-74c0-8d0e-cab1413edcb7';
  assert.equal(parseSessionId(JSON.stringify({ text: 'done', sessionId: sid })), sid);
  // Regex fallback when stdout is not clean JSON (e.g. a stray log line prefix).
  assert.equal(parseSessionId(`warn: something\n{"sessionId":"${sid}","stopReason":"EndTurn"}`), sid);
});

test('parseSessionId returns null when no valid session id is present', () => {
  assert.equal(parseSessionId('{"text":"no id here"}'), null);
  assert.equal(parseSessionId('not json at all'), null);
  // A malformed id (wrong shape) is not accepted.
  assert.equal(parseSessionId('{"sessionId":"nope"}'), null);
});
