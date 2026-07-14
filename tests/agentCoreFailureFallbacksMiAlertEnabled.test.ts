import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it. Separate process
// from tests/agentCoreFailureFallbacksMi.test.ts so UPSTREAM_LIMIT_ALERT_ENABLED
// can be pinned on here without affecting the default-off pin there (config
// is parsed once at import time) — mirrors tests/agentCoreUsageLimitAlert.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.UPSTREAM_LIMIT_ALERT_ENABLED = 'true';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';

let langBehavior: 'auto' | 'en' | 'mi' = 'mi';

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

// See tests/agentCoreFailureFallbacksMi.test.ts for why both mocks must be
// installed once, before core.js's first dynamic import, and reused.
let corePromise: Promise<typeof import('../src/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    const realSdk = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...realSdk, query: mockQuery } });
    const realRepo = await import('../src/storage/repository.js');
    t.mock.module('../src/storage/repository.js', {
      namedExports: { ...realRepo, getLanguagePreference: async () => langBehavior },
    });
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

test("runAgentTurn: a usage-limit-classified failure for a 'mi' caller returns USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_MI when the admin-alert flag is on (issue #396)", async (t) => {
  const { runAgentTurn } = await core(t);
  const { USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_MI, USAGE_LIMIT_REPLY_MI } =
    await import('../src/agent/upstreamFailure.js');
  langBehavior = 'mi';
  behavior = { mode: 'throw', message: 'overloaded_error: Overloaded' };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.text, USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_MI);
  assert.notEqual(reply.text, USAGE_LIMIT_REPLY_MI);
});
