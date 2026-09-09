import { test, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it, matching the convention in
// tests/projectScope.test.ts.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

// The moderation wordlist and notice pack are registered at their own module
// scope in production (src/index.ts / agentModule.ts) — tests opt in the same
// way tests/tools.test.ts does.
import './support/registerBadWords.js';
import './support/registerNotices.js';
await import('./support/registerToolRegistry.js');

const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');
const { config } = await import('@swampratnz/agent-base/config.js');
const { notice } = await import('../src/module/strings/notices.js');
const { getWithdrawnProjectNoteIds } = await import('../src/module/storage/projectNoteRecords.js');
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/**
 * Withdraw project note (issue #1344) end-to-end, through the actual
 * project_note/project_recall/withdraw_project_note tool handlers — the
 * behaviour tests/tools.test.ts's language-preference tests never exercise
 * (they only cover the empty-result branches). A real semantic-search match
 * needs `embed`, which is a static import inside repository.js, so it must be
 * mocked BEFORE that module (or anything importing it) is ever imported —
 * hence the whole tool-server/repository import chain is deferred into
 * `mods()` below, the same technique tests/projectScope.test.ts established.
 */

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const BOUND_CONVO = `${RUN}-bound-convo`;
const NOTE_CONTENT = `${RUN} decision: withdraw-test note content`;

const DIM = config.db.embeddingDim;
function oneHot(i: number): number[] {
  const v = new Array(DIM).fill(0);
  v[((i % DIM) + DIM) % DIM] = 1;
  return v;
}
const EMBED_FIXTURES: Record<string, number[]> = {
  [NOTE_CONTENT]: oneHot(31),
};

let modsPromise: Promise<{
  repo: typeof import('@swampratnz/agent-base/storage/repository.js');
  buildToolServer: typeof import('../src/module/agent/tools.js').buildToolServer;
}> | null = null;
function mods(t: TestContext) {
  if (!modsPromise) {
    t.mock.module('@swampratnz/agent-base/storage/embeddings.js', {
      namedExports: {
        embed: async (text: string) => {
          const vec = EMBED_FIXTURES[text];
          if (!vec)
            throw new Error(`projectNoteWithdrawal test fixture: no hand-crafted vector for "${text}"`);
          return vec;
        },
      },
    });
    modsPromise = (async () => {
      const repo = await import('@swampratnz/agent-base/storage/repository.js');
      const { buildToolServer } = await import('../src/module/agent/tools.js');
      return { repo, buildToolServer };
    })();
  }
  return modsPromise;
}

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM projects WHERE slug LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM community_users WHERE platform_user_id LIKE $1`, [`${RUN}%`]);
  }
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

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function toolHandler(
  buildToolServer: typeof import('../src/module/agent/tools.js').buildToolServer,
  name: 'project_note' | 'project_recall' | 'withdraw_project_note',
  caller: { userId: string; conversationId?: string },
) {
  const server = buildToolServer(
    {
      platform: 'discord' as const,
      userId: caller.userId,
      userName: 'Probe',
      role: 'member' as const,
      conversationId: caller.conversationId ?? BOUND_CONVO,
      isDirect: false,
    },
    stubAdapter(),
  );
  return (
    server.instance as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<ToolResult> }>;
    }
  )._registeredTools[name];
}

async function fixtureProject(
  repo: typeof import('@swampratnz/agent-base/storage/repository.js'),
  suffix: string,
) {
  const slug = `${RUN}-${suffix}`;
  const member = `${RUN}member${suffix}`;
  await repo.upsertMember({ platform: 'discord', userId: member, role: 'member', addedBy: 'test' });
  const project = await repo.createProject({ slug, name: `Withdraw Lab ${suffix}`, createdBy: 'test' });
  assert.ok(project, `fixture setup: slug ${slug} must be free`);
  await repo.addProjectMember(project.id, 'discord', member, 'test');
  await repo.bindProjectSurface(project.id, 'discord', BOUND_CONVO, 'test');
  return { project, slug, member };
}

function extractNoteId(replyText: string): number {
  const match = replyText.match(/\[#(\d+)\]/);
  assert.ok(match, `reply must carry a "[#<id>]" note id: ${replyText}`);
  return Number(match?.[1]);
}

test(
  "withdraw_project_note withdraws the caller's OWN note by id, idempotently, and the note is then absent from " +
    'project_recall for the author too — without ever bumping its retrieval_count (issue #1344 acceptance ' +
    'criteria 2, 3)',
  { skip },
  async (t) => {
    const { repo, buildToolServer } = await mods(t);
    const { slug, member } = await fixtureProject(repo, 'withdraw-own');

    const saveReply = await toolHandler(buildToolServer, 'project_note', { userId: member }).handler({
      project: slug,
      content: NOTE_CONTENT,
    });
    const noteId = extractNoteId(saveReply.content[0].text);

    // Positive control: recall finds it before withdrawal, and reading it
    // bumps retrieval_count — otherwise the post-withdrawal zero-count
    // assertion below would pass vacuously.
    const beforeRecall = await toolHandler(buildToolServer, 'project_recall', { userId: member }).handler({
      query: NOTE_CONTENT,
    });
    assert.match(
      beforeRecall.content[0].text,
      new RegExp(slug),
      'the note must be findable before withdrawal',
    );
    const { rows: beforeCount } = await pool.query(
      `SELECT retrieval_count FROM project_notes WHERE id = $1`,
      [noteId],
    );
    assert.equal(Number(beforeCount[0].retrieval_count), 1, 'the positive-control recall must have counted');

    const withdrawTool = toolHandler(buildToolServer, 'withdraw_project_note', { userId: member });
    const first = await withdrawTool.handler({ noteId });
    assert.equal(first.isError, false);
    assert.equal(first.content[0].text, notice('projectNoteWithdrawn')(noteId));

    // Idempotent: a repeat call succeeds, with no duplicate row.
    const second = await withdrawTool.handler({ noteId });
    assert.equal(second.isError, false);
    assert.equal(second.content[0].text, notice('projectNoteWithdrawn')(noteId));
    const { rows: withdrawalRows } = await pool.query(
      `SELECT count(*) AS n FROM project_note_withdrawals WHERE note_id = $1`,
      [noteId],
    );
    assert.equal(Number(withdrawalRows[0].n), 1, 'a repeat withdrawal must not insert a second row');

    // The note is now quarantined out of project_recall for its OWN author.
    const afterRecall = await toolHandler(buildToolServer, 'project_recall', { userId: member }).handler({
      query: NOTE_CONTENT,
    });
    assert.equal(
      afterRecall.content[0].text,
      notice('projectRecallEmpty'),
      'a withdrawn note must not appear in project_recall, even for the author who wrote it',
    );

    // And recordProjectNoteRetrieval must never have been called with its id
    // again — the count stays exactly where the positive control left it.
    const { rows: afterCount } = await pool.query(`SELECT retrieval_count FROM project_notes WHERE id = $1`, [
      noteId,
    ]);
    assert.equal(
      Number(afterCount[0].retrieval_count),
      1,
      'a withdrawn note must never be passed to recordProjectNoteRetrieval again',
    );

    const withdrawn = await getWithdrawnProjectNoteIds([noteId]);
    assert.ok(withdrawn.has(noteId));
  },
);

test(
  "SECURITY: withdraw_project_note cannot withdraw, or distinguish the existence of, another member's note — a " +
    'wholly unknown id and a real-but-not-mine id get the byte-identical refusal, and the real note remains ' +
    'retrievable (issue #1344 acceptance criterion 6)',
  { skip },
  async (t) => {
    const { repo, buildToolServer } = await mods(t);
    const { slug, member: author } = await fixtureProject(repo, 'not-mine');
    const outsider = `${RUN}outsider-not-mine`;
    await repo.upsertMember({ platform: 'discord', userId: outsider, role: 'member', addedBy: 'test' });

    const saveReply = await toolHandler(buildToolServer, 'project_note', { userId: author }).handler({
      project: slug,
      content: NOTE_CONTENT,
    });
    const noteId = extractNoteId(saveReply.content[0].text);

    const outsiderTool = toolHandler(buildToolServer, 'withdraw_project_note', { userId: outsider });
    const notMine = await outsiderTool.handler({ noteId });
    const unknown = await outsiderTool.handler({ noteId: noteId + 999_000_000 });

    assert.equal(notMine.isError, true);
    assert.equal(notMine.content[0].text, notice('projectNoteWithdrawRefused'));
    assert.equal(
      notMine.content[0].text,
      unknown.content[0].text,
      'a real-but-not-mine id and a wholly unknown id must return the IDENTICAL refusal — never confirm ' +
        "another member's note exists",
    );

    // The real note must still be intact and retrievable by its own author —
    // an outsider's refused attempt must not have withdrawn it.
    const stillThere = await toolHandler(buildToolServer, 'project_recall', { userId: author }).handler({
      query: NOTE_CONTENT,
    });
    assert.match(stillThere.content[0].text, new RegExp(slug));
  },
);

test(
  "SECURITY: purgeUserData erases a caller's own project_note_authors row (issue #1344 acceptance criterion 7) — " +
    "another identity's author row and the underlying project_notes content are both left untouched",
  { skip },
  async (t) => {
    const { repo, buildToolServer } = await mods(t);
    const { slug: slugA, member: authorA } = await fixtureProject(repo, 'purge-a');
    const { slug: slugB, member: authorB } = await fixtureProject(repo, 'purge-b');

    const replyA = await toolHandler(buildToolServer, 'project_note', { userId: authorA }).handler({
      project: slugA,
      content: NOTE_CONTENT,
    });
    const noteIdA = extractNoteId(replyA.content[0].text);
    const replyB = await toolHandler(buildToolServer, 'project_note', { userId: authorB }).handler({
      project: slugB,
      content: NOTE_CONTENT,
    });
    const noteIdB = extractNoteId(replyB.content[0].text);

    const { rows: beforeA } = await pool.query(`SELECT 1 FROM project_note_authors WHERE note_id = $1`, [
      noteIdA,
    ]);
    assert.equal(beforeA.length, 1, 'precondition: the author row exists before purging');

    await repo.purgeUserData('discord', authorA);

    const { rows: afterA } = await pool.query(`SELECT 1 FROM project_note_authors WHERE note_id = $1`, [
      noteIdA,
    ]);
    assert.equal(
      afterA.length,
      0,
      "forget_me/purge_user_data must erase the caller's project_note_authors row",
    );

    const { rows: afterB } = await pool.query(`SELECT 1 FROM project_note_authors WHERE note_id = $1`, [
      noteIdB,
    ]);
    assert.equal(afterB.length, 1, "a different identity's project_note_authors row must be untouched");

    // The underlying base project_notes content is never deleted or altered
    // by THIS contributor — matching project_remove_member's "revokes
    // access, does not erase contributions" precedent. (Base's own `projects`
    // purge contributor separately nulls author_platform/author_user_id on
    // the row, which is pre-existing behaviour this proposal does not
    // change — content survives either way.)
    const { rows: noteContent } = await pool.query(`SELECT content FROM project_notes WHERE id = $1`, [
      noteIdA,
    ]);
    assert.equal(noteContent.length, 1, 'purging the author must not delete the note itself');
    assert.equal(noteContent[0].content, NOTE_CONTENT, "the note's content must survive untouched");

    // withdraw_project_note against the now-authorless note must refuse —
    // exactly as an unknown id would (no backfill, no guessed authorship).
    const postPurgeWithdraw = await toolHandler(buildToolServer, 'withdraw_project_note', {
      userId: authorA,
    }).handler({ noteId: noteIdA });
    assert.equal(postPurgeWithdraw.content[0].text, notice('projectNoteWithdrawRefused'));
  },
);
