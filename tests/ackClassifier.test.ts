import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPureAcknowledgement } from '../src/ackClassifier.js';

test('isPureAcknowledgement: exact-match text acks', () => {
  assert.equal(isPureAcknowledgement('thanks'), true);
  assert.equal(isPureAcknowledgement('thank you'), true);
  assert.equal(isPureAcknowledgement('ty'), true);
  assert.equal(isPureAcknowledgement('tysm'), true);
  assert.equal(isPureAcknowledgement('cheers'), true);
  assert.equal(isPureAcknowledgement('ok'), true);
  assert.equal(isPureAcknowledgement('okay'), true);
  assert.equal(isPureAcknowledgement('kk'), true);
  assert.equal(isPureAcknowledgement('cool'), true);
  assert.equal(isPureAcknowledgement('sweet'), true);
  assert.equal(isPureAcknowledgement('got it'), true);
  assert.equal(isPureAcknowledgement('nice one'), true);
});

test('isPureAcknowledgement: case-insensitive, whitespace- and punctuation-tolerant', () => {
  assert.equal(isPureAcknowledgement('Thanks'), true);
  assert.equal(isPureAcknowledgement('THANKS!'), true);
  assert.equal(isPureAcknowledgement('  ok  '), true);
  assert.equal(isPureAcknowledgement('Cheers!!!'), true);
  assert.equal(isPureAcknowledgement('\tGot it.\n'), true);
});

test('isPureAcknowledgement: exact-match emoji acks, including variation-selector forms', () => {
  assert.equal(isPureAcknowledgement('👍'), true);
  assert.equal(isPureAcknowledgement('🙏'), true);
  assert.equal(isPureAcknowledgement('😂'), true);
  assert.equal(isPureAcknowledgement('🎉'), true);
  // Heart sent with the emoji-presentation variation selector (U+FE0F)...
  assert.equal(isPureAcknowledgement('❤️'), true);
  // ...and the bare form without it must match too.
  assert.equal(isPureAcknowledgement('❤'), true);
});

test('isPureAcknowledgement: skin-tone-modified emoji are treated as distinct content, not normalised away', () => {
  assert.equal(isPureAcknowledgement('👍🏽'), false);
  assert.equal(isPureAcknowledgement('🙏🏿'), false);
});

test('isPureAcknowledgement: a ZWJ multi-codepoint emoji sequence never matches (not in the fixed list)', () => {
  assert.equal(isPureAcknowledgement('👨‍👩‍👧'), false);
});

test('isPureAcknowledgement: mention-token-stripped forms match, same as classifyConfirmReply', () => {
  assert.equal(isPureAcknowledgement('@64211234567 thanks'), true);
  assert.equal(isPureAcknowledgement('@64211234567 @6421000000 ok'), true);
  assert.equal(isPureAcknowledgement('@64211234567 👍'), true);
});

test('SECURITY/regression: messages that merely start or end with an ack word never match', () => {
  assert.equal(isPureAcknowledgement("thanks but that didn't work"), false);
  assert.equal(isPureAcknowledgement("ok here's my question"), false);
  assert.equal(isPureAcknowledgement('cool, so what about the other issue'), false);
  assert.equal(isPureAcknowledgement('is this ok'), false);
  assert.equal(isPureAcknowledgement('got it working finally, thanks for the help'), false);
});

test('isPureAcknowledgement: empty or mention-only text never matches', () => {
  assert.equal(isPureAcknowledgement(''), false);
  assert.equal(isPureAcknowledgement('   '), false);
  assert.equal(isPureAcknowledgement('@64211234567'), false);
});

test('isPureAcknowledgement: unrelated content never matches', () => {
  assert.equal(isPureAcknowledgement('how do I reset my password'), false);
  assert.equal(isPureAcknowledgement('👋'), false);
});
