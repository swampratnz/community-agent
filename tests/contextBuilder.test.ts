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
// On for every test in this file (issue #102): harmless for tests whose
// injected summariser never returns a `candidate` (the builder only acts on
// one when both the flag AND a truthy candidate are present), and lets the
// candidate-specific tests below skip re-declaring it per test.
process.env.CONTEXT_CANDIDATES_ENABLED = 'true';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const pgvector = (await import('pgvector/pg')).default;
const { runContextBuilder, shouldRunContextBuilder } = await import('../src/context/builder.js');
const {
  declineKnowledgeCandidate,
  insertContextDigest,
  insertKnowledgeCandidate,
  listContextDigests,
  listKnowledgeCandidates,
  purgeUserData,
  saveKnowledge,
} = await import('../src/storage/repository.js');

const RUN = `ctx${Date.now()}${Math.floor(Math.random() * 1e6)}`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM interactions WHERE conversation_id LIKE $1`, [`${RUN}%`]);
    await pool.query(
      `DELETE FROM knowledge_candidates WHERE digest_id IN (SELECT id FROM context_digests WHERE topic LIKE $1)`,
      [`${RUN}%`],
    );
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
  'runContextBuilder: `failed` counts only clusters whose summarize() threw, and `attempted` (not `clustersConsidered`) is the right total-failure denominator when the run is cap-truncated (issue #335)',
  { skip },
  async () => {
    // Two eligible clusters (each >= the 3-distinct-user floor), but
    // CONTEXT_BUILDER_MAX_SUMMARIES=1 (set at the top of this file) caps the
    // run to attempting only one of them.
    await seed(30, `${RUN}-h1`, 'when does the market open');
    await seed(30, `${RUN}-h2`, 'market opening hours?');
    await seed(30, `${RUN}-h3`, 'opening time for the market');
    await seed(31, `${RUN}-i1`, 'where is the venue');
    await seed(31, `${RUN}-i2`, 'venue location please');
    await seed(31, `${RUN}-i3`, 'what is the venue address');

    const result = await runContextBuilder(async () => {
      throw new Error('summarizer unavailable');
    });

    assert.equal(result.attempted, 1, 'the cap limits this run to attempting exactly one cluster');
    assert.ok(
      result.clustersConsidered > result.attempted,
      'clustersConsidered includes the cap-truncated cluster too — a bigger number than attempted',
    );
    assert.equal(result.failed, 1, 'the one attempted cluster failed to summarise');
    assert.equal(
      result.failed,
      result.attempted,
      'every ATTEMPTED cluster failed — this is what defaultContextBuilderRun must treat as total failure, ' +
        'even though failed < clustersConsidered (comparing against clustersConsidered would never fire here)',
    );
    assert.equal(result.digests, 0, 'no digest was written since the one attempt failed');

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [`${RUN}-chan`]);
  },
);

test(
  'runContextBuilder: a partial failure (one of several attempted clusters fails) never makes failed === attempted',
  { skip },
  async () => {
    const orig = config.contextBuilder.maxSummaries;
    (config.contextBuilder as { maxSummaries: number }).maxSummaries = 2;
    try {
      await seed(32, `${RUN}-j1`, 'how do I reset my password');
      await seed(32, `${RUN}-j2`, 'password reset help');
      await seed(32, `${RUN}-j3`, 'forgot password, need reset');
      await seed(33, `${RUN}-k1`, 'is there a mobile app');
      await seed(33, `${RUN}-k2`, 'mobile app availability?');
      await seed(33, `${RUN}-k3`, 'app for phones?');

      let calls = 0;
      const result = await runContextBuilder(async (samples) => {
        calls += 1;
        if (calls === 1) throw new Error('summarizer unavailable');
        return { topic: `${RUN}-partial-topic`, summary: 'aggregate summary' };
      });

      assert.equal(result.attempted, 2);
      assert.equal(result.failed, 1, 'exactly one of the two attempted clusters failed');
      assert.notEqual(result.failed, result.attempted, 'a partial failure must never equal attempted');

      await pool.query(`DELETE FROM context_digests WHERE topic = $1`, [`${RUN}-partial-topic`]);
    } finally {
      (config.contextBuilder as { maxSummaries: number }).maxSummaries = orig;
      await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [`${RUN}-chan`]);
    }
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

test(
  'context builder drafts a pending knowledge candidate from a summariser-proposed Q&A, referencing its digest, with no extra model call (issue #102)',
  { skip },
  async () => {
    await seed(20, `${RUN}-e1`, 'does the community have a code of conduct?');
    await seed(20, `${RUN}-e2`, 'is there a code of conduct doc?');
    await seed(20, `${RUN}-e3`, 'looking for the code of conduct');

    const calls: string[][] = [];
    const result = await runContextBuilder(async (samples) => {
      calls.push(samples);
      return {
        topic: `${RUN}-cand-topic`,
        summary: 'members keep asking about the code of conduct',
        candidate: { title: `${RUN} Code of conduct`, content: 'See the pinned #rules channel.' },
      };
    });
    assert.equal(
      calls.length,
      1,
      'drafting a candidate rides the SAME summarisation call, never a second one',
    );
    assert.equal(result.digests, 1);
    assert.equal(result.candidates, 1, 'exactly one candidate is drafted for the one digest produced');

    const [digest] = (await listContextDigests(1, 100)).filter((d) => d.topic === `${RUN}-cand-topic`);
    assert.ok(digest, 'the digest landed');

    const candidateRows = await listKnowledgeCandidates('pending', 200);
    const mine = candidateRows.find((c) => c.title === `${RUN} Code of conduct`);
    assert.ok(mine, 'the drafted candidate landed as pending');
    assert.equal(mine.digestId, digest.id, 'the candidate references its source digest');
    assert.equal(mine.content, 'See the pinned #rules channel.');
    assert.equal(mine.topic, `${RUN}-cand-topic`, "the candidate's topic is denormalized from the digest");

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [`${RUN}-chan`]);
    await pool.query(`DELETE FROM knowledge_candidates WHERE id = $1`, [mine.id]);
    await pool.query(`DELETE FROM context_digests WHERE topic = $1`, [`${RUN}-cand-topic`]);
  },
);

test(
  'context builder never drafts a candidate when CONTEXT_CANDIDATES_ENABLED is off, even if the summariser proposes one (issue #102)',
  { skip },
  async () => {
    await seed(21, `${RUN}-cd1`, 'does the community have a code of conduct?');
    await seed(21, `${RUN}-cd2`, 'is there a code of conduct doc?');
    await seed(21, `${RUN}-cd3`, 'looking for the code of conduct');

    // Flip the flag off for this one call, restoring it immediately after —
    // every other test in this file relies on the file-level default of on
    // (see the process.env.CONTEXT_CANDIDATES_ENABLED set at the top).
    // config is `as const` (deep-readonly at the type level only); the cast
    // is confined to this one test.
    const flag = config.contextCandidates as { enabled: boolean };
    flag.enabled = false;
    let result;
    try {
      result = await runContextBuilder(async () => ({
        topic: `${RUN}-cd-topic`,
        summary: 'summary',
        candidate: { title: 'Code of conduct', content: 'See the pinned doc.' },
      }));
    } finally {
      flag.enabled = true;
    }
    assert.equal(result.digests, 1, 'the digest itself is unaffected by the flag');
    assert.equal(result.candidates, 0, 'no candidate is drafted while the flag is off');

    const rows = await listKnowledgeCandidates('pending', 200);
    assert.ok(!rows.some((c) => c.topic === `${RUN}-cd-topic`), 'no candidate row was inserted');

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [`${RUN}-chan`]);
    await pool.query(`DELETE FROM context_digests WHERE topic = $1`, [`${RUN}-cd-topic`]);
  },
);

test(
  "SECURITY: context builder's dedup guard skips drafting a candidate whose topic already has a queued candidate (even a DECLINED one) or is already answered by existing knowledge above the relevance floor (issue #102)",
  { skip },
  async () => {
    // Cluster F: the topic already has a (declined) candidate queued.
    await seed(22, `${RUN}-f1`, 'when is the next meetup happening');
    await seed(22, `${RUN}-f2`, 'meetup timing please');
    await seed(22, `${RUN}-f3`, 'any update on the meetup date');

    const priorDigestId = await insertContextDigest({
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(),
      topic: `${RUN}-dedup-queued-topic`,
      summary: 'prior run summary',
      exampleRefs: [],
      distinctUsers: 3,
      questionCount: 3,
    });
    const priorCandidateId = await insertKnowledgeCandidate({
      digestId: priorDigestId,
      topic: `${RUN}-dedup-queued-topic`,
      title: 'prior title',
      content: 'prior content',
    });
    await declineKnowledgeCandidate(priorCandidateId, 'admin-1');

    const resultQueued = await runContextBuilder(async () => ({
      topic: `${RUN}-dedup-queued-topic`,
      summary: 'summary',
      candidate: { title: 'new title', content: 'new content' },
    }));
    assert.equal(resultQueued.digests, 1, 'the digest itself is still written');
    assert.equal(
      resultQueued.candidates,
      0,
      'a topic with an existing (even declined) candidate is never re-queued',
    );

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [`${RUN}-chan`]);

    // Cluster G: the topic is already answered by an existing knowledge entry.
    await seed(23, `${RUN}-g1`, 'zylotrix onboarding help please');
    await seed(23, `${RUN}-g2`, 'how do I onboard to zylotrix');
    await seed(23, `${RUN}-g3`, 'zylotrix onboarding steps needed');

    const { id: knowledgeId } = await saveKnowledge({
      title: 'Zylotrix onboarding',
      content: `${RUN} zylotrix onboarding: register on the portal and verify your email.`,
      scope: 'global',
    });

    const resultAnswered = await runContextBuilder(async () => ({
      topic: `${RUN} zylotrix onboarding steps`,
      summary: 'summary',
      candidate: { title: 'new title', content: 'new content' },
    }));
    assert.equal(resultAnswered.digests, 1);
    assert.equal(
      resultAnswered.candidates,
      0,
      'a topic an existing knowledge entry already covers is never queued as a new suggestion',
    );

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [`${RUN}-chan`]);
    await pool.query(`DELETE FROM knowledge_candidates WHERE id = $1`, [priorCandidateId]);
    await pool.query(`DELETE FROM context_digests WHERE topic = ANY($1)`, [
      [`${RUN}-dedup-queued-topic`, `${RUN} zylotrix onboarding steps`],
    ]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [knowledgeId]);
  },
);
