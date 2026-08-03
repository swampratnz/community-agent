import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';
import type { CallerContext } from '@swampratnz/agent-base/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';
// Community content registrations (prompt sections + persona roster) — the
// composition-root contract: src/index.ts registers these in production, so
// tests that assemble prompts register them explicitly here.
import './support/registerPromptSections.js';
import './support/registerPersonas.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentCoreLanguagePreference.test.ts. DATABASE_URL is
// unreachable, but every repository call this file doesn't stub itself
// degrades gracefully (see tests/dbDegradation.test.ts) — the only export
// this file overrides is getResponseStyle, since it needs to simulate that
// lookup THROWING (issue #657's fail-open criterion), which the real
// implementation never does on its own (it already catches DB errors and
// degrades to 'standard' — see storage/repository.ts).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

// The tool registry's module-scope registrations (tool tiers, tool-server
// parts, feature-flag predicates) — the composition-root contract, matching
// tests/rbac.test.ts.
await import('./support/registerToolRegistry.js');

type StyleBehavior = { mode: 'value'; value: 'standard' | 'plain' } | { mode: 'throw' };
let styleBehavior: StyleBehavior = { mode: 'value', value: 'standard' };

function mockQuery() {
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

// Both query() and getResponseStyle() are static imports inside
// src/base/agent/core.ts, so once core.js has been dynamically imported anywhere
// in this process the bindings are fixed — a later t.mock.module call can't
// retarget them (see tests/agentCoreMaxTurns.test.ts for the same trap).
// Install both mocks once and reuse the cached import; `styleBehavior` is
// mutated per-test to vary the underlying getResponseStyle outcome.
let corePromise: Promise<typeof import('@swampratnz/agent-base/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    const realSdk = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...realSdk, query: mockQuery } });
    const realRepo = await import('@swampratnz/agent-base/storage/repository.js');
    t.mock.module('@swampratnz/agent-base/storage/repository.js', {
      namedExports: {
        ...realRepo,
        getResponseStyle: async () => {
          if (styleBehavior.mode === 'throw') throw new Error('response-style lookup exploded');
          return styleBehavior.value;
        },
      },
    });
    corePromise = import('@swampratnz/agent-base/agent/core.js');
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

test("runAgentTurn: a stubbed 'plain' response style is surfaced on AgentReply.responseStyle (issue #657)", async (t) => {
  const { runAgentTurn } = await core(t);
  styleBehavior = { mode: 'value', value: 'plain' };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.responseStyle, 'plain');
});

test("runAgentTurn: a default 'standard' response style is surfaced as-is, never coerced to 'plain' (issue #657)", async (t) => {
  const { runAgentTurn } = await core(t);
  styleBehavior = { mode: 'value', value: 'standard' };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.responseStyle, 'standard');
});

test("SECURITY: when getResponseStyle rejects during a turn, runAgentTurn still returns a reply with responseStyle degraded to 'standard' rather than throwing (issue #657, fail-open per #52)", async (t) => {
  const { runAgentTurn } = await core(t);
  styleBehavior = { mode: 'throw' };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(
    reply.responseStyle,
    'standard',
    'a failed lookup must degrade to standard, never throw and never leave "plain" reachable',
  );
  assert.equal(
    reply.ok,
    true,
    'the turn itself must still succeed — a response-style fault must not block the reply',
  );
  assert.equal(reply.text, 'ok');
});
