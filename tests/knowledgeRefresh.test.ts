import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Daily knowledge refresh. The pure freshness-guard test needs no DB; the
// upsert/run tests are DB-backed (skip without DATABASE_URL) and inject the
// researcher so no real model/web-search call ever happens.
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
const { runKnowledgeRefresh, shouldRunKnowledgeRefresh, REFRESH_TOPICS, REFRESH_TITLES } =
  await import('../src/context/knowledgeRefresh.js');

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM knowledge WHERE title = ANY($1)`, [[...REFRESH_TITLES]]);
  }
  await closeDb();
});

test('shouldRunKnowledgeRefresh: runs when never run, and only again after the interval', () => {
  const now = 1_000_000_000_000;
  assert.equal(shouldRunKnowledgeRefresh(null, now), true, 'null watermark → first run');
  assert.equal(
    shouldRunKnowledgeRefresh(new Date(now - 1 * 3_600_000), now),
    false,
    'refreshed an hour ago → skip (redeploy-safe)',
  );
  assert.equal(
    shouldRunKnowledgeRefresh(new Date(now - 21 * 3_600_000), now),
    true,
    'refreshed >20h ago → run again',
  );
});

test(
  'runKnowledgeRefresh upserts one entry per topic (create then update, never duplicate)',
  { skip },
  async () => {
    // First run: a briefing for every topic → all created.
    const first = await runKnowledgeRefresh(async () => 'First briefing bullet.');
    assert.equal(first.topics, REFRESH_TOPICS.length);
    assert.equal(first.created, REFRESH_TOPICS.length, 'first run creates one entry per topic');
    assert.equal(first.updated, 0);

    const countFor = async (title: string) =>
      Number(
        (
          await pool.query(`SELECT count(*) AS n FROM knowledge WHERE title = $1 AND scope = 'global'`, [
            title,
          ])
        ).rows[0].n,
      );
    for (const t of REFRESH_TOPICS) {
      assert.equal(await countFor(t.title), 1, `exactly one entry for "${t.title}"`);
    }

    // Second run: updates the SAME rows (no duplicates), and stamps content.
    const second = await runKnowledgeRefresh(async () => 'Second briefing bullet.');
    assert.equal(second.updated, REFRESH_TOPICS.length, 'second run updates, does not create');
    assert.equal(second.created, 0);
    for (const t of REFRESH_TOPICS) {
      assert.equal(await countFor(t.title), 1, 'still exactly one entry (upsert, not accumulate)');
    }

    const sample = await pool.query(`SELECT content FROM knowledge WHERE title = $1 AND scope = 'global'`, [
      REFRESH_TOPICS[0].title,
    ]);
    assert.match(
      sample.rows[0].content,
      /Second briefing bullet/,
      'content refreshed to the latest briefing',
    );
    assert.match(sample.rows[0].content, /Auto-researched/, 'entry is labelled auto-researched/unverified');
  },
);

test(
  'runKnowledgeRefresh leaves the existing entry untouched on NO_UPDATE (null briefing)',
  { skip },
  async () => {
    const title = REFRESH_TOPICS[0].title;
    // Seed a "current" entry, then a run where research finds nothing.
    await runKnowledgeRefresh(async () => 'Seed briefing.');
    const before = (
      await pool.query(`SELECT content FROM knowledge WHERE title = $1 AND scope = 'global'`, [title])
    ).rows[0].content;

    const res = await runKnowledgeRefresh(async () => null); // NO_UPDATE for every topic
    assert.equal(res.skipped, REFRESH_TOPICS.length, 'every topic skipped');
    assert.equal(res.created, 0);
    assert.equal(res.updated, 0);

    const after = (
      await pool.query(`SELECT content FROM knowledge WHERE title = $1 AND scope = 'global'`, [title])
    ).rows[0].content;
    assert.equal(after, before, 'a quiet week never blanks or churns the existing entry');
  },
);
