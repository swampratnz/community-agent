import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// tests/agentCoreUnhelpfulAnswerRated.test.ts, whose turn-scoped-ref pattern
// this file mirrors for `request_human_help` (issue #808).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

type ToolCallScript =
  | { kind: 'none' }
  | { kind: 'request' }
  | { kind: 'request-then-max-turns' }
  | { kind: 'request-then-throw' };

let script: ToolCallScript = { kind: 'none' };

type RegisteredRequestHumanHelpTool = {
  handler: () => Promise<unknown>;
};

function mockQuery(params: { options: { mcpServers: Record<string, unknown> } }) {
  return (async function* () {
    const server = params.options.mcpServers.community as {
      instance: { _registeredTools: Record<string, RegisteredRequestHumanHelpTool> };
    };
    const requestHumanHelp = server.instance._registeredTools['request_human_help'];

    if (
      script.kind === 'request' ||
      script.kind === 'request-then-max-turns' ||
      script.kind === 'request-then-throw'
    ) {
      await requestHumanHelp.handler();
    }
    if (script.kind === 'request-then-throw') {
      throw new Error('simulated upstream failure mid-turn');
    }
    if (script.kind === 'request-then-max-turns') {
      yield {
        type: 'result',
        subtype: 'error_max_turns',
        result: '',
        session_id: 'sess-1',
        total_cost_usd: 0,
      };
      return;
    }
    yield {
      type: 'result',
      subtype: 'success',
      result: "Got it — I've flagged this for a community admin to follow up.",
      session_id: 'sess-1',
      total_cost_usd: 0,
    };
  })();
}

// query() is a static import inside src/agent/core.ts, so once the module
// has been dynamically imported anywhere in this process the binding is
// fixed — a later t.mock.module call can't retarget it (see
// tests/agentCoreMaxTurns.test.ts for the same trap). Install the mock once
// and reuse the cached import; `script` is mutated per-test.
let corePromise: Promise<typeof import('../src/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    const realSdk = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...realSdk, query: mockQuery } });
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

function makeCaller(overrides: Partial<CallerContext> = {}): CallerContext {
  return {
    platform: 'discord',
    userId: `member-${Math.random()}`,
    userName: 'Member',
    role: 'member',
    conversationId: 'convo-1',
    isDirect: false,
    ...overrides,
  };
}

test('runAgentTurn: AgentReply.humanHelpRequested is true after a genuine request_human_help call (issue #808 acceptance criterion 2)', async (t) => {
  const { runAgentTurn } = await core(t);
  script = { kind: 'request' };

  const reply = await runAgentTurn(makeCaller(), 'can I talk to a human', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(reply.humanHelpRequested, true);
});

test('runAgentTurn: AgentReply.humanHelpRequested is absent when the turn makes no request_human_help call (issue #808)', async (t) => {
  const { runAgentTurn } = await core(t);
  script = { kind: 'none' };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.humanHelpRequested, undefined);
});

test('SECURITY: runAgentTurn: AgentReply.humanHelpRequested is absent when the turn ends in a thrown failure, even though a genuine request was recorded first — never a stale flag on a failed turn (issue #808, mirrors #598)', async (t) => {
  const { runAgentTurn } = await core(t);
  script = { kind: 'request-then-throw' };

  const reply = await runAgentTurn(makeCaller(), 'can I talk to a human', makeAdapter().adapter);

  assert.equal(reply.ok, false, 'the simulated thrown failure must surface as a failed turn');
  assert.equal(
    reply.humanHelpRequested,
    undefined,
    'a failed turn must never carry humanHelpRequested, even if a genuine request was recorded before the failure',
  );
});

test('SECURITY: runAgentTurn: AgentReply.humanHelpRequested is absent on an error_max_turns result, even though a genuine request was recorded first — never a stale flag on a non-success result (issue #808, mirrors #598)', async (t) => {
  const { runAgentTurn } = await core(t);
  script = { kind: 'request-then-max-turns' };

  const reply = await runAgentTurn(makeCaller(), 'can I talk to a human', makeAdapter().adapter);

  assert.equal(reply.ok, false);
  assert.equal(reply.maxTurnsExceeded, true);
  assert.equal(
    reply.humanHelpRequested,
    undefined,
    'a max-turns failure must never carry humanHelpRequested, even if a genuine request was recorded before it',
  );
});
