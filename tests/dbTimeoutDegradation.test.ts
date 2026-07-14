import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/dbDegradation.test.ts. These tests never reach a real
// database: pool.query is mocked to throw a statement-timeout-shaped error
// (issue #502), proving the existing #52 degrade-gracefully paths treat a
// bounded timeout exactly like any other DB failure — including that the raw
// Postgres error text never reaches an outbound reply.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { pool } = await import('../src/storage/db.js');
const { logger } = await import('../src/logger.js');
const { searchMemory, getClaudeSession } = await import('../src/storage/repository.js');

// The real Postgres error text emitted when statement_timeout cancels a
// query (SQLSTATE 57014) — used verbatim so this test proves the actual
// wording never leaks, not a stand-in.
const STATEMENT_TIMEOUT_MESSAGE = 'canceling statement due to statement timeout';

test('SECURITY: a statement-timeout rejection on the memory-recall path degrades exactly like any other DB failure (issue #52/#502)', async (t) => {
  const warn = t.mock.method(logger, 'warn');
  t.mock.method(pool, 'query', async () => {
    throw new Error(STATEMENT_TIMEOUT_MESSAGE);
  });

  const hits = await searchMemory(' ', { platform: 'discord', conversationId: 'c-timeout' });

  assert.deepEqual(hits, [], 'a statement-timeout rejection degrades to "no relevant memories", same as #52');
  assert.ok(
    warn.mock.calls.some((c) => String(c.arguments[1]).includes('Memory search query failed')),
    'the degradation is logged at warn with the error',
  );
});

test('SECURITY: a statement-timeout rejection on the session-lookup path degrades exactly like any other DB failure (issue #52/#502)', async (t) => {
  const warn = t.mock.method(logger, 'warn');
  t.mock.method(pool, 'query', async () => {
    throw new Error(STATEMENT_TIMEOUT_MESSAGE);
  });

  const session = await getClaudeSession('discord', 'c-timeout');

  assert.equal(session, null, 'a statement-timeout rejection degrades to "start fresh" (null), same as #52');
  assert.ok(
    warn.mock.calls.some((c) => String(c.arguments[1]).includes('Session lookup failed')),
    'the degradation is logged at warn with the error',
  );
});

test('SECURITY: a full agent turn completes normally, and the raw Postgres statement-timeout error string never reaches the outbound reply, even when every DB read on the turn hits it (issue #502)', async (t) => {
  const realSdk = await import('@anthropic-ai/claude-agent-sdk');
  t.mock.module('@anthropic-ai/claude-agent-sdk', {
    namedExports: {
      ...realSdk,
      query: () =>
        (async function* () {
          yield {
            type: 'result',
            subtype: 'success',
            result: 'a normal, helpful answer',
            session_id: 'sess-1',
            total_cost_usd: 0,
          };
        })(),
    },
  });
  t.mock.method(pool, 'query', async () => {
    throw new Error(STATEMENT_TIMEOUT_MESSAGE);
  });

  const { runAgentTurn } = await import('../src/agent/core.js');

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
  const caller: CallerContext = {
    platform: 'discord',
    userId: 'member-1',
    userName: 'Member',
    role: 'member',
    conversationId: 'convo-timeout',
    isDirect: false,
  };

  const reply = await runAgentTurn(caller, 'hello', adapter);

  assert.equal(
    reply.ok,
    true,
    'every DB read on this path degrades internally per #52 — the turn itself must still succeed',
  );
  assert.equal(reply.text, 'a normal, helpful answer');
  assert.ok(
    !reply.text.includes(STATEMENT_TIMEOUT_MESSAGE),
    'the raw Postgres statement-timeout error text must never reach the outbound reply',
  );
});
