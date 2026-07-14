import { test } from 'node:test';
import assert from 'node:assert/strict';

// Issue #503, AC5: at most one embed() call per attempted cluster now that
// the builder's candidate dedup check reuses ONE computed vector across
// candidateTopicAlreadyReviewed's similarity check, knowledgeCoversTopic,
// and insertKnowledgeCandidate, instead of re-embedding for each. This
// needs its OWN file, separate from
// tests/knowledgeCandidateDedupDegradation.test.ts's throwing mocks:
// repository.js/builder.js, once evaluated, keep a live binding to
// whichever embeddings.js mock was active at their FIRST import in this
// process — a later test's `t.mock.module` call for the same specifier
// cannot retarget an already-cached importer's binding, so a real,
// non-throwing embed() fixture here would otherwise inherit a stale
// throwing mock from another file's earlier-run test. Nothing at the top of
// this file imports repository.js/embeddings.js (statically or
// dynamically) before the mock below is registered.
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
  "context builder's candidate dedup guard calls embed() at most once per attempted cluster even though the resulting vector now feeds candidateTopicAlreadyReviewed's similarity check, knowledgeCoversTopic, AND insertKnowledgeCandidate (issue #503, AC5)",
  { skip: dbSkip },
  async (t) => {
    let embeddingDim = 384;
    let embedCalls = 0;
    t.mock.module('../src/storage/embeddings.js', {
      namedExports: {
        // Call-count is this test's only concern; semantic accuracy of the
        // dedup checks themselves is covered with REAL embeddings in
        // tests/repository.test.ts (AC2/AC3).
        embed: async () => {
          embedCalls += 1;
          const vec = new Array(embeddingDim).fill(0);
          vec[0] = 1;
          return vec;
        },
      },
    });

    const { pool, closeDb } = await import('../src/storage/db.js');
    const { config } = await import('../src/config.js');
    embeddingDim = config.db.embeddingDim;
    const pgvector = (await import('pgvector/pg')).default;
    const { runContextBuilder } = await import('../src/context/builder.js');

    // config is `as const` (deep-readonly at the type level only) — same
    // narrow-cast-and-mutate convention as tests/contextBuilder.test.ts,
    // since env vars are only read once at config's own import time.
    const builderCfg = config.contextBuilder as {
      maxSummaries: number;
      minDistinctUsers: number;
      windowDays: number;
    };
    builderCfg.maxSummaries = 1;
    builderCfg.minDistinctUsers = 3;
    builderCfg.windowDays = 1;
    (config.contextCandidates as { enabled: boolean }).enabled = true;

    const RUN = `ctxembedcount${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const seed = async (axis: number, userId: string, content: string) => {
      const vec = new Array(embeddingDim).fill(0);
      vec[axis] = 1;
      const { rows } = await pool.query(
        `INSERT INTO interactions (platform, conversation_id, user_id, role, direction, content, embedding)
         VALUES ('discord', $1, $2, 'member', 'inbound', $3, $4) RETURNING id`,
        [`${RUN}-chan`, userId, content, pgvector.toSql(vec)],
      );
      return Number(rows[0].id);
    };

    await seed(31, `${RUN}-a1`, 'when is the next meetup?');
    await seed(31, `${RUN}-a2`, 'meetup date please?');
    await seed(31, `${RUN}-a3`, 'any update on the meetup?');

    try {
      const result = await runContextBuilder(async () => ({
        topic: `${RUN}-embed-count-topic`,
        summary: 'summary',
        candidate: { title: 'title', content: 'content' },
      }));

      assert.equal(result.digests, 1, 'the digest itself is still produced');
      assert.equal(embedCalls, 1, 'embed() is called at most once for this one attempted cluster');
    } finally {
      await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [`${RUN}-chan`]);
      await pool.query(
        `DELETE FROM knowledge_candidates WHERE digest_id IN (SELECT id FROM context_digests WHERE topic = $1)`,
        [`${RUN}-embed-count-topic`],
      );
      await pool.query(`DELETE FROM context_digests WHERE topic = $1`, [`${RUN}-embed-count-topic`]);
      await closeDb();
    }
  },
);
