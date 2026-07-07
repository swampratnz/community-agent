import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it. Separate process
// from tests/agentCoreUsageLimit.test.ts so UPSTREAM_LIMIT_ALERT_ENABLED can
// be pinned on here without affecting the default-off pin there (config is
// parsed once at import time).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.UPSTREAM_LIMIT_ALERT_ENABLED = 'true';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';

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

// See tests/agentCoreUsageLimit.test.ts for why the mock must be installed
// once, before core.js's first dynamic import, and reused thereafter.
let corePromise: Promise<typeof import('../src/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    // Preserve the real createSdkMcpServer/tool (agent/tools.ts needs them to
    // build the MCP tool server) and override only query.
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

// sendDirectMessage above is synchronous/awaited inline, but core.ts fires it
// fire-and-forget (`.catch()`, no await) — give the microtask queue a turn
// so the DM lands before assertions run.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('runAgentTurn: a usage-limit/overload error DMs super admins once, then stays silent while it persists, and re-arms on recovery (issue #131)', async (t) => {
  const { runAgentTurn } = await core(t);
  const { USAGE_LIMIT_REPLY_ADMIN_NOTIFIED } = await import('../src/agent/upstreamFailure.js');
  const { adapter, dms } = makeAdapter();
  const caller = makeCaller();

  behavior = { mode: 'throw', message: 'overloaded_error: Overloaded' };
  const first = await runAgentTurn(caller, 'hello', adapter);
  await flush();
  assert.equal(
    first.text,
    USAGE_LIMIT_REPLY_ADMIN_NOTIFIED,
    'reply says an admin was notified once the flag is on',
  );
  assert.equal(dms.length, 1, 'exactly one DM on the first failure');
  assert.equal(dms[0].userId, 'super-1');

  const second = await runAgentTurn(caller, 'hello again', adapter);
  await flush();
  assert.equal(second.text, USAGE_LIMIT_REPLY_ADMIN_NOTIFIED);
  assert.equal(dms.length, 1, 'no repeat DM while the condition is still ongoing');

  behavior = { mode: 'success', text: 'back to normal' };
  const recovered = await runAgentTurn(caller, 'ok now', adapter);
  await flush();
  assert.equal(recovered.text, 'back to normal');
  assert.equal(dms.length, 1, 'a successful turn never itself sends a DM');

  behavior = { mode: 'throw', message: 'overloaded_error: Overloaded again' };
  const thirdFailure = await runAgentTurn(caller, 'hello a third time', adapter);
  await flush();
  assert.equal(thirdFailure.text, USAGE_LIMIT_REPLY_ADMIN_NOTIFIED);
  assert.equal(dms.length, 2, 'a new window after recovery DMs again');
});
