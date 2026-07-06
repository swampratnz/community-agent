import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Docs ingest. Parsing/chunking are pure (no DB); the ingest-run tests are
// DB-backed (skip without DATABASE_URL) and inject the fetcher so no network
// call ever happens.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const { parseDocIndex, titleForUrl, chunkMarkdown, shouldRunDocsIngest, runDocsIngest, DOCS_PROVENANCE } =
  await import('../src/context/docsIngest.js');

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

test('chunkMarkdown splits by heading, prefixes the page title, and caps long sections', () => {
  const md = ['intro paragraph', '', '## Section A', 'body a', '', '## Section B', 'body b'].join('\n');
  const chunks = chunkMarkdown('docs: api/messages', md);
  const titles = chunks.map((c) => c.title);
  assert.deepEqual(titles, [
    'docs: api/messages',
    'docs: api/messages › Section A',
    'docs: api/messages › Section B',
  ]);
  assert.match(chunks[1].content, /^docs: api\/messages › Section A/, 'chunk carries its own context prefix');
  assert.match(chunks[1].content, /body a/);

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
