import { test, after } from 'node:test';
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
// Community turn-state registration — the finalizer that surfaces this
// module's keys on AgentReply.turnState (src/index.ts loads it in production).
import './support/registerTurnState.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// tests/agentCoreUnhelpfulAnswerRated.test.ts, whose turn-scoped-ref pattern
// this file mirrors for `request_human_help` (issue #808).
// DATABASE_URL gates the cleanup step at the bottom of this file (skipped
// cleanly when unset, per CLAUDE.md) — captured before the dummy-env
// fallback below so it reflects whether a real DB is actually present,
// matching tests/knowledgeEval.test.ts's own convention.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';
// Every 'request'/'request-then-*' script below drives the REAL
// request_human_help tool handler, which fires a fire-and-forget write into
// human_help_request_log (issue #1364). That table carries no identity
// column by design, so unlike every other DB-backed test in this repo there
// is no owning id to filter a targeted cleanup by — captured here, before
// any test in this file runs, so the cleanup test at the bottom can delete
// every row THIS FILE inserted without touching a row from elsewhere.
const HUMAN_HELP_LOG_TESTS_STARTED_AT = new Date();

const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');
after(async () => {
  await closeDb();
});

// The tool registry's module-scope registrations (tool tiers, tool-server
// parts, feature-flag predicates) — the composition-root contract, matching
// tests/rbac.test.ts.
await import('./support/registerToolRegistry.js');

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

// query() is a static import inside src/base/agent/core.ts, so once the module
// has been dynamically imported anywhere in this process the binding is
// fixed — a later t.mock.module call can't retarget it (see
// tests/agentCoreMaxTurns.test.ts for the same trap). Install the mock once
// and reuse the cached import; `script` is mutated per-test.
let corePromise: Promise<typeof import('@swampratnz/agent-base/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    const realSdk = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...realSdk, query: mockQuery } });
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
  assert.equal(reply.turnState?.humanHelpRequested, true);
});

test('runAgentTurn: AgentReply.humanHelpRequested is absent when the turn makes no request_human_help call (issue #808)', async (t) => {
  const { runAgentTurn } = await core(t);
  script = { kind: 'none' };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.turnState?.humanHelpRequested, undefined);
});

test('SECURITY: runAgentTurn: AgentReply.humanHelpRequested is absent when the turn ends in a thrown failure, even though a genuine request was recorded first — never a stale flag on a failed turn (issue #808, mirrors #598)', async (t) => {
  const { runAgentTurn } = await core(t);
  script = { kind: 'request-then-throw' };

  const reply = await runAgentTurn(makeCaller(), 'can I talk to a human', makeAdapter().adapter);

  assert.equal(reply.ok, false, 'the simulated thrown failure must surface as a failed turn');
  assert.equal(
    reply.turnState?.humanHelpRequested,
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
    reply.turnState?.humanHelpRequested,
    undefined,
    'a max-turns failure must never carry humanHelpRequested, even if a genuine request was recorded before it',
  );
});

// Cleanup for the genuine calls the three tests above made — see
// HUMAN_HELP_LOG_TESTS_STARTED_AT's own doc comment for why a targeted
// per-row delete isn't possible here (issue #1364).
test(
  "cleanup: remove every human_help_request_log row this file's genuine request_human_help calls inserted (issue #1364)",
  { skip },
  async () => {
    // A short grace period for the LAST test's fire-and-forget write — the
    // handler never awaits recordHumanHelpRequest(), so its own test body
    // can resolve (and node:test move on to this one) slightly before the
    // INSERT lands.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await pool.query('DELETE FROM human_help_request_log WHERE created_at >= $1', [
      HUMAN_HELP_LOG_TESTS_STARTED_AT,
    ]);
  },
);
