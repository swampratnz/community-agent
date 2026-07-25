import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Docs ingest. Parsing/chunking are pure (no DB); the ingest-run tests are
// DB-backed (skip without DATABASE_URL) and inject the fetcher so no network
// call ever happens.
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
const { config } = await import('../src/config.js');
const {
  parseDocIndex,
  titleForUrl,
  filterExcludedUrls,
  chunkMarkdown,
  shouldRunDocsIngest,
  runDocsIngest,
  partitionDeadUrls,
  DOCS_PROVENANCE,
} = await import('../src/context/docsIngest.js');

// Pin the dead-URL feature OFF for this file by default (issue #611). Every
// test written before it existed calls runDocsIngest WITHOUT stub deps, so with
// the feature on they would read/write the real docs_ingest_url_failures table
// against the shared CI database — and a URL failed by enough of them could
// start being SKIPPED, silently changing those tests' expected counts. The
// dead-URL tests at the bottom opt themselves back in via withDeadUrlConfig.
(config.docsIngest as { deadUrlRuns: number }).deadUrlRuns = 0;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM knowledge WHERE created_by_role = $1`, [DOCS_PROVENANCE]);
    await pool.query(`DELETE FROM knowledge WHERE title LIKE 'docs: %'`);
  }
  await closeDb();
});

// --- pure ------------------------------------------------------------------

test('SECURITY: parseDocIndex keeps only SAME-ORIGIN .md URLs — a third-party .md in the index is dropped, never ingested as trusted', () => {
  const idx = [
    '# Index',
    '- [Overview](https://platform.claude.com/docs/en/build-with-claude/overview.md)',
    'https://platform.claude.com/docs/en/api/messages.md',
    '- [dup](https://platform.claude.com/docs/en/api/messages.md)',
    '- [evil, same path different host](https://evil.example.com/docs/en/api/messages.md)',
    'not a url, and https://example.com/page.html should be ignored',
  ].join('\n');
  const urls = parseDocIndex(idx, 'https://platform.claude.com');
  assert.deepEqual(urls.sort(), [
    'https://platform.claude.com/docs/en/api/messages.md',
    'https://platform.claude.com/docs/en/build-with-claude/overview.md',
  ]);
  assert.ok(!urls.some((u) => u.includes('evil')), 'a foreign-origin .md must never survive the index parse');
});

test('titleForUrl derives a short stable title', () => {
  assert.equal(titleForUrl('https://platform.claude.com/docs/en/api/messages.md'), 'docs: api/messages');
});

test('filterExcludedUrls drops pages at/under an excluded prefix, keeps everything else (and prefix boundaries are respected)', () => {
  const base = 'https://platform.claude.com/docs/en';
  const urls = [
    `${base}/api/messages.md`,
    `${base}/api/python.md`, // the section index page itself
    `${base}/api/python/client.md`, // under it
    `${base}/api/pythonic/thing.md`, // NOT under api/python (boundary)
    `${base}/build-with-claude/tool-use.md`,
  ];
  const kept = filterExcludedUrls(urls, ['api/python', 'api/go']);
  assert.deepEqual(kept, [
    `${base}/api/messages.md`,
    `${base}/api/pythonic/thing.md`,
    `${base}/build-with-claude/tool-use.md`,
  ]);
  assert.equal(filterExcludedUrls(urls, []).length, urls.length, 'empty exclude list keeps everything');
});

test('chunkMarkdown splits at H2 only (### folds inline), prefixes the page title, and caps long sections', () => {
  const md = [
    '# Page Title',
    'intro paragraph',
    '',
    '## Section A',
    'body a',
    '### Sub A1',
    'sub detail a1',
    '',
    '## Section B',
    'body b',
  ].join('\n');
  const chunks = chunkMarkdown('docs: api/messages', md);
  const titles = chunks.map((c) => c.title);
  assert.deepEqual(
    titles,
    ['docs: api/messages', 'docs: api/messages › Section A', 'docs: api/messages › Section B'],
    'H1 and H3 do not create their own chunks — only H2 does',
  );
  assert.match(chunks[1].content, /^docs: api\/messages › Section A/, 'chunk carries its own context prefix');
  assert.match(chunks[1].content, /body a/);
  assert.match(chunks[1].content, /### Sub A1/, 'the ### subheading stays inline within its H2 chunk');
  assert.match(chunks[1].content, /sub detail a1/);

  // A very long section is hard-split into "(part N)".
  const long = ['## Big', ...Array.from({ length: 400 }, (_, i) => `line ${i} with some words`)].join('\n');
  const bigChunks = chunkMarkdown('docs: x', long);
  assert.ok(bigChunks.length >= 2, 'long section is split');
  assert.match(bigChunks[0].title, /Big \(part 1\)/);
  assert.match(bigChunks[1].title, /Big \(part 2\)/);

  // A page repeating a heading disambiguates the titles (never collides/overwrites).
  const dup = ['## Examples', 'first', '## Examples', 'second'].join('\n');
  const dupTitles = chunkMarkdown('docs: y', dup).map((c) => c.title);
  assert.equal(new Set(dupTitles).size, dupTitles.length, 'duplicate-heading chunk titles are made unique');
});

test('shouldRunDocsIngest: first run always, then only after ~a week', () => {
  const now = 1_000_000_000_000;
  assert.equal(shouldRunDocsIngest(null, now), true);
  assert.equal(shouldRunDocsIngest(new Date(now - 2 * 24 * 3_600_000), now), false, '2 days ago → skip');
  assert.equal(shouldRunDocsIngest(new Date(now - 7 * 24 * 3_600_000), now), true, '7 days ago → run');
});

// --- total-failure signal (issue #335) — no DB needed: both paths below
// return before any DB call is made, so they run regardless of DATABASE_URL.

test('runDocsIngest: indexFetchFailed is true when the llms.txt index itself fails to fetch — the total-failure signal defaultDocsIngestRun throws on', async () => {
  const failingIndex = async (_url: string): Promise<string> => {
    throw new Error('network down');
  };
  const res = await runDocsIngest(failingIndex);
  assert.equal(res.indexFetchFailed, true);
  assert.equal(res.pages, 0);
  assert.equal(res.failed, 0, 'no per-page failures are counted — the run never got to any page');
});

test('runDocsIngest: a reachable index that parses to zero page URLs is a legitimate no-op — indexFetchFailed stays false', async () => {
  const emptyIndex = async (_url: string): Promise<string> => '# Index\n\nno links here';
  const res = await runDocsIngest(emptyIndex);
  assert.equal(res.indexFetchFailed, false);
  assert.equal(res.pages, 0);
});

test('runDocsIngest: index reachable but EVERY page fetch fails — indexFetchFailed stays false (that field is only for the index itself), yet pages > 0 && fetched === 0, the signal defaultDocsIngestRun uses to still detect this as a total failure', async () => {
  const u1 = 'https://platform.claude.com/docs/en/api/messages.md';
  const u2 = 'https://platform.claude.com/docs/en/api/models.md';
  const indexOkAllPagesFail = async (url: string): Promise<string> => {
    if (url === config.docsIngest.indexUrl) return `- [a](${u1})\n- [b](${u2})`;
    throw new Error('docs host blocked the request');
  };
  const res = await runDocsIngest(indexOkAllPagesFail);
  assert.equal(res.indexFetchFailed, false, 'the index itself fetched fine');
  assert.equal(res.pages, 2);
  assert.equal(res.fetched, 0, 'no page fetch succeeded');
  assert.equal(res.failed, 2, 'both page fetches are counted as failures');
});

// --- fetch-failure log batching (issue #613). Only the all-fetches-fail case
// is genuinely DB-free: with zero successful fetches nothing is chunked, so
// `seen` stays empty and runDocsIngest returns before the prune's
// listGlobalKnowledgeTitlesByProvenance call. The other two here have at
// least one SUCCESSFUL fetch, which reaches both syncGlobalKnowledgeByProvenance
// and that prune query — so they are DB-backed and carry `{ skip }` like every
// other DB-touching test in this file, rather than failing without a local
// Postgres (CLAUDE.md).

test(
  'runDocsIngest: F failed page fetches emit exactly ONE warn-level summary line (not F), with count/sample/rollup, plus one debug line per failure',
  { skip },
  async (t) => {
    const { logger } = await import('../src/logger.js');
    const warn = t.mock.method(logger, 'warn');
    const debug = t.mock.method(logger, 'debug');

    const ok = 'https://platform.claude.com/docs/en/api/messages.md';
    const dead = Array.from(
      { length: 3 },
      (_, i) => `https://platform.claude.com/docs/en/api/terraform/beta/page-${i}.md`,
    );
    const index = `- [ok](${ok})\n` + dead.map((u) => `- [d](${u})`).join('\n');
    const fetchText = async (url: string): Promise<string> => {
      if (url === config.docsIngest.indexUrl) return index;
      if (url === ok) return 'Messages API.';
      throw new Error(`404 ${url}`);
    };

    const res = await runDocsIngest(fetchText);

    assert.equal(res.failed, 3);
    assert.equal(res.fetched, 1);

    const fetchFailureWarns = warn.mock.calls.filter(
      (c) => c.arguments[1] === 'Docs ingest: page fetch failures',
    );
    assert.equal(
      fetchFailureWarns.length,
      1,
      'exactly one warn call for fetch failures, however many pages failed',
    );
    const payload = fetchFailureWarns[0].arguments[0] as {
      failed: number;
      attempted: number;
      sample: string[];
      rollup: string;
    };
    assert.equal(payload.failed, 3);
    assert.equal(payload.attempted, 4);
    assert.equal(payload.sample.length, 3, 'sample capped at <=5 (here, all 3 failures)');
    assert.match(
      payload.rollup,
      /3× api\/terraform\/beta/,
      'by-prefix rollup groups the dead tranche together',
    );

    assert.equal(debug.mock.calls.length, 3, 'one debug line per failed URL, unchanged shape');
    for (const call of debug.mock.calls) {
      assert.equal(call.arguments[1], 'Docs ingest: page fetch failed');
      assert.ok((call.arguments[0] as { url: string }).url, 'debug payload still carries the url');
    }
  },
);

test('runDocsIngest: the fetch-failure summary sample is capped at 5 URLs even with many more failures', async (t) => {
  const { logger } = await import('../src/logger.js');
  const warn = t.mock.method(logger, 'warn');

  const dead = Array.from(
    { length: 8 },
    (_, i) => `https://platform.claude.com/docs/en/api/terraform/beta/page-${i}.md`,
  );
  const index = dead.map((u) => `- [d](${u})`).join('\n');
  const fetchText = async (url: string): Promise<string> => {
    if (url === config.docsIngest.indexUrl) return index;
    throw new Error(`404 ${url}`);
  };

  const res = await runDocsIngest(fetchText);
  assert.equal(res.failed, 8);

  const fetchFailureWarns = warn.mock.calls.filter(
    (c) => c.arguments[1] === 'Docs ingest: page fetch failures',
  );
  assert.equal(fetchFailureWarns.length, 1);
  const payload = fetchFailureWarns[0].arguments[0] as { sample: string[]; failed: number };
  assert.equal(payload.failed, 8, 'the full count is reported even though the sample is capped');
  assert.equal(payload.sample.length, 5, 'sample capped at <=5 URLs');
});

test(
  'runDocsIngest: zero failed fetches emit no fetch-failure warning (unchanged from today)',
  { skip },
  async (t) => {
    const { logger } = await import('../src/logger.js');
    const warn = t.mock.method(logger, 'warn');

    const u1 = 'https://platform.claude.com/docs/en/api/messages.md';
    const fetchText = async (url: string): Promise<string> => {
      if (url === config.docsIngest.indexUrl) return `- [a](${u1})`;
      return 'Messages API.';
    };

    const res = await runDocsIngest(fetchText);
    assert.equal(res.failed, 0);

    const fetchFailureWarns = warn.mock.calls.filter(
      (c) => c.arguments[1] === 'Docs ingest: page fetch failures',
    );
    assert.equal(fetchFailureWarns.length, 0, 'no fetch-failure summary when nothing failed');
  },
);

test(
  'runDocsIngest: chunk-upsert failures are untouched by the fetch-failure summary — still one warn per upsert failure, at the pre-existing message',
  { skip },
  async (t) => {
    const { pool } = await import('../src/storage/db.js');
    const { logger } = await import('../src/logger.js');
    const warn = t.mock.method(logger, 'warn');
    await pool.query(`DELETE FROM knowledge WHERE created_by_role = $1`, [DOCS_PROVENANCE]);

    // Fail only syncGlobalKnowledgeByProvenance's lookup SELECT — the prune
    // step's own queries (listGlobalKnowledgeTitlesByProvenance /
    // deleteProvenancedKnowledgeByTitles) still hit the real DB.
    const origQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes(`FROM knowledge WHERE title = $1 AND scope = 'global'`)) {
        throw new Error('simulated write failure');
      }
      return origQuery(sql, params);
    });

    const u1 = 'https://platform.claude.com/docs/en/api/messages.md';
    const fetchText = async (url: string): Promise<string> => {
      if (url === config.docsIngest.indexUrl) return `- [a](${u1})`;
      return 'Messages API.';
    };

    const res = await runDocsIngest(fetchText);
    assert.equal(res.failed, 1, 'the chunk-upsert failure still counts toward failed');
    assert.equal(res.fetched, 1, 'the page fetch itself succeeded');

    const upsertWarns = warn.mock.calls.filter((c) => c.arguments[1] === 'Docs ingest: chunk upsert failed');
    assert.equal(upsertWarns.length, 1, 'the pre-existing per-upsert warn is unchanged by this proposal');
    const fetchFailureWarns = warn.mock.calls.filter(
      (c) => c.arguments[1] === 'Docs ingest: page fetch failures',
    );
    assert.equal(fetchFailureWarns.length, 0, 'no fetch-failure summary — the page fetch itself succeeded');

    await pool.query(`DELETE FROM knowledge WHERE created_by_role = $1`, [DOCS_PROVENANCE]);
  },
);

// --- DB-backed, injected fetcher -------------------------------------------

/** Build an injected fetchText from an index page-list + a per-URL body map. */
function fakeFetcher(pageBodies: Record<string, string>) {
  const index = Object.keys(pageBodies)
    .map((u) => `- [x](${u})`)
    .join('\n');
  return async (url: string): Promise<string> => {
    if (url === config.docsIngest.indexUrl) return index;
    const body = pageBodies[url];
    if (body === undefined) throw new Error(`404 ${url}`);
    return body;
  };
}

test(
  'runDocsIngest: create, then diff — unchanged is skipped (no re-embed), changed is updated, removed is pruned',
  { skip },
  async () => {
    const u1 = 'https://platform.claude.com/docs/en/api/messages.md';
    const u2 = 'https://platform.claude.com/docs/en/build-with-claude/tool-use.md';

    // First run: two single-chunk pages -> both created.
    const first = await runDocsIngest(fakeFetcher({ [u1]: 'Messages API v1.', [u2]: 'Tool use v1.' }));
    assert.equal(first.created, 2, 'two chunks created');
    assert.equal(first.updated, 0);

    // Same content -> all unchanged (the diff efficiency: no re-embed).
    const same = await runDocsIngest(fakeFetcher({ [u1]: 'Messages API v1.', [u2]: 'Tool use v1.' }));
    assert.equal(same.unchanged, 2, 'identical content skips re-embed');
    assert.equal(same.created, 0);
    assert.equal(same.updated, 0);

    // Change one page, drop the other from the index.
    const changed = await runDocsIngest(fakeFetcher({ [u1]: 'Messages API v2 — new params.' }));
    assert.equal(changed.updated, 1, 'the changed page is updated');
    assert.ok(changed.removed >= 1, 'the dropped page is pruned');

    const remaining = await pool.query(
      `SELECT title, content, created_by_role FROM knowledge WHERE created_by_role = $1`,
      [DOCS_PROVENANCE],
    );
    assert.equal(remaining.rows.length, 1, 'only the surviving page remains');
    assert.equal(remaining.rows[0].created_by_role, 'docs');
    assert.match(remaining.rows[0].content, /v2 — new params/);
  },
);

test(
  'runDocsIngest: created/updated chunks carry their source_url/source_title and a verified_at (issue #214)',
  { skip },
  async () => {
    const u1 = 'https://platform.claude.com/docs/en/api/messages.md';
    await pool.query(`DELETE FROM knowledge WHERE created_by_role = $1`, [DOCS_PROVENANCE]);

    await runDocsIngest(fakeFetcher({ [u1]: 'Messages API v1.' }));
    const created = await pool.query(
      `SELECT source_url, source_title, verified_at FROM knowledge WHERE created_by_role = $1`,
      [DOCS_PROVENANCE],
    );
    assert.equal(created.rows.length, 1);
    assert.equal(created.rows[0].source_url, u1, 'the page URL is populated automatically');
    assert.match(created.rows[0].source_title, /^docs: api\/messages/);
    assert.ok(created.rows[0].verified_at, 'verified_at is set at ingest time');

    const firstVerifiedAt = new Date(created.rows[0].verified_at).getTime();
    await new Promise((r) => setTimeout(r, 10));
    await runDocsIngest(fakeFetcher({ [u1]: 'Messages API v2 — new params.' }));
    const updated = await pool.query(
      `SELECT source_url, verified_at FROM knowledge WHERE created_by_role = $1`,
      [DOCS_PROVENANCE],
    );
    assert.equal(updated.rows[0].source_url, u1, 'source_url survives a content update');
    assert.ok(
      new Date(updated.rows[0].verified_at).getTime() >= firstVerifiedAt,
      'a content-changed re-ingest re-verifies the citation',
    );

    await pool.query(`DELETE FROM knowledge WHERE created_by_role = $1`, [DOCS_PROVENANCE]);
  },
);

test(
  'runDocsIngest: an "unchanged" content diff still backfills a missing source_url without touching updated_at (pre-#214 rows)',
  { skip },
  async () => {
    const u1 = 'https://platform.claude.com/docs/en/api/messages.md';
    await pool.query(`DELETE FROM knowledge WHERE created_by_role = $1`, [DOCS_PROVENANCE]);

    // Seed a row, then null out its source fields to simulate one ingested
    // before this feature existed.
    await runDocsIngest(fakeFetcher({ [u1]: 'Messages API v1.' }));
    await pool.query(
      `UPDATE knowledge SET source_url = NULL, source_title = NULL, verified_at = NULL WHERE created_by_role = $1`,
      [DOCS_PROVENANCE],
    );
    const before = await pool.query(`SELECT updated_at FROM knowledge WHERE created_by_role = $1`, [
      DOCS_PROVENANCE,
    ]);

    const res = await runDocsIngest(fakeFetcher({ [u1]: 'Messages API v1.' })); // identical content -> unchanged
    assert.equal(res.unchanged, 1);

    const after = await pool.query(
      `SELECT source_url, verified_at, updated_at FROM knowledge WHERE created_by_role = $1`,
      [DOCS_PROVENANCE],
    );
    assert.equal(after.rows[0].source_url, u1, 'the backfill sets source_url even on an unchanged diff');
    assert.ok(after.rows[0].verified_at);
    assert.equal(
      new Date(after.rows[0].updated_at).getTime(),
      new Date(before.rows[0].updated_at).getTime(),
      'backfilling source metadata must not bump updated_at',
    );

    await pool.query(`DELETE FROM knowledge WHERE created_by_role = $1`, [DOCS_PROVENANCE]);
  },
);

test(
  'runDocsIngest: a page still listed in the index but transiently failing to fetch is NOT pruned (prune keys off the index, not fetch success)',
  { skip },
  async () => {
    const u1 = 'https://platform.claude.com/docs/en/api/messages.md';
    const u2 = 'https://platform.claude.com/docs/en/api/models.md';
    await pool.query(`DELETE FROM knowledge WHERE created_by_role = $1`, [DOCS_PROVENANCE]);

    await runDocsIngest(fakeFetcher({ [u1]: 'Messages.', [u2]: 'Models.' })); // both created

    // Both stay in the index, but u2's fetch 404s this run.
    const u2Fails = async (url: string): Promise<string> => {
      if (url === config.docsIngest.indexUrl) return `- [a](${u1})\n- [b](${u2})`;
      if (url === u1) return 'Messages.';
      throw new Error(`404 ${url}`);
    };
    const res = await runDocsIngest(u2Fails);
    assert.ok(res.failed >= 1, 'u2 failed to fetch');
    assert.equal(res.removed, 0, 'a still-indexed page that failed to fetch must NOT be pruned');

    const kept = await pool.query(
      `SELECT count(*) AS n FROM knowledge WHERE created_by_role = $1 AND title LIKE 'docs: api/models%'`,
      [DOCS_PROVENANCE],
    );
    assert.ok(Number(kept.rows[0].n) >= 1, "u2's chunk survives a transient fetch failure");

    await pool.query(`DELETE FROM knowledge WHERE created_by_role = $1`, [DOCS_PROVENANCE]);
  },
);

test(
  'runDocsIngest: a page beyond DOCS_INGEST_MAX_PAGES is NOT pruned — prune keys off the FULL index, not the fetch cap',
  { skip },
  async () => {
    const u1 = 'https://platform.claude.com/docs/en/api/messages.md';
    const u2 = 'https://platform.claude.com/docs/en/api/models.md';
    await pool.query(`DELETE FROM knowledge WHERE created_by_role = $1`, [DOCS_PROVENANCE]);

    // Seed both pages (default cap fetches both).
    await runDocsIngest(fakeFetcher({ [u1]: 'Messages.', [u2]: 'Models.' }));

    // Cap the fetch to one page — u2 is now past the cap but STILL in the index.
    const orig = config.docsIngest.maxPages;
    (config.docsIngest as { maxPages: number }).maxPages = 1;
    try {
      const res = await runDocsIngest(fakeFetcher({ [u1]: 'Messages.', [u2]: 'Models.' }));
      assert.equal(res.pages, 1, 'fetch is capped to one page');
      assert.equal(res.removed, 0, 'a still-indexed page past the fetch cap must NOT be pruned');
    } finally {
      (config.docsIngest as { maxPages: number }).maxPages = orig;
    }

    const kept = await pool.query(
      `SELECT count(*) AS n FROM knowledge WHERE created_by_role = $1 AND title LIKE 'docs: api/models%'`,
      [DOCS_PROVENANCE],
    );
    assert.ok(Number(kept.rows[0].n) >= 1, 'u2 survives being past the fetch cap');
    await pool.query(`DELETE FROM knowledge WHERE created_by_role = $1`, [DOCS_PROVENANCE]);
  },
);

test(
  'SECURITY: docs ingest never overwrites or prunes a human-authored entry sharing a docs title',
  { skip },
  async () => {
    const u1 = 'https://platform.claude.com/docs/en/api/messages.md';
    const humanTitle = titleForUrl(u1); // exactly the title the ingest would use
    await pool.query(`DELETE FROM knowledge WHERE title = $1 AND scope = 'global'`, [humanTitle]);
    await pool.query(
      `INSERT INTO knowledge (scope, title, content, created_by_role) VALUES ('global', $1, $2, 'admin')`,
      [humanTitle, 'Human-curated, trusted content.'],
    );

    const res = await runDocsIngest(fakeFetcher({ [u1]: 'Machine-ingested docs content.' }));

    const row = (
      await pool.query(
        `SELECT content, created_by_role FROM knowledge WHERE title = $1 AND scope = 'global'`,
        [humanTitle],
      )
    ).rows;
    assert.equal(row.length, 1, 'no colliding duplicate');
    assert.equal(row[0].created_by_role, 'admin', 'human provenance preserved (never becomes docs)');
    assert.equal(
      row[0].content,
      'Human-curated, trusted content.',
      'human content never overwritten by ingest',
    );
    assert.ok(res.skipped >= 1, 'the collided chunk is reported skipped');

    await pool.query(`DELETE FROM knowledge WHERE title = $1 AND scope = 'global'`, [humanTitle]);
  },
);

// --- Dead-URL skipping (issue #611) -----------------------------------------
// The upstream index habitually lists a tranche of pages that don't exist (one
// observed run: 157/586 404ing under api/terraform/beta/*). #613 batched the
// LOGGING of those failures; this closes #611's remaining ask — stop re-fetching
// them every run, report once, and self-heal via a periodic re-probe.

const DEAD_URL = 'https://platform.claude.com/docs/en/api/terraform/beta/dead.md';
const LIVE_URL = 'https://platform.claude.com/docs/en/api/messages.md';

/** A failure-state entry as listDocsIngestUrlFailures would return it. */
function failure(url: string, consecutiveFailures: number, agedDays = 0, reportedAt: Date | null = null) {
  return {
    url,
    consecutiveFailures,
    lastFailedAt: new Date(Date.now() - agedDays * 86_400_000),
    reportedAt,
  };
}

/** Captures every dead-URL store call so a test can assert on the bookkeeping. */
function stubDeadUrlStore(failures: ReturnType<typeof failure>[] = []) {
  const calls = {
    recorded: [] as string[][],
    cleared: [] as string[][],
    reported: [] as string[][],
  };
  return {
    calls,
    deps: {
      listFailures: async () => failures,
      recordFailures: async (urls: readonly string[]) => {
        calls.recorded.push([...urls]);
      },
      clearFailures: async (urls: readonly string[]) => {
        calls.cleared.push([...urls]);
      },
      markReported: async (urls: readonly string[]) => {
        calls.reported.push([...urls]);
      },
    },
  };
}

/** Runs `fn` with the dead-URL config knobs overridden, restoring them after. */
async function withDeadUrlConfig(runs: number, recheckDays: number, fn: () => Promise<void>): Promise<void> {
  const cfg = config.docsIngest as { deadUrlRuns: number; deadUrlRecheckDays: number };
  const wasRuns = cfg.deadUrlRuns;
  const wasDays = cfg.deadUrlRecheckDays;
  cfg.deadUrlRuns = runs;
  cfg.deadUrlRecheckDays = recheckDays;
  try {
    await fn();
  } finally {
    cfg.deadUrlRuns = wasRuns;
    cfg.deadUrlRecheckDays = wasDays;
  }
}

test('partitionDeadUrls: skips only URLs at/over the threshold that are still inside the re-probe cooldown', () => {
  const now = Date.now();
  const recheckMs = 30 * 86_400_000;
  const state = new Map([
    ['a', { consecutiveFailures: 1, lastFailedAt: new Date(now) }], // under threshold
    ['b', { consecutiveFailures: 3, lastFailedAt: new Date(now) }], // dead, in cooldown
    ['c', { consecutiveFailures: 9, lastFailedAt: new Date(now - 31 * 86_400_000) }], // dead, due for re-probe
  ]);
  const { toFetch, skipped } = partitionDeadUrls(['a', 'b', 'c', 'd'], state, 3, recheckMs, now);
  assert.deepEqual(skipped, ['b'], 'only the in-cooldown dead URL is skipped');
  assert.deepEqual(
    toFetch,
    ['a', 'c', 'd'],
    'under-threshold, due-for-re-probe, and never-failed URLs are all fetched',
  );
});

test('partitionDeadUrls: deadRuns=0 disables skipping entirely — every listed URL is fetched', () => {
  const now = Date.now();
  const state = new Map([['b', { consecutiveFailures: 99, lastFailedAt: new Date(now) }]]);
  const { toFetch, skipped } = partitionDeadUrls(['a', 'b'], state, 0, 30 * 86_400_000, now);
  assert.deepEqual(skipped, []);
  assert.deepEqual(toFetch, ['a', 'b'], 'a long-dead URL is still fetched when the feature is off');
});

test('partitionDeadUrls: a URL exactly AT the threshold is skipped (>=, not >)', () => {
  const now = Date.now();
  const state = new Map([['b', { consecutiveFailures: 3, lastFailedAt: new Date(now) }]]);
  const { skipped } = partitionDeadUrls(['b'], state, 3, 30 * 86_400_000, now);
  assert.deepEqual(skipped, ['b']);
});

test('runDocsIngest: a persistently-dead URL is not fetched at all and is counted in deadSkipped', async () => {
  await withDeadUrlConfig(3, 30, async () => {
    const { calls, deps } = stubDeadUrlStore([failure(DEAD_URL, 3)]);
    const attempted: string[] = [];
    const fetchText = async (url: string): Promise<string> => {
      if (url === config.docsIngest.indexUrl) return `- [a](${DEAD_URL})\n- [b](${LIVE_URL})`;
      attempted.push(url);
      throw new Error(`404 ${url}`); // LIVE_URL also fails, keeping this test DB-free
    };

    const res = await runDocsIngest(fetchText, deps);

    assert.ok(!attempted.includes(DEAD_URL), 'the dead URL costs no request at all');
    assert.deepEqual(attempted, [LIVE_URL], 'only the non-dead URL is attempted');
    assert.equal(res.deadSkipped, 1, 'the skip is counted');
    assert.equal(res.pages, 2, 'pages still reflects the full index slice');
    assert.equal(res.failed, 1, 'only the attempted-and-failed page counts as failed');
    assert.deepEqual(calls.recorded, [[LIVE_URL]], 'only the attempted failure bumps a streak');
  });
});

test('runDocsIngest: a URL crossing the dead threshold is reported ONCE and stamped reported', async (t) => {
  await withDeadUrlConfig(3, 30, async () => {
    const { logger } = await import('../src/logger.js');
    const warn = t.mock.method(logger, 'warn');
    // Two prior consecutive failures — this run's failure is the 3rd, crossing.
    const { calls, deps } = stubDeadUrlStore([failure(DEAD_URL, 2)]);
    const fetchText = async (url: string): Promise<string> => {
      if (url === config.docsIngest.indexUrl) return `- [a](${DEAD_URL})`;
      throw new Error(`404 ${url}`);
    };

    await runDocsIngest(fetchText, deps);

    const deadWarns = warn.mock.calls.filter(
      (c) =>
        c.arguments[1] === 'Docs ingest: URLs persistently failing; skipping them until the next re-probe',
    );
    assert.equal(deadWarns.length, 1, 'exactly one newly-dead report');
    const payload = deadWarns[0].arguments[0] as { count: number; sample: string[]; rollup: string };
    assert.equal(payload.count, 1);
    assert.deepEqual(payload.sample, [DEAD_URL]);
    assert.match(payload.rollup, /1× api\/terraform\/beta/);
    assert.deepEqual(calls.reported, [[DEAD_URL]], 'the crossing is stamped so it is never re-reported');
  });
});

test('runDocsIngest: an ALREADY-reported dead URL that gets re-probed and fails again is not re-reported', async (t) => {
  await withDeadUrlConfig(3, 30, async () => {
    const { logger } = await import('../src/logger.js');
    const warn = t.mock.method(logger, 'warn');
    // Well past the threshold, already reported, and due for its re-probe.
    const { calls, deps } = stubDeadUrlStore([failure(DEAD_URL, 9, 31, new Date())]);
    const attempted: string[] = [];
    const fetchText = async (url: string): Promise<string> => {
      if (url === config.docsIngest.indexUrl) return `- [a](${DEAD_URL})`;
      attempted.push(url);
      throw new Error(`404 ${url}`);
    };

    const res = await runDocsIngest(fetchText, deps);

    assert.deepEqual(attempted, [DEAD_URL], 'the cooldown elapsed, so it IS re-probed exactly once');
    assert.equal(res.deadSkipped, 0, 'a re-probed URL is not counted as skipped this run');
    const deadWarns = warn.mock.calls.filter(
      (c) =>
        c.arguments[1] === 'Docs ingest: URLs persistently failing; skipping them until the next re-probe',
    );
    assert.equal(deadWarns.length, 0, 'no second report — the operator was already told once');
    assert.deepEqual(calls.reported, [], 'nothing re-stamped');
  });
});

test('runDocsIngest: with deadUrlRuns=0 a long-dead URL is still fetched and never reported', async (t) => {
  await withDeadUrlConfig(0, 30, async () => {
    const { logger } = await import('../src/logger.js');
    const warn = t.mock.method(logger, 'warn');
    const { calls, deps } = stubDeadUrlStore([failure(DEAD_URL, 99)]);
    const attempted: string[] = [];
    const fetchText = async (url: string): Promise<string> => {
      if (url === config.docsIngest.indexUrl) return `- [a](${DEAD_URL})`;
      attempted.push(url);
      throw new Error(`404 ${url}`);
    };

    const res = await runDocsIngest(fetchText, deps);

    assert.deepEqual(attempted, [DEAD_URL], 'skipping is off, so the URL is fetched as before');
    assert.equal(res.deadSkipped, 0);
    assert.equal(
      warn.mock.calls.filter(
        (c) =>
          c.arguments[1] === 'Docs ingest: URLs persistently failing; skipping them until the next re-probe',
      ).length,
      0,
      'no dead-URL reporting when the feature is disabled',
    );
    // 0 is a COMPLETE off-switch, not just "never skip": no streak read and no
    // streak write either, so opting out is byte-identical to pre-feature
    // behaviour with no extra queries.
    assert.deepEqual(calls.reported, []);
    assert.deepEqual(calls.recorded, [], 'no streak write when the feature is off');
    assert.deepEqual(calls.cleared, [], 'no streak clear when the feature is off');
  });
});

test('runDocsIngest: a dead-URL store read failure degrades to fetching everything, never to skipping blindly', async () => {
  await withDeadUrlConfig(3, 30, async () => {
    const attempted: string[] = [];
    const fetchText = async (url: string): Promise<string> => {
      if (url === config.docsIngest.indexUrl) return `- [a](${DEAD_URL})`;
      attempted.push(url);
      throw new Error(`404 ${url}`);
    };

    const res = await runDocsIngest(fetchText, {
      listFailures: async () => {
        throw new Error('db down');
      },
      recordFailures: async () => {},
      clearFailures: async () => {},
      markReported: async () => {},
    });

    assert.deepEqual(attempted, [DEAD_URL], 'an unreadable streak store must not cause a silent skip');
    assert.equal(res.deadSkipped, 0);
  });
});

test(
  'runDocsIngest: a dead URL that fetches successfully again has its failing streak cleared (self-heals)',
  { skip },
  async () => {
    await withDeadUrlConfig(3, 30, async () => {
      const { calls, deps } = stubDeadUrlStore([failure(LIVE_URL, 9, 31)]);
      const fetchText = async (url: string): Promise<string> => {
        if (url === config.docsIngest.indexUrl) return `- [a](${LIVE_URL})`;
        return '# Messages\n\nThe Messages API sends a conversation to the model.';
      };

      const res = await runDocsIngest(fetchText, deps);

      assert.equal(res.fetched, 1, 'the re-probe succeeded');
      assert.deepEqual(calls.cleared, [[LIVE_URL]], 'the streak is deleted, so it rejoins the normal set');
      assert.deepEqual(calls.recorded, [[]], 'nothing failed, so nothing is recorded');
    });
  },
);

test('runDocsIngest: lowering the threshold onto an existing streak still reports the URL once before it goes quiet (PR #691 review)', async (t) => {
  // The URL has 2 prior failures and was never reported. An operator lowers
  // DOCS_INGEST_DEAD_URL_RUNS to 2, so it is dead on the NEXT run — and is
  // therefore skipped before it is ever re-attempted, never entering
  // failedFetchUrls. It must still get its one-time report rather than
  // silently disappearing from the fetch set.
  await withDeadUrlConfig(2, 30, async () => {
    const { logger } = await import('../src/logger.js');
    const warn = t.mock.method(logger, 'warn');
    const { calls, deps } = stubDeadUrlStore([failure(DEAD_URL, 2)]);
    const attempted: string[] = [];
    const fetchText = async (url: string): Promise<string> => {
      if (url === config.docsIngest.indexUrl) return `- [a](${DEAD_URL})`;
      attempted.push(url);
      throw new Error(`404 ${url}`);
    };

    const res = await runDocsIngest(fetchText, deps);

    assert.deepEqual(attempted, [], 'already over the lowered threshold, so it is skipped, not fetched');
    assert.equal(res.deadSkipped, 1);
    const deadWarns = warn.mock.calls.filter(
      (c) =>
        c.arguments[1] === 'Docs ingest: URLs persistently failing; skipping them until the next re-probe',
    );
    assert.equal(deadWarns.length, 1, 'the one-time report still fires for a config-induced crossing');
    assert.deepEqual((deadWarns[0].arguments[0] as { sample: string[] }).sample, [DEAD_URL]);
    assert.deepEqual(calls.reported, [[DEAD_URL]], 'and it is stamped, so it never reports again');
  });
});

test('runDocsIngest: an already-reported URL that stays skipped is never re-reported (the report is once, not per run)', async (t) => {
  await withDeadUrlConfig(3, 30, async () => {
    const { logger } = await import('../src/logger.js');
    const warn = t.mock.method(logger, 'warn');
    const { calls, deps } = stubDeadUrlStore([failure(DEAD_URL, 5, 0, new Date())]);
    const fetchText = async (url: string): Promise<string> => {
      if (url === config.docsIngest.indexUrl) return `- [a](${DEAD_URL})`;
      throw new Error('unreachable: this URL is dead and in cooldown');
    };

    const res = await runDocsIngest(fetchText, deps);

    assert.equal(res.deadSkipped, 1, 'still skipped');
    assert.equal(
      warn.mock.calls.filter(
        (c) =>
          c.arguments[1] === 'Docs ingest: URLs persistently failing; skipping them until the next re-probe',
      ).length,
      0,
      'already reported, so the run stays silent about it',
    );
    assert.deepEqual(calls.reported, []);
  });
});

test('runDocsIngest: a streak row whose URL has left the index is reaped, so the table stays bounded by the current dead tranche (PR #691 review)', async () => {
  await withDeadUrlConfig(3, 30, async () => {
    const goneFromIndex = 'https://platform.claude.com/docs/en/api/terraform/beta/removed-upstream.md';
    // Two open streaks: one URL still listed, one that has vanished from the
    // index. The vanished one will never be fetched again, so nothing would
    // ever clear it — it must be reaped here instead of lingering forever.
    const { calls, deps } = stubDeadUrlStore([failure(DEAD_URL, 1), failure(goneFromIndex, 1)]);
    const fetchText = async (url: string): Promise<string> => {
      if (url === config.docsIngest.indexUrl) return `- [a](${DEAD_URL})`;
      throw new Error(`404 ${url}`);
    };

    await runDocsIngest(fetchText, deps);

    assert.equal(calls.cleared.length, 1, 'one clear call');
    assert.deepEqual(
      calls.cleared[0],
      [goneFromIndex],
      'only the de-listed URL is reaped — the still-listed one keeps its streak',
    );
    assert.deepEqual(calls.recorded, [[DEAD_URL]], 'the still-listed URL still bumps its streak');
  });
});
