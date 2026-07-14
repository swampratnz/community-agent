import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentCoreUsageLimit.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

type QueryBehavior = { mode: 'success'; text: string } | { mode: 'nonSuccess'; subtype: string };
let behavior: QueryBehavior = { mode: 'success', text: 'ok' };

function mockQuery() {
  return (async function* () {
    if (behavior.mode === 'nonSuccess') {
      yield {
        type: 'result',
        subtype: behavior.subtype,
        result: '',
        session_id: 'sess-1',
        total_cost_usd: 0.01,
      };
      return;
    }
    yield {
      type: 'result',
      subtype: 'success',
      result: behavior.text,
      session_id: 'sess-1',
      total_cost_usd: 0,
    };
  })();
}

// query() is a static import inside src/agent/core.ts, so once core.js has
// been dynamically imported anywhere in this process the binding is fixed —
// a later t.mock.module call can't retarget it (see tests/agentCoreUsageLimit.test.ts
// for the same trap). Install the mock once and reuse the cached import;
// `behavior` is mutated per-test to vary the underlying query() outcome.
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
    conversationId: 'convo-1',
    isDirect: false,
  };
}

test('runAgentTurn: resultSubtype === "error_max_turns" sets maxTurnsExceeded: true alongside ok: false and the fixed MAX_TURNS_REPLY text (issue #306)', async (t) => {
  const { runAgentTurn, MAX_TURNS_REPLY } = await core(t);

  behavior = { mode: 'nonSuccess', subtype: 'error_max_turns' };
  const reply = await runAgentTurn(makeCaller(), 'a very long ask', makeAdapter().adapter);

  assert.equal(reply.ok, false);
  assert.equal(reply.maxTurnsExceeded, true);
  assert.equal(reply.text, MAX_TURNS_REPLY);
});

test('runAgentTurn: a different non-success subtype leaves maxTurnsExceeded strictly undefined (never truthy for a non-max-turns failure)', async (t) => {
  const { runAgentTurn } = await core(t);

  behavior = { mode: 'nonSuccess', subtype: 'error_during_execution' };
  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, false);
  assert.equal(reply.maxTurnsExceeded, undefined);
});

test('runAgentTurn: a successful turn leaves maxTurnsExceeded strictly undefined', async (t) => {
  const { runAgentTurn } = await core(t);

  behavior = { mode: 'success', text: 'all good' };
  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(reply.maxTurnsExceeded, undefined);
});
