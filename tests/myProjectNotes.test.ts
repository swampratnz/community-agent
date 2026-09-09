import { test, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it, matching the convention in
// tests/projectNoteWithdrawal.test.ts.
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
const { untrusted } = await import('../src/module/agent/tools/helpers.js');
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/**
 * `my_project_notes` (issue #1366) end-to-end, through the actual
 * project_note/withdraw_project_note/my_project_notes tool handlers — the
 * self-service listing #1344 explicitly deferred. A real semantic-search
 * embedding needs `embed`, which is a static import inside repository.js, so
 * it must be mocked BEFORE that module (or anything importing it) is ever
 * imported — hence the whole tool-server/repository import chain is deferred
 * into `mods()` below, the same technique tests/projectNoteWithdrawal.test.ts
 * established. No test here uses a `title`, so each note's embed() input
 * (title ? `${title}\n${content}` : content, inside saveProjectNote) is
 * exactly the plain content string used as this file's embed-fixture key.
 */

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const BOUND_CONVO = `${RUN}-bound-convo`;

const DIM = config.db.embeddingDim;
function oneHot(i: number): number[] {
  const v = new Array(DIM).fill(0);
  v[((i % DIM) + DIM) % DIM] = 1;
  return v;
}

let nextEmbedIndex = 0;
const EMBED_FIXTURES: Record<string, number[]> = {};
function contentFor(suffix: string): string {
  const content = `${RUN} ${suffix} content`;
  EMBED_FIXTURES[content] ??= oneHot(nextEmbedIndex++);
  return content;
}

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
          if (!vec) throw new Error(`myProjectNotes test fixture: no hand-crafted vector for "${text}"`);
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
  name: 'project_note' | 'withdraw_project_note' | 'my_project_notes',
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
  member: string,
) {
  const slug = `${RUN}-${suffix}`;
  const project = await repo.createProject({ slug, name: `Notes Lab ${suffix}`, createdBy: 'test' });
  assert.ok(project, `fixture setup: slug ${slug} must be free`);
  await repo.addProjectMember(project.id, 'discord', member, 'test');
  await repo.bindProjectSurface(project.id, 'discord', BOUND_CONVO, 'test');
  return { project, slug };
}

function extractNoteId(replyText: string): number {
  const match = replyText.match(/\[#(\d+)\]/);
  assert.ok(match, `reply must carry a "[#<id>]" note id: ${replyText}`);
  return Number(match?.[1]);
}

test(
  "my_project_notes lists only the caller's own recorded notes — id, project slug, preview and relative age, " +
    "newest-first, with a withdrawn note ANNOTATED rather than filtered out — and never another member's " +
    'notes (issue #1366 acceptance criteria 1, 2, 3)',
  { skip },
  async (t) => {
    const { repo, buildToolServer } = await mods(t);
    const authorA = `${RUN}memberA`;
    await repo.upsertMember({ platform: 'discord', userId: authorA, role: 'member', addedBy: 'test' });
    const { slug: slug1 } = await fixtureProject(repo, 'a-proj1', authorA);
    const { slug: slug2 } = await fixtureProject(repo, 'a-proj2', authorA);

    const content1 = contentFor('a-note1');
    const content2 = contentFor('a-note2');

    const save1 = await toolHandler(buildToolServer, 'project_note', { userId: authorA }).handler({
      project: slug1,
      content: content1,
    });
    const id1 = extractNoteId(save1.content[0].text);

    const save2 = await toolHandler(buildToolServer, 'project_note', { userId: authorA }).handler({
      project: slug2,
      content: content2,
    });
    const id2 = extractNoteId(save2.content[0].text);

    await toolHandler(buildToolServer, 'withdraw_project_note', { userId: authorA }).handler({ noteId: id2 });

    // A different member, in a different project, with their own note —
    // must never appear in author A's listing (acceptance criterion 2).
    const authorB = `${RUN}memberB`;
    await repo.upsertMember({ platform: 'discord', userId: authorB, role: 'member', addedBy: 'test' });
    const { slug: slug3 } = await fixtureProject(repo, 'a-proj3', authorB);
    const content3 = contentFor('a-note3-other-member');
    await toolHandler(buildToolServer, 'project_note', { userId: authorB }).handler({
      project: slug3,
      content: content3,
    });

    const listing = await toolHandler(buildToolServer, 'my_project_notes', { userId: authorA }).handler({});
    const listingText = listing.content[0].text;

    assert.match(listingText, new RegExp(`#${id1}, ${slug1}, today\\] ${content1}(?! \\(withdrawn\\))`));
    assert.match(listingText, new RegExp(`#${id2}, ${slug2}, today\\] ${content2} \\(withdrawn\\)`));
    assert.ok(
      listingText.indexOf(`#${id2}`) < listingText.indexOf(`#${id1}`),
      'newest-first: note 2 was recorded after note 1, so it must render first',
    );
    assert.doesNotMatch(
      listingText,
      new RegExp(content3),
      "author A's listing must never include another member's note",
    );

    const listingB = await toolHandler(buildToolServer, 'my_project_notes', { userId: authorB }).handler({});
    const listingBText = listingB.content[0].text;
    assert.match(listingBText, new RegExp(content3));
    assert.doesNotMatch(
      listingBText,
      new RegExp(`${content1}|${content2}`),
      "author B's listing must never include author A's notes",
    );
  },
);

test(
  'my_project_notes reports the empty-state notice for a member who has recorded nothing',
  { skip },
  async (t) => {
    const { repo, buildToolServer } = await mods(t);
    const emptyMember = `${RUN}memberEmpty`;
    await repo.upsertMember({ platform: 'discord', userId: emptyMember, role: 'member', addedBy: 'test' });

    const listing = await toolHandler(buildToolServer, 'my_project_notes', { userId: emptyMember }).handler(
      {},
    );
    assert.equal(listing.content[0].text, notice('myProjectNotesEmpty'));
  },
);

test(
  "SECURITY: my_project_notes renders the caller's own note previews through untrusted() quarantine, matching " +
    "project_recall's treatment of the same member-authored content (issue #1366 acceptance criterion 5)",
  { skip },
  async (t) => {
    const { repo, buildToolServer } = await mods(t);
    const author = `${RUN}memberUntrusted`;
    await repo.upsertMember({ platform: 'discord', userId: author, role: 'member', addedBy: 'test' });
    const { slug } = await fixtureProject(repo, 'untrusted-proj', author);
    const content = contentFor('untrusted-note');

    const save = await toolHandler(buildToolServer, 'project_note', { userId: author }).handler({
      project: slug,
      content,
    });
    const id = extractNoteId(save.content[0].text);

    const listing = await toolHandler(buildToolServer, 'my_project_notes', { userId: author }).handler({});
    const expected = untrusted('Your project notes', `- [#${id}, ${slug}, today] ${content}`);
    assert.equal(listing.content[0].text, expected);
  },
);

test(
  "SECURITY: purgeUserData deletes a caller's project_note_previews rows in the same purge as their " +
    "project_note_authors rows — no orphaned preview row survives, and a different identity's preview is " +
    'untouched (issue #1366 acceptance criterion 4)',
  { skip },
  async (t) => {
    const { repo, buildToolServer } = await mods(t);
    const authorC = `${RUN}memberPurgeC`;
    const authorD = `${RUN}memberPurgeD`;
    await repo.upsertMember({ platform: 'discord', userId: authorC, role: 'member', addedBy: 'test' });
    await repo.upsertMember({ platform: 'discord', userId: authorD, role: 'member', addedBy: 'test' });
    const { slug: slugC } = await fixtureProject(repo, 'purge-c', authorC);
    const { slug: slugD } = await fixtureProject(repo, 'purge-d', authorD);

    const contentC = contentFor('purge-note-c');
    const contentD = contentFor('purge-note-d');

    const saveC = await toolHandler(buildToolServer, 'project_note', { userId: authorC }).handler({
      project: slugC,
      content: contentC,
    });
    const idC = extractNoteId(saveC.content[0].text);
    const saveD = await toolHandler(buildToolServer, 'project_note', { userId: authorD }).handler({
      project: slugD,
      content: contentD,
    });
    const idD = extractNoteId(saveD.content[0].text);

    const { rows: beforeC } = await pool.query(`SELECT 1 FROM project_note_previews WHERE note_id = $1`, [
      idC,
    ]);
    assert.equal(beforeC.length, 1, 'precondition: the preview row exists before purging');

    await repo.purgeUserData('discord', authorC);

    // The join-scoped delete must have run BEFORE (or with) the
    // project_note_authors delete — an ordering bug would leave this row
    // stranded with no way back to its identity ever again.
    const { rows: afterPreviewC } = await pool.query(
      `SELECT 1 FROM project_note_previews WHERE note_id = $1`,
      [idC],
    );
    assert.equal(afterPreviewC.length, 0, "purging must erase the caller's own project_note_previews row");
    const { rows: afterAuthorC } = await pool.query(`SELECT 1 FROM project_note_authors WHERE note_id = $1`, [
      idC,
    ]);
    assert.equal(afterAuthorC.length, 0, "purging must erase the caller's own project_note_authors row");

    const { rows: afterPreviewD } = await pool.query(
      `SELECT 1 FROM project_note_previews WHERE note_id = $1`,
      [idD],
    );
    assert.equal(
      afterPreviewD.length,
      1,
      "a different identity's project_note_previews row must be untouched",
    );

    // The note content itself survives purging (module contributor never
    // touches the base project_notes row), matching
    // tests/projectNoteWithdrawal.test.ts's existing purge assertion.
    const { rows: noteContent } = await pool.query(`SELECT content FROM project_notes WHERE id = $1`, [idC]);
    assert.equal(noteContent[0].content, contentC, "the note's content must survive untouched");
  },
);

test(
  'project_note succeeds even when the best-effort preview capture fails, and the note is simply absent from ' +
    'my_project_notes rather than the save being reported as a failure (issue #1366 acceptance criterion 7)',
  { skip },
  async (t) => {
    const { repo, buildToolServer } = await mods(t);
    const author = `${RUN}memberPreviewFail`;
    await repo.upsertMember({ platform: 'discord', userId: author, role: 'member', addedBy: 'test' });
    const { slug } = await fixtureProject(repo, 'preview-fail', author);
    const content = contentFor('preview-fail-note');

    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', ((sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO project_note_previews')) {
        return Promise.reject(new Error('preview insert unreachable'));
      }
      return (realQuery as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof pool.query);

    const save = await toolHandler(buildToolServer, 'project_note', { userId: author }).handler({
      project: slug,
      content,
    });
    assert.equal(
      save.isError,
      false,
      'a forced preview-capture failure must never turn a successfully-saved note into a reported failure',
    );
    const noteId = extractNoteId(save.content[0].text);

    const { rows } = await pool.query(`SELECT 1 FROM project_note_previews WHERE note_id = $1`, [noteId]);
    assert.equal(rows.length, 0, 'the preview row must genuinely not exist after the forced failure');

    t.mock.reset();
    const listing = await toolHandler(buildToolServer, 'my_project_notes', { userId: author }).handler({});
    assert.doesNotMatch(
      listing.content[0].text,
      new RegExp(content),
      'a note with no preview row must simply be absent from the listing, not surfaced as an error',
    );
  },
);
