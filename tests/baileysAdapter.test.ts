import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it. Locally
// DATABASE_URL points nowhere and policy reads fail over to defaults (see
// src/storage/policies.ts); in CI (ci.yml) DATABASE_URL is a REAL pgvector
// Postgres shared by the whole test job, not just tests/repository.test.ts.
// Either way this file must stay DB-independent — see the blanket
// `beforeEach` pool.query stub below.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const {
  BaileysAdapter,
  initialWelcomeCooldownState,
  stepWelcomeCooldown,
  WHATSAPP_GROUP_WELCOME_MESSAGE,
  WHATSAPP_GROUP_WELCOME_MESSAGE_OPEN,
} = await import('../src/platforms/whatsapp/baileysAdapter.js');
const { config } = await import('../src/config.js');
const { pool } = await import('../src/storage/db.js');
const { resetPolicyCacheForTests } = await import('../src/storage/policies.js');
const { buildToolServer } = await import('../src/agent/tools.js');

/**
 * Issue #407: `onGroupParticipantsUpdate` now unconditionally writes to
 * `server_roster` on every add/remove, not just reads policies. Against a
 * REAL DATABASE_URL (CI's shared pgvector Postgres) an un-mocked
 * `fireGroupJoin` would leave real roster rows behind, leaking into
 * unrelated tests/files (e.g. tests/adminDigest.test.ts's
 * `rosterCounts('whatsapp')` assertions) that share the same DB. Default
 * every pool.query call in this file to a harmless empty response — any test
 * that needs a specific response (roster writes, policy reads) installs its
 * own `t.mock.method(pool, 'query', ...)` afterwards, which simply layers on
 * top of this one for that test's duration.
 */
beforeEach((t) => {
  t.mock.method(pool, 'query', async () => ({ rows: [], rowCount: 0 }));
});

/**
 * Stubs the Baileys socket so sendMessage / sendDirectMessage can be
 * exercised without a real WhatsApp connection — mirrors the network-mocking
 * style used for the Cloud WhatsApp adapter in whatsappCloudAdapter.test.ts.
 */
function stubSocket(adapter: InstanceType<typeof BaileysAdapter>) {
  const sent: string[] = [];
  (
    adapter as unknown as {
      sock: {
        sendMessage: (jid: string, msg: { text: string }) => Promise<void>;
        sendPresenceUpdate: (type: string, jid?: string) => Promise<void>;
      };
    }
  ).sock = {
    sendMessage: async (_jid, msg) => {
      sent.push(msg.text);
    },
    // sendMessage clears the typing indicator via a presence update after
    // sending (see stubSocketWithPresence below for tests that assert on it).
    sendPresenceUpdate: async () => {},
  };
  return sent;
}

test('SECURITY: sendMessage routes through filterOutbound — a secret cannot reach a WhatsApp chat unredacted', async () => {
  const adapter = new BaileysAdapter();
  const sent = stubSocket(adapter);
  await adapter.sendMessage({
    conversationId: '64211234567@s.whatsapp.net',
    text: 'secret is sk-ant-' + 'y'.repeat(30) + ' end',
  });
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes('sk-ant-'), 'no raw secret fragment may reach the chat');
  assert.ok(sent[0].includes('[redacted]'), 'the secret must have been redacted, not silently dropped');
});

test('SECURITY: sendDirectMessage routes through filterOutbound — a secret cannot reach a WhatsApp DM unredacted', async () => {
  const adapter = new BaileysAdapter();
  const sent = stubSocket(adapter);
  await adapter.sendDirectMessage('64211234567', 'secret is sk-ant-' + 'y'.repeat(30) + ' end');
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes('sk-ant-'), 'no raw secret fragment may reach the DM');
  assert.ok(sent[0].includes('[redacted]'), 'the secret must have been redacted, not silently dropped');
});

// Retry-receipt cache: when a recipient can't decrypt a message we sent, their
// device asks for a resend and Baileys serves it via the `getMessage` handler,
// which reads the `sentMessages` cache we populate on every content send.
// Without it a proactive/background-job DM that fails first-delivery decryption
// is stuck on WhatsApp's "Waiting for this message. This may take a while."
// A socket stub whose sendMessage returns a WAMessage-shaped result (the real
// Baileys return; stubSocket above returns void, which `remember` safely skips).
function stubSocketReturningWAMessage(adapter: InstanceType<typeof BaileysAdapter>): { ids: string[] } {
  const ids: string[] = [];
  let n = 0;
  (
    adapter as unknown as {
      sock: {
        sendMessage: (
          jid: string,
          msg: { text?: string },
        ) => Promise<{ key: { id: string }; message: { conversation: string } }>;
        sendPresenceUpdate: (type: string, jid?: string) => Promise<void>;
      };
    }
  ).sock = {
    sendMessage: async (_jid, msg) => {
      const id = `wa-${n++}`;
      ids.push(id);
      return { key: { id }, message: { conversation: msg.text ?? '' } };
    },
    sendPresenceUpdate: async () => {},
  };
  return { ids };
}

function sentCache(
  adapter: InstanceType<typeof BaileysAdapter>,
): Map<string, { message: { conversation?: string }; at: number }> {
  return (
    adapter as unknown as { sentMessages: Map<string, { message: { conversation?: string }; at: number }> }
  ).sentMessages;
}

test('sendMessage caches the sent message so a retry receipt can be resent (getMessage backing)', async () => {
  const adapter = new BaileysAdapter();
  const { ids } = stubSocketReturningWAMessage(adapter);
  await adapter.sendMessage({ conversationId: '64211234567@s.whatsapp.net', text: 'proactive alert' });
  assert.equal(ids.length, 1);
  const cached = sentCache(adapter).get(ids[0]);
  assert.ok(cached, 'the sent message id is in the retry cache');
  assert.equal(
    cached.message.conversation,
    'proactive alert',
    'getMessage can return the original content to resend',
  );
});

test('sendDirectMessage caches the sent message too — the proactive-DM path that saw "Waiting for this message…"', async () => {
  const adapter = new BaileysAdapter();
  const { ids } = stubSocketReturningWAMessage(adapter);
  await adapter.sendDirectMessage('64211234567', 'super-admin alert');
  assert.equal(ids.length, 1);
  assert.ok(sentCache(adapter).get(ids[0]), 'a proactive DM is cached so its retry receipt can be served');
});

test('the sent-message retry cache is bounded — oldest entries evict past the max, newest kept', () => {
  const adapter = new BaileysAdapter();
  const remember = (adapter as unknown as { remember: (m: unknown) => void }).remember.bind(adapter);
  const total = 1005; // a handful over SENT_MESSAGE_CACHE_MAX (1000)
  for (let i = 0; i < total; i++) {
    remember({ key: { id: `m-${i}` }, message: { conversation: `msg ${i}` } });
  }
  const cache = sentCache(adapter);
  assert.equal(cache.size, 1000, 'cache never exceeds the max');
  assert.ok(!cache.has('m-0'), 'the oldest entry was evicted');
  assert.ok(cache.has(`m-${total - 1}`), 'the newest entry is retained');
});

/** Stubs the socket's sendMessage to capture the native image+caption payload sendImage builds (issue #174). */
function stubSocketForImage(adapter: InstanceType<typeof BaileysAdapter>) {
  const sent: Array<{ image: Buffer; caption?: string }> = [];
  (
    adapter as unknown as {
      sock: { sendMessage: (jid: string, msg: { image: Buffer; caption?: string }) => Promise<void> };
    }
  ).sock = {
    sendMessage: async (_jid, msg) => {
      sent.push(msg);
    },
  };
  return sent;
}

test('sendImage forwards the caption as the native WhatsApp image caption (issue #174)', async () => {
  const adapter = new BaileysAdapter();
  const sent = stubSocketForImage(adapter);
  await adapter.sendImage(
    '64211234567@s.whatsapp.net',
    { data: Buffer.from('fake-image'), filename: 'image.jpg', mimeType: 'image/jpeg' },
    'a cat wearing a hat',
  );
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].caption,
    'a cat wearing a hat',
    'no image may be posted bare — the prompt must be the caption',
  );
});

test('SECURITY: sendImage routes the caption through filterOutbound — a secret cannot reach WhatsApp unredacted (issue #174)', async () => {
  const adapter = new BaileysAdapter();
  const sent = stubSocketForImage(adapter);
  await adapter.sendImage(
    '64211234567@s.whatsapp.net',
    { data: Buffer.from('fake-image'), filename: 'image.jpg', mimeType: 'image/jpeg' },
    'secret is sk-ant-' + 'y'.repeat(30) + ' end',
  );
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].caption?.includes('sk-ant-'), 'no raw secret fragment may reach the caption');
  assert.ok(
    sent[0].caption?.includes('[redacted]'),
    'the secret must have been redacted, not silently dropped',
  );
});

/** Stubs the socket with a `sendPresenceUpdate` spy, in addition to `sendMessage`. */
function stubSocketWithPresence(
  adapter: InstanceType<typeof BaileysAdapter>,
  opts: { rejectPresence?: boolean } = {},
) {
  const sent: string[] = [];
  const presenceCalls: Array<{ type: string; jid?: string }> = [];
  (
    adapter as unknown as {
      sock: {
        sendMessage: (jid: string, msg: { text: string }) => Promise<void>;
        sendPresenceUpdate: (type: string, jid?: string) => Promise<void>;
      };
    }
  ).sock = {
    sendMessage: async (_jid, msg) => {
      sent.push(msg.text);
    },
    sendPresenceUpdate: async (type, jid) => {
      presenceCalls.push({ type, jid });
      if (opts.rejectPresence) throw new Error('presence update failed');
    },
  };
  return { sent, presenceCalls };
}

function fakeMessage(conversationId: string): IncomingMessage {
  return {
    platform: 'whatsapp',
    conversationId,
    userId: '64211234567',
    userName: 'User',
    text: 'hi',
    isDirect: true,
    addressedToBot: true,
    timestamp: Date.now(),
  };
}

test('sendTypingIndicator: sends a "composing" presence update to the conversation', async () => {
  const adapter = new BaileysAdapter();
  const { presenceCalls } = stubSocketWithPresence(adapter);
  await adapter.sendTypingIndicator(fakeMessage('64211234567@s.whatsapp.net'));
  assert.deepEqual(presenceCalls, [{ type: 'composing', jid: '64211234567@s.whatsapp.net' }]);
});

test('sendMessage: clears the indicator to "paused" once the reply has actually sent', async () => {
  const adapter = new BaileysAdapter();
  const { sent, presenceCalls } = stubSocketWithPresence(adapter);
  await adapter.sendMessage({ conversationId: '64211234567@s.whatsapp.net', text: 'reply' });
  assert.equal(sent.length, 1);
  // The presence clear is fire-and-forget (not awaited by sendMessage) — give its microtask a tick.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(presenceCalls, [{ type: 'paused', jid: '64211234567@s.whatsapp.net' }]);
});

test('best-effort: a failing presence-clear after sendMessage never throws or blocks the send', async () => {
  const adapter = new BaileysAdapter();
  const { sent } = stubSocketWithPresence(adapter, { rejectPresence: true });
  await assert.doesNotReject(() =>
    adapter.sendMessage({ conversationId: '64211234567@s.whatsapp.net', text: 'ok' }),
  );
  assert.equal(sent.length, 1);
});

// --- WhatsApp group-join welcome message -----------------------------------

interface GroupParticipantsUpdate {
  id: string;
  participants: string[];
  action: string;
}

/** Stubs the socket's sendMessage to capture group-welcome posts (jid + text). */
function stubSocketForGroupWelcome(adapter: InstanceType<typeof BaileysAdapter>) {
  const sent: Array<{ jid: string; text: string }> = [];
  (
    adapter as unknown as {
      sock: { sendMessage: (jid: string, msg: { text: string }) => Promise<void> };
    }
  ).sock = {
    sendMessage: async (jid, msg) => {
      sent.push({ jid, text: msg.text });
    },
  };
  return sent;
}

/** Reaches the private group-participants.update handler directly, mirroring how this file already reaches `.sock`. */
function fireGroupJoin(adapter: InstanceType<typeof BaileysAdapter>, update: GroupParticipantsUpdate) {
  return (
    adapter as unknown as { onGroupParticipantsUpdate: (u: GroupParticipantsUpdate) => Promise<void> }
  ).onGroupParticipantsUpdate(update);
}

/** Temporarily overrides config.whatsapp.welcome for the duration of `fn`, then restores it. */
async function withWelcomeConfig<T>(
  overrides: Partial<{ enabled: boolean; cooldownMinutes: number }>,
  fn: () => Promise<T>,
): Promise<T> {
  const welcome = config.whatsapp.welcome as { enabled: boolean; cooldownMinutes: number };
  const prev = { ...welcome };
  Object.assign(welcome, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(welcome, prev);
  }
}

test('WhatsApp group welcome: disabled by default (WHATSAPP_WELCOME_ENABLED unset) is a pinned no-op', async () => {
  assert.equal(config.whatsapp.welcome.enabled, false, 'precondition: default env has the flag off');
  const adapter = new BaileysAdapter();
  const sent = stubSocketForGroupWelcome(adapter);
  await fireGroupJoin(adapter, {
    id: 'group-1@g.us',
    participants: ['64211111111@s.whatsapp.net'],
    action: 'add',
  });
  assert.equal(sent.length, 0);
});

test('WhatsApp group welcome: enabled + action "add" sends exactly one static message to the group, never naming the joiner', async () => {
  const adapter = new BaileysAdapter();
  const sent = stubSocketForGroupWelcome(adapter);
  let handlerCalls = 0;
  adapter.onMessage(async () => {
    handlerCalls += 1;
  });

  await withWelcomeConfig({ enabled: true }, () =>
    fireGroupJoin(adapter, {
      id: 'group-2@g.us',
      participants: ['64211111111@s.whatsapp.net'],
      action: 'add',
    }),
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, 'group-2@g.us', 'posted to the group, never a 1:1 DM to the joiner');
  assert.ok(!sent[0].text.includes('64211111111'), 'the joiner is never named or @-mentioned');
  assert.equal(handlerCalls, 0, 'zero agent/query turns for a static welcome post');
});

test('WhatsApp group welcome: a bulk add (multiple participants in one event) sends exactly one message', async () => {
  const adapter = new BaileysAdapter();
  const sent = stubSocketForGroupWelcome(adapter);

  await withWelcomeConfig({ enabled: true }, () =>
    fireGroupJoin(adapter, {
      id: 'group-3@g.us',
      participants: [
        '64211111111@s.whatsapp.net',
        '64222222222@s.whatsapp.net',
        '64233333333@s.whatsapp.net',
      ],
      action: 'add',
    }),
  );

  assert.equal(sent.length, 1);
});

test('WhatsApp group welcome: a second join to the same group inside the cooldown window sends no second message', async () => {
  const adapter = new BaileysAdapter();
  const sent = stubSocketForGroupWelcome(adapter);

  await withWelcomeConfig({ enabled: true }, async () => {
    await fireGroupJoin(adapter, {
      id: 'group-4@g.us',
      participants: ['64211111111@s.whatsapp.net'],
      action: 'add',
    });
    await fireGroupJoin(adapter, {
      id: 'group-4@g.us',
      participants: ['64222222222@s.whatsapp.net'],
      action: 'add',
    });
  });

  assert.equal(sent.length, 1, 'sequential joins within the cooldown window collapse into one message');
});

test('WhatsApp group welcome: respects WHATSAPP_ALLOWED_JIDS — a group outside the allowlist gets no message', async () => {
  const adapter = new BaileysAdapter();
  const sent = stubSocketForGroupWelcome(adapter);
  const allowedJids = config.whatsapp as unknown as { allowedJids: string[] };
  const prevJids = allowedJids.allowedJids;
  allowedJids.allowedJids = ['some-other-group@g.us'];

  try {
    await withWelcomeConfig({ enabled: true }, () =>
      fireGroupJoin(adapter, {
        id: 'not-allowed@g.us',
        participants: ['64211111111@s.whatsapp.net'],
        action: 'add',
      }),
    );
  } finally {
    allowedJids.allowedJids = prevJids;
  }

  assert.equal(sent.length, 0);
});

/**
 * Mocks pool.query so a `community_guidelines` policy read returns `value`
 * (or nothing, if omitted). `opts.welcomeMessage` similarly stubs the
 * `welcome_message` key (issue #253); `opts.throwFor` simulates a policy
 * read failure for the named key.
 */
function stubPoliciesQuery(
  value?: string,
  opts?: { welcomeMessage?: string; throwFor?: 'community_guidelines' | 'welcome_message' },
) {
  return async (sql: string, params?: unknown[]) => {
    if (!sql.includes('FROM policies')) return { rows: [], rowCount: 0 };
    const key = params?.[0];
    if (opts?.throwFor === key) throw new Error('simulated policy read failure');
    if (key === 'community_guidelines') {
      return value === undefined ? { rows: [], rowCount: 0 } : { rows: [{ value }], rowCount: 1 };
    }
    if (key === 'welcome_message') {
      return opts?.welcomeMessage === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ value: opts.welcomeMessage }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
}

test('WhatsApp group welcome: stays byte-identical to today when no guidelines are set (issue #212)', async (t) => {
  resetPolicyCacheForTests();
  t.mock.method(pool, 'query', stubPoliciesQuery());
  const adapter = new BaileysAdapter();
  const sent = stubSocketForGroupWelcome(adapter);

  await withWelcomeConfig({ enabled: true }, () =>
    fireGroupJoin(adapter, {
      id: 'group-guidelines-unset@g.us',
      participants: ['64211111111@s.whatsapp.net'],
      action: 'add',
    }),
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, WHATSAPP_GROUP_WELCOME_MESSAGE);
  resetPolicyCacheForTests();
});

test('WhatsApp group welcome: appends community guidelines verbatim when set (issue #212)', async (t) => {
  resetPolicyCacheForTests();
  const guidelines = 'Be respectful. No spam. Keep discussion on-topic.';
  t.mock.method(pool, 'query', stubPoliciesQuery(guidelines));
  const adapter = new BaileysAdapter();
  const sent = stubSocketForGroupWelcome(adapter);

  await withWelcomeConfig({ enabled: true }, () =>
    fireGroupJoin(adapter, {
      id: 'group-guidelines-set@g.us',
      participants: ['64211111111@s.whatsapp.net'],
      action: 'add',
    }),
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, `${WHATSAPP_GROUP_WELCOME_MESSAGE}\n\nCommunity guidelines:\n${guidelines}`);
  resetPolicyCacheForTests();
});

test('WhatsApp group welcome: uses the configured welcome message in place of the hardcoded default, guidelines still appended (issue #253)', async (t) => {
  resetPolicyCacheForTests();
  const welcomeMessage = 'Welcome to our community!';
  const guidelines = 'Be respectful. No spam.';
  t.mock.method(pool, 'query', stubPoliciesQuery(guidelines, { welcomeMessage }));
  const adapter = new BaileysAdapter();
  const sent = stubSocketForGroupWelcome(adapter);

  await withWelcomeConfig({ enabled: true }, () =>
    fireGroupJoin(adapter, {
      id: 'group-configured-welcome@g.us',
      participants: ['64211111111@s.whatsapp.net'],
      action: 'add',
    }),
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, `${welcomeMessage}\n\nCommunity guidelines:\n${guidelines}`);
  assert.ok(
    !sent[0].text.includes(WHATSAPP_GROUP_WELCOME_MESSAGE),
    'the hardcoded default must not appear once a value is configured',
  );
  resetPolicyCacheForTests();
});

test('SECURITY: WhatsApp group welcome falls back to the hardcoded default when the welcome_message policy read fails (issue #253)', async (t) => {
  resetPolicyCacheForTests();
  t.mock.method(pool, 'query', stubPoliciesQuery(undefined, { throwFor: 'welcome_message' }));
  const adapter = new BaileysAdapter();
  const sent = stubSocketForGroupWelcome(adapter);

  await withWelcomeConfig({ enabled: true }, () =>
    fireGroupJoin(adapter, {
      id: 'group-welcome-read-failure@g.us',
      participants: ['64211111111@s.whatsapp.net'],
      action: 'add',
    }),
  );

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].text,
    WHATSAPP_GROUP_WELCOME_MESSAGE,
    'a policy-read failure must fall back to the hardcoded default, never an empty or broken welcome',
  );
  resetPolicyCacheForTests();
});

// --- WhatsApp group-join welcome: access-mode-aware default text (issue #351) ---

/** Temporarily overrides config.rbac.accessMode.whatsapp for the duration of `fn`, then restores it. */
async function withAccessMode<T>(mode: 'gated' | 'open', fn: () => Promise<T>): Promise<T> {
  const prev = config.rbac.accessMode.whatsapp;
  config.rbac.accessMode.whatsapp = mode;
  try {
    return await fn();
  } finally {
    config.rbac.accessMode.whatsapp = prev;
  }
}

test(
  'WhatsApp group welcome: open access mode uses WHATSAPP_GROUP_WELCOME_MESSAGE_OPEN, which states no ' +
    'admin approval is needed and nudges "what can you do?" (issue #351)',
  async (t) => {
    resetPolicyCacheForTests();
    t.mock.method(pool, 'query', stubPoliciesQuery());
    const adapter = new BaileysAdapter();
    const sent = stubSocketForGroupWelcome(adapter);

    await withAccessMode('open', () =>
      withWelcomeConfig({ enabled: true }, () =>
        fireGroupJoin(adapter, {
          id: 'group-open-mode@g.us',
          participants: ['64211111111@s.whatsapp.net'],
          action: 'add',
        }),
      ),
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, WHATSAPP_GROUP_WELCOME_MESSAGE_OPEN);
    assert.ok(
      /no admin approval needed/i.test(sent[0].text),
      'open-mode default must state plainly that no admin approval is needed',
    );
    assert.ok(
      sent[0].text.includes('what can you do?'),
      'open-mode default must nudge the capability phrase',
    );
    resetPolicyCacheForTests();
  },
);

test(
  'SECURITY: WhatsApp group welcome gated-mode default text is byte-for-byte unchanged from ' +
    'WHATSAPP_GROUP_WELCOME_MESSAGE (issue #351)',
  async (t) => {
    resetPolicyCacheForTests();
    t.mock.method(pool, 'query', stubPoliciesQuery());
    const adapter = new BaileysAdapter();
    const sent = stubSocketForGroupWelcome(adapter);

    await withAccessMode('gated', () =>
      withWelcomeConfig({ enabled: true }, () =>
        fireGroupJoin(adapter, {
          id: 'group-gated-mode@g.us',
          participants: ['64211111111@s.whatsapp.net'],
          action: 'add',
        }),
      ),
    );

    assert.equal(sent.length, 1);
    assert.equal(
      sent[0].text,
      WHATSAPP_GROUP_WELCOME_MESSAGE,
      'gated mode must send the existing default, byte-for-byte unchanged',
    );
    resetPolicyCacheForTests();
  },
);

test('WhatsApp group welcome: an admin-configured welcome message overrides the open-mode default too (issue #351)', async (t) => {
  resetPolicyCacheForTests();
  const welcomeMessage = 'Custom welcome for our open-mode group!';
  t.mock.method(pool, 'query', stubPoliciesQuery(undefined, { welcomeMessage }));
  const adapter = new BaileysAdapter();
  const sent = stubSocketForGroupWelcome(adapter);

  await withAccessMode('open', () =>
    withWelcomeConfig({ enabled: true }, () =>
      fireGroupJoin(adapter, {
        id: 'group-open-mode-custom@g.us',
        participants: ['64211111111@s.whatsapp.net'],
        action: 'add',
      }),
    ),
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, welcomeMessage);
  assert.ok(
    !sent[0].text.includes(WHATSAPP_GROUP_WELCOME_MESSAGE_OPEN),
    'the open-mode hardcoded default must not appear once an admin override is configured',
  );
  resetPolicyCacheForTests();
});

test('WhatsApp group welcome: community guidelines are appended identically to the open-mode default (issue #351)', async (t) => {
  resetPolicyCacheForTests();
  const guidelines = 'Be respectful. No spam. Keep discussion on-topic.';
  t.mock.method(pool, 'query', stubPoliciesQuery(guidelines));
  const adapter = new BaileysAdapter();
  const sent = stubSocketForGroupWelcome(adapter);

  await withAccessMode('open', () =>
    withWelcomeConfig({ enabled: true }, () =>
      fireGroupJoin(adapter, {
        id: 'group-open-mode-guidelines@g.us',
        participants: ['64211111111@s.whatsapp.net'],
        action: 'add',
      }),
    ),
  );

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].text,
    `${WHATSAPP_GROUP_WELCOME_MESSAGE_OPEN}\n\nCommunity guidelines:\n${guidelines}`,
  );
  resetPolicyCacheForTests();
});

test('SECURITY: WHATSAPP_GROUP_WELCOME_MESSAGE_OPEN carries no participant-supplied data (issue #351)', async (t) => {
  resetPolicyCacheForTests();
  t.mock.method(pool, 'query', stubPoliciesQuery());
  const adapter = new BaileysAdapter();
  const sent = stubSocketForGroupWelcome(adapter);

  await withAccessMode('open', () =>
    withWelcomeConfig({ enabled: true }, () =>
      fireGroupJoin(adapter, {
        id: 'group-open-mode-injection-check@g.us',
        participants: ['64211111111@s.whatsapp.net'],
        action: 'add',
      }),
    ),
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, WHATSAPP_GROUP_WELCOME_MESSAGE_OPEN);
  assert.ok(
    !sent[0].text.includes('64211111111'),
    'the open-mode default must never interpolate the joining participant JID',
  );
  resetPolicyCacheForTests();
});

for (const action of ['remove', 'promote', 'demote']) {
  test(`WhatsApp group welcome: non-"add" action "${action}" produces no message`, async () => {
    const adapter = new BaileysAdapter();
    const sent = stubSocketForGroupWelcome(adapter);

    await withWelcomeConfig({ enabled: true }, () =>
      fireGroupJoin(adapter, { id: 'group-5@g.us', participants: ['64211111111@s.whatsapp.net'], action }),
    );

    assert.equal(sent.length, 0);
  });
}

// --- WhatsApp roster tracking (issue #407) ----------------------------------

/**
 * Captures every pool.query call into `calls`, returning a generic success
 * response, so server_roster/interactions writes can be asserted without a
 * real DB — mirrors stubPoliciesQuery above and stubRejoinQueries in
 * tests/discordAdapter.test.ts.
 */
function rosterQueryRecorder(calls: Array<{ sql: string; params?: unknown[] }>) {
  return async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    return { rows: [], rowCount: 1 };
  };
}

test('group-participants.update "add" upserts a server_roster row for each participant (issue #407)', async (t) => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  t.mock.method(pool, 'query', rosterQueryRecorder(calls));
  const adapter = new BaileysAdapter();

  await fireGroupJoin(adapter, {
    id: 'group-407-add@g.us',
    participants: ['64211111111@s.whatsapp.net', '64222222222@s.whatsapp.net'],
    action: 'add',
  });

  const inserts = calls.filter((c) => c.sql.includes('INSERT INTO server_roster'));
  assert.equal(inserts.length, 2, 'one upsert per participant in the add event');
  assert.deepEqual(
    inserts.map((c) => c.params).sort((a, b) => String(a?.[1]).localeCompare(String(b?.[1]))),
    [
      ['whatsapp', '64211111111', null],
      ['whatsapp', '64222222222', null],
    ],
    'each upsert is platform "whatsapp", the bare local-part userId, and no display name (Baileys carries none here)',
  );
});

test("SECURITY: group-participants.update never roster-tracks the bot's own number or LID, on add or remove (issue #407)", async (t) => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  t.mock.method(pool, 'query', rosterQueryRecorder(calls));
  const adapter = new BaileysAdapter();
  (adapter as unknown as { botNumber: string; botLid: string }).botNumber = '64299999999';
  (adapter as unknown as { botNumber: string; botLid: string }).botLid = '11111';

  await fireGroupJoin(adapter, {
    id: 'group-407-bot-add@g.us',
    participants: ['64299999999@s.whatsapp.net', '11111@lid', '64211111111@s.whatsapp.net'],
    action: 'add',
  });
  await fireGroupJoin(adapter, {
    id: 'group-407-bot-remove@g.us',
    participants: ['64299999999@s.whatsapp.net', '11111@lid', '64211111111@s.whatsapp.net'],
    action: 'remove',
  });

  const rosterWrites = calls.filter((c) => c.sql.includes('server_roster'));
  assert.equal(rosterWrites.length, 2, 'exactly one add-upsert and one remove-mark, both for the non-bot id');
  for (const write of rosterWrites) {
    assert.equal(write.params?.[1], '64211111111');
  }
});

test('group-participants.update "remove" marks the participant left in server_roster AND still invalidates the membership cache (issue #407)', async (t) => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  t.mock.method(pool, 'query', rosterQueryRecorder(calls));
  const adapter = new BaileysAdapter();
  const fetchCalls = stubConversationsSocket(adapter, ['64211111111']);
  await adapter.conversationsForUser('64211111111');
  assert.equal(fetchCalls.groupFetch, 1, 'precondition: first lookup is a cache miss');

  await fireGroupJoin(adapter, {
    id: 'group-286@g.us',
    participants: ['64211111111@s.whatsapp.net'],
    action: 'remove',
  });

  const updates = calls.filter((c) => c.sql.includes('UPDATE server_roster'));
  assert.equal(updates.length, 1, 'the remove event marks the roster row left');
  assert.deepEqual(updates[0].params, ['whatsapp', '64211111111']);

  await adapter.conversationsForUser('64211111111');
  assert.equal(
    fetchCalls.groupFetch,
    2,
    'the existing membership-cache invalidation (issue #286) still fires alongside the new roster leave-mark, not replaced by it',
  );
});

test('roster recording fires with WHATSAPP_WELCOME_ENABLED off (issue #407)', async (t) => {
  assert.equal(config.whatsapp.welcome.enabled, false, 'precondition: default env has the flag off');
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  t.mock.method(pool, 'query', rosterQueryRecorder(calls));
  const adapter = new BaileysAdapter();

  await fireGroupJoin(adapter, {
    id: 'group-407-flag-off@g.us',
    participants: ['64211111111@s.whatsapp.net'],
    action: 'add',
  });

  assert.equal(calls.filter((c) => c.sql.includes('INSERT INTO server_roster')).length, 1);
});

test('roster recording still fires identically with WHATSAPP_WELCOME_ENABLED on (issue #407)', async (t) => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  t.mock.method(pool, 'query', rosterQueryRecorder(calls));
  const adapter = new BaileysAdapter();
  stubSocketForGroupWelcome(adapter);

  await withWelcomeConfig({ enabled: true }, () =>
    fireGroupJoin(adapter, {
      id: 'group-407-flag-on@g.us',
      participants: ['64211111111@s.whatsapp.net'],
      action: 'add',
    }),
  );

  assert.equal(
    calls.filter((c) => c.sql.includes('INSERT INTO server_roster')).length,
    1,
    'roster recording is independent of the welcome flag, mirroring Discord never depending on DISCORD_WELCOME_ENABLED',
  );
});

test('SECURITY: with WHATSAPP_ALLOWED_JIDS set, an add or remove event for a group outside the allowlist writes zero server_roster rows (issue #407)', async (t) => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  t.mock.method(pool, 'query', rosterQueryRecorder(calls));
  const allowedJids = config.whatsapp as unknown as { allowedJids: string[] };
  const prevJids = allowedJids.allowedJids;
  allowedJids.allowedJids = ['some-other-group@g.us'];

  try {
    const adapter = new BaileysAdapter();
    await fireGroupJoin(adapter, {
      id: 'not-allowed-407@g.us',
      participants: ['64211111111@s.whatsapp.net'],
      action: 'add',
    });
    await fireGroupJoin(adapter, {
      id: 'not-allowed-407@g.us',
      participants: ['64211111111@s.whatsapp.net'],
      action: 'remove',
    });
  } finally {
    allowedJids.allowedJids = prevJids;
  }

  const rosterWrites = calls.filter((c) => c.sql.includes('server_roster'));
  assert.equal(
    rosterWrites.length,
    0,
    'roster identity data must never be collected for a group outside the operator-configured scope',
  );
});

test('SECURITY: neither the add nor the remove roster path ever writes to interactions (issue #407)', async (t) => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  t.mock.method(pool, 'query', rosterQueryRecorder(calls));
  const adapter = new BaileysAdapter();

  await fireGroupJoin(adapter, {
    id: 'group-407-add-interactions@g.us',
    participants: ['64211111111@s.whatsapp.net'],
    action: 'add',
  });
  await fireGroupJoin(adapter, {
    id: 'group-407-remove-interactions@g.us',
    participants: ['64211111111@s.whatsapp.net'],
    action: 'remove',
  });

  const interactionWrites = calls.filter((c) => c.sql.includes('interactions'));
  assert.equal(interactionWrites.length, 0, 'no roster code path ever opens a message-content write path');
});

/** Reaches the private backfillRoster handler directly. */
function fireBackfillRoster(adapter: InstanceType<typeof BaileysAdapter>): Promise<void> {
  return (adapter as unknown as { backfillRoster: () => Promise<void> }).backfillRoster();
}

/** Stubs the socket's groupFetchAllParticipating for backfillRoster tests. */
function stubGroupsSocket(
  adapter: InstanceType<typeof BaileysAdapter>,
  groups: Record<string, { participants: { id: string }[] }>,
) {
  (
    adapter as unknown as {
      sock: { groupFetchAllParticipating: () => Promise<Record<string, { participants: { id: string }[] }>> };
    }
  ).sock = { groupFetchAllParticipating: async () => groups };
}

test('WhatsApp roster startup backfill idempotently upserts every participant of every currently-participating group, excluding the bot (issue #407)', async (t) => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  t.mock.method(pool, 'query', rosterQueryRecorder(calls));
  const adapter = new BaileysAdapter();
  (adapter as unknown as { botNumber: string }).botNumber = '64299999999';
  stubGroupsSocket(adapter, {
    'group-a@g.us': {
      participants: [{ id: '64211111111@s.whatsapp.net' }, { id: '64299999999@s.whatsapp.net' }],
    },
    'group-b@g.us': { participants: [{ id: '64222222222@s.whatsapp.net' }] },
  });

  await fireBackfillRoster(adapter);
  const inserts = calls.filter((c) => c.sql.includes('INSERT INTO server_roster'));
  assert.equal(inserts.length, 2, 'two non-bot participants across both groups; the bot itself is excluded');
  assert.deepEqual(inserts.map((c) => c.params?.[1]).sort(), ['64211111111', '64222222222']);

  calls.length = 0;
  await fireBackfillRoster(adapter);
  const secondInserts = calls.filter((c) => c.sql.includes('INSERT INTO server_roster'));
  assert.equal(
    secondInserts.length,
    2,
    'running the backfill twice re-upserts the same participants — upsertRosterMember is idempotent, so no rows accumulate',
  );
});

test('WhatsApp roster startup backfill respects WHATSAPP_ALLOWED_JIDS, skipping out-of-scope groups (issue #407)', async (t) => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  t.mock.method(pool, 'query', rosterQueryRecorder(calls));
  const allowedJids = config.whatsapp as unknown as { allowedJids: string[] };
  const prevJids = allowedJids.allowedJids;
  allowedJids.allowedJids = ['group-a@g.us'];

  try {
    const adapter = new BaileysAdapter();
    stubGroupsSocket(adapter, {
      'group-a@g.us': { participants: [{ id: '64211111111@s.whatsapp.net' }] },
      'group-b@g.us': { participants: [{ id: '64222222222@s.whatsapp.net' }] },
    });
    await fireBackfillRoster(adapter);
  } finally {
    allowedJids.allowedJids = prevJids;
  }

  const inserts = calls.filter((c) => c.sql.includes('INSERT INTO server_roster'));
  assert.equal(inserts.length, 1, 'only the allowed group contributes backfill rows');
  assert.equal(inserts[0].params?.[1], '64211111111');
});

test('WhatsApp roster startup backfill degrades to a warning log on failure, never crashing (issue #407)', async () => {
  const adapter = new BaileysAdapter();
  (adapter as unknown as { sock: { groupFetchAllParticipating: () => Promise<never> } }).sock = {
    groupFetchAllParticipating: async () => {
      throw new Error('simulated fetch failure');
    },
  };
  await assert.doesNotReject(() => fireBackfillRoster(adapter));
});

test('stepWelcomeCooldown: sends on first contact for a group, then suppresses within the window', () => {
  let state = initialWelcomeCooldownState();
  const first = stepWelcomeCooldown(state, 'g@g.us', 1_000, 60_000);
  assert.equal(first.shouldSend, true);
  state = first.state;

  const second = stepWelcomeCooldown(state, 'g@g.us', 1_000 + 30_000, 60_000);
  assert.equal(second.shouldSend, false, 'still inside the 60s window');
});

test('stepWelcomeCooldown: re-arms once `now` reaches the cooldown boundary', () => {
  let state = initialWelcomeCooldownState();
  ({ state } = stepWelcomeCooldown(state, 'g@g.us', 1_000, 60_000));

  const after = stepWelcomeCooldown(state, 'g@g.us', 1_000 + 60_000, 60_000);
  assert.equal(after.shouldSend, true, 'at/after the cooldown boundary the latch re-arms');
});

test('stepWelcomeCooldown: different groups have independent cooldowns', () => {
  let state = initialWelcomeCooldownState();
  ({ state } = stepWelcomeCooldown(state, 'g1@g.us', 1_000, 60_000));

  const other = stepWelcomeCooldown(state, 'g2@g.us', 1_000, 60_000);
  assert.equal(other.shouldSend, true, "a fresh group is unaffected by another group's cooldown");
});

// --------------------------------------------------------------------------
// Voice notes (super-admin only). The security-critical invariant is that a
// non-super-admin, a disabled feature, or an over-length note is dropped
// BEFORE any media is fetched or transcribed. The download+Whisper step is
// isolated behind the private `transcribeAudioMessage` seam, overridden here
// so the gate runs for real without a WhatsApp fetch or a model download.
// --------------------------------------------------------------------------

type VoiceAdapter = InstanceType<typeof BaileysAdapter> & {
  onWhatsappMessage: (m: unknown) => Promise<void>;
  transcribeAudioMessage: (m: unknown, seconds: number) => Promise<string>;
};

/** A DM voice note (audioMessage, ptt) from `fromNumber`. isDirect => addressed. */
function voiceDm(fromNumber: string, seconds = 5): unknown {
  return {
    key: { remoteJid: `${fromNumber}@s.whatsapp.net`, fromMe: false, id: 'VOICEMSG1' },
    pushName: 'Tester',
    messageTimestamp: 1_700_000_000,
    message: { audioMessage: { seconds, ptt: true, mimetype: 'audio/ogg; codecs=opus' } },
  };
}

/** Overrides config.whatsapp.voice + the super-admin allowlist for `fn`, then restores. */
async function withVoice(
  opts: { enabled?: boolean; maxSeconds?: number; superAdmins?: string[] },
  fn: () => Promise<void>,
): Promise<void> {
  const voice = config.whatsapp.voice as { enabled: boolean; model: string; maxSeconds: number };
  const rbac = config.rbac as { superAdminWhatsappNumbers: readonly string[] };
  const prevVoice = { ...voice };
  const prevAdmins = rbac.superAdminWhatsappNumbers;
  if (opts.enabled !== undefined) voice.enabled = opts.enabled;
  if (opts.maxSeconds !== undefined) voice.maxSeconds = opts.maxSeconds;
  if (opts.superAdmins) rbac.superAdminWhatsappNumbers = opts.superAdmins;
  try {
    await fn();
  } finally {
    Object.assign(voice, prevVoice);
    rbac.superAdminWhatsappNumbers = prevAdmins;
  }
}

test('SECURITY: a voice note from a non-super-admin is dropped — never downloaded, transcribed, or actioned', async () => {
  const adapter = new BaileysAdapter() as VoiceAdapter;
  let handlerCalls = 0;
  adapter.onMessage(async () => {
    handlerCalls += 1;
  });
  // The seam must never be reached for a non-super-admin — make it explode if it is.
  adapter.transcribeAudioMessage = async () => {
    throw new Error('non-super-admin voice note must never be downloaded/transcribed');
  };
  await withVoice({ enabled: true, superAdmins: ['64990000000'] }, () =>
    adapter.onWhatsappMessage(voiceDm('64211234567')),
  );
  assert.equal(handlerCalls, 0, 'a non-super-admin voice note must not reach the agent');
});

test('SECURITY: voice transcription is off by default — a super-admin voice note is dropped when WHATSAPP_VOICE_ENABLED is unset', async () => {
  assert.equal(config.whatsapp.voice.enabled, false, 'precondition: default env has voice off');
  const adapter = new BaileysAdapter() as VoiceAdapter;
  let handlerCalls = 0;
  adapter.onMessage(async () => {
    handlerCalls += 1;
  });
  adapter.transcribeAudioMessage = async () => {
    throw new Error('voice must not be transcribed while the feature flag is off');
  };
  // Sender IS a super admin — proving it is the flag, not the tier, that blocks.
  await withVoice({ superAdmins: ['64211234567'] }, () => adapter.onWhatsappMessage(voiceDm('64211234567')));
  assert.equal(handlerCalls, 0);
});

test('SECURITY: a voice note longer than WHATSAPP_VOICE_MAX_SECONDS is ignored without downloading or transcribing', async () => {
  const adapter = new BaileysAdapter() as VoiceAdapter;
  let handlerCalls = 0;
  adapter.onMessage(async () => {
    handlerCalls += 1;
  });
  let seamCalls = 0;
  adapter.transcribeAudioMessage = async () => {
    seamCalls += 1;
    return 'should never run';
  };
  await withVoice({ enabled: true, maxSeconds: 60, superAdmins: ['64211234567'] }, () =>
    adapter.onWhatsappMessage(voiceDm('64211234567', 120)),
  );
  assert.equal(seamCalls, 0, 'an over-cap note must be rejected before any download/transcribe');
  assert.equal(handlerCalls, 0);
});

test('WhatsApp voice: an enabled super-admin voice note is transcribed and actioned as if typed', async () => {
  const adapter = new BaileysAdapter() as VoiceAdapter;
  let seen: IncomingMessage | null = null;
  adapter.onMessage(async (m) => {
    seen = m;
  });
  adapter.transcribeAudioMessage = async () => 'what is the member count';
  await withVoice({ enabled: true, maxSeconds: 120, superAdmins: ['64211234567'] }, () =>
    adapter.onWhatsappMessage(voiceDm('64211234567', 8)),
  );
  assert.ok(seen, 'the transcript must reach the handler');
  const msg = seen as unknown as IncomingMessage;
  assert.equal(msg.text, 'what is the member count', 'the transcript becomes the message text');
  assert.equal(msg.userId, '64211234567', 'identity stays the platform-envelope sender');
  assert.equal(msg.platform, 'whatsapp');
  assert.equal(msg.isDirect, true);
});

test(
  'SECURITY: BaileysAdapter does not implement canPostTo — WhatsApp keeps isKnownConversation as its ' +
    'sole reachability gate, since any phone number is dialable (issue #270)',
  () => {
    const adapter = new BaileysAdapter();
    assert.equal(adapter.canPostTo, undefined);
  },
);

// --- group-participants.update 'remove': membership-scope cache invalidation (issue #286) ---

/**
 * Stubs the socket's groupFetchAllParticipating for conversationsForUser's
 * cache-miss path, counting how many times it actually runs so tests can
 * assert a cache hit vs. a live re-fetch. Every configured member is placed
 * in the same single group.
 */
function stubConversationsSocket(adapter: InstanceType<typeof BaileysAdapter>, memberIds: string[]) {
  const calls = { groupFetch: 0 };
  const participants = memberIds.map((id) => ({ id: `${id}@s.whatsapp.net` }));
  (
    adapter as unknown as {
      sock: { groupFetchAllParticipating: () => Promise<Record<string, { participants: unknown[] }>> };
    }
  ).sock = {
    groupFetchAllParticipating: async () => {
      calls.groupFetch += 1;
      return { 'group-286@g.us': { participants } };
    },
  };
  return calls;
}

test(
  "group-participants.update 'remove' invalidates the removed participant's membershipCache entry — " +
    'the next conversationsForUser call re-fetches instead of returning the stale cached list',
  async () => {
    const adapter = new BaileysAdapter();
    const calls = stubConversationsSocket(adapter, ['64211111111']);

    const first = await adapter.conversationsForUser('64211111111');
    assert.deepEqual(first, ['64211111111@s.whatsapp.net', 'group-286@g.us']);
    assert.equal(calls.groupFetch, 1, 'first call is a cache miss and must hit groupFetchAllParticipating');

    const cached = await adapter.conversationsForUser('64211111111');
    assert.deepEqual(cached, first);
    assert.equal(calls.groupFetch, 1, 'second call within the TTL must be served from cache, not re-fetched');

    await fireGroupJoin(adapter, {
      id: 'group-286@g.us',
      participants: ['64211111111@s.whatsapp.net'],
      action: 'remove',
    });

    await adapter.conversationsForUser('64211111111');
    assert.equal(
      calls.groupFetch,
      2,
      "a 'remove' event for this participant must invalidate the cache so the next lookup re-fetches live",
    );
  },
);

test(
  "SECURITY: group-participants.update 'remove' cache invalidation is targeted — a different, still-cached " +
    "participant's membershipCache entry survives untouched (issue #286)",
  async () => {
    const adapter = new BaileysAdapter();
    const calls = stubConversationsSocket(adapter, ['64211111111', '64222222222']);

    await adapter.conversationsForUser('64211111111');
    await adapter.conversationsForUser('64222222222');
    assert.equal(calls.groupFetch, 2, 'two distinct users each cause one cache-miss fetch');

    await fireGroupJoin(adapter, {
      id: 'group-286@g.us',
      participants: ['64211111111@s.whatsapp.net'],
      action: 'remove',
    });

    await adapter.conversationsForUser('64222222222');
    assert.equal(
      calls.groupFetch,
      2,
      "the other participant's still-live cache entry must be untouched — zero additional fetches",
    );
  },
);

test(
  'SECURITY: the WhatsApp JID normalization never false-positive-deletes a similarly-shaped-but-different ' +
    'cached id (issue #286)',
  async () => {
    const adapter = new BaileysAdapter();
    // '6421111111' (cached) vs '64211111111' (removed) differ only by one
    // digit — an exact-match normalization must not conflate them.
    const calls = stubConversationsSocket(adapter, ['6421111111']);

    await adapter.conversationsForUser('6421111111');
    assert.equal(calls.groupFetch, 1);

    await fireGroupJoin(adapter, {
      id: 'group-286@g.us',
      participants: ['64211111111@s.whatsapp.net'],
      action: 'remove',
    });

    await adapter.conversationsForUser('6421111111');
    assert.equal(
      calls.groupFetch,
      1,
      'a removal for a different, similarly-shaped id must not evict an unrelated cache entry',
    );
  },
);

test(
  "group-participants.update 'remove' does not send a welcome message, and 'add' welcome behavior is " +
    'unchanged by the new invalidation logic (regression, issue #286)',
  async () => {
    const adapter = new BaileysAdapter();
    const sent = stubSocketForGroupWelcome(adapter);

    await withWelcomeConfig({ enabled: true }, async () => {
      await fireGroupJoin(adapter, {
        id: 'group-286-welcome@g.us',
        participants: ['64211111111@s.whatsapp.net'],
        action: 'remove',
      });
      assert.equal(sent.length, 0, "a 'remove' event must never trigger the welcome message");

      await fireGroupJoin(adapter, {
        id: 'group-286-welcome@g.us',
        participants: ['64222222222@s.whatsapp.net'],
        action: 'add',
      });
    });

    assert.equal(sent.length, 1, "the 'add' welcome path still fires exactly as before");
  },
);

test(
  "group-participants.update 'remove' carrying an @lid JID invalidates the lid-keyed membershipCache entry " +
    'for the same person (issue #286)',
  async () => {
    const adapter = new BaileysAdapter();
    const calls = stubConversationsSocket(adapter, ['64211111111']);

    await adapter.conversationsForUser('lid:9999');
    assert.equal(calls.groupFetch, 1, 'first call is a cache miss and must hit groupFetchAllParticipating');

    await fireGroupJoin(adapter, {
      id: 'group-286@g.us',
      participants: ['9999@lid'],
      action: 'remove',
    });

    await adapter.conversationsForUser('lid:9999');
    assert.equal(
      calls.groupFetch,
      2,
      "a 'remove' event carrying this participant's @lid JID must invalidate the lid-keyed cache entry",
    );
  },
);

test(
  "SECURITY: a 'remove' event carrying only an @lid JID cannot invalidate a phone-number-keyed " +
    'membershipCache entry for the same real person when NO prior group message ever taught the ' +
    'LID->phone mapping — the removal event itself carries no phone number, so that entry survives ' +
    'the full TTL (narrowed residual-window gap, SECURITY.md "Membership-scope staleness", issues #286 + #374)',
  async () => {
    const adapter = new BaileysAdapter();
    const calls = stubConversationsSocket(adapter, ['64211111111']);

    // Two entries for the SAME real person: one resolved (elsewhere) to
    // their real phone number, one to their otherwise-unresolvable LID.
    // Seeded directly via conversationsForUser (never via a group message),
    // so `lidToPhone` never learns this pairing — the case #374 leaves open.
    await adapter.conversationsForUser('64211111111');
    await adapter.conversationsForUser('lid:9999');
    assert.equal(calls.groupFetch, 2, 'two distinct cache keys each cause one cache-miss fetch');

    await fireGroupJoin(adapter, {
      id: 'group-286@g.us',
      participants: ['9999@lid'],
      action: 'remove',
    });

    await adapter.conversationsForUser('lid:9999');
    assert.equal(calls.groupFetch, 3, 'the lid-keyed entry is invalidated as expected');

    await adapter.conversationsForUser('64211111111');
    assert.equal(
      calls.groupFetch,
      3,
      'the phone-number-keyed entry for the same person must NOT be invalidated by an @lid-only removal ' +
        'event when no prior message ever taught the mapping — this is the narrowed, still-documented gap',
    );
  },
);

// --- LID->phone opportunistic mapping closes the above gap (issue #374) ---

/**
 * Fires an incoming WhatsApp GROUP text message through the private
 * `onWhatsappMessage` handler, mirroring how `voiceDm`/`fireGroupJoin` reach
 * other private adapter internals in this file. A handler must already be
 * registered via `adapter.onMessage` — `onWhatsappMessage` returns early
 * without one, same as production wiring.
 */
function fireGroupMessage(
  adapter: InstanceType<typeof BaileysAdapter>,
  opts: { groupJid: string; participant: string; participantPn?: string; id?: string },
) {
  const msg = {
    key: {
      remoteJid: opts.groupJid,
      participant: opts.participant,
      participantPn: opts.participantPn,
      fromMe: false,
      id: opts.id ?? 'MSG-374',
    },
    pushName: 'Tester',
    messageTimestamp: 1_700_000_000,
    message: { conversation: 'hello' },
  };
  return (adapter as unknown as { onWhatsappMessage: (m: unknown) => Promise<void> }).onWhatsappMessage(msg);
}

test(
  "SECURITY: a 'remove' event carrying only an @lid JID now invalidates BOTH the lid-keyed AND the " +
    'phone-number-keyed membershipCache entry for the same person, once a prior group message has taught ' +
    'the LID->phone mapping (issue #374, closes the residual gap pinned above)',
  async () => {
    const adapter = new BaileysAdapter();
    const calls = stubConversationsSocket(adapter, ['64211111111']);
    adapter.onMessage(async () => {});

    await adapter.conversationsForUser('64211111111');
    await adapter.conversationsForUser('lid:9999');
    assert.equal(calls.groupFetch, 2, 'two distinct cache keys each cause one cache-miss fetch');

    // A prior group message from this participant, routed by LID, resolving
    // a real phone number — exactly what resolveSenderId sees on the hot path.
    await fireGroupMessage(adapter, {
      groupJid: 'group-374@g.us',
      participant: '9999@lid',
      participantPn: '64211111111@s.whatsapp.net',
    });

    await fireGroupJoin(adapter, {
      id: 'group-374@g.us',
      participants: ['9999@lid'],
      action: 'remove',
    });

    await adapter.conversationsForUser('lid:9999');
    assert.equal(calls.groupFetch, 3, 'the lid-keyed entry is invalidated as before');

    await adapter.conversationsForUser('64211111111');
    assert.equal(
      calls.groupFetch,
      4,
      'the phone-number-keyed entry for the same person is now ALSO invalidated by the @lid-only removal, ' +
        'because a prior message taught the LID->phone mapping',
    );
  },
);

test(
  'SECURITY: a LID->phone mapping learned for participant A is never consulted when invalidating a ' +
    "'remove' naming only participant B's @lid — B's own phone-keyed entry survives, and A's mapping is " +
    'not corrupted or wrongly consumed by the unrelated event (issue #374)',
  async () => {
    const adapter = new BaileysAdapter();
    const calls = stubConversationsSocket(adapter, ['64211111111', '64222222222']);
    adapter.onMessage(async () => {});

    // Only A (lid 9999 / phone 64211111111) is ever taught a mapping.
    await fireGroupMessage(adapter, {
      groupJid: 'group-374b@g.us',
      participant: '9999@lid',
      participantPn: '64211111111@s.whatsapp.net',
    });

    await adapter.conversationsForUser('64211111111');
    await adapter.conversationsForUser('64222222222');
    assert.equal(calls.groupFetch, 2, 'two distinct users each cause one cache-miss fetch');

    // Remove event names only B's (never-taught) @lid.
    await fireGroupJoin(adapter, {
      id: 'group-374b@g.us',
      participants: ['8888@lid'],
      action: 'remove',
    });

    await adapter.conversationsForUser('64222222222');
    assert.equal(
      calls.groupFetch,
      2,
      "B's phone-keyed entry must survive — B's lid was never taught a mapping, and A's mapping must not " +
        'be misapplied to an unrelated removal',
    );

    // A's own mapping must still be intact and usable afterwards — proving
    // the unrelated B removal above didn't corrupt or consume it.
    await fireGroupJoin(adapter, {
      id: 'group-374b@g.us',
      participants: ['9999@lid'],
      action: 'remove',
    });
    await adapter.conversationsForUser('64211111111');
    assert.equal(
      calls.groupFetch,
      3,
      "A's phone-keyed entry is invalidated once A's own removal event fires, proving A's mapping " +
        "survived B's unrelated removal untouched",
    );
  },
);

test(
  "lidToPhone entries are consumed once: a second identical 'remove' event for the same " +
    'already-departed participant is a no-op, not a lingering mapping that mis-fires later (issue #374)',
  async () => {
    const adapter = new BaileysAdapter();
    const calls = stubConversationsSocket(adapter, ['64211111111']);
    adapter.onMessage(async () => {});

    await fireGroupMessage(adapter, {
      groupJid: 'group-374c@g.us',
      participant: '9999@lid',
      participantPn: '64211111111@s.whatsapp.net',
    });

    await adapter.conversationsForUser('64211111111');
    assert.equal(calls.groupFetch, 1);

    await fireGroupJoin(adapter, {
      id: 'group-374c@g.us',
      participants: ['9999@lid'],
      action: 'remove',
    });

    // Re-cache a FRESH entry for the same phone number after the invalidation above.
    await adapter.conversationsForUser('64211111111');
    assert.equal(calls.groupFetch, 2, 'the mapping consumed above invalidated the entry; this re-fetches it');

    // A second, identical removal event for the same (already-departed) participant.
    await fireGroupJoin(adapter, {
      id: 'group-374c@g.us',
      participants: ['9999@lid'],
      action: 'remove',
    });

    await adapter.conversationsForUser('64211111111');
    assert.equal(
      calls.groupFetch,
      2,
      'the freshly re-cached entry must survive the duplicate removal — the mapping was already consumed ' +
        'by the first removal, so there is nothing left to (mis-)invalidate a second time',
    );
  },
);

test(
  'SECURITY: learning a LID->phone mapping from a group message never creates, extends, or otherwise ' +
    'touches a membershipCache entry — the mapping is consulted ONLY at invalidation time, never to grant ' +
    'or widen scope (issue #374)',
  async () => {
    const adapter = new BaileysAdapter();
    const calls = stubConversationsSocket(adapter, ['64211111111']);
    adapter.onMessage(async () => {});

    await fireGroupMessage(adapter, {
      groupJid: 'group-374d@g.us',
      participant: '9999@lid',
      participantPn: '64211111111@s.whatsapp.net',
    });

    const membershipCache = (adapter as unknown as { membershipCache: Map<string, unknown> }).membershipCache;
    assert.equal(
      membershipCache.size,
      0,
      'learning the mapping must not itself create a membershipCache entry for anyone',
    );
    assert.equal(
      calls.groupFetch,
      0,
      'learning the mapping must never trigger a live group fetch on its own',
    );
  },
);

test(
  'list_events reports the standard unsupported-on-whatsapp reply on the real Baileys adapter, which ' +
    'implements no scheduled-events primitive — mirrors the sendImage/reactToMessage unsupported-platform ' +
    'pattern (issue #388)',
  async () => {
    const adapter = new BaileysAdapter();
    assert.equal(
      adapter.listUpcomingEvents,
      undefined,
      'BaileysAdapter must not implement listUpcomingEvents — Discord-only capability',
    );
    const server = buildToolServer(
      {
        platform: 'whatsapp',
        userId: 'member-1',
        userName: 'Member',
        role: 'member',
        conversationId: '64211234567@s.whatsapp.net',
        isDirect: true,
      },
      adapter,
    );
    const registeredTool = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          { handler: () => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }
        >;
      }
    )._registeredTools['list_events'];
    const result = await registeredTool.handler();
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /not available|aren't available/i);
  },
);
