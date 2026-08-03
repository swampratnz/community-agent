import { test } from 'node:test';
import assert from 'node:assert/strict';

// Issue #886, acceptance criterion 2: mergeKnowledgeEntries must call embed()
// only when title/content is explicitly supplied, never when both are
// omitted. Needs its OWN file, same reasoning as
// tests/knowledgeCandidateDedupEmbedCount.test.ts — repository.js, once
// evaluated, keeps a live binding to whichever embeddings.js mock was active
// at its FIRST import in this process, and a later test file's `t.mock.module`
// call for the same specifier cannot retarget an already-cached importer's
// binding. Nothing at the top of this file imports repository.js/
// embeddings.js (statically or dynamically) before the mock below is
// registered.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const dbSkip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

test(
  'mergeKnowledgeEntries calls embed() only when title or content is explicitly supplied, and exactly once when it is (issue #886, acceptance criterion 2)',
  { skip: dbSkip },
  async (t) => {
    let embedCalls = 0;
    t.mock.module('../src/base/storage/embeddings.js', {
      namedExports: {
        // Call-count is this test's only concern; semantic accuracy of the
        // merge itself is covered with REAL embeddings in
        // tests/repository.test.ts.
        embed: async () => {
          embedCalls += 1;
          return new Array(384).fill(0);
        },
      },
    });

    const { pool, closeDb } = await import('../src/base/storage/db.js');
    const { saveKnowledge, mergeKnowledgeEntries } = await import('../src/base/storage/repository.js');
    const RUN = `mkembedcount${Date.now()}${Math.floor(Math.random() * 1e6)}`;

    try {
      // No override supplied: embed() must not run at all.
      const scopeA = `${RUN}-a`;
      const { id: keepA } = await saveKnowledge({
        title: 'Keep A',
        content: 'Keep A content.',
        scope: scopeA,
      });
      const { id: mergeA } = await saveKnowledge({
        title: 'Merge A',
        content: 'Merge A content.',
        scope: scopeA,
      });
      embedCalls = 0; // reset past the two setup saves' own embed() calls
      const noOverride = await mergeKnowledgeEntries(keepA, mergeA, {});
      assert.equal(noOverride.merged, true);
      assert.equal(embedCalls, 0, 'omitting title/content must not call embed()');

      // Content override supplied: exactly one embed() call for the survivor.
      const scopeB = `${RUN}-b`;
      const { id: keepB } = await saveKnowledge({
        title: 'Keep B',
        content: 'Keep B content.',
        scope: scopeB,
      });
      const { id: mergeB } = await saveKnowledge({
        title: 'Merge B',
        content: 'Merge B content.',
        scope: scopeB,
      });
      embedCalls = 0;
      const withOverride = await mergeKnowledgeEntries(keepB, mergeB, { content: 'New survivor content.' });
      assert.equal(withOverride.merged, true);
      assert.equal(embedCalls, 1, 'supplying content must call embed() exactly once for the survivor');
    } finally {
      await pool.query(`DELETE FROM knowledge WHERE scope LIKE $1`, [`${RUN}-%`]);
      await closeDb();
    }
  },
);
