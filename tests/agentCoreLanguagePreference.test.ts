import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentCoreMaxTurns.test.ts. DATABASE_URL is
// unreachable, but every repository call this file doesn't stub itself
// degrades gracefully (see tests/dbDegradation.test.ts) — the only export
// this file overrides is getLanguagePreference, since it needs to simulate
// that lookup THROWING (issue #339's fail-open criterion), which the real
// implementation never does on its own (it already catches DB errors and
// degrades to 'auto' — see storage/repository.ts).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

type LangBehavior = { mode: 'value'; value: 'auto' | 'en' | 'mi' } | { mode: 'throw' };
let langBehavior: LangBehavior = { mode: 'value', value: 'auto' };

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

// Both query() and getLanguagePreference() are static imports inside
// src/agent/core.ts, so once core.js has been dynamically imported anywhere
// in this process the bindings are fixed — a later t.mock.module call can't
// retarget them (see tests/agentCoreMaxTurns.test.ts for the same trap).
// Install both mocks once and reuse the cached import; `langBehavior` is
// mutated per-test to vary the underlying getLanguagePreference outcome.
let corePromise: Promise<typeof import('../src/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    const realSdk = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...realSdk, query: mockQuery } });
    const realRepo = await import('../src/storage/repository.js');
    t.mock.module('../src/storage/repository.js', {
      namedExports: {
        ...realRepo,
        getLanguagePreference: async () => {
          if (langBehavior.mode === 'throw') throw new Error('language-preference lookup exploded');
          return langBehavior.value;
        },
      },
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

test("runAgentTurn: a stubbed 'mi' language preference is surfaced on AgentReply.languagePreference (issue #339)", async (t) => {
  const { runAgentTurn } = await core(t);
  langBehavior = { mode: 'value', value: 'mi' };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.languagePreference, 'mi');
});

test("runAgentTurn: a default 'auto' language preference is never coerced to 'mi'", async (t) => {
  const { runAgentTurn } = await core(t);
  langBehavior = { mode: 'value', value: 'auto' };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.notEqual(reply.languagePreference, 'mi');
});

test('SECURITY: when getLanguagePreference rejects during a turn, runAgentTurn still returns a reply with languagePreference left undefined rather than throwing (issue #339, fail-open per #52)', async (t) => {
  const { runAgentTurn } = await core(t);
  langBehavior = { mode: 'throw' };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.languagePreference, undefined, 'a failed lookup must degrade to undefined, never throw');
  assert.equal(
    reply.ok,
    true,
    'the turn itself must still succeed — a language-pref fault must not block the reply',
  );
  assert.equal(reply.text, 'ok');
});
