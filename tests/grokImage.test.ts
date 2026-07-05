import { test } from 'node:test';
import assert from 'node:assert/strict';

// grokImage.ts imports config.ts, which validates env at import time.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { sniffImageType } = await import('../src/media/grokImage.js');

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
