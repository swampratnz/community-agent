import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentCoreMaxTurns.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { logger } = await import('../src/logger.js');

type UsageBehavior = {
  usage: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null;
  subtype?: string;
};
let behavior: UsageBehavior = { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };

function mockQuery() {
  return (async function* () {
    yield {
      type: 'result',
      subtype: behavior.subtype ?? 'success',
      result: 'ok',
      session_id: 'sess-1',
      total_cost_usd: 0,
      ...(behavior.usage ? { usage: behavior.usage } : {}),
    };
  })();
}

// query() is a static import inside src/agent/core.ts, so once core.js has
// been dynamically imported anywhere in this process the binding is fixed —
// a later t.mock.module call can't retarget it (see tests/agentCoreMaxTurns.test.ts
// for the same trap). Install the mock once and reuse the cached import;
// `behavior` is mutated per-test to vary the simulated usage payload.
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
    userName: 'Member',
    role: 'member',
    conversationId: 'convo-cache-1',
    isDirect: false,
  };
}

test('runAgentTurn: cache-usage telemetry from the SDK result message is logged at debug level with conversationId (issue #508, acceptance criterion 4)', async (t) => {
  const { runAgentTurn } = await core(t);
  const debugLog = t.mock.method(logger, 'debug');
  behavior = { usage: { cache_read_input_tokens: 1234, cache_creation_input_tokens: 56 } };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  const call = debugLog.mock.calls.find(
    (c) => typeof c.arguments[1] === 'string' && c.arguments[1] === 'agent turn cache usage',
  );
  assert.ok(call, 'a debug log for "agent turn cache usage" must be emitted');
  const payload = call.arguments[0] as Record<string, unknown>;
  assert.equal(payload.cacheReadTokens, 1234);
  assert.equal(payload.cacheCreationTokens, 56);
  assert.equal(payload.conversationId, 'convo-cache-1');
});

test('runAgentTurn: no cache-usage debug log when the result message carries no usage field', async (t) => {
  const { runAgentTurn } = await core(t);
  const debugLog = t.mock.method(logger, 'debug');
  behavior = { usage: null };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  const call = debugLog.mock.calls.find(
    (c) => typeof c.arguments[1] === 'string' && c.arguments[1] === 'agent turn cache usage',
  );
  assert.equal(call, undefined, 'no cache-usage log should fire when usage is absent');
});

test('runAgentTurn: a successful turn threads cache_read_input_tokens/cache_creation_input_tokens onto AgentReply.cacheReadTokens/cacheCreationTokens (issue #522, acceptance criterion 3)', async (t) => {
  const { runAgentTurn } = await core(t);
  behavior = { usage: { cache_read_input_tokens: 1234, cache_creation_input_tokens: 56 } };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(reply.cacheReadTokens, 1234);
  assert.equal(reply.cacheCreationTokens, 56);
});

test('runAgentTurn: a max-turns (non-success) result still threads cache tokens onto AgentReply, mirroring costUsd (issue #522, acceptance criterion 3)', async (t) => {
  const { runAgentTurn } = await core(t);
  behavior = {
    usage: { cache_read_input_tokens: 789, cache_creation_input_tokens: 12 },
    subtype: 'error_max_turns',
  };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, false);
  assert.equal(reply.maxTurnsExceeded, true);
  assert.equal(reply.cacheReadTokens, 789);
  assert.equal(reply.cacheCreationTokens, 12);
});

test('runAgentTurn: no usage field leaves AgentReply.cacheReadTokens/cacheCreationTokens strictly undefined', async (t) => {
  const { runAgentTurn } = await core(t);
  behavior = { usage: null };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(reply.cacheReadTokens, undefined);
  assert.equal(reply.cacheCreationTokens, undefined);
});
