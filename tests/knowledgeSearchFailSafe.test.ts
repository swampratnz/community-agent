import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/base/platforms/types.js';

// Fail-safe coverage for the two SUPPLEMENTARY lookups inside the
// knowledge_search handler: the advisory conflict badge
// (`hasConflictAmongIds`) and the below-floor lexical fallback
// (`searchKnowledgeLexical`). Both were unguarded awaits, so a transient
// rejection replaced results the handler had ALREADY fetched successfully
// with a raw driver error — which the MCP layer returns verbatim as an
// `isError` tool result, i.e. straight into model context. These pin the
// same invariant `knowledgeSearchLowRatedCaveat.test.ts` pins for the
// low-rated caveat (issue #432), using that file's exact
// reject-one-SQL-fragment technique.
//
// A SEPARATE file (not knowledgeSearchLowRatedCaveat.test.ts) so the
// low-rated caveat stays at its default-off value here: these tests are about
// the conflict/lexical guards alone, and the node test runner isolates env
// per file (issue #337's own convention).
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { buildToolServer, KNOWLEDGE_CONFLICT_CAVEAT_TEXT } = await import('../src/module/agent/tools.js');
const { pool, closeDb } = await import('../src/base/storage/db.js');
const { embed } = await import('../src/base/storage/embeddings.js');
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

function makeCaller(scope: string) {
  return {
    platform: 'discord' as const,
    userId: `${RUN}-member`,
    userName: 'Member',
    role: 'member' as const,
    conversationId: scope,
  };
}

test(
  'SECURITY: knowledge_search omits the conflict badge and still returns its hits when the conflict-check query rejects, never surfacing the DB error (issue #389)',
  { skip },
  async (t) => {
    const scope = `${RUN}-conflict-fails`;
    const query = 'what is the community refund policy for paid events';
    const anchorVec = await embed(query);
    // Two hits BOTH clearing the 0.35 relevance floor — that is what makes
    // relevantIds.length >= 2 and so actually reaches hasConflictAmongIds
    // (below 2 ids it short-circuits without a query at all).
    const near = atCosineSimilarity(anchorVec, 0.9);
    const alsoNear = atCosineSimilarity(anchorVec, 0.6);

    const { rows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding)
       VALUES ($1,$2,$3,$4), ($1,$5,$6,$7) RETURNING id`,
      [
        scope,
        `Refund policy ${RUN}`,
        'Refunds are available within 7 days of purchase.',
        pgvector.toSql(near),
        `Refund exceptions ${RUN}`,
        'Exceptions apply for cancelled events.',
        pgvector.toSql(alsoNear),
      ],
    );
    const ids = rows.map((r: { id: string }) => Number(r.id));

    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      // The self-join is unique to hasConflictAmongIds; every other query the
      // handler issues (including searchKnowledge's own) passes through.
      if (typeof sql === 'string' && sql.includes('JOIN knowledge b ON a.id < b.id')) {
        return Promise.reject(new Error('DB unreachable'));
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const result = await getKnowledgeSearchHandler(makeCaller(scope)).handler({ query });
    const text = result.content[0]?.text ?? '';

    assert.match(text, /Refund policy/, 'the hits must still render despite the failed conflict check');
    assert.match(text, /Refund exceptions/, 'both qualifying hits must still render');
    assert.doesNotMatch(
      text,
      new RegExp(KNOWLEDGE_CONFLICT_CAVEAT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'a failed conflict check must omit the badge rather than claim entries disagree',
    );
    assert.doesNotMatch(
      text,
      /DB unreachable/,
      'the raw driver error must never reach the tool result (and so model context)',
    );

    t.mock.reset();
    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [ids]);
  },
);

test(
  'SECURITY: knowledge_search degrades to a clean no-match instead of an error when the below-floor lexical fallback query rejects (issue #362)',
  { skip },
  async (t) => {
    const scope = `${RUN}-lexical-fails`;
    // Deliberately distinctive so no unrelated 'global' entry (docs-ingest
    // populates some in CI) outranks the fixture below.
    const query = `zzq lexical fallback probe phrase ${RUN}`;
    const anchorVec = await embed(query);
    // Below the 0.35 relevance floor but still the nearest row, so
    // searchKnowledge returns a hit whose id does NOT qualify — the exact
    // `hits.length > 0 && relevantIds.length === 0` branch that, and only
    // that, reaches searchKnowledgeLexical.
    const belowFloor = atCosineSimilarity(anchorVec, 0.3);

    const { rows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [
        scope,
        `Below-floor entry ${RUN}`,
        'This entry deliberately sits under the relevance floor for its probe query.',
        pgvector.toSql(belowFloor),
      ],
    );
    const id = Number(rows[0].id);

    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      // word_similarity() is unique to searchKnowledgeLexical's trigram match.
      if (typeof sql === 'string' && sql.includes("word_similarity($1, COALESCE(title, '')")) {
        return Promise.reject(new Error('DB unreachable'));
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    // Must RESOLVE, not reject: before the guard this threw, and the MCP layer
    // turns a thrown handler into an isError result carrying error.message.
    const result = await getKnowledgeSearchHandler(makeCaller(scope)).handler({ query });
    const text = result.content[0]?.text ?? '';

    assert.equal(
      text,
      'No matching knowledge entries.',
      'a failed lexical fallback must degrade to the normal no-match reply (a different reply here means a stray global entry cleared the floor and the fixture needs re-tuning)',
    );
    assert.doesNotMatch(
      text,
      /DB unreachable/,
      'the raw driver error must never reach the tool result (and so model context)',
    );

    t.mock.reset();
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
    // The below-floor branch also fire-and-forgets a knowledge_gaps row for
    // this query; clear it so the fixture leaves nothing behind.
    await pool.query(`DELETE FROM knowledge_gaps WHERE conversation_id = $1`, [scope]);
  },
);
