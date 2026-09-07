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
const { buildToolServer, WHO_IS_INTO_NO_PROFILE_HINT, formatWhoIsIntoEmptyText } =
  await import('../src/module/agent/tools.js');
const { MEMBER_TOOLS } = await import('@swampratnz/agent-base/auth/rbac.js');
const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');
const { embed } = await import('@swampratnz/agent-base/storage/embeddings.js');
const { setMemberInterests } = await import('@swampratnz/agent-base/storage/repository.js');
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

function getKnowledgeForMeHandler(caller: {
  platform: 'discord';
  userId: string;
  userName: string;
  role: 'member' | 'guest';
  conversationId: string;
  isDirect: boolean;
}): KnowledgeForMeHandler {
  const server = buildToolServer(caller, stubAdapter());
  return (
    server.instance as unknown as {
      _registeredTools: Record<string, KnowledgeForMeHandler>;
    }
  )._registeredTools['knowledge_for_me'];
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
