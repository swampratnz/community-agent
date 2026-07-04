import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Offline context builder (issue #51). DB-backed (skip without DATABASE_URL);
// the summariser is injected so no real model call ever happens in tests.
// Vectors are hand-crafted one-hot axes (same technique as the
// recentQuestionClusters tests) so clustering is deterministic and immune to
// whatever real-embedding rows other test files insert.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
// Exercise the hard cap with the smallest possible value.
process.env.CONTEXT_BUILDER_MAX_SUMMARIES = '1';
process.env.CONTEXT_BUILDER_MIN_DISTINCT_USERS = '3';
process.env.CONTEXT_BUILDER_WINDOW_DAYS = '1';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const pgvector = (await import('pgvector/pg')).default;
const { runContextBuilder, shouldRunContextBuilder } = await import('../src/context/builder.js');
const { listContextDigests, purgeUserData } = await import('../src/storage/repository.js');

const RUN = `ctx${Date.now()}${Math.floor(Math.random() * 1e6)}`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM interactions WHERE conversation_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM context_digests WHERE topic LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

/** Insert an inbound interaction with a hand-crafted embedding on a given axis. */
async function seed(axis: number, userId: string, content: string): Promise<number> {
  const vec = new Array(config.db.embeddingDim).fill(0);
  vec[axis] = 1;
  const { rows } = await pool.query(
    `INSERT INTO interactions (platform, conversation_id, user_id, role, direction, content, embedding)
     VALUES ('discord', $1, $2, 'member', 'inbound', $3, $4) RETURNING id`,
    [`${RUN}-chan`, userId, content, pgvector.toSql(vec)],
  );
  return Number(rows[0].id);
}

test('shouldRunContextBuilder gates to roughly one run per day, restart-safe', () => {
  const now = Date.now();
  assert.equal(shouldRunContextBuilder(null, now), true, 'no digests yet: run');
  assert.equal(shouldRunContextBuilder(new Date(now - 2 * 3_600_000), now), false, 'ran 2h ago: skip');
  assert.equal(shouldRunContextBuilder(new Date(now - 21 * 3_600_000), now), true, 'ran 21h ago: run');
});

test(
  'context builder digests the top cross-user topic, drops sub-floor clusters, and never exceeds the summary cap (issue #51)',
  { skip },
  async () => {
    // Cluster A (axis 10): 4 messages from 3 distinct users — eligible, top.
    const aIds = [
      await seed(10, `${RUN}-a1`, 'when is the next meetup?'),
      await seed(10, `${RUN}-a2`, 'anyone know the meetup date?'),
      await seed(10, `${RUN}-a3`, 'meetup timing this month?'),
      await seed(10, `${RUN}-a1`, 'still wondering about the meetup'),
    ];
    // Cluster B (axis 11): 3 messages from 3 users — eligible, second.
    await seed(11, `${RUN}-b1`, 'how do rate limits work?');
    await seed(11, `${RUN}-b2`, 'hitting rate limits');
    await seed(11, `${RUN}-b3`, 'rate limit question');
    // Cluster C (axis 12): 2 messages from ONE user — recurring but below the
    // 3-distinct-user floor; must be dropped (a digest must never be a
    // single-person profile).
    await seed(12, `${RUN}-c1`, 'my very personal niche topic');
    await seed(12, `${RUN}-c1`, 'more about my niche topic');

    const calls: string[][] = [];
    const result = await runContextBuilder(async (samples) => {
      calls.push(samples);
      return { topic: `${RUN}-topic-${calls.length}`, summary: 'aggregate summary of the theme' };
    });

    assert.equal(calls.length, 1, 'HARD cap: exactly maxSummaries (1) model calls, no overrun');
    assert.equal(result.digests, 1);
    assert.ok(result.truncatedByCap >= 1, 'cluster B (eligible) was truncated by the cap, and logged');
    assert.ok(result.droppedBelowFloor >= 1, 'cluster C was dropped below the distinct-user floor');
    assert.ok(
      calls[0].some((s) => s.includes('meetup')),
      'the single summary call went to the highest-count cluster (A)',
    );
    assert.ok(
      calls.every((samples) => samples.every((s) => !s.includes('niche topic'))),
      'sub-floor content never reaches the summariser',
    );

    const digests = await listContextDigests(1, 100);
    const mine = digests.find((d) => d.topic === `${RUN}-topic-1`);
    assert.ok(mine, 'the digest row landed');
    assert.equal(mine.distinctUsers, 3);
    assert.equal(mine.questionCount, 4);
    assert.deepEqual([...mine.exampleRefs].sort(), [...aIds].sort(), 'refs are interaction ids, no content');

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [`${RUN}-chan`]);
    await pool.query(`DELETE FROM context_digests WHERE topic LIKE $1`, [`${RUN}%`]);
  },
);

test(
  'SECURITY: purging a user invalidates every digest built over their content — it cannot resurface (issue #51)',
  { skip },
  async () => {
    const victim = `${RUN}-purge-me`;
    // Cluster D (axis 13): 6 messages across 3 users, victim included.
    await seed(13, victim, 'we decided to use the community discord for events');
    await seed(13, victim, 'events on discord it is');
    await seed(13, `${RUN}-d2`, 'discord events sound good');
    await seed(13, `${RUN}-d2`, 'agree on discord events');
    await seed(13, `${RUN}-d3`, 'discord for events works');
    await seed(13, `${RUN}-d3`, '+1 discord events');

    const result = await runContextBuilder(async () => ({
      topic: `${RUN}-purge-topic`,
      summary: 'a summary that was partly built over the purged user content',
    }));
    assert.ok(result.digests >= 1, 'a digest was built over the cluster');

    const before = await pool.query(`SELECT id FROM context_digests WHERE topic = $1`, [
      `${RUN}-purge-topic`,
    ]);
    assert.equal(before.rows.length, 1);

    await purgeUserData('discord', victim);

    const afterRows = await pool.query(`SELECT id FROM context_digests WHERE topic = $1`, [
      `${RUN}-purge-topic`,
    ]);
    assert.equal(
      afterRows.rows.length,
      0,
      'SECURITY: the digest referencing the purged user is invalidated, so their signal cannot resurface',
    );
    const victimRows = await pool.query(`SELECT 1 FROM interactions WHERE user_id = $1`, [victim]);
    assert.equal(victimRows.rows.length, 0, 'the purge itself removed the raw rows');
  },
);
