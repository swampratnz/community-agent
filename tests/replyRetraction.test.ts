import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure unit tests for the in-memory reply-retraction map (issue #575) —
// src/replyRetraction.ts only imports `type { Platform }` (erased at
// compile/transpile time), so it never touches config.ts and needs no env
// setup, unlike almost every other test file in this repo.
const {
  recordReplyMapping,
  peekReplyMapping,
  takeReplyMapping,
  evictReplyMapping,
  resetReplyMappingsForTests,
  REPLY_RETRACTION_TTL_MS,
  REPLY_RETRACTION_MAX_ENTRIES,
} = await import('../src/replyRetraction.js');

test('replyRetraction: record + take round-trips the mapping and evicts on read (single-use)', () => {
  resetReplyMappingsForTests();
  recordReplyMapping('discord', 'chan-1', 'msg-1', {
    replyConversationId: 'chan-1',
    botReplyMessageId: 'reply-1',
    senderId: 'user-1',
  });

  const taken = takeReplyMapping('discord', 'chan-1', 'msg-1');
  assert.equal(taken?.replyConversationId, 'chan-1');
  assert.equal(taken?.botReplyMessageId, 'reply-1');
  assert.equal(taken?.senderId, 'user-1');

  assert.equal(
    takeReplyMapping('discord', 'chan-1', 'msg-1'),
    undefined,
    'a second take finds nothing — the first take already evicted it',
  );
});

test('replyRetraction: peek never evicts, even across repeated reads — only evictReplyMapping removes an entry (issue #575 griefing-vector fix)', () => {
  resetReplyMappingsForTests();
  recordReplyMapping('whatsapp', 'group-1', 'msg-2', {
    replyConversationId: 'group-1',
    botReplyMessageId: 'reply-2',
    senderId: 'sender-a',
  });

  assert.ok(peekReplyMapping('whatsapp', 'group-1', 'msg-2'), 'first peek finds the mapping');
  assert.ok(
    peekReplyMapping('whatsapp', 'group-1', 'msg-2'),
    'a repeated peek still finds it — a failed authorization check upstream must never silently consume the entry',
  );

  evictReplyMapping('whatsapp', 'group-1', 'msg-2');
  assert.equal(
    peekReplyMapping('whatsapp', 'group-1', 'msg-2'),
    undefined,
    'evictReplyMapping actually removes the entry',
  );
});

test('replyRetraction: the map key is (platform, conversationId, messageId) — no cross-platform/cross-conversation bleed', () => {
  resetReplyMappingsForTests();
  recordReplyMapping('discord', 'chan-a', 'msg-x', {
    replyConversationId: 'chan-a',
    botReplyMessageId: 'reply-a',
    senderId: 'user-a',
  });

  assert.equal(
    peekReplyMapping('discord', 'chan-b', 'msg-x'),
    undefined,
    'the same message id in a DIFFERENT conversation must not match',
  );
  assert.equal(
    peekReplyMapping('whatsapp', 'chan-a', 'msg-x'),
    undefined,
    'the same conversation+message id on a DIFFERENT platform must not match',
  );
  assert.ok(
    peekReplyMapping('discord', 'chan-a', 'msg-x'),
    'the exact (platform, conversation, message) still matches',
  );
});

test('replyRetraction: an entry older than the TTL is not honoured (time-injected, acceptance criterion 7)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  try {
    resetReplyMappingsForTests();
    recordReplyMapping('discord', 'chan-ttl', 'msg-ttl', {
      replyConversationId: 'chan-ttl',
      botReplyMessageId: 'reply-ttl',
      senderId: 'user-ttl',
    });

    t.mock.timers.tick(REPLY_RETRACTION_TTL_MS - 1_000);
    assert.ok(peekReplyMapping('discord', 'chan-ttl', 'msg-ttl'), 'still within the TTL window');

    t.mock.timers.tick(2_000); // now just past REPLY_RETRACTION_TTL_MS
    assert.equal(
      peekReplyMapping('discord', 'chan-ttl', 'msg-ttl'),
      undefined,
      'an entry past its TTL is not honoured — retraction must be skipped',
    );
    assert.equal(
      takeReplyMapping('discord', 'chan-ttl', 'msg-ttl'),
      undefined,
      'takeReplyMapping agrees: an expired entry is never returned',
    );
  } finally {
    t.mock.timers.reset();
  }
});

test('replyRetraction: the map is size-capped with oldest-first eviction (acceptance criterion 7)', () => {
  resetReplyMappingsForTests();
  const overflow = 5;
  for (let i = 0; i < REPLY_RETRACTION_MAX_ENTRIES + overflow; i++) {
    recordReplyMapping('discord', 'chan-cap', `msg-${i}`, {
      replyConversationId: 'chan-cap',
      botReplyMessageId: `reply-${i}`,
      senderId: 'user-cap',
    });
  }

  for (let i = 0; i < overflow; i++) {
    assert.equal(
      peekReplyMapping('discord', 'chan-cap', `msg-${i}`),
      undefined,
      `entry ${i} was among the oldest and must have been evicted once the cap was exceeded`,
    );
  }
  const newestIndex = REPLY_RETRACTION_MAX_ENTRIES + overflow - 1;
  assert.ok(
    peekReplyMapping('discord', 'chan-cap', `msg-${newestIndex}`),
    'the most recently recorded entry survives the cap',
  );
});
