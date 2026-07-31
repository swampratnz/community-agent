import { test, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it, matching the convention in
// tests/knowledgeScope.test.ts.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const { PROJECT_NOTE_CONTENT_MAX_CHARS, PROJECT_NOTE_TITLE_MAX_CHARS } =
  await import('../src/storage/repository/projects.js');

/**
 * Projects (issue #927) enforce TWO checks, both in SQL in `visibleProjectIds`:
 * membership (expanded through linked identities) says WHO may read, and the
 * surface binding says WHERE it may be rendered. Almost every test here pins
 * one half of that, because dropping either one is a private-content leak:
 * membership alone would recite a team's notes into a public channel, and
 * surface alone would serve them to anyone who happens to be in the channel.
 *
 * The positive-control tests are load-bearing. Without them every negative
 * assertion below would also pass against a `searchProjectNotes` that simply
 * returned [] unconditionally.
 */

// Unique per test-run tag so fixtures never collide across runs and can be
// cleaned up precisely (RUN-tag convention from tests/repository.test.ts).
// node:test runs test FILES in parallel, so unscoped fixtures would land on
// rows other files are counting.
const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const DISCORD_USER = `${RUN}1111111111111111`;
const WHATSAPP_USER = `${RUN}64211111111`;
const OUTSIDER = `${RUN}2222222222222222`;
const BOUND_CONVO = `${RUN}-bound-convo`;
const UNBOUND_CONVO = `${RUN}-unbound-convo`;

after(async () => {
  if (hasDb) {
    // projects cascade to members/surfaces/notes; community_users rows are
    // this run's own and are removed explicitly.
    await pool.query(`DELETE FROM projects WHERE slug LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM community_users WHERE platform_user_id LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

/**
 * Hand-crafted, deterministic embeddings (no model download) — the same
 * technique tests/knowledgeScope.test.ts uses. Each fixture string maps to its
 * own orthogonal unit vector, so similarity is exactly 1 for an identical
 * string and ~0 for any other, independent of the real model's semantics.
 * Mocked once at module scope because `embed` is a static import inside
 * repository.js: once that module is cached, a later t.mock.module call does
 * not retarget the binding it already closed over.
 */
const NOTE_CONTENT = `${RUN} decision: the lab meets on the first Tuesday`;
const OTHER_NOTE = `${RUN} decision: catering is confirmed`;

const DIM = config.db.embeddingDim;
function oneHot(i: number): number[] {
  const v = new Array(DIM).fill(0);
  v[((i % DIM) + DIM) % DIM] = 1;
  return v;
}
const EMBED_FIXTURES: Record<string, number[]> = {
  [NOTE_CONTENT]: oneHot(11),
  [OTHER_NOTE]: oneHot(12),
};

let repoPromise: Promise<typeof import('../src/storage/repository.js')> | null = null;
function repo(t: TestContext) {
  if (!repoPromise) {
    t.mock.module('../src/storage/embeddings.js', {
      namedExports: {
        embed: async (text: string) => {
          const vec = EMBED_FIXTURES[text];
          if (!vec) throw new Error(`projectScope test fixture: no hand-crafted vector for "${text}"`);
          return vec;
        },
      },
    });
    repoPromise = import('../src/storage/repository.js');
  }
  return repoPromise;
}

type Repo = typeof import('../src/storage/repository.js');

/**
 * One project with a Discord member, bound to BOUND_CONVO, holding one note.
 * Each caller gets its own slug so the parallel-safe cleanup above can find it
 * and so tests never observe each other's bindings.
 */
async function fixture(r: Repo, suffix: string) {
  const slug = `${RUN}-${suffix}`;
  // A distinct member per fixture. Sharing one identity across fixtures made a
  // DM query (an allowed surface for EVERY project that identity is in) return
  // all of them, so a per-project assertion silently measured the whole set.
  const member = `${DISCORD_USER}${suffix}`;
  await r.upsertMember({
    platform: 'discord',
    userId: member,
    role: 'member',
    addedBy: 'test',
  });
  const project = await r.createProject({ slug, name: `Lab ${suffix}`, createdBy: 'test' });
  assert.ok(project, `fixture setup: slug ${slug} must be free`);
  await r.addProjectMember(project.id, 'discord', member, 'test');
  await r.bindProjectSurface(project.id, 'discord', BOUND_CONVO, 'test');
  const saved = await r.saveProjectNote(
    { platform: 'discord', userId: member, conversationId: BOUND_CONVO, isDirect: false },
    { slug, content: NOTE_CONTENT },
  );
  assert.ok(saved && 'id' in saved, 'fixture setup: the member must be able to save in a bound conversation');
  return { project, slug, member, noteId: saved.id };
}

test(
  'SECURITY: projects: a member reaches project notes in a BOUND conversation (positive control — without this every negative below would pass vacuously)',
  { skip },
  async (t) => {
    const r = await repo(t);
    const { slug, member } = await fixture(r, 'pos');
    const hits = await r.searchProjectNotes(NOTE_CONTENT, {
      platform: 'discord',
      userId: member,
      conversationId: BOUND_CONVO,
      isDirect: false,
    });
    assert.equal(hits.length, 1, 'the member must see their project note in a bound conversation');
    assert.equal(hits[0].content, NOTE_CONTENT);
    assert.equal(hits[0].projectSlug, slug);
  },
);

test(
  "SECURITY: projects: a NON-member gets nothing, even in the project's own bound conversation (membership check)",
  { skip },
  async (t) => {
    const r = await repo(t);
    await fixture(r, 'nonmember');
    await r.upsertMember({ platform: 'discord', userId: OUTSIDER, role: 'member', addedBy: 'test' });
    const hits = await r.searchProjectNotes(NOTE_CONTENT, {
      platform: 'discord',
      userId: OUTSIDER,
      conversationId: BOUND_CONVO,
      isDirect: false,
    });
    assert.deepEqual(hits, [], 'being in the bound channel must not confer project access');
  },
);

test(
  'SECURITY: projects: a MEMBER gets nothing in an UNBOUND conversation — the second check, which stops private notes being recited into a public channel',
  { skip },
  async (t) => {
    const r = await repo(t);
    const { member } = await fixture(r, 'unbound');
    const hits = await r.searchProjectNotes(NOTE_CONTENT, {
      platform: 'discord',
      userId: member,
      conversationId: UNBOUND_CONVO,
      isDirect: false,
    });
    assert.deepEqual(
      hits,
      [],
      'membership alone must not render project content anywhere the member happens to be',
    );
  },
);

test(
  'SECURITY: projects: a member reaches their project by DM without any binding (a DM is always an allowed surface, and has no stable conversation id to bind)',
  { skip },
  async (t) => {
    const r = await repo(t);
    const { slug, member } = await fixture(r, 'dm');
    const hits = await r.searchProjectNotes(NOTE_CONTENT, {
      platform: 'discord',
      userId: member,
      conversationId: `${RUN}-some-dm-channel`,
      isDirect: true,
    });
    assert.deepEqual(
      hits.map((h) => h.projectSlug),
      [slug],
      'a DM to a member is an allowed surface, and shows exactly their own project',
    );
  },
);

test(
  'SECURITY: projects: a linked WhatsApp identity reaches a project its Discord identity was added to, and does NOT before linking (visibility expands through `persons`, never through message content)',
  { skip },
  async (t) => {
    const r = await repo(t);
    const { project, member } = await fixture(r, 'linked');
    await r.upsertMember({ platform: 'whatsapp', userId: WHATSAPP_USER, role: 'member', addedBy: 'test' });
    await r.bindProjectSurface(project.id, 'whatsapp', BOUND_CONVO, 'test');

    const before = await r.searchProjectNotes(NOTE_CONTENT, {
      platform: 'whatsapp',
      userId: WHATSAPP_USER,
      conversationId: BOUND_CONVO,
      isDirect: false,
    });
    assert.deepEqual(before, [], 'an unlinked second identity is a different person and must see nothing');

    await r.linkMembers('discord', member, 'whatsapp', WHATSAPP_USER);

    const after = await r.searchProjectNotes(NOTE_CONTENT, {
      platform: 'whatsapp',
      userId: WHATSAPP_USER,
      conversationId: BOUND_CONVO,
      isDirect: false,
    });
    assert.equal(after.length, 1, 'once linked, the same human reaches the project from either platform');
  },
);

test(
  'SECURITY: projects: saveProjectNote refuses a non-member and refuses a member in an unbound conversation — writes are gated by the same two checks as reads',
  { skip },
  async (t) => {
    const r = await repo(t);
    const { slug, member } = await fixture(r, 'write');
    await r.upsertMember({ platform: 'discord', userId: OUTSIDER, role: 'member', addedBy: 'test' });

    const byOutsider = await r.saveProjectNote(
      { platform: 'discord', userId: OUTSIDER, conversationId: BOUND_CONVO, isDirect: false },
      { slug, content: OTHER_NOTE },
    );
    assert.equal(byOutsider, null, 'a non-member must not be able to write into a project');

    const fromUnbound = await r.saveProjectNote(
      { platform: 'discord', userId: member, conversationId: UNBOUND_CONVO, isDirect: false },
      { slug, content: OTHER_NOTE },
    );
    assert.equal(fromUnbound, null, 'a member must not write project content from an unbound conversation');
  },
);

test(
  'SECURITY: projects: removing a member revokes their access immediately, but KEEPS the notes they contributed — revoke is not erasure (PR #929 review)',
  { skip },
  async (t) => {
    const r = await repo(t);
    const { project, member, noteId } = await fixture(r, 'revoke');

    // Positive control first: they can reach it before removal, so the
    // post-removal assertion below cannot pass vacuously.
    const before = await r.searchProjectNotes(NOTE_CONTENT, {
      platform: 'discord',
      userId: member,
      conversationId: BOUND_CONVO,
      isDirect: false,
    });
    assert.equal(before.length, 1, 'fixture member must have access before removal');

    const removed = await r.removeProjectMember(project.id, 'discord', member);
    assert.equal(removed, true, 'removal must report that it removed a row');

    const after = await r.searchProjectNotes(NOTE_CONTENT, {
      platform: 'discord',
      userId: member,
      conversationId: BOUND_CONVO,
      isDirect: false,
    });
    assert.deepEqual(after, [], 'a removed member must immediately lose read access');

    const writeAfter = await r.saveProjectNote(
      { platform: 'discord', userId: member, conversationId: BOUND_CONVO, isDirect: false },
      { slug: `${RUN}-revoke`, content: OTHER_NOTE },
    );
    assert.equal(writeAfter, null, 'a removed member must immediately lose write access');

    // Revoking access is NOT erasure: what they already contributed stays
    // with the team, authorship intact (unlike forget_me, which nulls it).
    const { rows } = await pool.query(`SELECT content, author_user_id FROM project_notes WHERE id = $1`, [
      noteId,
    ]);
    assert.equal(rows.length, 1, "removing a member must not delete the project's notes");
    assert.equal(rows[0].author_user_id, member, 'revoking access leaves authorship untouched');
  },
);

test(
  "SECURITY: projects: remove_member revokes project access as a matter of STORAGE, not just tool gating — otherwise a removed member keeps reading a team's notes on an open-mode deployment (PR #929 review)",
  { skip },
  async (t) => {
    const r = await repo(t);
    const { member } = await fixture(r, 'removemember');

    const before = await r.searchProjectNotes(NOTE_CONTENT, {
      platform: 'discord',
      userId: member,
      conversationId: BOUND_CONVO,
      isDirect: false,
    });
    assert.equal(before.length, 1, 'positive control: access exists before removal');

    // removeMember only ever deleted the community_users row. project_members
    // has no FK to it (it is keyed on the platform identity so visibility
    // survives person-row merges), and visibleProjectIds checks only that
    // table, never tier — so without an explicit cascade the membership row
    // outlives community membership.
    const removed = await r.removeMember('discord', member);
    assert.equal(removed, true, 'the member must actually have been removed');

    const after = await r.searchProjectNotes(NOTE_CONTENT, {
      platform: 'discord',
      userId: member,
      conversationId: BOUND_CONVO,
      isDirect: false,
    });
    assert.deepEqual(after, [], 'removing someone from the community must revoke their project access');

    const { rows } = await pool.query(
      `SELECT 1 FROM project_members WHERE platform = 'discord' AND user_id = $1`,
      [member],
    );
    assert.equal(rows.length, 0, 'the project_members row itself must be gone, not merely unreachable');
  },
);

test(
  'SECURITY: projects: an ARCHIVED project is invisible to its own members (archive is a revocation, not just a label)',
  { skip },
  async (t) => {
    const r = await repo(t);
    const { slug, member } = await fixture(r, 'archived');
    await r.archiveProject(slug);
    const hits = await r.searchProjectNotes(NOTE_CONTENT, {
      platform: 'discord',
      userId: member,
      conversationId: BOUND_CONVO,
      isDirect: false,
    });
    assert.deepEqual(hits, [], 'archiving must stop content being served');
  },
);

test(
  'SECURITY: projects: saveProjectNote caps note length in the REPOSITORY, not only in the tool schema — the zod cap guards one path, this guards the exported function (PR #929 review)',
  { skip },
  async (t) => {
    // project_notes was the one new member-writable table with no size bound
    // at all. Same defence-in-depth as createKnowledgeTip: zod at the tool
    // layer, slice() here, because this is an exported repository entry point
    // a later caller could reach without going through the tool schema.
    const r = await repo(t);
    const { slug, member } = await fixture(r, 'length-cap');
    const caller = {
      platform: 'discord' as const,
      userId: member,
      conversationId: BOUND_CONVO,
      isDirect: false,
    };
    const saved = await r.saveProjectNote(caller, {
      slug,
      content: 'x'.repeat(r.PROJECT_NOTE_CONTENT_MAX_CHARS + 500),
      title: 'y'.repeat(r.PROJECT_NOTE_TITLE_MAX_CHARS + 50),
      referenceUrl: `https://example.com/${'z'.repeat(r.PROJECT_NOTE_REFERENCE_URL_MAX_CHARS + 50)}`,
    });
    assert.ok(saved && 'id' in saved, 'an over-long note is truncated, not rejected outright');

    const { rows } = await pool.query(
      `SELECT title, content, reference_url FROM project_notes WHERE id = $1`,
      [saved.id],
    );
    assert.equal(rows[0].content.length, r.PROJECT_NOTE_CONTENT_MAX_CHARS);
    assert.equal(rows[0].title.length, r.PROJECT_NOTE_TITLE_MAX_CHARS);
    assert.equal(rows[0].reference_url.length, r.PROJECT_NOTE_REFERENCE_URL_MAX_CHARS);
  },
);

test(
  "projects: the note caps keep `title\\ncontent` inside embed()'s own 4000-char truncation, so no note is ever half-embedded (PR #929 review)",
  { skip: false },
  () => {
    // A note whose stored text outran its embedding would be silently
    // unfindable by its own tail — worse than refusing the write. This pins
    // the relationship between the two numbers rather than the numbers.
    const EMBED_TRUNCATION = 4000;
    assert.ok(
      PROJECT_NOTE_TITLE_MAX_CHARS + 1 + PROJECT_NOTE_CONTENT_MAX_CHARS <= EMBED_TRUNCATION,
      "title + newline + content must fit within embed()'s slice(0, 4000)",
    );
  },
);

test(
  'SECURITY: projects: saveProjectNote enforces a rolling-24h per-member write cap DB-side, so a member cannot bloat project_notes unattended (PR #929 review)',
  { skip },
  async (t) => {
    const r = await repo(t);
    const { slug, member } = await fixture(r, 'rate-cap');
    const caller = {
      platform: 'discord' as const,
      userId: member,
      conversationId: BOUND_CONVO,
      isDirect: false,
    };

    // fixture() already wrote one note as this member.
    for (let i = 1; i < r.PROJECT_NOTE_RATE_LIMIT_PER_DAY; i++) {
      const ok = await r.saveProjectNote(caller, { slug, content: NOTE_CONTENT });
      assert.ok(ok && 'id' in ok, `write ${i + 1} must land while under the cap`);
    }

    // NOTE: this pins the SEQUENTIAL guarantee only, which is the honest scope
    // of the check. The COUNT(*)-in-the-INSERT shape is not atomic under READ
    // COMMITTED — concurrent writes from one member can all read the same
    // pre-insert count and all land — so there is deliberately no concurrent
    // assertion here that would be flaky by construction. See saveProjectNote's
    // comment and docs/SECURITY.md: this is an abuse ceiling, not an
    // authorization check.
    const overCap = await r.saveProjectNote(caller, { slug, content: NOTE_CONTENT });
    assert.deepEqual(
      overCap,
      { atCap: true },
      'the write past the cap must be refused, not silently dropped',
    );

    const { rows } = await pool.query(
      `SELECT count(*) AS n FROM project_notes WHERE author_platform = 'discord' AND author_user_id = $1`,
      [member],
    );
    assert.equal(
      Number(rows[0].n),
      r.PROJECT_NOTE_RATE_LIMIT_PER_DAY,
      'the refused write must not have inserted a row',
    );

    // The cap is per-member, not per-project or global: a different member in
    // the same project is unaffected. Without this the cap would be a denial
    // of service on the team rather than on the abuser.
    const other = await fixture(r, 'rate-cap-other');
    const otherWrite = await r.saveProjectNote(
      { platform: 'discord', userId: other.member, conversationId: BOUND_CONVO, isDirect: false },
      { slug: other.slug, content: NOTE_CONTENT },
    );
    assert.ok(otherWrite && 'id' in otherWrite, "one member's cap must not block another member");
  },
);

test(
  'SECURITY: projects: unarchiving restores the SAME access archiving revoked — the members who could read before can read again, and nobody else can (PR #929 review)',
  { skip },
  async (t) => {
    // The point of project_unarchive is that archiving stops being a one-way
    // door, which is also why project_archive is not CONFIRM-gated. So the
    // test has to prove the round trip actually lands back where it started —
    // both halves: the member regains access, and an outsider still has none.
    const r = await repo(t);
    const { slug, member } = await fixture(r, 'unarchived');
    const outsiderCaller = {
      platform: 'discord' as const,
      userId: OUTSIDER,
      conversationId: BOUND_CONVO,
      isDirect: false,
    };
    const memberCaller = { ...outsiderCaller, userId: member };

    await r.archiveProject(slug);
    assert.deepEqual(
      await r.searchProjectNotes(NOTE_CONTENT, memberCaller),
      [],
      'precondition: archiving revoked the member',
    );

    assert.equal(
      await r.unarchiveProject(slug),
      true,
      'unarchiving an archived project must report a change',
    );
    const restored = await r.searchProjectNotes(NOTE_CONTENT, memberCaller);
    assert.equal(restored.length, 1, 'the member must be able to read the project again');
    assert.equal(restored[0]?.projectSlug, slug);

    // Positive control's mirror: restoring access must not WIDEN it. An
    // outsider was never a member, and unarchiving touches no membership row.
    assert.deepEqual(
      await r.searchProjectNotes(NOTE_CONTENT, outsiderCaller),
      [],
      'unarchiving must not grant access to a non-member',
    );
  },
);

test(
  'SECURITY: projects: unarchiveProject only ever clears archived_at — it can neither create a project nor report success for an active one (PR #929 review)',
  { skip },
  async (t) => {
    const r = await repo(t);
    const { slug } = await fixture(r, 'unarchive-noop');

    // An active project is not "restored" — the admin tool relies on this
    // false to answer `No archived project "..."` rather than implying it
    // changed something.
    assert.equal(await r.unarchiveProject(slug), false, 'an already-active project must report no change');
    assert.equal(
      await r.unarchiveProject(`${RUN}-does-not-exist`),
      false,
      'an unknown slug must report no change, never conjure a project',
    );
    const { rows } = await pool.query(`SELECT slug FROM projects WHERE slug = $1`, [`${RUN}-does-not-exist`]);
    assert.equal(rows.length, 0, 'unarchiving an unknown slug must not insert a row');
  },
);

test(
  'projects: createProject is race-free on a duplicate slug — the second create returns null instead of throwing a raw constraint violation (PR #929 review)',
  { skip },
  async (t) => {
    const r = await repo(t);
    const slug = `${RUN}-dup-slug`;
    const first = await r.createProject({ slug, name: 'First', createdBy: 'test' });
    assert.ok(first, 'the first create must win');

    // Concurrent, so a SELECT-then-INSERT implementation cannot pass this by
    // winning the check-then-act race — both calls are in flight together.
    const [a, b] = await Promise.all([
      r.createProject({ slug, name: 'Second', createdBy: 'test' }),
      r.createProject({ slug, name: 'Third', createdBy: 'test' }),
    ]);
    assert.equal(a, null, 'a duplicate create must return null, not throw');
    assert.equal(b, null, 'a duplicate create must return null, not throw');

    const { rows } = await pool.query(`SELECT name FROM projects WHERE slug = $1`, [slug]);
    assert.equal(rows.length, 1, 'exactly one project may hold a slug');
    assert.equal(rows[0].name, 'First', 'the loser must not overwrite the winner');
  },
);

test(
  "SECURITY: projects: forget_me hard-deletes project MEMBERSHIP but KEEPS the notes with authorship nulled — a departing member must not silently gut the team's shared decisions (issue #927 owner decision)",
  { skip },
  async (t) => {
    const r = await repo(t);
    const { project, member, noteId } = await fixture(r, 'purge');

    await r.purgeUserData('discord', member);

    const { rows: noteRows } = await pool.query(
      `SELECT content, author_platform, author_user_id FROM project_notes WHERE id = $1`,
      [noteId],
    );
    assert.equal(noteRows.length, 1, 'the project note must survive its author being erased');
    assert.equal(noteRows[0].content, NOTE_CONTENT, 'the decision text itself is retained');
    assert.equal(noteRows[0].author_user_id, null, 'authorship must be unlinked');
    assert.equal(noteRows[0].author_platform, null, 'authorship must be unlinked');

    const { rows: memberRows } = await pool.query(
      `SELECT 1 FROM project_members WHERE project_id = $1 AND platform = 'discord' AND user_id = $2`,
      [project.id, member],
    );
    assert.equal(memberRows.length, 0, 'membership is pure identity and must be hard-deleted');

    // And the erased identity can no longer reach the project it was in.
    const hits = await r.searchProjectNotes(NOTE_CONTENT, {
      platform: 'discord',
      userId: member,
      conversationId: BOUND_CONVO,
      isDirect: false,
    });
    assert.deepEqual(hits, [], 'erasure removes access even though the note survives');
  },
);

test(
  'SECURITY: projects: ordinary (non-project) knowledge authored by the member is still HARD-DELETED by forget_me — the keep-the-row exception is scoped to project content only',
  { skip },
  async (t) => {
    const r = await repo(t);
    const purgeUser = `${RUN}3333333333333333`;
    await r.upsertMember({ platform: 'discord', userId: purgeUser, role: 'member', addedBy: 'test' });
    const { rows } = await pool.query(
      `INSERT INTO knowledge (scope, content, source_user_id, created_by_role) VALUES ('global', $1, $2, 'member') RETURNING id`,
      [`${RUN} ordinary knowledge entry`, purgeUser],
    );
    const knowledgeId = Number(rows[0].id);

    await r.purgeUserData('discord', purgeUser);

    const { rows: after } = await pool.query(`SELECT 1 FROM knowledge WHERE id = $1`, [knowledgeId]);
    assert.equal(after.length, 0, 'the project exception must not weaken erasure for ordinary knowledge');
  },
);

test(
  'SECURITY: projects: project membership grants DATA SCOPE ONLY — it never changes the tool surface, exactly as `persons` never touches role',
  { skip },
  async (t) => {
    const { toolsForRole } = await import('../src/auth/rbac.js');
    const r = await repo(t);
    const { project } = await fixture(r, 'tiersurface');

    const before = toolsForRole('member', 'discord');
    await r.addProjectMember(project.id, 'discord', OUTSIDER, 'test');
    const after = toolsForRole('member', 'discord');

    assert.deepEqual(
      [...after],
      [...before],
      'the per-turn tool surface is derived from tier alone; project membership must never widen it',
    );
    // And the project tools are on every member's surface regardless, which is
    // what lets them be gated inside the tool body instead of in the surface.
    for (const t of [
      'mcp__community__project_recall',
      'mcp__community__project_note',
      'mcp__community__project_list',
    ]) {
      assert.ok(before.includes(t), `${t} must be a plain member-tier tool`);
    }
  },
);
