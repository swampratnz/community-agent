import { test } from 'node:test';
import assert from 'node:assert/strict';

// Issue #503: candidateTopicAlreadyReviewed's semantic dedup check computes
// its embedding via embed() only when the cheap exact-match fast path
// misses. This file pins the parts of that contract that need embed()
// itself mocked — same reasoning and convention as
// tests/knowledgeDuplicateDegradation.test.ts: embed() must be mocked via
// node:test's module mocking BEFORE repository.js/embeddings.js are ever
// imported (statically or dynamically) elsewhere in this process, so
// nothing at the top of this file imports either — every import below is a
// dynamic `await import` inside its own test, after that test's mock is
// registered. (The "at most one embed() call" contract, issue #503 AC5,
// needs a REAL functioning embed() rather than one that throws, so it lives
// in its own file — tests/knowledgeCandidateDedupEmbedCount.test.ts —
// because repository.js/builder.js, once evaluated, keep a live binding to
// whichever embeddings.js mock was active at THEIR first import in this
// process; a later test's `t.mock.module` call for the same specifier
// cannot retarget an already-cached importer's binding.)

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

test('SECURITY: candidateTopicAlreadyReviewed short-circuits an exact (case-insensitive) topic match WITHOUT ever calling embed() — proves the fast path is a true short circuit, not just cheap (issue #503, AC1)', async (t) => {
  let embedCalls = 0;
  t.mock.module('../src/storage/embeddings.js', {
    namedExports: {
      embed: async () => {
        embedCalls += 1;
        throw new Error('embed() must never be called on the exact-match fast path');
      },
    },
  });

  const { pool } = await import('../src/storage/db.js');
  const queries: string[] = [];
  t.mock.method(pool, 'query', async (sql: string) => {
    queries.push(sql);
    // Simulate an existing knowledge_candidates row matching exactly.
    return { rows: [{ '?column?': 1 }] };
  });

  const { candidateTopicAlreadyReviewed } = await import('../src/storage/repository.js');
  const result = await candidateTopicAlreadyReviewed('an already-queued topic');

  assert.equal(result.blocked, true, 'the exact match still blocks re-emission');
  assert.equal(result.embedding, null, 'no embedding was computed for the exact-match path');
  assert.equal(embedCalls, 0, 'embed() was never called');
  assert.equal(queries.length, 1, 'only the cheap exact-match SELECT ran');
});

test("candidateTopicAlreadyReviewed fails open (not blocked) when embedding the topic throws, matching knowledgeCoversTopic's existing posture — a transient embedding outage never blocks the builder run (issue #503, AC4)", async (t) => {
  t.mock.module('../src/storage/embeddings.js', {
    namedExports: {
      embed: async () => {
        throw new Error('embedding backend unavailable');
      },
    },
  });

  const { pool } = await import('../src/storage/db.js');
  const { logger } = await import('../src/logger.js');
  const warn = t.mock.method(logger, 'warn');
  const queries: string[] = [];
  t.mock.method(pool, 'query', async (sql: string) => {
    queries.push(sql);
    return { rows: [] }; // no exact match
  });

  const { candidateTopicAlreadyReviewed } = await import('../src/storage/repository.js');
  const result = await candidateTopicAlreadyReviewed('a brand new topic never seen before');

  assert.equal(result.blocked, false, 'a failed embedding degrades to "not previously reviewed"');
  assert.equal(result.embedding, null);
  assert.equal(
    queries.length,
    1,
    'only the exact-match SELECT ran — the semantic-similarity SELECT never fires once embedding fails',
  );
  assert.equal(warn.mock.calls.length, 1, 'exactly one warn-level line is logged');
});
