import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

// Issue #1287: knowledge_for_me composes getPublishedInterestsForOwners (the
// exact self-scoped lookup who_is_into({mine:true}) already uses) with
// searchKnowledge and the existing formatKnowledgeSearchResults, unmodified.
// These tests exercise the composition end to end rather than re-testing
// searchKnowledge/formatKnowledgeSearchResults' own behaviour, which
// tests/tools.test.ts and tests/knowledgeSearchFailSafe.test.ts already cover
// for knowledge_search. Every test mocks `pool.query` (a live method swap on
// the shared `pool` object, safe to redo per test) rather than
// `t.mock.module`-ing an ES module — the latter only takes effect on an
// import that has not yet happened anywhere in this process, and this file's
// own top-level imports already load agent-base's storage modules for real.

const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

await import('./support/registerToolRegistry.js');
await import('./support/registerNotices.js');
const {
  buildToolServer,
  WHO_IS_INTO_NO_PROFILE_HINT,
  formatWhoIsIntoEmptyText,
  KNOWLEDGE_CONFLICT_CAVEAT_TEXT,
} = await import('../src/module/agent/tools.js');
const { MEMBER_TOOLS } = await import('@swampratnz/agent-base/auth/rbac.js');
const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');
const { logger } = await import('@swampratnz/agent-base/logger.js');
const { embed } = await import('@swampratnz/agent-base/storage/embeddings.js');
const { config } = await import('@swampratnz/agent-base/config.js');
const { notice } = await import('../src/module/strings/notices.js');
const { COMMUNITY_TURN_STATE_FINALIZER } = await import('../src/module/agent/communityTurnState.js');
const { setMemberInterests, recordInteraction } =
  await import('@swampratnz/agent-base/storage/repository.js');
const pgvector = (await import('pgvector/pg')).default;

if (hasDb) await embed('warmup').catch(() => {});

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

type KnowledgeForMeHandler = {
  handler: (args: Record<string, never>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

type KnowledgeForMeTurnState = {
  lastKnowledgeHitId: number | null;
  staleKnowledgeAlertIds?: number[];
};

function getKnowledgeForMeHandler(
  caller: {
    platform: 'discord';
    userId: string;
    userName: string;
    role: 'member' | 'guest';
    conversationId: string;
    isDirect: boolean;
  },
  turnState?: KnowledgeForMeTurnState,
): KnowledgeForMeHandler {
  const server = buildToolServer(caller, stubAdapter(), undefined, turnState);
  return (
    server.instance as unknown as {
      _registeredTools: Record<string, KnowledgeForMeHandler>;
    }
  )._registeredTools['knowledge_for_me'];
}

type KnowledgeSearchHandler = {
  handler: (args: { query: string }) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

function getKnowledgeSearchHandler(
  caller: {
    platform: 'discord';
    userId: string;
    userName: string;
    role: 'member' | 'guest';
    conversationId: string;
    isDirect: boolean;
  },
  turnState?: KnowledgeForMeTurnState,
): KnowledgeSearchHandler {
  const server = buildToolServer(caller, stubAdapter(), undefined, turnState);
  return (
    server.instance as unknown as {
      _registeredTools: Record<string, KnowledgeSearchHandler>;
    }
  )._registeredTools['knowledge_search'];
}

/** Poll for the fire-and-forget retrieval-count bump (issue #134/#1383) to land. */
async function waitForRetrievalCount(
  id: number,
  predicate: (count: number) => boolean,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(`SELECT retrieval_count FROM knowledge WHERE id = $1`, [id]);
    const count = Number(rows[0]?.retrieval_count ?? 0);
    if (predicate(count) || Date.now() > deadline) return count;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// `config.knowledgeStaleAlert`/`config.adminDigest` are deeply `readonly` in
// agent-base's config type (this file is on tsconfig.tests.json's typechecked
// ratchet) — same confined-cast discipline as
// setKnowledgeLowRatedCaveatMinUnhelpful above.
function setKnowledgeStaleAlertEnabled(value: boolean): void {
  (config.knowledgeStaleAlert as { enabled: boolean }).enabled = value;
}
function setKnowledgeStaleDays(value: number): void {
  (config.adminDigest as { knowledgeStaleDays: number }).knowledgeStaleDays = value;
}

type RateAnswerHandler = {
  handler: (args: {
    helpful: boolean;
    comment?: string;
  }) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
};

function getRateAnswerHandler(userId: string, conversationId: string): RateAnswerHandler {
  const server = buildToolServer(
    {
      platform: 'discord' as const,
      userId,
      userName: 'Rating Member',
      role: 'member' as const,
      conversationId,
      isDirect: false,
    },
    stubAdapter(),
  );
  return (
    server.instance as unknown as {
      _registeredTools: Record<string, RateAnswerHandler>;
    }
  )._registeredTools['rate_answer'];
}

// Mirrors tools.test.ts's own withAnswerCandidateFlag helper (issue #726) —
// `config.knowledgeAnswerCandidate` is deeply `readonly` in agent-base's
// config type, so the cast is confined to this one setter, same discipline
// as setKnowledgeLowRatedCaveatMinUnhelpful below.
async function withAnswerCandidateFlag<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  const original = config.knowledgeAnswerCandidate.enabled;
  (config.knowledgeAnswerCandidate as { enabled: boolean }).enabled = enabled;
  try {
    return await fn();
  } finally {
    (config.knowledgeAnswerCandidate as { enabled: boolean }).enabled = original;
  }
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

// `config.behaviour` is deeply `readonly` in agent-base's config type (this
// file is on tsconfig.tests.json's typechecked ratchet, unlike the untyped
// tests/tools.test.ts, which mutates the same field directly). The cast
// below is confined to this one setter so the readonly-ness stays enforced
// everywhere else in the file.
function setKnowledgeLowRatedCaveatMinUnhelpful(value: number): void {
  (
    config.behaviour as unknown as { knowledgeLowRatedCaveatMinUnhelpful: number }
  ).knowledgeLowRatedCaveatMinUnhelpful = value;
}

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

test('knowledge_for_me is member-tier, registered in the manifest wiring (issue #1287 acceptance criterion 1)', () => {
  assert.ok(
    MEMBER_TOOLS.includes('mcp__community__knowledge_for_me'),
    'knowledge_for_me must be in MEMBER_TOOLS',
  );
});

test(
  "knowledge_for_me searches the knowledge base using the caller's own published interests text, rendering " +
    'hits through formatKnowledgeSearchResults (issue #1287 acceptance criteria 1, 2)',
  { skip },
  async () => {
    const scope = `${RUN}-basic`;
    const userId = `${RUN}-member-basic`;
    const interests = `deep in RAG evaluation ${RUN}`;

    await setMemberInterests('discord', userId, interests);
    const anchorVec = await embed(interests);
    const near = atCosineSimilarity(anchorVec, 0.9);
    const { rows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [scope, `RAG eval guide ${RUN}`, 'How this community evaluates RAG pipelines.', pgvector.toSql(near)],
    );
    const id = Number(rows[0].id);

    const caller = {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
      isDirect: false,
    };
    const result = await getKnowledgeForMeHandler(caller).handler({});
    const text = result.content[0]?.text ?? '';

    assert.equal(result.isError, false);
    assert.match(text, /RAG eval guide/, "hits computed from the caller's own interests text must render");

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
    await setMemberInterests('discord', userId, 'clear');
  },
);

test(
  "knowledge_for_me returns who_is_into's own 'publish interests first' guidance, and never queries the " +
    'knowledge table (so never reaches searchKnowledge), when the caller has no published-interests row ' +
    '(issue #1287 acceptance criterion 3)',
  async (t) => {
    let knowledgeQueryCalls = 0;
    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM member_interests')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (typeof sql === 'string' && sql.includes('FROM knowledge')) {
        knowledgeQueryCalls += 1;
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const caller = {
      platform: 'discord' as const,
      userId: `${RUN}-member-no-profile`,
      userName: 'Member',
      role: 'member' as const,
      conversationId: `${RUN}-no-profile`,
      isDirect: false,
    };
    const result = await getKnowledgeForMeHandler(caller).handler({});
    const text = result.content[0]?.text ?? '';

    assert.equal(
      text,
      WHO_IS_INTO_NO_PROFILE_HINT,
      "must render who_is_into's own no-profile guidance verbatim",
    );
    assert.equal(
      knowledgeQueryCalls,
      0,
      'searchKnowledge must never query the knowledge table when the caller has no published interests',
    );
  },
);

test(
  "knowledge_for_me's no-profile guidance is translated for a 'mi'-preference caller, via " +
    "formatWhoIsIntoEmptyText('noProfile', language) rather than the raw English-only constant — matching " +
    "who_is_into({mine:true}) and the !whois mine command's own threading of getLanguagePreference (PR #1288 " +
    'review fix)',
  async (t) => {
    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM member_interests')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (typeof sql === 'string' && sql.includes('FROM language_prefs')) {
        return Promise.resolve({ rows: [{ language: 'mi' }], rowCount: 1 });
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const caller = {
      platform: 'discord' as const,
      userId: `${RUN}-member-no-profile-mi`,
      userName: 'Member',
      role: 'member' as const,
      conversationId: `${RUN}-no-profile-mi`,
      isDirect: false,
    };
    const result = await getKnowledgeForMeHandler(caller).handler({});
    const text = result.content[0]?.text ?? '';

    assert.equal(
      text,
      formatWhoIsIntoEmptyText('noProfile', 'mi'),
      "a 'mi'-preference caller must get the Māori no-profile guidance, not the English-only constant",
    );
    assert.notEqual(
      text,
      WHO_IS_INTO_NO_PROFILE_HINT,
      'the Māori rendering must differ from the raw English constant',
    );
  },
);

test(
  "SECURITY: knowledge_for_me reads only the caller's OWN {platform, userId} — a different identity's " +
    "published interests row is never read or leaked, even when seeded alongside the caller's own (issue " +
    '#1287 acceptance criterion 4)',
  { skip },
  async (t) => {
    const scope = `${RUN}-cross-identity`;
    const callerId = `${RUN}-member-self`;
    const otherId = `${RUN}-member-other`;
    const callerInterests = `caller-only interests text ${RUN}`;
    const otherInterests = `OTHER MEMBER SECRET interests text ${RUN}`;

    await setMemberInterests('discord', callerId, callerInterests);
    await setMemberInterests('discord', otherId, otherInterests);

    const calls: Array<{ params: unknown[] }> = [];
    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM member_interests')) {
        calls.push({ params: rest[0] as unknown[] });
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const caller = {
      platform: 'discord' as const,
      userId: callerId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
      isDirect: false,
    };
    const result = await getKnowledgeForMeHandler(caller).handler({});
    const text = result.content[0]?.text ?? '';

    assert.equal(calls.length, 1, 'getPublishedInterestsForOwners must have run exactly once');
    assert.deepEqual(
      calls[0]?.params,
      [['discord'], [callerId]],
      "only the caller's own {platform, userId} may reach getPublishedInterestsForOwners — never the other identity's",
    );
    assert.doesNotMatch(
      text,
      /OTHER MEMBER SECRET/,
      "the other identity's interests text must never leak into the caller's reply",
    );

    await setMemberInterests('discord', callerId, 'clear');
    await setMemberInterests('discord', otherId, 'clear');
  },
);

test(
  'SECURITY: knowledge_for_me rejects a guest caller via the assertAtLeast re-check, before reaching either ' +
    'getPublishedInterestsForOwners or searchKnowledge (issue #1287 acceptance criterion 5)',
  async (t) => {
    let memberInterestsCalls = 0;
    let knowledgeQueryCalls = 0;
    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM member_interests')) {
        memberInterestsCalls += 1;
      }
      if (typeof sql === 'string' && sql.includes('FROM knowledge')) {
        knowledgeQueryCalls += 1;
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const caller = {
      platform: 'discord' as const,
      userId: `${RUN}-guest`,
      userName: 'Guest',
      role: 'guest' as const,
      conversationId: `${RUN}-guest-scope`,
      isDirect: false,
    };

    await assert.rejects(
      () => getKnowledgeForMeHandler(caller).handler({}),
      /member/i,
      'a guest caller must be rejected by the assertAtLeast re-check',
    );

    assert.equal(
      memberInterestsCalls,
      0,
      'a rejected guest caller must never reach getPublishedInterestsForOwners',
    );
    assert.equal(knowledgeQueryCalls, 0, 'a rejected guest caller must never reach searchKnowledge');
  },
);

// Issue #1321: knowledge_for_me's handler used to call
// formatKnowledgeSearchResults bare, defaulting `hasConflict`/`lowRatedIds`
// off — the one remaining renderer call site missing the caveats every
// sibling knowledge-serving surface already carries. These tests mirror
// knowledge_search's own low-rated/conflict fixture style (tests/tools.test.ts)
// adapted to knowledge_for_me's own query source (the caller's published
// interests text, not a caller-supplied query).

test(
  'knowledge_for_me renders the same low-rated caveat text knowledge_search renders for a hit ' +
    'areKnowledgeEntriesLowRated flags, and sorts it after a non-low-rated near-tie sibling (issue #1321 ' +
    'acceptance criterion 1)',
  { skip },
  async (t) => {
    const was = config.behaviour.knowledgeLowRatedCaveatMinUnhelpful;
    setKnowledgeLowRatedCaveatMinUnhelpful(2);
    t.after(() => {
      setKnowledgeLowRatedCaveatMinUnhelpful(was);
    });

    const scope = `${RUN}-low-rated`;
    const userId = `${RUN}-member-low-rated`;
    const interests = `low-rated caveat test interests ${RUN}`;
    await setMemberInterests('discord', userId, interests);

    const anchorVec = await embed(interests);
    // Same rho for both fixtures, so their similarities land within
    // KNOWLEDGE_TIE_MARGIN of each other and the lowRatedIds-aware tie-break
    // (formatKnowledgeSearchResults) is what decides the order, not a real
    // relevance gap.
    const nearVec = atCosineSimilarity(anchorVec, 0.9);
    const { rows: lowRatedRows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [scope, `Low-rated entry ${RUN}`, 'LOW_RATED_FOR_ME_TEXT', pgvector.toSql(nearVec)],
    );
    const { rows: fineRows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [scope, `Fine entry ${RUN}`, 'FINE_FOR_ME_TEXT', pgvector.toSql(nearVec)],
    );
    const lowRatedId = Number(lowRatedRows[0].id);
    const fineId = Number(fineRows[0].id);

    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM answer_feedback')) {
        return Promise.resolve({ rows: [{ id: lowRatedId }], rowCount: 1 });
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const caller = {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
      isDirect: false,
    };
    const result = await getKnowledgeForMeHandler(caller).handler({});
    const text = result.content[0]?.text ?? '';
    const rows = text.split('\n').filter((l) => l.startsWith('- '));
    const lowRatedLine = rows.find((l) => l.includes('LOW_RATED_FOR_ME_TEXT'));
    const fineLine = rows.find((l) => l.includes('FINE_FOR_ME_TEXT'));

    const caveatText = notice('knowledgeLowRatedCaveat');
    assert.ok(
      lowRatedLine?.includes(caveatText),
      "the flagged entry's own line must carry the same low-rated caveat text knowledge_search renders",
    );
    assert.ok(
      !fineLine?.includes(caveatText),
      'a sibling entry outside the low-rated set must never carry it',
    );
    assert.ok(
      rows.indexOf(fineLine ?? '') < rows.indexOf(lowRatedLine ?? ''),
      'the non-low-rated near-tie sibling must sort ahead of the low-rated entry (the lowRatedIds tie-break engages)',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[lowRatedId, fineId]]);
    await setMemberInterests('discord', userId, 'clear');
  },
);

test(
  'knowledge_for_me appends the trailing conflict-caveat note exactly once when hasConflictAmongIds resolves ' +
    'true for the relevant hits, and omits it when false (issue #1321 acceptance criterion 2)',
  { skip },
  async (t) => {
    const scope = `${RUN}-conflict`;
    const userId = `${RUN}-member-conflict`;
    const interests = `conflict caveat test interests ${RUN}`;
    await setMemberInterests('discord', userId, interests);

    const anchorVec = await embed(interests);
    const midBandVec = atCosineSimilarity(anchorVec, 0.7);
    const { rows: aRows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [scope, `Conflict A ${RUN}`, 'CONFLICT_A_FOR_ME_TEXT', pgvector.toSql(anchorVec)],
    );
    const { rows: bRows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [scope, `Conflict B ${RUN}`, 'CONFLICT_B_FOR_ME_TEXT', pgvector.toSql(midBandVec)],
    );
    const aId = Number(aRows[0].id);
    const bId = Number(bRows[0].id);

    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('JOIN knowledge b')) {
        return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 });
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const caller = {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
      isDirect: false,
    };
    const result = await getKnowledgeForMeHandler(caller).handler({});
    const text = result.content[0]?.text ?? '';

    const escapedCaveat = KNOWLEDGE_CONFLICT_CAVEAT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.equal(
      (text.match(new RegExp(escapedCaveat, 'g')) ?? []).length,
      1,
      'the caveat appears exactly once when hasConflictAmongIds resolves true',
    );
    assert.match(
      text,
      new RegExp(`\\n\\n\\(${escapedCaveat}\\)$`),
      'the caveat is the exact fixed exported string, appended as a trailing line',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[aId, bId]]);
    await setMemberInterests('discord', userId, 'clear');
  },
);

test(
  'SECURITY: knowledge_for_me triggers no hasConflictAmongIds call with fewer than 2 relevant hits, and no ' +
    'areKnowledgeEntriesLowRated call with zero relevant hits or the low-rated feature disabled (issue #1321 ' +
    'acceptance criterion 3)',
  { skip },
  async (t) => {
    assert.equal(
      config.behaviour.knowledgeLowRatedCaveatMinUnhelpful,
      0,
      'this test only proves the disabled-feature half with the feature at its off default',
    );

    const scope = `${RUN}-short-circuit`;
    const userId = `${RUN}-member-short-circuit`;
    const interests = `short circuit test interests ${RUN}`;
    await setMemberInterests('discord', userId, interests);
    const anchorVec = await embed(interests);
    const { rows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [scope, `Solo entry ${RUN}`, 'SOLO_FOR_ME_TEXT', pgvector.toSql(anchorVec)],
    );
    const id = Number(rows[0].id);

    let conflictQueryRan = false;
    let lowRatedQueryRan = false;
    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('JOIN knowledge b')) conflictQueryRan = true;
      if (typeof sql === 'string' && sql.includes('FROM answer_feedback')) lowRatedQueryRan = true;
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const caller = {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
      isDirect: false,
    };
    await getKnowledgeForMeHandler(caller).handler({});

    assert.equal(
      conflictQueryRan,
      false,
      'hasConflictAmongIds must never even be called with fewer than 2 relevant hits',
    );
    assert.equal(
      lowRatedQueryRan,
      false,
      'areKnowledgeEntriesLowRated must never even be called with the feature disabled',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
    await setMemberInterests('discord', userId, 'clear');
  },
);

test(
  'SECURITY: knowledge_for_me never renders a source: clause for an autoGenerated: true hit, regardless of ' +
    'its low-rated/conflict status (the formatKnowledgeCitationNote !autoGenerated guard, issue #1321 ' +
    'acceptance criterion 4)',
  { skip },
  async (t) => {
    const was = config.behaviour.knowledgeLowRatedCaveatMinUnhelpful;
    setKnowledgeLowRatedCaveatMinUnhelpful(2);
    t.after(() => {
      setKnowledgeLowRatedCaveatMinUnhelpful(was);
    });

    const scope = `${RUN}-auto-generated`;
    const userId = `${RUN}-member-auto-generated`;
    const interests = `auto generated citation guard test ${RUN}`;
    await setMemberInterests('discord', userId, interests);

    // Embedding is pinned directly to the interests' own embed() output
    // (rather than derived from `content` via saveKnowledge) so relevance is
    // deterministic, matching this file's other raw-INSERT fixtures above —
    // real-content embedding similarity between two unrelated short strings
    // isn't reliably above the relevance floor.
    const anchorVec = await embed(interests);
    const { rows: autoRows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, created_by_role, source_url, source_title, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        scope,
        `Auto-generated entry ${RUN}`,
        'AUTO_GENERATED_FOR_ME_TEXT',
        'auto',
        'https://example.com/auto-generated-for-me',
        'Example source',
        pgvector.toSql(anchorVec),
      ],
    );
    const autoId = Number(autoRows[0].id);

    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM answer_feedback')) {
        return Promise.resolve({ rows: [{ id: autoId }], rowCount: 1 });
      }
      if (typeof sql === 'string' && sql.includes('JOIN knowledge b')) {
        return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 });
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    // Only this one entry is in scope, so hasConflictAmongIds never actually
    // runs (relevantIds.length < 2) — the mock above exists only in case a
    // future change widens the fetch; the assertion below is about the
    // rendered text regardless.
    const caller = {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
      isDirect: false,
    };
    const result = await getKnowledgeForMeHandler(caller).handler({});
    const text = result.content[0]?.text ?? '';

    assert.match(text, /AUTO_GENERATED_FOR_ME_TEXT/, 'the auto-generated entry must still be served');
    assert.doesNotMatch(
      text,
      /source:/,
      'an autoGenerated: true hit must never render a source: clause, regardless of low-rated/conflict status',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [autoId]);
    await setMemberInterests('discord', userId, 'clear');
  },
);

test(
  'SECURITY: knowledge_for_me still returns the plain search results — no thrown error, no raw error text, ' +
    'caveats simply omitted — when both areKnowledgeEntriesLowRated and hasConflictAmongIds reject (fail-safe, ' +
    'issue #1321 acceptance criterion 5)',
  { skip },
  async (t) => {
    const was = config.behaviour.knowledgeLowRatedCaveatMinUnhelpful;
    setKnowledgeLowRatedCaveatMinUnhelpful(2);
    t.after(() => {
      setKnowledgeLowRatedCaveatMinUnhelpful(was);
    });

    const scope = `${RUN}-failsafe`;
    const userId = `${RUN}-member-failsafe`;
    const interests = `fail safe test interests ${RUN}`;
    await setMemberInterests('discord', userId, interests);

    const anchorVec = await embed(interests);
    const midBandVec = atCosineSimilarity(anchorVec, 0.7);
    const { rows: aRows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [scope, `Failsafe A ${RUN}`, 'STILL_SERVED_FOR_ME_A', pgvector.toSql(anchorVec)],
    );
    const { rows: bRows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [scope, `Failsafe B ${RUN}`, 'STILL_SERVED_FOR_ME_B', pgvector.toSql(midBandVec)],
    );
    const aId = Number(aRows[0].id);
    const bId = Number(bRows[0].id);

    const warnLog = t.mock.method(logger, 'warn', () => {});
    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM answer_feedback')) {
        return Promise.reject(new Error('low-rated lookup unavailable'));
      }
      if (typeof sql === 'string' && sql.includes('JOIN knowledge b')) {
        return Promise.reject(new Error('conflict lookup unavailable'));
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const caller = {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
      isDirect: false,
    };
    const result = await getKnowledgeForMeHandler(caller).handler({});
    const text = result.content[0]?.text ?? '';

    assert.equal(
      result.isError,
      false,
      'a lookup rejection in either lookup must never fail the whole reply',
    );
    assert.ok(text.includes('STILL_SERVED_FOR_ME_A'), 'the first entry must still be served');
    assert.ok(text.includes('STILL_SERVED_FOR_ME_B'), 'the second entry must still be served');
    assert.doesNotMatch(
      text,
      new RegExp(KNOWLEDGE_CONFLICT_CAVEAT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'a conflict-lookup failure must degrade to no caveat, never an error',
    );
    assert.doesNotMatch(
      text,
      new RegExp(notice('knowledgeLowRatedCaveat').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'a low-rated-lookup failure must degrade to no caveat, never an error',
    );
    assert.ok(warnLog.mock.calls.length >= 2, 'both lookup failures must be logged, not silently swallowed');

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[aId, bId]]);
    await setMemberInterests('discord', userId, 'clear');
  },
);

// Issue #1325: knowledge_for_me computes the same relevantIds knowledge_search
// does but never stamped turnState.lastKnowledgeHitId, so a helpful rating on
// one of its answers was misattributed as "ungrounded" (see feedback.ts's
// #726 draft guard). These tests exercise the stamp this file's handler now
// performs, mirroring knowledge_search's own turnState tests in tests/tools.test.ts.

test(
  'knowledge_for_me writes the top-scoring qualifying hit id into turnState.lastKnowledgeHitId, and ' +
    'COMMUNITY_TURN_STATE_FINALIZER then surfaces it as knowledgeEntryId (issue #1325 acceptance criteria 1, 3)',
  { skip },
  async () => {
    const scope = `${RUN}-attribution-stamp`;
    const userId = `${RUN}-member-attribution-stamp`;
    const interests = `attribution stamp test interests ${RUN}`;
    await setMemberInterests('discord', userId, interests);

    const anchorVec = await embed(interests);
    const { rows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [scope, `Attribution stamp entry ${RUN}`, 'ATTRIBUTION_STAMP_FOR_ME_TEXT', pgvector.toSql(anchorVec)],
    );
    const id = Number(rows[0].id);

    const caller = {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
      isDirect: false,
    };
    const turnState: { lastKnowledgeHitId: number | null } = { lastKnowledgeHitId: null };
    const result = await getKnowledgeForMeHandler(caller, turnState).handler({});
    const text = result.content[0]?.text ?? '';

    assert.match(text, /ATTRIBUTION_STAMP_FOR_ME_TEXT/, 'the qualifying entry must still be served');
    assert.equal(
      turnState.lastKnowledgeHitId,
      id,
      'a qualifying knowledge_for_me call must write its top-scoring hit id into turnState',
    );
    assert.deepEqual(
      COMMUNITY_TURN_STATE_FINALIZER(turnState),
      { knowledgeEntryId: id },
      'the finalizer must surface the stamped id as knowledgeEntryId, the same key knowledge_search feeds',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
    await setMemberInterests('discord', userId, 'clear');
  },
);

test(
  'knowledge_for_me leaves an earlier qualifying turnState.lastKnowledgeHitId untouched when its own call finds ' +
    'no qualifying hit — last QUALIFYING call wins, matching knowledge_search (issue #1325 acceptance criterion 2)',
  { skip },
  async () => {
    const userId = `${RUN}-member-no-clobber`;
    const interests = `no clobber test interests ${RUN} with no matching knowledge entry`;
    await setMemberInterests('discord', userId, interests);

    const caller = {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: `${RUN}-no-clobber`,
      isDirect: false,
    };
    // Simulates an earlier, qualifying knowledge_search call in the same turn.
    const turnState: { lastKnowledgeHitId: number | null } = { lastKnowledgeHitId: 424242 };
    await getKnowledgeForMeHandler(caller, turnState).handler({});

    assert.equal(
      turnState.lastKnowledgeHitId,
      424242,
      'a below-floor (or no-hit) knowledge_for_me call must never clear an earlier qualifying turnState id',
    );

    await setMemberInterests('discord', userId, 'clear');
  },
);

test(
  'knowledge_for_me leaves turnState.lastKnowledgeHitId null when buildToolServer was called with no turnState ' +
    'at all (issue #1325) — must not throw just because there is no turnState ref to write into',
  { skip },
  async () => {
    const userId = `${RUN}-member-no-turnstate`;
    const interests = `no turnstate test interests ${RUN}`;
    await setMemberInterests('discord', userId, interests);

    const anchorVec = await embed(interests);
    const { rows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [
        `${RUN}-no-turnstate`,
        `No turnstate entry ${RUN}`,
        'NO_TURNSTATE_FOR_ME_TEXT',
        pgvector.toSql(anchorVec),
      ],
    );
    const id = Number(rows[0].id);

    const caller = {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: `${RUN}-no-turnstate`,
      isDirect: false,
    };
    // No turnState argument at all.
    await getKnowledgeForMeHandler(caller).handler({});

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
    await setMemberInterests('discord', userId, 'clear');
  },
);

test(
  'SECURITY: a rate_answer(helpful: true) following a knowledge_for_me answer that carries the ' +
    "knowledgeEntryId this fix now stamps never drafts an ungrounded knowledge candidate — feedback.ts's " +
    'grounding.knowledgeEntryId === null guard correctly skips createKnowledgeTip (issue #1325 acceptance ' +
    'criterion 4)',
  { skip },
  async () => {
    const scope = `${RUN}-attribution-security`;
    const userId = `${RUN}-member-attribution-security`;
    const interests = `attribution security test interests ${RUN}`;
    await setMemberInterests('discord', userId, interests);

    const anchorVec = await embed(interests);
    const { rows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [
        scope,
        `Attribution security entry ${RUN}`,
        'ATTRIBUTION_SECURITY_FOR_ME_TEXT',
        pgvector.toSql(anchorVec),
      ],
    );
    const id = Number(rows[0].id);

    const caller = {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
      isDirect: false,
    };
    const turnState: { lastKnowledgeHitId: number | null } = { lastKnowledgeHitId: null };
    await getKnowledgeForMeHandler(caller, turnState).handler({});
    assert.equal(
      turnState.lastKnowledgeHitId,
      id,
      'precondition: the call must have stamped the served entry id',
    );

    // Simulates what the router's outbound-recording stamp (issue #411) does
    // with the finalizer's output — the exact meta shape
    // tests/knowledgeEntryIdRouter.test.ts pins for the primary reply path.
    const { knowledgeEntryId } = COMMUNITY_TURN_STATE_FINALIZER(turnState);
    await recordInteraction({
      platform: 'discord',
      conversationId: scope,
      userId,
      role: 'member',
      direction: 'inbound',
      content: `${RUN} attribution security question`,
    });
    await recordInteraction({
      platform: 'discord',
      conversationId: scope,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'ATTRIBUTION_SECURITY_FOR_ME_TEXT',
      meta: { replyToUserId: userId, knowledgeEntryId },
    });

    await withAnswerCandidateFlag(true, async () => {
      const result = await getRateAnswerHandler(userId, scope).handler({ helpful: true });
      assert.notEqual(result.isError, true);
    });

    const rows2 = await pool.query(`SELECT 1 FROM knowledge_candidates WHERE source_user_id = $1`, [userId]);
    assert.equal(
      rows2.rows.length,
      0,
      'SECURITY: a helpful rating on a knowledge_for_me answer now correctly grounded via the ' +
        'lastKnowledgeHitId stamp must never draft a redundant candidate',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [scope]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
    await setMemberInterests('discord', userId, 'clear');
  },
);

// Issue #1383: knowledge_for_me computed the same relevantIds knowledge_search
// does (already reused for the #1325 lastKnowledgeHitId stamp above) but never
// fed them to recordKnowledgeRetrieval or the #701 stale-alert turn-state
// write — the exact #1052/#1103 curation-signal gap, one tool over. These
// tests mirror knowledge_search's own retrieval-count/stale-alert coverage in
// tests/tools.test.ts, adapted to this tool's interests-derived query and its
// lack of a lexical fallback.

test(
  'knowledge_for_me bumps retrieval_count only for the hit that clears the relevance floor, matching ' +
    "knowledge_search's own recordKnowledgeRetrieval call (issue #1383 acceptance criteria 1, 5)",
  { skip },
  async () => {
    const scope = `${RUN}-retrieval-bump`;
    const userId = `${RUN}-member-retrieval-bump`;
    const interests = `retrieval bump test interests ${RUN}`;
    await setMemberInterests('discord', userId, interests);

    const anchorVec = await embed(interests);
    const relevantVec = atCosineSimilarity(anchorVec, 0.9);
    // Orthogonal-ish to the anchor, so its similarity lands well below the
    // 0.35 relevance floor — the negative case proving a below-floor hit is
    // never counted as a "use", same shape as tools.test.ts's own
    // knowledge_search retrieval-bump test.
    const distractorVec = atCosineSimilarity(anchorVec, 0.05);
    const { rows: relevantRows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [scope, `Retrieval bump entry ${RUN}`, 'RETRIEVAL_BUMP_FOR_ME_TEXT', pgvector.toSql(relevantVec)],
    );
    const { rows: distractorRows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [
        scope,
        `Retrieval bump distractor ${RUN}`,
        'RETRIEVAL_BUMP_DISTRACTOR_TEXT',
        pgvector.toSql(distractorVec),
      ],
    );
    const relevantId = Number(relevantRows[0].id);
    const distractorId = Number(distractorRows[0].id);

    const caller = {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
      isDirect: false,
    };
    await getKnowledgeForMeHandler(caller).handler({});

    const relevantCount = await waitForRetrievalCount(relevantId, (c) => c >= 1);
    assert.equal(
      relevantCount,
      1,
      'the entry that clears the relevance floor gets its retrieval_count bumped',
    );

    const distractorCount = await waitForRetrievalCount(distractorId, (c) => c >= 1, 1_000);
    assert.equal(
      distractorCount,
      0,
      'a below-floor entry must never be counted as a use — only relevantIds reaches recordKnowledgeRetrieval',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[relevantId, distractorId]]);
    await setMemberInterests('discord', userId, 'clear');
  },
);

test(
  'knowledge_for_me makes no retrieval_count write and no published interests, hence never reaches ' +
    'searchKnowledge — matching criterion 4 for the "no interests" branch (issue #1383 acceptance criterion 4)',
  async (t) => {
    let retrievalUpdateCalls = 0;
    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM member_interests')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (typeof sql === 'string' && sql.includes('retrieval_count')) {
        retrievalUpdateCalls += 1;
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const caller = {
      platform: 'discord' as const,
      userId: `${RUN}-member-no-profile-retrieval`,
      userName: 'Member',
      role: 'member' as const,
      conversationId: `${RUN}-no-profile-retrieval`,
      isDirect: false,
    };
    const turnState: KnowledgeForMeTurnState = { lastKnowledgeHitId: null };
    await getKnowledgeForMeHandler(caller, turnState).handler({});

    assert.equal(
      retrievalUpdateCalls,
      0,
      'a caller with no published interests must never reach recordKnowledgeRetrieval',
    );
    assert.equal(
      turnState.staleKnowledgeAlertIds,
      undefined,
      'a caller with no published interests must never push onto staleKnowledgeAlertIds',
    );
  },
);

test(
  'knowledge_for_me makes no retrieval_count write when hits exist but none clear the relevance floor (issue ' +
    '#1383 acceptance criterion 4)',
  { skip },
  async () => {
    const scope = `${RUN}-below-floor`;
    const userId = `${RUN}-member-below-floor`;
    const interests = `below floor test interests ${RUN}`;
    await setMemberInterests('discord', userId, interests);

    const anchorVec = await embed(interests);
    const belowFloorVec = atCosineSimilarity(anchorVec, 0.05);
    const { rows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [scope, `Below floor entry ${RUN}`, 'BELOW_FLOOR_FOR_ME_TEXT', pgvector.toSql(belowFloorVec)],
    );
    const id = Number(rows[0].id);

    const caller = {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
      isDirect: false,
    };
    const turnState: KnowledgeForMeTurnState = { lastKnowledgeHitId: 999_999 };
    await getKnowledgeForMeHandler(caller, turnState).handler({});

    const count = await waitForRetrievalCount(id, (c) => c >= 1, 1_000);
    assert.equal(count, 0, 'a below-floor-only result set must never bump retrieval_count');
    assert.equal(
      turnState.lastKnowledgeHitId,
      999_999,
      'a non-qualifying call must never clobber an earlier qualifying turnState id',
    );
    assert.equal(
      turnState.staleKnowledgeAlertIds,
      undefined,
      'a non-qualifying call must never push onto staleKnowledgeAlertIds',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
    await setMemberInterests('discord', userId, 'clear');
  },
);

test(
  'knowledge_for_me (KNOWLEDGE_STALE_ALERT_ENABLED=true): a served, stale hit pushes its id onto ' +
    'turnState.staleKnowledgeAlertIds — the same #701 nudge knowledge_search gives its own hits (issue #1383 ' +
    'acceptance criterion 2)',
  { skip },
  async () => {
    const originalEnabled = config.knowledgeStaleAlert.enabled;
    const originalStaleDays = config.adminDigest.knowledgeStaleDays;
    setKnowledgeStaleAlertEnabled(true);
    setKnowledgeStaleDays(30);
    try {
      const scope = `${RUN}-stale-alert-for-me`;
      const userId = `${RUN}-member-stale-alert`;
      const interests = `stale alert test interests ${RUN}`;
      await setMemberInterests('discord', userId, interests);

      const anchorVec = await embed(interests);
      const { rows } = await pool.query(
        `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
        [scope, `Stale alert entry ${RUN}`, 'STALE_ALERT_FOR_ME_TEXT', pgvector.toSql(anchorVec)],
      );
      const id = Number(rows[0].id);
      await pool.query(`UPDATE knowledge SET updated_at = now() - interval '400 days' WHERE id = $1`, [id]);

      const caller = {
        platform: 'discord' as const,
        userId,
        userName: 'Member',
        role: 'member' as const,
        conversationId: scope,
        isDirect: false,
      };
      const turnState: KnowledgeForMeTurnState = { lastKnowledgeHitId: null };
      await getKnowledgeForMeHandler(caller, turnState).handler({});

      assert.deepEqual(
        turnState.staleKnowledgeAlertIds,
        [id],
        'a served, stale hit must have its id pushed onto turnState.staleKnowledgeAlertIds',
      );

      await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
      await setMemberInterests('discord', userId, 'clear');
    } finally {
      setKnowledgeStaleAlertEnabled(originalEnabled);
      setKnowledgeStaleDays(originalStaleDays);
    }
  },
);

test(
  'knowledge_for_me (KNOWLEDGE_STALE_ALERT_ENABLED unset/false, the default): a served, stale hit never sets ' +
    'turnState.staleKnowledgeAlertIds, but its retrieval_count still bumps — the only observable change is the ' +
    'new recordKnowledgeRetrieval call (issue #1383 acceptance criterion 3)',
  { skip },
  async () => {
    assert.equal(config.knowledgeStaleAlert.enabled, false, 'this test requires the flag at its off default');
    const originalStaleDays = config.adminDigest.knowledgeStaleDays;
    setKnowledgeStaleDays(30);
    try {
      const scope = `${RUN}-stale-alert-off-for-me`;
      const userId = `${RUN}-member-stale-alert-off`;
      const interests = `stale alert off test interests ${RUN}`;
      await setMemberInterests('discord', userId, interests);

      const anchorVec = await embed(interests);
      const { rows } = await pool.query(
        `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
        [scope, `Stale alert off entry ${RUN}`, 'STALE_ALERT_OFF_FOR_ME_TEXT', pgvector.toSql(anchorVec)],
      );
      const id = Number(rows[0].id);
      await pool.query(`UPDATE knowledge SET updated_at = now() - interval '400 days' WHERE id = $1`, [id]);

      const caller = {
        platform: 'discord' as const,
        userId,
        userName: 'Member',
        role: 'member' as const,
        conversationId: scope,
        isDirect: false,
      };
      const turnState: KnowledgeForMeTurnState = { lastKnowledgeHitId: null };
      await getKnowledgeForMeHandler(caller, turnState).handler({});

      assert.equal(
        turnState.staleKnowledgeAlertIds,
        undefined,
        'the flag being off must never set turnState.staleKnowledgeAlertIds, even for a stale served hit',
      );
      const count = await waitForRetrievalCount(id, (c) => c >= 1);
      assert.equal(
        count,
        1,
        'the retrieval_count bump is unconditional — the flag only gates the stale-alert turn-state write',
      );

      await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
      await setMemberInterests('discord', userId, 'clear');
    } finally {
      setKnowledgeStaleDays(originalStaleDays);
    }
  },
);

test(
  'SECURITY: knowledge_for_me writes only relevantIds to recordKnowledgeRetrieval and only ' +
    'staleKnowledgeAlertIds onto turnState — no caller-supplied field, no widened id set, no second call site ' +
    '(issue #1383 acceptance criterion 5)',
  { skip },
  async () => {
    const scope = `${RUN}-security-surface`;
    const userId = `${RUN}-member-security-surface`;
    const interests = `security surface test interests ${RUN}`;
    await setMemberInterests('discord', userId, interests);

    const anchorVec = await embed(interests);
    const relevantVec = atCosineSimilarity(anchorVec, 0.9);
    const { rows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
      [scope, `Security surface entry ${RUN}`, 'SECURITY_SURFACE_FOR_ME_TEXT', pgvector.toSql(relevantVec)],
    );
    const id = Number(rows[0].id);

    const caller = {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: scope,
      isDirect: false,
    };
    const turnState: KnowledgeForMeTurnState = { lastKnowledgeHitId: null };
    await getKnowledgeForMeHandler(caller, turnState).handler({});

    const count = await waitForRetrievalCount(id, (c) => c >= 1);
    assert.equal(count, 1, 'the only floor-clearing id must reach recordKnowledgeRetrieval exactly once');
    // Subset check rather than an exact set, since staleKnowledgeAlertIds is
    // only populated when the flag is on AND the served hit is stale
    // (neither true for this fixture) — the point here is that the handler
    // never introduces any OTHER key.
    for (const key of Object.keys(turnState)) {
      assert.ok(
        key === 'lastKnowledgeHitId' || key === 'staleKnowledgeAlertIds',
        `the handler must never write any turnState key beyond the pre-existing lastKnowledgeHitId and the ` +
          `new staleKnowledgeAlertIds — found unexpected key "${key}"`,
      );
    }

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
    await setMemberInterests('discord', userId, 'clear');
  },
);

test(
  'SECURITY: knowledge_for_me and knowledge_search produce parity outcomes (a retrieval_count bump plus a ' +
    'staleKnowledgeAlertIds push) for a stale hit served the same way through each path — no interest-path ' +
    'entry is under-counted or under-alerted relative to the search path (issue #1383 acceptance criterion 6)',
  { skip },
  async () => {
    const originalEnabled = config.knowledgeStaleAlert.enabled;
    const originalStaleDays = config.adminDigest.knowledgeStaleDays;
    setKnowledgeStaleAlertEnabled(true);
    setKnowledgeStaleDays(30);
    try {
      const sharedText = `parity test shared text ${RUN}`;
      const anchorVec = await embed(sharedText);

      // Two independent fixtures (separate scope, separate row) rather than
      // one shared row, so each tool's own fire-and-forget write can be
      // observed in isolation without one call's bump racing the other's.
      const searchScope = `${RUN}-parity-search`;
      const forMeScope = `${RUN}-parity-for-me`;
      const forMeUserId = `${RUN}-member-parity`;
      await setMemberInterests('discord', forMeUserId, sharedText);

      const { rows: searchRows } = await pool.query(
        `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
        [searchScope, `Parity search entry ${RUN}`, 'PARITY_SEARCH_TEXT', pgvector.toSql(anchorVec)],
      );
      const { rows: forMeRows } = await pool.query(
        `INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`,
        [forMeScope, `Parity for-me entry ${RUN}`, 'PARITY_FOR_ME_TEXT', pgvector.toSql(anchorVec)],
      );
      const searchId = Number(searchRows[0].id);
      const forMeId = Number(forMeRows[0].id);
      await pool.query(`UPDATE knowledge SET updated_at = now() - interval '400 days' WHERE id = ANY($1)`, [
        [searchId, forMeId],
      ]);

      const searchCaller = {
        platform: 'discord' as const,
        userId: `${RUN}-member-parity-search`,
        userName: 'Member',
        role: 'member' as const,
        conversationId: searchScope,
        isDirect: false,
      };
      const forMeCaller = {
        platform: 'discord' as const,
        userId: forMeUserId,
        userName: 'Member',
        role: 'member' as const,
        conversationId: forMeScope,
        isDirect: false,
      };
      const searchTurnState: KnowledgeForMeTurnState = { lastKnowledgeHitId: null };
      const forMeTurnState: KnowledgeForMeTurnState = { lastKnowledgeHitId: null };

      await getKnowledgeSearchHandler(searchCaller, searchTurnState).handler({ query: sharedText });
      await getKnowledgeForMeHandler(forMeCaller, forMeTurnState).handler({});

      const searchCount = await waitForRetrievalCount(searchId, (c) => c >= 1);
      const forMeCount = await waitForRetrievalCount(forMeId, (c) => c >= 1);
      assert.equal(searchCount, 1, 'knowledge_search must bump retrieval_count for its served hit');
      assert.equal(
        forMeCount,
        1,
        'knowledge_for_me must bump retrieval_count for its served hit — parity with knowledge_search',
      );

      assert.deepEqual(
        searchTurnState.staleKnowledgeAlertIds,
        [searchId],
        'precondition: knowledge_search pushes the stale hit onto staleKnowledgeAlertIds',
      );
      assert.deepEqual(
        forMeTurnState.staleKnowledgeAlertIds,
        [forMeId],
        'knowledge_for_me must push its own served stale hit onto staleKnowledgeAlertIds — parity with ' +
          'knowledge_search, no under-alerting for the interest-discovery path',
      );

      await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[searchId, forMeId]]);
      await setMemberInterests('discord', forMeUserId, 'clear');
    } finally {
      setKnowledgeStaleAlertEnabled(originalEnabled);
      setKnowledgeStaleDays(originalStaleDays);
    }
  },
);
