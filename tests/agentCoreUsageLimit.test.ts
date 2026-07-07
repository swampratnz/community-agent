import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/router.test.ts. UPSTREAM_LIMIT_ALERT_ENABLED is left
// unset here (default false) so this file pins the default, no-DM-promised
// behaviour; tests/agentCoreUsageLimitAlert.test.ts covers the flag-on path
// in its own process, since config is parsed once at import time.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

type QueryBehavior = { mode: 'throw'; message: string } | { mode: 'success'; text: string };
let behavior: QueryBehavior = { mode: 'success', text: 'ok' };

function mockQuery() {
  return (async function* () {
    if (behavior.mode === 'throw') throw new Error(behavior.message);
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
// a later t.mock.module call can't retarget it (see tests/knowledgeScope.test.ts
// for the same trap). Install the mock once via the first test's context and
// reuse the cached import; `behavior` is mutated per-test to vary the
// underlying query() outcome instead.
let corePromise: Promise<typeof import('../src/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    // Preserve the real createSdkMcpServer/tool (agent/tools.ts needs them to
    // build the MCP tool server) and override only query, the one export
    // this file's classifier tests actually exercise.
    const real = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...real, query: mockQuery } });
    corePromise = import('../src/agent/core.js');
  }
  return corePromise;
}

function makeAdapter(): { adapter: PlatformAdapter; dms: Array<{ userId: string; text: string }> } {
  const dms: Array<{ userId: string; text: string }> = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage() {},
    async sendMessage(_out: OutgoingMessage) {},
    async sendDirectMessage(userId: string, text: string) {
      dms.push({ userId, text });
    },
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return { adapter, dms };
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

test('runAgentTurn: a usage-limit/overload error gets the honest reply, without a false "admin notified" claim when the DM flag is off (default)', async (t) => {
  const { runAgentTurn } = await core(t);
  const { USAGE_LIMIT_REPLY, USAGE_LIMIT_REPLY_ADMIN_NOTIFIED } =
    await import('../src/agent/upstreamFailure.js');
  const { adapter, dms } = makeAdapter();

  behavior = { mode: 'throw', message: 'rate_limit_error: Number of request tokens has exceeded your limit' };
  const reply = await runAgentTurn(makeCaller(), 'hello', adapter);

  assert.equal(reply.text, USAGE_LIMIT_REPLY);
  assert.notEqual(
    reply.text,
    USAGE_LIMIT_REPLY_ADMIN_NOTIFIED,
    'must not claim an admin was notified when the DM feature is disabled',
  );
  assert.equal(dms.length, 0, 'no DM is sent when UPSTREAM_LIMIT_ALERT_ENABLED is unset');
});

test('runAgentTurn: an unrelated thrown error still returns the exact existing INTERNAL_ERROR_REPLY (no regression)', async (t) => {
  const { runAgentTurn, INTERNAL_ERROR_REPLY } = await core(t);
  const { adapter } = makeAdapter();

  behavior = { mode: 'throw', message: 'ECONNRESET' };
  const reply = await runAgentTurn(makeCaller(), 'hello', adapter);

  assert.equal(reply.text, INTERNAL_ERROR_REPLY);
});

test('runAgentTurn: a successful turn is unaffected by the classifier', async (t) => {
  const { runAgentTurn } = await core(t);
  const { adapter } = makeAdapter();

  behavior = { mode: 'success', text: 'all good' };
  const reply = await runAgentTurn(makeCaller(), 'hello', adapter);

  assert.equal(reply.text, 'all good');
});
