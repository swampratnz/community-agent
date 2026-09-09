import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';
// The notice pack, for find_helper's/request_project_connection's recipient
// DMs — the manifest does this in production (src/module/agentModule.ts).
import './support/registerNotices.js';

// config.ts validates env at import time — provide a dummy environment
// before anything that (transitively) loads it. This file's process has the
// find-helper feature ENABLED so find_helper's matched/dailyCap/noMatch
// branches can all be exercised, same split tests/findHelperTools.test.ts
// establishes vs tests/tools.test.ts's disabled process.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.FIND_HELPER_ENABLED ??= 'true';

const hasDb = Boolean(process.env.DATABASE_URL) && !process.env.DATABASE_URL.includes('test:test');
const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

await import('./support/registerToolRegistry.js');
const { buildToolServer } = await import('../src/module/agent/tools.js');
const {
  FIND_HELPER_REQUESTER_DAILY_LIMIT,
  PROJECT_CONNECTION_REQUESTER_DAILY_LIMIT,
  setMemberInterests,
  setHelperAvailability,
} = await import('@swampratnz/agent-base/storage/repository.js');
const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM member_interests WHERE platform = 'discord' AND user_id LIKE $1`, [
      `${RUN}%`,
    ]);
    await pool.query(`DELETE FROM helper_notifications WHERE helper_user_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM helper_notifications WHERE requester_user_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM member_projects WHERE user_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM project_connection_requests WHERE requester_user_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM project_connection_requests WHERE owner_user_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM connection_outcomes WHERE requester_user_id LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

function stubAdapter(
  sends: Array<{ userId: string; text: string }>,
  platform: 'discord' | 'whatsapp' = 'discord',
): PlatformAdapter {
  return {
    platform,
    start: async () => {},
    stop: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    sendMessage: async () => {},
    async sendDirectMessage(userId: string, text: string) {
      sends.push({ userId, text });
    },
    conversationsForUser: async () => [],
    adminCapabilities: new Set(),
    performAdminAction: async () => {
      throw new Error('not implemented in stub');
    },
  };
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function findHelperHandler(
  caller: { platform?: 'discord' | 'whatsapp'; userId: string },
  adapter: PlatformAdapter,
) {
  const server = buildToolServer(
    {
      platform: caller.platform ?? 'discord',
      userId: caller.userId,
      userName: 'Member',
      role: 'member',
      conversationId: 'convo-connection-outcome-find-helper',
      isDirect: false,
    },
    adapter,
  );
  return (
    server.instance as unknown as {
      _registeredTools: Record<string, { handler: (args: { topic: string }) => Promise<ToolResult> }>;
    }
  )._registeredTools['find_helper'];
}

function shareProjectHandler(caller: { platform: 'discord' | 'whatsapp'; userId: string }) {
  const server = buildToolServer(
    {
      platform: caller.platform,
      userId: caller.userId,
      userName: 'Owner',
      role: 'member',
      conversationId: 'convo-connection-outcome-share-project',
      isDirect: false,
    },
    stubAdapter([], caller.platform),
  );
  return (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (args: {
            name: string;
            description?: string;
            seekingCollaborators?: boolean;
          }) => Promise<ToolResult>;
        }
      >;
    }
  )._registeredTools['share_project'];
}

function requestProjectConnectionHandler(
  caller: { platform?: 'discord' | 'whatsapp'; userId: string },
  adapter: PlatformAdapter,
) {
  const server = buildToolServer(
    {
      platform: caller.platform ?? 'discord',
      userId: caller.userId,
      userName: 'Requester',
      role: 'member',
      conversationId: 'convo-connection-outcome-request-project-connection',
      isDirect: false,
    },
    adapter,
  );
  return (
    server.instance as unknown as {
      _registeredTools: Record<string, { handler: (args: { projectId: number }) => Promise<ToolResult> }>;
    }
  )._registeredTools['request_project_connection'];
}

function rateConnectionOutcomeHandler(caller: {
  userId: string;
  role?: 'member' | 'guest' | 'admin' | 'super_admin';
}) {
  const server = buildToolServer(
    {
      platform: 'discord',
      userId: caller.userId,
      userName: 'Member',
      role: caller.role ?? 'member',
      conversationId: 'convo-connection-outcome-rate',
      isDirect: false,
    },
    stubAdapter([]),
  );
  return (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: { outcomeId: number; helpful: boolean }) => Promise<ToolResult> }
      >;
    }
  )._registeredTools['rate_connection_outcome'];
}

async function ownRows(userId: string): Promise<Array<{ kind: string }>> {
  const { rows } = await pool.query(
    `SELECT kind FROM connection_outcomes WHERE requester_platform = 'discord' AND requester_user_id = $1`,
    [userId],
  );
  return rows;
}

// --- find_helper: connection_outcomes row creation (issue #1354 SECURITY criterion 1) ---

test(
  "find_helper's matched branch creates exactly one connection_outcomes row with kind='find_helper' (issue #1354 acceptance criterion 1)",
  { skip },
  async () => {
    const requester = `${RUN}-co-find-helper-matched-requester`;
    const helper = `${RUN}-co-find-helper-matched-helper`;
    await setMemberInterests('discord', helper, 'a very unique connection-outcome matched-branch phrase');
    await setHelperAvailability('discord', helper, true);

    const sends: Array<{ userId: string; text: string }> = [];
    const tool = findHelperHandler({ userId: requester }, stubAdapter(sends));
    const result = await tool.handler({ topic: 'a very unique connection-outcome matched-branch phrase' });

    assert.equal(result.isError, false);
    const rows = await ownRows(requester);
    assert.equal(rows.length, 1, 'exactly one row is created on the matched branch');
    assert.equal(rows[0].kind, 'find_helper');
  },
);

test(
  "SECURITY: find_helper's noMatch branch creates zero connection_outcomes rows (issue #1354 acceptance criterion 1)",
  { skip },
  async () => {
    const requester = `${RUN}-co-find-helper-nomatch-requester`;
    const tool = findHelperHandler({ userId: requester }, stubAdapter([]));
    const result = await tool.handler({ topic: 'a very unique phrase nobody has published' });

    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? '', /no one available/i);
    const rows = await ownRows(requester);
    assert.equal(rows.length, 0, 'the noMatch branch must never write a connection_outcomes row');
  },
);

test(
  "SECURITY: find_helper's dailyCap branch creates zero connection_outcomes rows (issue #1354 acceptance criterion 1)",
  { skip },
  async () => {
    const requester = `${RUN}-co-find-helper-dailycap-requester`;
    for (let i = 0; i < FIND_HELPER_REQUESTER_DAILY_LIMIT; i++) {
      await pool.query(
        `INSERT INTO helper_notifications
           (helper_platform, helper_user_id, requester_platform, requester_user_id, topic)
         VALUES ('discord', $1, 'discord', $2, $3)`,
        [`${RUN}-co-find-helper-dailycap-prior-helper-${i}`, requester, `prior topic ${i}`],
      );
    }

    const tool = findHelperHandler({ userId: requester }, stubAdapter([]));
    const result = await tool.handler({ topic: 'irrelevant, refused before matching runs' });

    assert.equal(result.isError, true);
    const rows = await ownRows(requester);
    assert.equal(rows.length, 0, 'the dailyCap branch must never write a connection_outcomes row');
  },
);

// --- request_project_connection: connection_outcomes row creation (issue #1354 SECURITY criterion 1) ---

test(
  "request_project_connection's sent branch creates exactly one connection_outcomes row with kind='project_connection' (issue #1354 acceptance criterion 1)",
  { skip },
  async () => {
    const owner = `${RUN}-co-rpc-sent-owner`;
    const requester = `${RUN}-co-rpc-sent-requester`;
    const shareTool = shareProjectHandler({ platform: 'discord', userId: owner });
    const created = await shareTool.handler({
      name: 'CO Sent Project',
      description: 'seeking collaborators',
      seekingCollaborators: true,
    });
    assert.equal(created.isError, false);
    const { rows: projectRows } = await pool.query(
      `SELECT id FROM member_projects WHERE platform = 'discord' AND user_id = $1 AND name = $2`,
      [owner, 'CO Sent Project'],
    );
    const projectId = Number(projectRows[0].id);

    const tool = requestProjectConnectionHandler({ userId: requester }, stubAdapter([]));
    const result = await tool.handler({ projectId });

    assert.equal(result.isError, false);
    const rows = await ownRows(requester);
    assert.equal(rows.length, 1, 'exactly one row is created on the sent branch');
    assert.equal(rows[0].kind, 'project_connection');
  },
);

test(
  'SECURITY: every request_project_connection refusal branch (dailyCap, notFound, notSeeking, selfMatch, ownerUnreachable, ownerCapped) creates zero connection_outcomes rows (issue #1354 acceptance criterion 1)',
  { skip },
  async () => {
    const owner = `${RUN}-co-rpc-refusals-owner`;
    const shareTool = shareProjectHandler({ platform: 'discord', userId: owner });

    const showcaseOnly = await shareTool.handler({
      name: 'CO Showcase Only',
      description: 'not seeking collaborators',
    });
    assert.equal(showcaseOnly.isError, false);
    const seeking = await shareTool.handler({
      name: 'CO Seeking',
      description: 'seeking collaborators',
      seekingCollaborators: true,
    });
    assert.equal(seeking.isError, false);

    const { rows: showcaseRows } = await pool.query(
      `SELECT id FROM member_projects WHERE platform = 'discord' AND user_id = $1 AND name = $2`,
      [owner, 'CO Showcase Only'],
    );
    const { rows: seekingRows } = await pool.query(
      `SELECT id FROM member_projects WHERE platform = 'discord' AND user_id = $1 AND name = $2`,
      [owner, 'CO Seeking'],
    );
    const showcaseOnlyId = Number(showcaseRows[0].id);
    const seekingId = Number(seekingRows[0].id);

    // dailyCap
    const dailyCapRequester = `${RUN}-co-rpc-refusals-dailycap`;
    for (let i = 0; i < PROJECT_CONNECTION_REQUESTER_DAILY_LIMIT; i++) {
      await pool.query(
        `INSERT INTO project_connection_requests
           (owner_platform, owner_user_id, requester_platform, requester_user_id, project_id)
         VALUES ('discord', $1, 'discord', $2, $3)`,
        [`${RUN}-co-rpc-refusals-prior-owner-${i}`, dailyCapRequester, seekingId],
      );
    }
    const dailyCapResult = await requestProjectConnectionHandler(
      { userId: dailyCapRequester },
      stubAdapter([]),
    ).handler({ projectId: seekingId });
    assert.equal(dailyCapResult.isError, true);
    assert.equal((await ownRows(dailyCapRequester)).length, 0, 'dailyCap must write zero rows');

    // notFound
    const notFoundRequester = `${RUN}-co-rpc-refusals-notfound`;
    const notFoundResult = await requestProjectConnectionHandler(
      { userId: notFoundRequester },
      stubAdapter([]),
    ).handler({ projectId: seekingId + 1_000_000 });
    assert.equal(notFoundResult.isError, true);
    assert.equal((await ownRows(notFoundRequester)).length, 0, 'notFound must write zero rows');

    // notSeeking
    const notSeekingRequester = `${RUN}-co-rpc-refusals-notseeking`;
    const notSeekingResult = await requestProjectConnectionHandler(
      { userId: notSeekingRequester },
      stubAdapter([]),
    ).handler({ projectId: showcaseOnlyId });
    assert.equal(notSeekingResult.isError, true);
    assert.equal((await ownRows(notSeekingRequester)).length, 0, 'notSeeking must write zero rows');

    // selfMatch
    const selfMatchResult = await requestProjectConnectionHandler({ userId: owner }, stubAdapter([])).handler(
      {
        projectId: seekingId,
      },
    );
    assert.equal(selfMatchResult.isError, true);
    assert.equal((await ownRows(owner)).length, 0, 'selfMatch must write zero rows');

    // ownerUnreachable — the owner's project lives on 'whatsapp', but this
    // requester's tool server only has a 'discord' adapter (no getAdapter
    // passed to buildToolServer), so adapterFor('whatsapp') resolves
    // undefined, same mechanism social.ts's own handler relies on.
    const waOwner = `${RUN}-co-rpc-refusals-wa-owner`;
    const waShareTool = shareProjectHandler({ platform: 'whatsapp', userId: waOwner });
    const waCreated = await waShareTool.handler({
      name: 'CO WA Seeking',
      description: 'seeking collaborators',
      seekingCollaborators: true,
    });
    assert.equal(waCreated.isError, false);
    const { rows: waRows } = await pool.query(
      `SELECT id FROM member_projects WHERE platform = 'whatsapp' AND user_id = $1 AND name = $2`,
      [waOwner, 'CO WA Seeking'],
    );
    const waProjectId = Number(waRows[0].id);
    const ownerUnreachableRequester = `${RUN}-co-rpc-refusals-ownerunreachable`;
    const ownerUnreachableResult = await requestProjectConnectionHandler(
      { userId: ownerUnreachableRequester },
      stubAdapter([]),
    ).handler({ projectId: waProjectId });
    assert.equal(ownerUnreachableResult.isError, true);
    assert.match(ownerUnreachableResult.content[0]?.text ?? '', /can't be reached/i);
    assert.equal(
      (await ownRows(ownerUnreachableRequester)).length,
      0,
      'ownerUnreachable must write zero rows',
    );

    // ownerCapped
    const { PROJECT_CONNECTION_OWNER_WEEKLY_LIMIT } =
      await import('@swampratnz/agent-base/storage/repository.js');
    for (let i = 0; i < PROJECT_CONNECTION_OWNER_WEEKLY_LIMIT; i++) {
      await pool.query(
        `INSERT INTO project_connection_requests
           (owner_platform, owner_user_id, requester_platform, requester_user_id, project_id)
         VALUES ('discord', $1, 'discord', $2, $3)`,
        [owner, `${RUN}-co-rpc-refusals-ownercapped-prior-${i}`, seekingId],
      );
    }
    const ownerCappedRequester = `${RUN}-co-rpc-refusals-ownercapped`;
    const ownerCappedResult = await requestProjectConnectionHandler(
      { userId: ownerCappedRequester },
      stubAdapter([]),
    ).handler({ projectId: seekingId });
    assert.equal(ownerCappedResult.isError, true);
    assert.equal((await ownRows(ownerCappedRequester)).length, 0, 'ownerCapped must write zero rows');
  },
);

// --- rate_connection_outcome (issue #1354 acceptance criterion 4) ---

test(
  'rate_connection_outcome records a helpful/not_helpful rating for a row the caller owns (issue #1354 acceptance criterion 4)',
  { skip },
  async () => {
    const requester = `${RUN}-co-rate-happy-requester`;
    const helper = `${RUN}-co-rate-happy-helper`;
    await setMemberInterests('discord', helper, 'a very unique connection-outcome rate-happy phrase');
    await setHelperAvailability('discord', helper, true);
    const findTool = findHelperHandler({ userId: requester }, stubAdapter([]));
    await findTool.handler({ topic: 'a very unique connection-outcome rate-happy phrase' });
    const { rows } = await pool.query(
      `SELECT id FROM connection_outcomes WHERE requester_platform = 'discord' AND requester_user_id = $1`,
      [requester],
    );
    const outcomeId = Number(rows[0].id);

    const rateTool = rateConnectionOutcomeHandler({ userId: requester });
    const result = await rateTool.handler({ outcomeId, helpful: true });

    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? '', /helped/i);
  },
);

test(
  'rate_connection_outcome is a no-op on a second call for the same, already-responded id (issue #1354 acceptance criterion 4)',
  { skip },
  async () => {
    const requester = `${RUN}-co-rate-writeonce-requester`;
    const helper = `${RUN}-co-rate-writeonce-helper`;
    await setMemberInterests('discord', helper, 'a very unique connection-outcome writeonce phrase');
    await setHelperAvailability('discord', helper, true);
    const findTool = findHelperHandler({ userId: requester }, stubAdapter([]));
    await findTool.handler({ topic: 'a very unique connection-outcome writeonce phrase' });
    const { rows } = await pool.query(
      `SELECT id FROM connection_outcomes WHERE requester_platform = 'discord' AND requester_user_id = $1`,
      [requester],
    );
    const outcomeId = Number(rows[0].id);

    const rateTool = rateConnectionOutcomeHandler({ userId: requester });
    const first = await rateTool.handler({ outcomeId, helpful: true });
    assert.equal(first.isError, false);
    const second = await rateTool.handler({ outcomeId, helpful: false });
    assert.equal(
      second.isError,
      true,
      'a second call on an already-responded row is a no-op, reported as such',
    );

    const { rows: after } = await pool.query('SELECT outcome FROM connection_outcomes WHERE id = $1', [
      outcomeId,
    ]);
    assert.equal(
      after[0].outcome,
      'helpful',
      'the first rating is never overwritten by the no-op second call',
    );
  },
);

test(
  "SECURITY: rate_connection_outcome returns the identical refusal for an unknown outcomeId and for another member's outcomeId, and never mutates the other member's row (issue #1354 acceptance criterion 4)",
  { skip },
  async () => {
    const owner = `${RUN}-co-rate-security-owner`;
    const helper = `${RUN}-co-rate-security-helper`;
    const attacker = `${RUN}-co-rate-security-attacker`;
    await setMemberInterests('discord', helper, 'a very unique connection-outcome security phrase');
    await setHelperAvailability('discord', helper, true);
    const findTool = findHelperHandler({ userId: owner }, stubAdapter([]));
    await findTool.handler({ topic: 'a very unique connection-outcome security phrase' });
    const { rows } = await pool.query(
      `SELECT id FROM connection_outcomes WHERE requester_platform = 'discord' AND requester_user_id = $1`,
      [owner],
    );
    const ownedId = Number(rows[0].id);
    const unknownId = ownedId + 1_000_000;

    const attackerTool = rateConnectionOutcomeHandler({ userId: attacker });
    const forUnknown = await attackerTool.handler({ outcomeId: unknownId, helpful: true });
    const forOwned = await attackerTool.handler({ outcomeId: ownedId, helpful: true });

    assert.equal(forUnknown.isError, true);
    assert.equal(forOwned.isError, true);
    assert.equal(
      forUnknown.content[0]?.text,
      forOwned.content[0]?.text,
      'an unknown id and a real id owned by someone else must read identically',
    );

    const { rows: ownerRow } = await pool.query(
      'SELECT outcome, responded_at FROM connection_outcomes WHERE id = $1',
      [ownedId],
    );
    assert.equal(ownerRow[0].outcome, null, "the owner's row must be untouched by the attacker's attempt");
    assert.equal(ownerRow[0].responded_at, null);
  },
);

test(
  'rate_connection_outcome is reachable by a guest-tier caller, same self-scoped posture as rate_answer (MEMBER_TOOLS surface)',
  { skip },
  async () => {
    const guestId = `${RUN}-co-rate-guest`;
    const tool = rateConnectionOutcomeHandler({ userId: guestId, role: 'guest' });
    const result = await tool.handler({ outcomeId: 999_999_999, helpful: true });
    assert.equal(
      result.isError,
      true,
      'an unknown id is still refused, but the CALL ITSELF is not tier-blocked',
    );
    assert.doesNotMatch(result.content[0]?.text ?? '', /permission denied/i);
  },
);
