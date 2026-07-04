import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. These tests never reach a real
// database: pool.query is mocked to throw, which is the whole point — they
// pin the issue #52 invariant that a DB failure mid-turn degrades instead of
// killing the turn, and they run without DATABASE_URL (like healthState.test.ts).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { pool } = await import('../src/storage/db.js');
const { logger } = await import('../src/logger.js');
const { searchMemory, getClaudeSession } = await import('../src/storage/repository.js');

test('searchMemory returns [] and logs a warning when the DB query fails (issue #52)', async (t) => {
  const warn = t.mock.method(logger, 'warn');
  t.mock.method(pool, 'query', async () => {
    throw new Error('connection refused');
  });

  // A whitespace-only query short-circuits embed() to a zero vector without
  // loading the (network-dependent) embedding model, so the mocked pool.query
  // is the only failure point this test exercises.
  const hits = await searchMemory(' ', { platform: 'discord', conversationId: 'c-degrade' });

  assert.deepEqual(hits, [], 'a failed memory query degrades to "no relevant memories"');
  assert.ok(
    warn.mock.calls.some((c) => String(c.arguments[1]).includes('Memory search query failed')),
    'the degradation is logged at warn with the error',
  );
});

test('getClaudeSession returns null and logs a warning when the DB query fails (issue #52)', async (t) => {
  const warn = t.mock.method(logger, 'warn');
  t.mock.method(pool, 'query', async () => {
    throw new Error('pool exhausted');
  });

  const session = await getClaudeSession('discord', 'c-degrade');

  assert.equal(session, null, 'a failed session lookup degrades to "start fresh" (null)');
  assert.ok(
    warn.mock.calls.some((c) => String(c.arguments[1]).includes('Session lookup failed')),
    'the degradation is logged at warn with the error',
  );
});
