import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it, matching
// lowRatedCaveatRouter.test.ts's convention. This file is a SEPARATE test
// file (not tools.test.ts) specifically so KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL
// can be set to a non-zero value here without disturbing tools.test.ts's
// default-off (byte-for-byte unchanged) coverage of the same handler — the
// node test runner isolates env per test file (issue #337's own convention).
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL = '2';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { config } = await import('../src/config.js');
const { buildToolServer, KNOWLEDGE_LOW_RATED_CAVEAT_TEXT } = await import('../src/agent/tools.js');
const { saveKnowledge, recordInteraction, createAnswerFeedback } =
  await import('../src/storage/repository.js');
const { pool, closeDb } = await import('../src/storage/db.js');
const { embed } = await import('../src/storage/embeddings.js');
const pgvector = (await import('pgvector/pg')).default;

await embed('warmup').catch(() => {});

after(async () => {
  await closeDb();
});

function stubAdapter(): PlatformAdapter {
  return {
    platform: 'discord',
    start: async () => {},
    stop: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    sendMessage: async () => {},
    sendDirectMessage: async () => {},
    conversationsForUser: async () => [],
    adminCapabilities: new Set(),
    performAdminAction: async () => {
      throw new Error('not implemented in stub');
    },
  };
}

function getKnowledgeSearchHandler(caller: {
  platform: 'discord';
  userId: string;
  userName: string;
  role: 'member';
  conversationId: string;
}) {
  const server = buildToolServer(caller, stubAdapter());
  return (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: { query: string }) => Promise<{ content: Array<{ type: string; text: string }> }> }
      >;
    }
  )._registeredTools['knowledge_search'];
}

/** A unit vector at an exact cosine similarity `rho` to `anchor` (mirrors tools.test.ts's own helper). */
function atCosineSimilarity(anchor: number[], rho: number): number[] {
  const dim = anchor.length;
  const seed = new Array(dim).fill(0);
  seed[Math.abs(anchor[0]) > 0.9 ? 1 : 0] = 1;
  const dot = seed.reduce((s, v, i) => s + v * anchor[i], 0);
  const orth = seed.map((v, i) => v - dot * anchor[i]);
  const norm = Math.sqrt(orth.reduce((s, v) => s + v * v, 0));
  const unitOrth = orth.map((v) => v / norm);
  const scale = Math.sqrt(1 - rho * rho);
  return anchor.map((v, i) => rho * v + scale * unitOrth[i]);
}

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

test('config: KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL=2 is reflected in config.behaviour.knowledgeLowRatedCaveatMinUnhelpful', () => {
  assert.equal(config.behaviour.knowledgeLowRatedCaveatMinUnhelpful, 2);
});

test(
  "knowledge_search tool handler appends the low-rated caveat to only the low-rated hit's own line, never a sibling relevant hit's line (issue #432)",
  { skip },
  async () => {
    const scope = `${RUN}-per-hit`;
    const query = 'what is the community refund policy for paid events';
    const anchorVec = await embed(query);
    const siblingVec = atCosineSimilarity(anchorVec, 0.6); // clears the 0.35 relevance floor

    const { rows: lowRatedRows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [
        scope,
        `Refund policy ${RUN}`,
        'Refunds are available within 7 days of purchase.',
        pgvector.toSql(anchorVec),
      ],
    );
    const { rows: siblingRows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [
        scope,
        `Refund exceptions ${RUN}`,
        'Exceptions apply for cancelled events.',
        pgvector.toSql(siblingVec),
      ],
    );
    const lowRatedId = Number(lowRatedRows[0].id);
    const siblingId = Number(siblingRows[0].id);

    // 2 unhelpful ratings on lowRatedId only, via the same
    // interactions.meta.knowledgeEntryId join the normal knowledge_search
    // path stamps (issue #411/#413) — never via the shortcut-only
    // knowledgeShortcut meta flag.
    for (const suffix of ['a', 'b']) {
      const userId = `${RUN}-rater-${suffix}`;
      await recordInteraction({
        platform: 'discord',
        conversationId: scope,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `knowledge_search answer referencing entry for ${userId}`,
        meta: { knowledgeEntryId: lowRatedId },
      });
      const feedback = await createAnswerFeedback({
        platform: 'discord',
        conversationId: scope,
        userId,
        helpful: false,
      });
      assert.notEqual(feedback, 'no_recent_answer');
      assert.notEqual(feedback, 'rate_limited');
    }

    const caller = {
      platform: 'discord' as const,
      userId: `${RUN}-per-hit-member`,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
    };
    const result = await getKnowledgeSearchHandler(caller).handler({ query });
    const text = result.content[0]?.text ?? '';

    const lines = text.split('\n');
    const lowRatedLine = lines.find((l) => l.includes('Refund policy'));
    const siblingLine = lines.find((l) => l.includes('Refund exceptions'));
    assert.ok(lowRatedLine, 'the low-rated hit must be present in the reply');
    assert.ok(siblingLine, 'the sibling relevant hit must be present in the reply');
    assert.match(
      lowRatedLine ?? '',
      new RegExp(KNOWLEDGE_LOW_RATED_CAVEAT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      "the caveat must render on the low-rated hit's own line",
    );
    assert.doesNotMatch(
      siblingLine ?? '',
      new RegExp(KNOWLEDGE_LOW_RATED_CAVEAT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the caveat must never leak onto a sibling hit that is not itself low-rated',
    );
    assert.equal(
      (text.match(/rate_answer/g) ?? []).length,
      1,
      'the caveat must appear exactly once total, not once per hit or as a result-wide line',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id LIKE $1`, [`${RUN}-rater-%`]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [scope]);
    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[lowRatedId, siblingId]]);
  },
);

test(
  'SECURITY: knowledge_search tool handler omits the low-rated caveat and still replies normally when the low-rated lookup query rejects, never throwing or blocking (issue #432)',
  { skip },
  async (t) => {
    const scope = `${RUN}-lookup-fails`;
    const { id } = await saveKnowledge({
      title: `Lookup-fails entry ${RUN}`,
      content: 'This entry is used to test a failing low-rated lookup.',
      scope,
    });

    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('WHERE knowledge.id = ANY($1)')) {
        return Promise.reject(new Error('DB unreachable'));
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const caller = {
      platform: 'discord' as const,
      userId: `${RUN}-lookup-fails-member`,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
    };
    const result = await getKnowledgeSearchHandler(caller).handler({
      query: 'This entry is used to test a failing low-rated lookup.',
    });
    const text = result.content[0]?.text ?? '';

    assert.match(text, /Lookup-fails entry/, 'the reply must still render the hit despite the failed lookup');
    assert.doesNotMatch(
      text,
      /rate_answer/,
      'a failed lookup must omit the caveat, never crash or block the reply',
    );

    t.mock.reset();
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
  },
);
