import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it. DATABASE_URL
// points nowhere; policy reads fail and fall back to defaults (see
// src/storage/policies.ts), so no real DB is needed for this adapter-level
// test.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { BaileysAdapter, initialWelcomeCooldownState, stepWelcomeCooldown } =
  await import('../src/platforms/whatsapp/baileysAdapter.js');
const { config } = await import('../src/config.js');

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
