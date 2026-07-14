import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/repository.test.ts.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { saveKnowledge, searchKnowledge, searchKnowledgeLexical } =
  await import('../src/storage/repository.js');
const { KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD } = await import('../src/agent/tools.js');

// Unique per test-run tag so fixtures never collide across runs and can be
// cleaned up precisely, mirroring the RUN-tag convention in
// tests/repository.test.ts.
const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const EVAL_SCOPE = `${RUN}-knowledge-eval`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM knowledge WHERE scope = $1`, [EVAL_SCOPE]);
  }
  await closeDb();
});

interface FixtureEntry {
  title: string;
  content: string;
}

interface FixtureQuery {
  query: string;
  expectedTitle: string;
  core: boolean;
}

interface FixtureNegativeQuery {
  query: string;
  label: string;
}

interface FixtureFallbackQuery {
  query: string;
  expectedTitle: string;
}

interface Fixture {
  entries: FixtureEntry[];
  queries: FixtureQuery[];
  negativeQueries: FixtureNegativeQuery[];
  fallbackQueries: FixtureFallbackQuery[];
}

const fixturePath = fileURLToPath(new URL('./fixtures/knowledgeEval.json', import.meta.url));
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

// How many top-ranked results we require the expected entry to appear
// within. Kept in sync with the proposal's precision@K definition.
const TOP_K = 3;

// searchKnowledge (issue #106) scopes results to 'global' + the caller's
// platform/conversation. These fixtures are saved under one conversation-like
// EVAL_SCOPE tag, and every lookup below passes a caller whose conversationId
// is that same tag, so retrieval here is unaffected by scoping (scope
// enforcement itself is covered by tests/knowledgeScope.test.ts). We still
// over-fetch and filter down to just this run's seeded fixture rows before
// computing rank — that keeps the pass/fail verdict independent of whatever
// else happens to be in the DB (CI's empty container vs. a developer's
// populated local instance), per the tightened acceptance criteria on issue
// #62.
const OVER_FETCH = 200;
const EVAL_CALLER = { platform: 'discord' as const, conversationId: EVAL_SCOPE };

// A small "must-hit" core (paraphrases of the most unambiguous entries) is
// asserted at 100% so one genuine ranking regression always fails the
// suite. The full set only needs to clear an aggregate floor so one
// borderline paraphrase can't red-flake CI on small N.
const CORE_FLOOR = 1;
const AGGREGATE_FLOOR = 0.8;

test(
  'knowledgeEval: knowledge_search retrieval precision@K holds against a curated golden query set',
  { skip },
  async () => {
    const contentToTitle = new Map(fixture.entries.map((e) => [e.content, e.title]));

    for (const entry of fixture.entries) {
      await saveKnowledge({ title: entry.title, content: entry.content, scope: EVAL_SCOPE });
    }

    const misses: Array<{ query: string; expectedTitle: string; core: boolean; got: (string | null)[] }> = [];
    let hits = 0;

    for (const q of fixture.queries) {
      const results = await searchKnowledge(q.query, EVAL_CALLER, OVER_FETCH);
      // Restrict to rows belonging to this run's fixture set (see OVER_FETCH
      // comment above), then take the top-K of what's left.
      const ownTopK = results
        .filter((r) => contentToTitle.has(r.content))
        .slice(0, TOP_K)
        .map((r) => r.title);

      const hit = ownTopK.includes(q.expectedTitle);
      if (hit) {
        hits += 1;
      } else {
        misses.push({ query: q.query, expectedTitle: q.expectedTitle, core: q.core, got: ownTopK });
      }
    }

    if (misses.length > 0) {
      console.log('knowledgeEval misses (query -> expected vs. top-K got):');
      for (const m of misses) {
        console.log(
          `  [${m.core ? 'CORE' : 'aggregate'}] "${m.query}" -> expected "${m.expectedTitle}", got ${JSON.stringify(m.got)}`,
        );
      }
    }

    const coreMisses = misses.filter((m) => m.core);
    assert.equal(
      coreMisses.length,
      0,
      `must-hit core queries missed retrieval (floor ${CORE_FLOOR * 100}%): ${coreMisses
        .map((m) => m.query)
        .join(', ')}`,
    );

    const precision = hits / fixture.queries.length;
    assert.ok(
      precision >= AGGREGATE_FLOOR,
      `aggregate precision@${TOP_K} ${(precision * 100).toFixed(1)}% is below the ${
        AGGREGATE_FLOOR * 100
      }% floor — see logged misses above`,
    );
  },
);

test(
  "knowledgeEval: negative queries (issue #95) stay below KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD against this fixture's own entries",
  { skip },
  async () => {
    // Reseeds the same fixture rows under EVAL_SCOPE; harmless duplicates —
    // this test only cares about the ceiling on similarity, which is
    // unaffected by repeated identical rows, and the shared `after` hook
    // cleans up everything under EVAL_SCOPE regardless of row count.
    for (const entry of fixture.entries) {
      await saveKnowledge({ title: entry.title, content: entry.content, scope: EVAL_SCOPE });
    }
    const seededContent = new Set(fixture.entries.map((e) => e.content));

    const overThreshold: Array<{ query: string; label: string; similarity: number; title: string | null }> =
      [];
    for (const n of fixture.negativeQueries) {
      const results = (await searchKnowledge(n.query, EVAL_CALLER, OVER_FETCH)).filter((r) =>
        seededContent.has(r.content),
      );
      const top = results[0];
      if (top && top.similarity >= KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD) {
        overThreshold.push({ query: n.query, label: n.label, similarity: top.similarity, title: top.title });
      }
    }

    assert.equal(
      overThreshold.length,
      0,
      `negative quer${overThreshold.length === 1 ? 'y' : 'ies'} scored at/above KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD ` +
        `(${KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD}) against this fixture's entries — the threshold in src/agent/tools.ts ` +
        `needs re-deriving (embedding model drift?): ${JSON.stringify(overThreshold)}`,
    );
  },
);

test(
  'knowledgeEval: fallbackQueries (issue #362) — searchKnowledgeLexical resolves an exact-string query to its expectedTitle without a false positive against any other fixture entry (including distractors)',
  { skip },
  async () => {
    // Reseeds the same fixture rows under EVAL_SCOPE; harmless duplicates,
    // same convention as the negativeQueries test above.
    for (const entry of fixture.entries) {
      await saveKnowledge({ title: entry.title, content: entry.content, scope: EVAL_SCOPE });
    }
    const titleByContent = new Map(fixture.entries.map((e) => [e.content, e.title]));

    const failures: Array<{ query: string; expectedTitle: string; got: string | null | undefined }> = [];
    for (const q of fixture.fallbackQueries) {
      const top = (await searchKnowledgeLexical(q.query, EVAL_CALLER, OVER_FETCH)).filter((r) =>
        titleByContent.has(r.content),
      )[0];
      if (!top || top.title !== q.expectedTitle) {
        failures.push({ query: q.query, expectedTitle: q.expectedTitle, got: top?.title });
      }
    }

    assert.equal(
      failures.length,
      0,
      `fallback quer${failures.length === 1 ? 'y' : 'ies'} did not resolve to its expectedTitle via the lexical ` +
        `fallback (empty result, or a false-positive match against a different fixture entry): ${JSON.stringify(failures)}`,
    );
  },
);
