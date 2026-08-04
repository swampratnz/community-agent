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
// convention in tests/agentCoreCacheUsage.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

// The tool registry's module-scope registrations (tool tiers, tool-server
// parts, feature-flag predicates) — the composition-root contract, matching
// tests/rbac.test.ts.
await import('./support/registerToolRegistry.js');

type ModelUsageBehavior = {
  modelUsage: Record<string, { costUSD?: number; canonicalModel?: string; inputTokens?: number }> | null;
  subtype?: string;
};
let behavior: ModelUsageBehavior = { modelUsage: null };

function mockQuery() {
  return (async function* () {
    yield {
      type: 'result',
      subtype: behavior.subtype ?? 'success',
      result: 'ok',
      session_id: 'sess-1',
      total_cost_usd: 0,
      ...(behavior.modelUsage ? { modelUsage: behavior.modelUsage } : {}),
    };
  })();
}

// query() is a static import inside src/base/agent/core.ts, so once core.js has
// been dynamically imported anywhere in this process the binding is fixed —
// a later t.mock.module call can't retarget it (see tests/agentCoreCacheUsage.test.ts
// for the same trap). Install the mock once and reuse the cached import;
// `behavior` is mutated per-test to vary the simulated modelUsage payload.
let corePromise: Promise<typeof import('@swampratnz/agent-base/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    const real = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...real, query: mockQuery } });
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
    conversationId: 'convo-model-usage-1',
    isDirect: false,
  };
}

test('runAgentTurn: a successful turn threads a single-key modelUsage onto AgentReply.modelUsage, copying only costUSD (issue #792, acceptance criterion 1)', async (t) => {
  const { runAgentTurn } = await core(t);
  behavior = {
    modelUsage: { 'claude-sonnet-5': { costUSD: 1.23, inputTokens: 999, canonicalModel: 'claude-sonnet-5' } },
  };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.deepEqual(reply.modelUsage, { 'claude-sonnet-5': 1.23 });
});

test('runAgentTurn: a fallback-fired turn threads multi-key modelUsage onto AgentReply.modelUsage — both models contribute (issue #792, acceptance criterion 2)', async (t) => {
  const { runAgentTurn } = await core(t);
  behavior = {
    modelUsage: {
      'claude-sonnet-5': { costUSD: 1.23 },
      'claude-haiku-4-5': { costUSD: 0.04 },
    },
  };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.deepEqual(reply.modelUsage, { 'claude-sonnet-5': 1.23, 'claude-haiku-4-5': 0.04 });
});

test('runAgentTurn: a raw model key is rekeyed onto canonicalModel when the SDK provides one, merging entries that share a canonical model', async (t) => {
  const { runAgentTurn } = await core(t);
  behavior = {
    modelUsage: {
      'us.anthropic.claude-sonnet-5-20260101-v1:0': { costUSD: 1.0, canonicalModel: 'claude-sonnet-5' },
      'claude-sonnet-5': { costUSD: 0.5, canonicalModel: 'claude-sonnet-5' },
    },
  };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.deepEqual(reply.modelUsage, { 'claude-sonnet-5': 1.5 });
});

test('runAgentTurn: a max-turns (non-success) result still threads modelUsage onto AgentReply, mirroring costUsd/cacheReadTokens (issue #792)', async (t) => {
  const { runAgentTurn } = await core(t);
  behavior = {
    modelUsage: { 'claude-sonnet-5': { costUSD: 0.02 } },
    subtype: 'error_max_turns',
  };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, false);
  assert.equal(reply.maxTurnsExceeded, true);
  assert.deepEqual(reply.modelUsage, { 'claude-sonnet-5': 0.02 });
});

test('SECURITY: runAgentTurn leaves AgentReply.modelUsage strictly undefined (never an empty object) when the result message carries no modelUsage field — absent, not zero (issue #792, acceptance criterion 6)', async (t) => {
  const { runAgentTurn } = await core(t);
  behavior = { modelUsage: null };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(reply.modelUsage, undefined);
});

test('SECURITY: runAgentTurn leaves AgentReply.modelUsage strictly undefined when the result message carries an all-empty modelUsage object (issue #792, acceptance criterion 6)', async (t) => {
  const { runAgentTurn } = await core(t);
  behavior = { modelUsage: {} };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(reply.modelUsage, undefined);
});

test('SECURITY: runAgentTurn ignores an entry with no numeric costUSD rather than coercing it, and drops modelUsage entirely if that leaves nothing (issue #792)', async (t) => {
  const { runAgentTurn } = await core(t);
  behavior = { modelUsage: { 'claude-sonnet-5': { inputTokens: 500 } } };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(reply.modelUsage, undefined);
});
