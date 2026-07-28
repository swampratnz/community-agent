import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentCoreRequesterTag.test.ts. MAX_INCOMING_MESSAGE_CHARS
// is fixed per test FILE (config.ts reads env once at import time), so the
// `0 = disabled` case (acceptance criterion 3) needs its own file, separate
// from tests/agentCoreIncomingMessageTruncation.test.ts's fixed 20-char cap.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.MAX_INCOMING_MESSAGE_CHARS ??= '0';

let lastQueryParams: { prompt: string; options: { systemPrompt: string } } | null = null;

function mockQuery(params: { prompt: string; options: { systemPrompt: string } }) {
  lastQueryParams = params;
  return (async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      result: 'ok',
      session_id: 'sess-1',
      total_cost_usd: 0,
    };
  })();
}

let corePromise: Promise<typeof import('../src/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    const real = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...real, query: mockQuery } });
    corePromise = import('../src/agent/core.js');
  }
  return corePromise;
}

function makeAdapter(): { adapter: PlatformAdapter } {
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage() {},
    async sendMessage(_out: OutgoingMessage) {},
    async sendDirectMessage() {},
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return { adapter };
}

function makeCaller(): CallerContext {
  return {
    platform: 'discord',
    userId: 'member-1',
    userName: '', // no requester tag, so the assembled prompt is exactly userText
    role: 'member',
    conversationId: 'convo-1',
    isDirect: false,
  };
}

test('runAgentTurn: MAX_INCOMING_MESSAGE_CHARS=0 leaves an oversized message byte-identical to the input — no marker, no truncation (acceptance criterion 3)', async (t) => {
  const { runAgentTurn } = await core(t);

  const huge = 'z'.repeat(50_000);
  const reply = await runAgentTurn(makeCaller(), huge, makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(lastQueryParams!.prompt, huge);
});
