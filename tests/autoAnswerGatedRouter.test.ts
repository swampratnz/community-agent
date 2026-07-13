import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// autoAnswerRouter.test.ts. This file deliberately leaves ACCESS_MODE_DISCORD
// unset (default 'gated') — the sibling of autoAnswerRouter.test.ts's 'open'
// mode coverage — to pin the acceptance criterion that gated mode excludes an
// unregistered guest from auto-answer exactly like it already excludes one
// from an addressed reply, with no new bypass.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.AUTO_ANSWER_CHANNEL_IDS = 'auto-chan-1';

const { Router } = await import('../src/router.js');
const { embed } = await import('../src/storage/embeddings.js');

await embed('warmup').catch(() => {});

function makeAdapter(): {
  adapter: PlatformAdapter;
  sent: OutgoingMessage[];
  threadCalls: unknown[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const threadCalls: unknown[] = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
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
    async startAutoAnswerThread(conversationId, messageId, name) {
      threadCalls.push({ conversationId, messageId, name });
      return 'thread-should-never-be-created';
    },
  };
  return {
    adapter,
    sent,
    threadCalls,
    trigger: async (msg) => {
      if (!handler) throw new Error('adapter.onMessage was never registered — call router.register() first');
      await handler(msg);
    },
  };
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'discord',
    conversationId: 'auto-chan-1',
    userId: 'unregistered-guest-1',
    userName: 'Unregistered Guest',
    text: 'how do I use tool use with the API?',
    isDirect: false,
    addressedToBot: false,
    messageId: 'origin-msg-gated-1',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeReply(text: string): AgentReply {
  return { text, ok: true };
}

test('SECURITY: gated mode excludes an unregistered guest from auto-answer, exactly like it already excludes one from an addressed reply (issue #477)', async () => {
  let calls = 0;
  const router = new Router(async () => {
    calls += 1;
    return makeReply('should never be sent to a gated guest');
  }, 20);
  const { adapter, sent, threadCalls, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(calls, 0, 'a gated, unregistered guest must never reach an agent turn via auto-answer');
  assert.equal(threadCalls.length, 0, 'no thread should ever be created for an excluded gated guest');
  // The gated-guest branch may still send the static "ask an admin"/gated
  // notice on an ADDRESSED message, but this post is deliberately NOT
  // addressed — the gated-guest branch's own rate-limited addressed check
  // means nothing is sent here either.
  assert.equal(sent.length, 0);
});
