import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

// Issue #1480: list_projects gains a `forMe` flag composing two already-shipped
// pieces — getPublishedInterestsForOwners (the exact self-scoped lookup
// who_is_into({mine:true})/knowledge_for_me already use) fed into searchProjects
// (the identical framework call list_projects' own `query` path already makes)
// — and rendered via the existing formatProjectResults, unmodified. These tests
// exercise the composition end to end, following knowledgeForMe.test.ts's exact
// shape for the sibling feature (#1287) applied to searchKnowledge instead.
// Every test mocks `pool.query` (a live method swap on the shared `pool`
// object, safe to redo per test) rather than `t.mock.module`-ing an ES module —
// the latter only takes effect on an import that has not yet happened anywhere
// in this process, and this file's own top-level imports already load
// agent-base's storage modules for real.
//
// Every fixture-writing test wraps its assertions in try/finally: searchProjects
// has no relevance floor (it returns the top-K nearest neighbours across ALL of
// member_projects, however distant), so a row this file fails to clean up would
// silently leak into every OTHER list_projects test's "no match"/exact-count
// expectations for the rest of the shared-DB run, not just this file.

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
const { buildToolServer, formatListProjectsEmptyText } = await import('../src/module/agent/tools.js');
const { MEMBER_TOOLS } = await import('@swampratnz/agent-base/auth/rbac.js');
const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');
const { embed } = await import('@swampratnz/agent-base/storage/embeddings.js');
const { setMemberInterests, shareProject } = await import('@swampratnz/agent-base/storage/repository.js');
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

type ListProjectsHandler = {
  handler: (args: {
    query?: string;
    seekingCollaborators?: boolean;
    mine?: boolean;
    forMe?: boolean;
  }) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

function getListProjectsHandler(caller: {
  platform: 'discord';
  userId: string;
  userName?: string;
  role: 'member' | 'guest';
  conversationId: string;
  isDirect: boolean;
}): ListProjectsHandler {
  const server = buildToolServer({ userName: 'Member', ...caller }, stubAdapter());
  return (
    server.instance as unknown as {
      _registeredTools: Record<string, ListProjectsHandler>;
    }
  )._registeredTools['list_projects'];
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

async function deleteProjects(userIds: string[]): Promise<void> {
  await pool.query(`DELETE FROM member_projects WHERE platform = 'discord' AND user_id = ANY($1)`, [userIds]);
}

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

test('list_projects is member-tier, registered in the manifest wiring (issue #1480)', () => {
  assert.ok(MEMBER_TOOLS.includes('mcp__community__list_projects'), 'list_projects must be in MEMBER_TOOLS');
});

test(
  "list_projects(forMe: true) searches shared projects using the caller's own published interests text, " +
    'rendering hits through the existing formatProjectResults (issue #1480 acceptance criterion 1)',
  { skip },
  async () => {
    const userId = `${RUN}-for-me-basic`;
    const ownerId = `${RUN}-for-me-basic-owner`;
    const interests = `deep in RAG evaluation tooling ${RUN}`;
    await setMemberInterests('discord', userId, interests);
    try {
      const anchorVec = await embed(interests);
      const near = atCosineSimilarity(anchorVec, 0.9);
      const created = await shareProject({
        platform: 'discord',
        userId: ownerId,
        name: `RAG eval helper ${RUN}`,
        description: 'A tool that helps evaluate RAG pipelines.',
      });
      assert.ok(created.ok, 'precondition: the project must have been created');
      // Pin the embedding directly so the similarity match is deterministic,
      // matching knowledgeForMe.test.ts's own raw-INSERT-vector fixture style.
      await pool.query(
        `UPDATE member_projects SET embedding = $1 WHERE platform = 'discord' AND user_id = $2`,
        [pgvector.toSql(near), ownerId],
      );

      const caller = {
        platform: 'discord' as const,
        userId,
        role: 'member' as const,
        conversationId: `${RUN}-for-me-basic-scope`,
        isDirect: false,
      };
      const result = await getListProjectsHandler(caller).handler({ forMe: true });
      const text = result.content[0]?.text ?? '';

      assert.equal(result.isError, false);
      assert.match(
        text,
        new RegExp(`RAG eval helper ${RUN}`),
        "a project near the caller's own interests must render",
      );
    } finally {
      await deleteProjects([ownerId]);
      await setMemberInterests('discord', userId, 'clear');
    }
  },
);

test(
  'list_projects(forMe: true, mine: true) behaves exactly as mine: true alone — mine takes precedence and ' +
    'forMe is never read (issue #1480 acceptance criterion 2)',
  { skip },
  async () => {
    const ownerId = `${RUN}-precedence-mine`;
    const ownerTool = getListProjectsHandler({
      platform: 'discord',
      userId: ownerId,
      role: 'member',
      conversationId: `${RUN}-precedence-mine-scope`,
      isDirect: false,
    });

    const mineOnly = await ownerTool.handler({ mine: true });
    const mineWithForMe = await ownerTool.handler({ mine: true, forMe: true });

    assert.equal(
      mineWithForMe.content[0]?.text,
      mineOnly.content[0]?.text,
      'forMe alongside mine: true must produce byte-identical output to mine: true alone',
    );
    // This caller has no published interests and no shared projects, so this
    // also proves forMe's own "publish interests first" guidance never fires
    // when mine: true wins.
    assert.equal(mineOnly.content[0]?.text, formatListProjectsEmptyText('mine', 'auto', undefined));
  },
);

test(
  "SECURITY: list_projects(forMe: true, query: <ignored>) reaches searchProjects with the caller's own " +
    'interests text, never the supplied query (issue #1480 acceptance criterion 2)',
  { skip },
  async () => {
    const userId = `${RUN}-precedence-query`;
    const interestsOwnerId = `${RUN}-precedence-query-interests-owner`;
    const queryOwnerId = `${RUN}-precedence-query-query-owner`;
    const interests = `Zorbnicate whimsy interests ${RUN}`;
    const queryText = `Flumberoo widget query ${RUN}`;
    await setMemberInterests('discord', userId, interests);
    try {
      const interestsAnchor = await embed(interests);
      const queryAnchor = await embed(queryText);
      const interestsMatchName = `Zorbnicate match project ${RUN}`;
      const queryMatchName = `Flumberoo match project ${RUN}`;

      await shareProject({
        platform: 'discord',
        userId: interestsOwnerId,
        name: interestsMatchName,
        description: 'matches the caller interests, not the supplied query',
      });
      await pool.query(
        `UPDATE member_projects SET embedding = $1 WHERE platform = 'discord' AND user_id = $2`,
        [pgvector.toSql(atCosineSimilarity(interestsAnchor, 0.95)), interestsOwnerId],
      );
      await shareProject({
        platform: 'discord',
        userId: queryOwnerId,
        name: queryMatchName,
        description: 'matches the supplied query, not the caller interests',
      });
      await pool.query(
        `UPDATE member_projects SET embedding = $1 WHERE platform = 'discord' AND user_id = $2`,
        [pgvector.toSql(atCosineSimilarity(queryAnchor, 0.95)), queryOwnerId],
      );

      const caller = {
        platform: 'discord' as const,
        userId,
        role: 'member' as const,
        conversationId: `${RUN}-precedence-query-scope`,
        isDirect: false,
      };
      const result = await getListProjectsHandler(caller).handler({ forMe: true, query: queryText });
      const text = result.content[0]?.text ?? '';

      // searchProjects has no relevance floor, so — unlike list_projects'
      // pre-existing mine:true-ignores-query test, which can assert the other
      // member's project is entirely absent via a hard identity filter — both
      // fixtures may legitimately appear here (this test's own pinned rows are
      // the only two guaranteed to exist, but a shared-DB run may have other
      // leftover rows too). What proves the query argument was ignored is
      // RANKING: only a search embedded on the caller's own interests text
      // ranks interestsMatchName strictly ahead of queryMatchName; a search
      // embedded on the supplied query would rank them the other way round.
      const interestsIndex = text.indexOf(interestsMatchName);
      const queryIndex = text.indexOf(queryMatchName);
      assert.notEqual(interestsIndex, -1, "the caller's own interests-driven match must be served");
      assert.ok(
        queryIndex === -1 || interestsIndex < queryIndex,
        'the interests-driven match must rank strictly ahead of the query-driven match, proving the search ' +
          "embedded the caller's interests text rather than the supplied query",
      );
    } finally {
      await deleteProjects([interestsOwnerId, queryOwnerId]);
      await setMemberInterests('discord', userId, 'clear');
    }
  },
);

test(
  'list_projects(forMe: true, seekingCollaborators: true) narrows the interests-driven search to seeking ' +
    'rows only, via the same searchProjects options object the query path already threads through (issue ' +
    '#1480 acceptance criterion 3)',
  { skip },
  async () => {
    const userId = `${RUN}-for-me-seeking`;
    const seekingOwnerId = `${RUN}-for-me-seeking-seeking-owner`;
    const showcaseOwnerId = `${RUN}-for-me-seeking-showcase-owner`;
    const interests = `gadget building interests ${RUN}`;
    await setMemberInterests('discord', userId, interests);
    try {
      const anchor = await embed(interests);
      const near = atCosineSimilarity(anchor, 0.95);
      const seekingName = `Seeking Gadget Project ${RUN}`;
      const showcaseName = `Showcase Gadget Project ${RUN}`;

      await shareProject({
        platform: 'discord',
        userId: seekingOwnerId,
        name: seekingName,
        description: 'a gadget project looking for collaborators',
        seekingCollaborators: true,
      });
      await pool.query(
        `UPDATE member_projects SET embedding = $1 WHERE platform = 'discord' AND user_id = $2`,
        [pgvector.toSql(near), seekingOwnerId],
      );
      await shareProject({
        platform: 'discord',
        userId: showcaseOwnerId,
        name: showcaseName,
        description: 'a gadget project with no collaborators flag',
      });
      await pool.query(
        `UPDATE member_projects SET embedding = $1 WHERE platform = 'discord' AND user_id = $2`,
        [pgvector.toSql(near), showcaseOwnerId],
      );

      const caller = {
        platform: 'discord' as const,
        userId,
        role: 'member' as const,
        conversationId: `${RUN}-for-me-seeking-scope`,
        isDirect: false,
      };
      const result = await getListProjectsHandler(caller).handler({
        forMe: true,
        seekingCollaborators: true,
      });
      const text = result.content[0]?.text ?? '';

      assert.match(text, new RegExp(seekingName), 'the seeking project must be served');
      assert.doesNotMatch(text, new RegExp(showcaseName), 'the non-seeking project must be filtered out');
    } finally {
      await deleteProjects([seekingOwnerId, showcaseOwnerId]);
      await setMemberInterests('discord', userId, 'clear');
    }
  },
);

test(
  "list_projects(forMe: true) returns a dedicated 'publish interests first' guidance string, and never " +
    'queries member_projects (so never reaches searchProjects), when the caller has no published-interests ' +
    'row (issue #1480 acceptance criterion 4)',
  async (t) => {
    let projectsQueryCalls = 0;
    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM member_interests')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (typeof sql === 'string' && sql.includes('FROM member_projects')) {
        projectsQueryCalls += 1;
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const caller = {
      platform: 'discord' as const,
      userId: `${RUN}-for-me-no-profile`,
      role: 'member' as const,
      conversationId: `${RUN}-for-me-no-profile-scope`,
      isDirect: false,
    };
    const result = await getListProjectsHandler(caller).handler({ forMe: true });
    const text = result.content[0]?.text ?? '';

    assert.equal(text, formatListProjectsEmptyText('forMe', 'auto', undefined));
    assert.notEqual(
      text,
      formatListProjectsEmptyText('mine', 'auto', undefined),
      "the 'forMe' guidance must be a distinct string from 'mine's — it names set_my_interests, not share_project",
    );
    assert.equal(
      projectsQueryCalls,
      0,
      'searchProjects must never query member_projects when the caller has no published interests',
    );
  },
);

test(
  'list_projects with forMe omitted, or forMe: false, leaves every existing path (no-arg, query, ' +
    'seekingCollaborators, mine) byte-identical to today (issue #1480 acceptance criterion 5)',
  { skip },
  async () => {
    const ownerId = `${RUN}-regression-owner`;
    const ownerTool = getListProjectsHandler({
      platform: 'discord',
      userId: ownerId,
      role: 'member',
      conversationId: `${RUN}-regression-owner-scope`,
      isDirect: false,
    });
    const viewerTool = getListProjectsHandler({
      platform: 'discord',
      userId: `${RUN}-regression-viewer`,
      role: 'member',
      conversationId: `${RUN}-regression-viewer-scope`,
      isDirect: false,
    });

    await setMemberInterests('discord', ownerId, `regression owner interests ${RUN}`);
    try {
      await shareProject({
        platform: 'discord',
        userId: ownerId,
        name: `Regression Project ${RUN}`,
        description: 'used to prove forMe: false/omitted changes nothing',
        seekingCollaborators: true,
      });

      for (const forMeValue of [undefined, false] as const) {
        const noArg = await viewerTool.handler(forMeValue === undefined ? {} : { forMe: forMeValue });
        const withQuery = await viewerTool.handler(
          forMeValue === undefined ? { query: 'Regression' } : { query: 'Regression', forMe: forMeValue },
        );
        const withSeeking = await viewerTool.handler(
          forMeValue === undefined
            ? { seekingCollaborators: true }
            : { seekingCollaborators: true, forMe: forMeValue },
        );
        const withMine = await ownerTool.handler(
          forMeValue === undefined ? { mine: true } : { mine: true, forMe: forMeValue },
        );

        assert.match(noArg.content[0]?.text ?? '', new RegExp(`Regression Project ${RUN}`));
        assert.match(withQuery.content[0]?.text ?? '', new RegExp(`Regression Project ${RUN}`));
        assert.match(withSeeking.content[0]?.text ?? '', new RegExp(`Regression Project ${RUN}`));
        assert.match(withMine.content[0]?.text ?? '', new RegExp(`Regression Project ${RUN}`));
      }
    } finally {
      await deleteProjects([ownerId]);
      await setMemberInterests('discord', ownerId, 'clear');
    }
  },
);

test(
  "SECURITY: list_projects(forMe: true) reads only the caller's OWN {platform, userId} — a different " +
    "identity's published interests row is never read or leaked, even when seeded alongside the caller's own " +
    '(issue #1480 acceptance criterion 6)',
  { skip },
  async (t) => {
    const callerId = `${RUN}-cross-identity-self`;
    const otherId = `${RUN}-cross-identity-other`;
    const callerInterests = `caller-only interests text ${RUN}`;
    const otherInterests = `OTHER MEMBER SECRET interests text ${RUN}`;

    await setMemberInterests('discord', callerId, callerInterests);
    await setMemberInterests('discord', otherId, otherInterests);
    try {
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
        role: 'member' as const,
        conversationId: `${RUN}-cross-identity-scope`,
        isDirect: false,
      };
      const result = await getListProjectsHandler(caller).handler({ forMe: true });
      const text = result.content[0]?.text ?? '';

      // The FIRST member_interests call is this forMe branch's own lookup —
      // it must be self-scoped. (A later call may legitimately follow from
      // formatProjectResults' own unrelated owner-interests cross-reference,
      // issue #718, when a returned project's owner happens to have published
      // interests too — that is pre-existing behaviour, not new surface this
      // change introduces, and it never includes otherId below since otherId
      // never shared a project.)
      assert.ok(calls.length >= 1, 'getPublishedInterestsForOwners must have run at least once');
      assert.deepEqual(
        calls[0]?.params,
        [['discord'], [callerId]],
        "only the caller's own {platform, userId} may reach the forMe branch's own getPublishedInterestsForOwners call",
      );
      assert.doesNotMatch(
        text,
        /OTHER MEMBER SECRET/,
        "the other identity's interests text must never leak into the caller's reply",
      );
    } finally {
      await setMemberInterests('discord', callerId, 'clear');
      await setMemberInterests('discord', otherId, 'clear');
    }
  },
);

test(
  'SECURITY: list_projects(forMe: true) rejects a guest caller via the assertAtLeast re-check, before reaching ' +
    'either getPublishedInterestsForOwners or searchProjects (issue #1480 acceptance criterion 7)',
  async (t) => {
    let memberInterestsCalls = 0;
    let projectsQueryCalls = 0;
    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM member_interests')) {
        memberInterestsCalls += 1;
      }
      if (typeof sql === 'string' && sql.includes('FROM member_projects')) {
        projectsQueryCalls += 1;
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const caller = {
      platform: 'discord' as const,
      userId: `${RUN}-guest`,
      role: 'guest' as const,
      conversationId: `${RUN}-guest-scope`,
      isDirect: false,
    };

    await assert.rejects(
      () => getListProjectsHandler(caller).handler({ forMe: true }),
      /member/i,
      'a guest caller must be rejected by the assertAtLeast re-check',
    );

    assert.equal(
      memberInterestsCalls,
      0,
      'a rejected guest caller must never reach getPublishedInterestsForOwners',
    );
    assert.equal(projectsQueryCalls, 0, 'a rejected guest caller must never reach searchProjects');
  },
);
