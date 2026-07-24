import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// tests/agentCoreKnowledgeEntryId.test.ts, whose turn-scoped-ref pattern
// this file mirrors for `rate_answer` (issue #598). DATABASE_URL is
// unreachable; the only repository export this file overrides is
// createAnswerFeedback, so it can simulate a rate_answer tool call's outcome
// deterministically without a real DB.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

type CreateAnswerFeedbackResult = { id: number } | 'no_recent_answer' | 'rate_limited';

type ToolCallScript =
  | { kind: 'none' }
  | { kind: 'rate'; helpful: boolean; result: CreateAnswerFeedbackResult }
  | { kind: 'rate-then-max-turns'; helpful: boolean; result: CreateAnswerFeedbackResult }
  | { kind: 'rate-then-throw'; helpful: boolean; result: CreateAnswerFeedbackResult };

let script: ToolCallScript = { kind: 'none' };
let feedbackCalls = 0;

type RegisteredRateAnswerTool = {
  handler: (args: { helpful: boolean; comment?: string }) => Promise<unknown>;
};

function mockQuery(params: { options: { mcpServers: Record<string, unknown> } }) {
  return (async function* () {
    const server = params.options.mcpServers.community as {
      instance: { _registeredTools: Record<string, RegisteredRateAnswerTool> };
    };
    const rateAnswer = server.instance._registeredTools['rate_answer'];

    if (
      script.kind === 'rate' ||
      script.kind === 'rate-then-max-turns' ||
      script.kind === 'rate-then-throw'
    ) {
      await rateAnswer.handler({ helpful: script.helpful });
    }
    if (script.kind === 'rate-then-throw') {
      throw new Error('simulated upstream failure mid-turn');
    }
    if (script.kind === 'rate-then-max-turns') {
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
      result: 'here is your answer',
      session_id: 'sess-1',
      total_cost_usd: 0,
    };
  })();
}

// Both query() and createAnswerFeedback() are static imports inside
// src/agent/core.ts / src/agent/tools.ts, so once those modules have been
// dynamically imported anywhere in this process the bindings are fixed — a
// later t.mock.module call can't retarget them (see
// tests/agentCoreMaxTurns.test.ts for the same trap). Install both mocks
// once and reuse the cached import; `script` is mutated per-test to vary the
// simulated rate_answer call pattern.
let corePromise: Promise<typeof import('../src/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    const realSdk = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...realSdk, query: mockQuery } });
    const realRepo = await import('../src/storage/repository.js');
    t.mock.module('../src/storage/repository.js', {
      namedExports: {
        ...realRepo,
        createAnswerFeedback: async (_input: unknown) => {
          feedbackCalls++;
          if (script.kind === 'none') throw new Error('unexpected createAnswerFeedback call');
          return script.result;
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

test('runAgentTurn: AgentReply.unhelpfulAnswerRated is true after a genuine rate_answer(helpful: false) that records feedback (issue #598, acceptance criterion 2)', async (t) => {
  const { runAgentTurn } = await core(t);
  script = { kind: 'rate', helpful: false, result: { id: 1 } };

  const reply = await runAgentTurn(makeCaller(), 'that was wrong', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(reply.unhelpfulAnswerRated, true);
});

test('runAgentTurn: AgentReply.unhelpfulAnswerRated is absent after rate_answer(helpful: true) (issue #598, acceptance criterion 3)', async (t) => {
  const { runAgentTurn } = await core(t);
  script = { kind: 'rate', helpful: true, result: { id: 2 } };

  const reply = await runAgentTurn(makeCaller(), 'that helped', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(reply.unhelpfulAnswerRated, undefined);
});

test("runAgentTurn: AgentReply.unhelpfulAnswerRated is absent when createAnswerFeedback returns 'no_recent_answer' (issue #598, acceptance criterion 4)", async (t) => {
  const { runAgentTurn } = await core(t);
  script = { kind: 'rate', helpful: false, result: 'no_recent_answer' };

  const reply = await runAgentTurn(makeCaller(), 'that was wrong', makeAdapter().adapter);

  assert.equal(reply.unhelpfulAnswerRated, undefined);
});

test("runAgentTurn: AgentReply.unhelpfulAnswerRated is absent when createAnswerFeedback returns 'rate_limited' (issue #598, acceptance criterion 4)", async (t) => {
  const { runAgentTurn } = await core(t);
  script = { kind: 'rate', helpful: false, result: 'rate_limited' };

  const reply = await runAgentTurn(makeCaller(), 'that was wrong', makeAdapter().adapter);

  assert.equal(reply.unhelpfulAnswerRated, undefined);
});

test('runAgentTurn: AgentReply.unhelpfulAnswerRated is absent when the turn makes no rate_answer call (issue #598)', async (t) => {
  const { runAgentTurn } = await core(t);
  script = { kind: 'none' };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.unhelpfulAnswerRated, undefined);
});

test('SECURITY: runAgentTurn: AgentReply.unhelpfulAnswerRated is absent when the turn ends in a thrown failure, even though a genuine thumbs-down was recorded first — never a stale flag on a failed turn (issue #598, mirrors #411 acceptance criterion 5)', async (t) => {
  const { runAgentTurn } = await core(t);
  script = { kind: 'rate-then-throw', helpful: false, result: { id: 3 } };

  const reply = await runAgentTurn(makeCaller(), 'that was wrong', makeAdapter().adapter);

  assert.equal(reply.ok, false, 'the simulated thrown failure must surface as a failed turn');
  assert.equal(
    reply.unhelpfulAnswerRated,
    undefined,
    'a failed turn must never carry unhelpfulAnswerRated, even if a genuine thumbs-down was recorded before the failure',
  );
});

test('SECURITY: runAgentTurn: AgentReply.unhelpfulAnswerRated is absent on an error_max_turns result, even though a genuine thumbs-down was recorded first — never a stale flag on a non-success result (issue #598, mirrors #411 acceptance criterion 5)', async (t) => {
  const { runAgentTurn } = await core(t);
  script = { kind: 'rate-then-max-turns', helpful: false, result: { id: 4 } };

  const reply = await runAgentTurn(makeCaller(), 'that was wrong', makeAdapter().adapter);

  assert.equal(reply.ok, false);
  assert.equal(reply.maxTurnsExceeded, true);
  assert.equal(
    reply.unhelpfulAnswerRated,
    undefined,
    'a max-turns failure must never carry unhelpfulAnswerRated, even if a genuine thumbs-down was recorded before it',
  );
});
