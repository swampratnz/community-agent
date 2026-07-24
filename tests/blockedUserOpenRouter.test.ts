import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Router-level test for issue #572's headline claim: on `open` access mode,
// `remove_member`/community_users membership genuinely cannot stop a sender
// (an open-mode guest has no membership row to remove — router.ts's `gated`
// branch is the only place that ever consults role for a guest, and it's
// skipped entirely in open mode). This file pins that the new block check
// closes exactly that gap, using a DEDICATED file (rather than a case inside
// blockedUserGatedRouter.test.ts) because ACCESS_MODE_WHATSAPP is read by
// config.ts at import time and fixed for the life of the process — same
// rationale as autoAnswerGatedRouter.test.ts living apart from
// autoAnswerRouter.test.ts. DATABASE_URL stays an unreachable dummy: every
// real DB read on this path (resolveRole's getMemberRole, checkPaused,
// countReplies) is `.catch()`-guarded to degrade gracefully (see
// tests/router.test.ts's own header comment), and `checkBlocked` itself is
// DI'd so this file never depends on a live Postgres either.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.ACCESS_MODE_WHATSAPP ??= 'open';

const { Router } = await import('../src/router.js');

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): {
  adapter: PlatformAdapter;
  sent: OutgoingMessage[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const adapter: PlatformAdapter = {
    platform: 'whatsapp',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage(h) {
      handler = h;
    },
    async sendMessage(out) {
      sent.push(out);
    },
    async sendDirectMessage() {},
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
    ...overrides,
  };
  return {
    adapter,
    sent,
    trigger: async (msg) => {
      if (!handler) throw new Error('adapter.onMessage was never registered — call router.register() first');
      await handler(msg);
    },
  };
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'whatsapp',
    conversationId: 'convo-1',
    // Not a configured super admin and unresolvable in `community_users`
    // (DB unreachable) — resolveRole degrades to 'guest'. ACCESS_MODE_WHATSAPP
    // is 'open' here, so — UNLIKE the gated case — a guest is never turned
    // away by role alone; this is deliberately the exact identity shape the
    // proposal names as unreachable by remove_member (issue #572's problem
    // statement: "an open-mode guest keeps getting answered with no
    // membership row at all").
    userId: `open-guest-${Date.now()}`,
    userName: 'Open Guest',
    text: 'hello bot',
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeReply(text: string): AgentReply {
  return { text };
}

test(
  'baseline (no block check tripped): an open-mode guest with no community_users row still reaches the ' +
    'agent and gets a reply — establishes the exact gap issue #572 says remove_member cannot close',
  async () => {
    let runTurnCalls = 0;
    const router = new Router(
      async () => {
        runTurnCalls += 1;
        return makeReply('a normal reply');
      },
      20,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => false, // checkBlocked: not blocked
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(makeMessage());

    assert.equal(runTurnCalls, 1, 'an unblocked open-mode guest must reach the agent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'a normal reply');
  },
);

test(
  'SECURITY: a blocked sender on `open` access mode gets zero footprint — the agent is never invoked and ' +
    "no reply is sent, overriding open mode's default-allow (issue #572 acceptance criterion 1)",
  async () => {
    let runTurnCalls = 0;
    const seenBlockChecks: Array<{ platform: string; userId: string }> = [];
    const router = new Router(
      async () => {
        runTurnCalls += 1;
        throw new Error('runTurn must never be called for a blocked sender');
      },
      20,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (platform, userId) => {
        seenBlockChecks.push({ platform, userId });
        return true; // checkBlocked: blocked
      },
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    const msg = makeMessage();
    await assert.doesNotReject(trigger(msg));

    assert.equal(runTurnCalls, 0, 'the agent must never be invoked for a blocked sender');
    assert.equal(sent.length, 0, 'no reply — not even a notice — for a blocked sender');
    assert.deepEqual(
      seenBlockChecks,
      [{ platform: 'whatsapp', userId: msg.userId }],
      'the block check is consulted with the exact (platform, userId) of the sender',
    );
  },
);
