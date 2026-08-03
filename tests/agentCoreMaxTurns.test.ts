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
// convention in tests/agentCoreUsageLimit.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

// The tool registry's module-scope registrations (tool tiers, tool-server
// parts, feature-flag predicates) — the composition-root contract, matching
// tests/rbac.test.ts.
await import('./support/registerToolRegistry.js');

// Notice constants agent-base deleted in the package flip (they named this
// community's axis values in framework code, and rendered at import time). Same
// catalogue entries, same values — see tests/support/legacyNotices.ts.
const { MAX_TURNS_REPLY } = await import('./support/legacyNotices.js');

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

// query() is a static import inside src/base/agent/core.ts, so once core.js has
// been dynamically imported anywhere in this process the binding is fixed —
// a later t.mock.module call can't retarget it (see tests/agentCoreUsageLimit.test.ts
// for the same trap). Install the mock once and reuse the cached import;
// `behavior` is mutated per-test to vary the underlying query() outcome.
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
    conversationId: 'convo-1',
    isDirect: false,
  };
}

test('runAgentTurn: resultSubtype === "error_max_turns" sets maxTurnsExceeded: true alongside ok: false and the fixed MAX_TURNS_REPLY text (issue #306)', async (t) => {
  const { runAgentTurn } = await core(t);

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
