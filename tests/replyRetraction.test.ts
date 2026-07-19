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
  mappingsSizeForTests,
  REPLY_RETRACTION_TTL_MS,
  REPLY_RETRACTION_MAX_ENTRIES,
} = await import('../src/replyRetraction.js');

test('replyRetraction: record + take round-trips the mapping and evicts on read (single-use)', () => {
  resetReplyMappingsForTests();
  recordReplyMapping('discord', 'chan-1', 'msg-1', {
    replyConversationId: 'chan-1',
    botReplyMessageIds: ['reply-1'],
    senderId: 'user-1',
  });

  const taken = takeReplyMapping('discord', 'chan-1', 'msg-1');
  assert.equal(taken?.replyConversationId, 'chan-1');
  assert.deepEqual(taken?.botReplyMessageIds, ['reply-1']);
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
    botReplyMessageIds: ['reply-2'],
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
    botReplyMessageIds: ['reply-a'],
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
      botReplyMessageIds: ['reply-ttl'],
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
      botReplyMessageIds: [`reply-${i}`],
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

test('replyRetraction: overwriting an existing key moves it to the end of iteration order, so sweep() still evicts a genuinely-expired entry behind it (PR #576 review — Map iteration order must track recency, not just insertion time)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  try {
    resetReplyMappingsForTests();
    // A is inserted first (would occupy the earliest iteration slot).
    recordReplyMapping('discord', 'chan-order', 'msg-a', {
      replyConversationId: 'chan-order',
      botReplyMessageIds: ['reply-a'],
      senderId: 'user-order',
    });

    t.mock.timers.tick(1);
    // B is inserted second, and — without the fix — would sit behind A in
    // iteration order even once A is later refreshed.
    recordReplyMapping('discord', 'chan-order', 'msg-b', {
      replyConversationId: 'chan-order',
      botReplyMessageIds: ['reply-b'],
      senderId: 'user-order',
    });

    t.mock.timers.tick(99);
    // Overwrite A's mapping well after B was recorded. If this merely
    // updates A in place (plain Map.set on an existing key), A keeps its
    // early iteration slot despite now having the freshest timestamp.
    recordReplyMapping('discord', 'chan-order', 'msg-a', {
      replyConversationId: 'chan-order',
      botReplyMessageIds: ['reply-a-2'],
      senderId: 'user-order',
    });

    // Advance past B's TTL (but not A's, since A was just refreshed), then
    // record a third entry to trigger another sweep.
    t.mock.timers.tick(REPLY_RETRACTION_TTL_MS - 100 + 2);
    recordReplyMapping('discord', 'chan-order', 'msg-c', {
      replyConversationId: 'chan-order',
      botReplyMessageIds: ['reply-c'],
      senderId: 'user-order',
    });

    // Assert on the raw map size, NOT via peekReplyMapping/takeReplyMapping —
    // both of those apply their own independent per-key TTL check as a side
    // effect, which would silently clean up (and so mask) an entry that
    // sweep() itself failed to evict. This must observe sweep()'s actual
    // cleanup, since sweep() is the only cleanup path for an entry nobody
    // ever looks up again (the "idle process" memory-bound claim in
    // docs/SECURITY.md).
    assert.equal(
      mappingsSizeForTests(),
      2,
      'B must have been swept, leaving only the refreshed A and the just-recorded C — ' +
        'a stale-but-refreshed A sitting in an early iteration slot must not block sweep() ' +
        'from reaching a genuinely-expired B behind it',
    );
    assert.ok(
      peekReplyMapping('discord', 'chan-order', 'msg-a'),
      'the refreshed A is still within its (restarted) TTL',
    );
    assert.ok(peekReplyMapping('discord', 'chan-order', 'msg-c'), 'the just-recorded C is present');
  } finally {
    t.mock.timers.reset();
  }
});

test('replyRetraction: botReplyMessageIds carries every chunk id of a multi-chunk reply, in order (PR #576 review — a multi-chunk Discord reply must be fully retractable, not just its last chunk)', () => {
  resetReplyMappingsForTests();
  recordReplyMapping('discord', 'chan-multi', 'msg-multi', {
    replyConversationId: 'chan-multi',
    botReplyMessageIds: ['reply-1', 'reply-2', 'reply-3'],
    senderId: 'user-multi',
  });

  const taken = takeReplyMapping('discord', 'chan-multi', 'msg-multi');
  assert.deepEqual(
    taken?.botReplyMessageIds,
    ['reply-1', 'reply-2', 'reply-3'],
    'all chunk ids are preserved, in send order, so every chunk can be retracted',
  );
});
