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

const { BaileysAdapter, initialWelcomeCooldownState, stepWelcomeCooldown, WHATSAPP_GROUP_WELCOME_MESSAGE } =
  await import('../src/platforms/whatsapp/baileysAdapter.js');
const { config } = await import('../src/config.js');
const { pool } = await import('../src/storage/db.js');
const { resetPolicyCacheForTests } = await import('../src/storage/policies.js');

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
