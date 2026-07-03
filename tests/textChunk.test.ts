import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/platforms/textChunk.js';

test('chunkText: text at or under the limit passes through as a single chunk', () => {
  assert.deepEqual(chunkText('hello', 2000), ['hello']);
  assert.deepEqual(chunkText('x'.repeat(2000), 2000), ['x'.repeat(2000)]);
});

test('chunkText: empty string yields a single empty chunk (no new-throw, no zero-length spam)', () => {
  assert.deepEqual(chunkText('', 2000), ['']);
});

test('chunkText: over-limit text splits into multiple chunks, each within the size limit', () => {
  const text = 'a'.repeat(5000);
  const chunks = chunkText(text, 2000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 2000);
});

test('chunkText: prefers splitting on the last newline before the boundary', () => {
  // The cut lands ON the newline: it ends the current chunk (excluded) and
  // starts the next one (included) — so each subsequent chunk leads with '\n'.
  const text = 'a'.repeat(1990) + '\n' + 'b'.repeat(1990) + '\n' + 'c'.repeat(10);
  const chunks = chunkText(text, 2000);
  assert.equal(chunks[0], 'a'.repeat(1990));
  assert.equal(chunks[1], '\n' + 'b'.repeat(1990));
  assert.equal(chunks[2], '\n' + 'c'.repeat(10));
});

test('chunkText: falls back to a hard cut when no newline is near the boundary', () => {
  const text = 'a'.repeat(5000);
  const chunks = chunkText(text, 2000);
  assert.equal(chunks[0], 'a'.repeat(2000));
  assert.equal(chunks[1], 'a'.repeat(2000));
  assert.equal(chunks[2], 'a'.repeat(1000));
});

test('chunkText: invariant — joining all chunks reproduces the original text exactly, at both platform limits', () => {
  for (const size of [2000, 4096]) {
    for (const text of [
      '',
      'short',
      'x'.repeat(size),
      'x'.repeat(size + 1),
      'line one\n'.repeat(1000),
      'no newlines at all '.repeat(500),
    ]) {
      const chunks = chunkText(text, size);
      assert.equal(chunks.join(''), text, `round-trip failed for size=${size}`);
      for (const chunk of chunks) assert.ok(chunk.length <= size, `chunk exceeds size=${size}`);
    }
  }
});
