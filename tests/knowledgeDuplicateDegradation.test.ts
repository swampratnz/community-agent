import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/dbDegradation.test.ts. This file never reaches a real
// database or the embedding model: it mocks ../src/storage/embeddings.js to
// throw (via node:test's module mocking, hence the top-level `embed` is
// never statically imported here) and mocks pool.query, to pin the
// saveKnowledge degradation path from issue #93 — when embed() fails, the
// near-duplicate check must be skipped and the save must still succeed.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

test('saveKnowledge skips the duplicate-check and still saves when embed() fails (issue #93)', async (t) => {
  t.mock.module('../src/storage/embeddings.js', {
    namedExports: {
      embed: async () => {
        throw new Error('embedding backend unavailable');
      },
    },
  });

  const { pool } = await import('../src/storage/db.js');
  const insertParams: unknown[][] = [];
  t.mock.method(pool, 'query', async (_sql: string, params: unknown[]) => {
    insertParams.push(params);
    return { rows: [{ id: 99 }] };
  });

  const { saveKnowledge } = await import('../src/storage/repository.js');
  const { id, similarEntry } = await saveKnowledge({
    title: 'Test entry',
    content: 'This save happens while embedding is broken.',
    scope: 'global',
  });

  assert.equal(id, 99);
  assert.equal(similarEntry, undefined, 'no duplicate check runs when embedding fails');
  assert.equal(insertParams.length, 1, 'only the INSERT runs — the duplicate-check SELECT is skipped');
  assert.equal(insertParams[0][5], null, 'embedding column is null in the insert');
});

test("searchKnowledge returns [] and logs a warning (matching searchMemory's shape) when embed() fails, without ever including the query text (issue #376)", async (t) => {
  t.mock.module('../src/storage/embeddings.js', {
    namedExports: {
      embed: async () => {
        throw new Error('embedding backend unavailable');
      },
    },
  });

  const { logger } = await import('../src/logger.js');
  const warn = t.mock.method(logger, 'warn');
  const { pool } = await import('../src/storage/db.js');
  const queryCalls: unknown[] = [];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[]) => {
    queryCalls.push({ sql, params });
    return { rows: [] };
  });

  const { searchKnowledge } = await import('../src/storage/repository.js');
  const sentinel = 'sentinel-secret-member-query-9f3a';
  const hits = await searchKnowledge(sentinel, { platform: 'discord', conversationId: 'x' });

  assert.deepEqual(hits, [], 'a failed knowledge-search embedding degrades to "no matches"');
  assert.equal(queryCalls.length, 0, 'the DB is never queried once embedding has failed');
  assert.equal(warn.mock.calls.length, 1, 'exactly one warn-level line is logged');
  const [meta, message] = warn.mock.calls[0].arguments;
  assert.equal(message, 'Embedding query failed; skipping knowledge search');
  assert.ok((meta as { err?: unknown }).err, 'the warn call carries the caught error, matching searchMemory');
  assert.ok(
    !String(message).includes(sentinel) && !JSON.stringify(meta).includes(sentinel),
    'SECURITY: the log line must never contain the member-supplied query text',
  );
});
