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
const { getWithdrawnProjectNoteIds, getProjectNoteAuthor } =
  await import('../src/module/storage/projectNoteRecords.js');
const { ADMIN_TOOLS, MEMBER_TOOLS } = await import('@swampratnz/agent-base/auth/rbac.js');
const { hasPendingAction, takePendingAction } =
  await import('@swampratnz/agent-base/agent/pendingActions.js');
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/**
 * remove_project_note (issue #1464) end-to-end, through the actual
 * project_note/project_recall/remove_project_note tool handlers — the
 * admin-moderation counterpart to withdraw_project_note (already covered by
 * tests/projectNoteWithdrawal.test.ts). A real semantic-search match needs
 * `embed`, which is a static import inside repository.js, so it must be
 * mocked BEFORE that module (or anything importing it) is ever imported —
 * hence the whole tool-server/repository import chain is deferred into
 * `mods()` below, the same technique projectNoteWithdrawal.test.ts and
 * projectScope.test.ts established.
 */

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const BOUND_CONVO = `${RUN}-bound-convo`;
const NOTE_CONTENT = `${RUN} decision: removal-test note content`;
const NOTE_CONTENT_WITH_REASON = `${RUN} decision: removal-test note content with-reason`;
const NOTE_CONTENT_WITHOUT_REASON = `${RUN} decision: removal-test note content without-reason`;

const DIM = config.db.embeddingDim;
function oneHot(i: number): number[] {
  const v = new Array(DIM).fill(0);
  v[((i % DIM) + DIM) % DIM] = 1;
  return v;
}
const EMBED_FIXTURES: Record<string, number[]> = {
  [NOTE_CONTENT]: oneHot(53),
  [NOTE_CONTENT_WITH_REASON]: oneHot(59),
  [NOTE_CONTENT_WITHOUT_REASON]: oneHot(61),
};

let modsPromise: Promise<{
  repo: typeof import('@swampratnz/agent-base/storage/repository.js');
  buildToolServer: typeof import('../src/module/agent/tools.js').buildToolServer;
  SUGGESTION_RESOLUTION_ECHO_CHARS: number;
}> | null = null;
function mods(t: TestContext) {
  if (!modsPromise) {
    t.mock.module('@swampratnz/agent-base/storage/embeddings.js', {
      namedExports: {
        embed: async (text: string) => {
          const vec = EMBED_FIXTURES[text];
          if (!vec) throw new Error(`projectNoteRemoval test fixture: no hand-crafted vector for "${text}"`);
          return vec;
        },
      },
    });
    modsPromise = (async () => {
      const repo = await import('@swampratnz/agent-base/storage/repository.js');
      const { buildToolServer, SUGGESTION_RESOLUTION_ECHO_CHARS } =
        await import('../src/module/agent/tools.js');
      return { repo, buildToolServer, SUGGESTION_RESOLUTION_ECHO_CHARS };
    })();
  }
  return modsPromise;
}

after(async () => {
  if (hasDb) {
    await pool.query(
      `DELETE FROM admin_audit WHERE action_kind = 'remove_project_note' AND actor_user_id LIKE $1`,
      [`${RUN}%`],
    );
    await pool.query(`DELETE FROM projects WHERE slug LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM community_users WHERE platform_user_id LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

function stubAdapter(
  sendDirectMessage: PlatformAdapter['sendDirectMessage'] = async () => {},
): PlatformAdapter {
  return {
    platform: 'discord',
    start: async () => {},
    stop: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    sendMessage: async () => {},
    sendDirectMessage,
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
  name: 'project_note' | 'project_recall' | 'remove_project_note',
  caller: {
    userId: string;
    role?: 'guest' | 'member' | 'admin' | 'super_admin';
    conversationId?: string;
  },
  adapter: PlatformAdapter = stubAdapter(),
) {
  const server = buildToolServer(
    {
      platform: 'discord' as const,
      userId: caller.userId,
      userName: 'Probe',
      role: caller.role ?? 'member',
      conversationId: caller.conversationId ?? BOUND_CONVO,
      isDirect: false,
    },
    adapter,
  );
  return (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (args: Record<string, unknown>) => Promise<ToolResult>;
          inputSchema: { safeParse: (v: unknown) => { success: boolean } };
        }
      >;
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
  const project = await repo.createProject({ slug, name: `Removal Lab ${suffix}`, createdBy: 'test' });
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

test('SECURITY: remove_project_note is registered admin-tier only (never offered on the member/guest surface), and its schema rejects a missing/non-integer noteId and a reason over the cap (issue #1464 acceptance criterion 1)', async (t) => {
  const { buildToolServer, SUGGESTION_RESOLUTION_ECHO_CHARS } = await mods(t);
  assert.ok(
    ADMIN_TOOLS.includes('mcp__community__remove_project_note'),
    'remove_project_note must be registered as an admin tool',
  );
  assert.ok(
    !MEMBER_TOOLS.includes('mcp__community__remove_project_note'),
    'remove_project_note must never be offered on the member/guest surface',
  );

  const tool = toolHandler(buildToolServer, 'remove_project_note', {
    userId: `${RUN}-schema-admin`,
    role: 'admin',
  });

  assert.equal(tool.inputSchema.safeParse({ noteId: 1 }).success, true, 'a bare integer noteId is valid');
  assert.equal(tool.inputSchema.safeParse({}).success, false, 'noteId is required');
  assert.equal(tool.inputSchema.safeParse({ noteId: 'abc' }).success, false, 'noteId must be numeric');
  assert.equal(tool.inputSchema.safeParse({ noteId: 1.5 }).success, false, 'noteId must be an integer');
  assert.equal(
    tool.inputSchema.safeParse({ noteId: 1, reason: 'x'.repeat(SUGGESTION_RESOLUTION_ECHO_CHARS) }).success,
    true,
    'exactly the echo bound is allowed',
  );
  assert.equal(
    tool.inputSchema.safeParse({ noteId: 1, reason: 'x'.repeat(SUGGESTION_RESOLUTION_ECHO_CHARS + 1) })
      .success,
    false,
    'one character over the echo bound must be rejected',
  );
});

test(
  'remove_project_note quarantines a real, not-yet-withdrawn note out of every subsequent project_recall result, for every member including its own author (issue #1464 acceptance criterion 2)',
  { skip },
  async (t) => {
    const { repo, buildToolServer } = await mods(t);
    const { slug, member } = await fixtureProject(repo, 'quarantine');

    const saveReply = await toolHandler(buildToolServer, 'project_note', { userId: member }).handler({
      project: slug,
      content: NOTE_CONTENT,
    });
    const noteId = extractNoteId(saveReply.content[0].text);

    // Positive control: recall finds it before removal, so the post-removal
    // empty-result assertion below doesn't pass vacuously.
    const beforeRecall = await toolHandler(buildToolServer, 'project_recall', { userId: member }).handler({
      query: NOTE_CONTENT,
    });
    assert.match(beforeRecall.content[0].text, new RegExp(slug), 'the note must be findable before removal');

    const admin = `${RUN}-quarantine-admin`;
    const convo = 'convo-remove-project-note-quarantine';
    const adminTool = toolHandler(buildToolServer, 'remove_project_note', {
      userId: admin,
      role: 'admin',
      conversationId: convo,
    });
    const confirmResult = await adminTool.handler({ noteId });
    assert.match(confirmResult.content[0]?.text ?? '', /CONFIRM/);
    const execResult = await takePendingAction('discord', convo, admin)?.execute();
    assert.match(execResult ?? '', new RegExp(`Removed project note #${noteId}`));

    const withdrawn = await getWithdrawnProjectNoteIds([noteId]);
    assert.ok(withdrawn.has(noteId), 'noteId must be present in getWithdrawnProjectNoteIds after removal');

    const afterRecall = await toolHandler(buildToolServer, 'project_recall', { userId: member }).handler({
      query: NOTE_CONTENT,
    });
    assert.equal(
      afterRecall.content[0].text,
      notice('projectRecallEmpty'),
      'a removed note must not appear in project_recall, even for the member who originally wrote it',
    );
  },
);

test(
  "SECURITY: remove_project_note fails closed with a distinct error for a noteId with no recorded author — never withdraw_project_note's ambiguous refusal, never a silent success — and writes no withdrawal row (issue #1464 acceptance criterion 3)",
  { skip },
  async (t) => {
    const { buildToolServer } = await mods(t);
    const admin = `${RUN}-unknown-admin`;
    const convo = 'convo-remove-project-note-unknown';
    const unknownId = 999_888_777;

    const adminTool = toolHandler(buildToolServer, 'remove_project_note', {
      userId: admin,
      role: 'admin',
      conversationId: convo,
    });
    const confirmResult = await adminTool.handler({ noteId: unknownId });
    assert.match(confirmResult.content[0]?.text ?? '', /CONFIRM/);
    const execResult = await takePendingAction('discord', convo, admin)?.execute();

    assert.match(
      execResult ?? '',
      new RegExp(`Failed: No project note with id ${unknownId}`),
      'an unknown noteId must fail cleanly with a distinct message, not throw uncaught',
    );
    assert.doesNotMatch(
      execResult ?? '',
      /doesn't exist, or isn't/,
      "must never reuse withdraw_project_note's deliberately-ambiguous unknown-vs-not-mine refusal wording",
    );

    const { rows } = await pool.query(`SELECT 1 FROM project_note_withdrawals WHERE note_id = $1`, [
      unknownId,
    ]);
    assert.equal(rows.length, 0, 'an unknown noteId must never produce a withdrawal row');
  },
);

test(
  'remove_project_note is idempotent: calling it twice on the same note succeeds both times and leaves exactly one project_note_withdrawals row (issue #1464 acceptance criterion 4)',
  { skip },
  async (t) => {
    const { repo, buildToolServer } = await mods(t);
    const { slug, member } = await fixtureProject(repo, 'idempotent');
    const saveReply = await toolHandler(buildToolServer, 'project_note', { userId: member }).handler({
      project: slug,
      content: NOTE_CONTENT,
    });
    const noteId = extractNoteId(saveReply.content[0].text);

    const admin = `${RUN}-idempotent-admin`;
    const convoA = 'convo-remove-project-note-idempotent-a';
    const convoB = 'convo-remove-project-note-idempotent-b';

    const first = toolHandler(buildToolServer, 'remove_project_note', {
      userId: admin,
      role: 'admin',
      conversationId: convoA,
    });
    await first.handler({ noteId });
    const firstResult = await takePendingAction('discord', convoA, admin)?.execute();
    assert.match(firstResult ?? '', new RegExp(`Removed project note #${noteId}`));

    const second = toolHandler(buildToolServer, 'remove_project_note', {
      userId: admin,
      role: 'admin',
      conversationId: convoB,
    });
    await second.handler({ noteId });
    const secondResult = await takePendingAction('discord', convoB, admin)?.execute();
    assert.match(
      secondResult ?? '',
      new RegExp(`Removed project note #${noteId}`),
      'a repeat removal must succeed, not throw',
    );

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM project_note_withdrawals WHERE note_id = $1`,
      [noteId],
    );
    assert.equal(rows[0].n, 1, 'a repeat removal must not insert a second withdrawal row');
  },
);

test(
  'SECURITY: remove_project_note rejects member and guest callers before any repository call, never reaching the CONFIRM gate (issue #1464 acceptance criterion 5)',
  { skip },
  async (t) => {
    const { buildToolServer } = await mods(t);
    for (const role of ['member', 'guest'] as const) {
      const userId = `${role}-remove-project-note-1`;
      const convo = `convo-remove-project-note-${role}`;
      const tool = toolHandler(buildToolServer, 'remove_project_note', {
        userId,
        role,
        conversationId: convo,
      });
      await assert.rejects(
        () => tool.handler({ noteId: 1 }),
        /Permission denied/,
        `${role} must never reach remove_project_note`,
      );
      assert.equal(
        hasPendingAction('discord', convo, userId),
        false,
        `${role} must never reach the CONFIRM gate, let alone a repository call`,
      );
    }
  },
);

test(
  'SECURITY: remove_project_note never persists the optional reason into admin_audit params (issue #1464 acceptance criterion 6)',
  { skip },
  async (t) => {
    const { repo, buildToolServer } = await mods(t);
    const { slug, member } = await fixtureProject(repo, 'reason-persist');
    const saveReply = await toolHandler(buildToolServer, 'project_note', { userId: member }).handler({
      project: slug,
      content: NOTE_CONTENT,
    });
    const noteId = extractNoteId(saveReply.content[0].text);

    const admin = `${RUN}-reason-persist-admin`;
    const convo = 'convo-remove-project-note-reason-persist';
    const tool = toolHandler(buildToolServer, 'remove_project_note', {
      userId: admin,
      role: 'admin',
      conversationId: convo,
    });
    await tool.handler({ noteId, reason: 'contained a scam link' });
    const execResult = await takePendingAction('discord', convo, admin)?.execute();
    assert.match(execResult ?? '', new RegExp(`Removed project note #${noteId}`));

    const { rows } = await pool.query(
      `SELECT params FROM admin_audit WHERE action_kind = 'remove_project_note' AND actor_user_id = $1 ORDER BY id DESC LIMIT 1`,
      [admin],
    );
    const params = rows[0].params as Record<string, unknown>;
    assert.equal(params.noteId, noteId, 'audited params must still carry the noteId');
    assert.equal(
      'reason' in params,
      false,
      'SECURITY: the optional reason must never be persisted into admin_audit params',
    );
  },
);

test(
  "remove_project_note sends exactly one resolution DM to the note's original author when a reason is supplied, none when omitted, and the recipient is resolved via getProjectNoteAuthor rather than the caller (issue #1464 acceptance criterion 7)",
  { skip },
  async (t) => {
    const { repo, buildToolServer } = await mods(t);
    const { slug, member: author } = await fixtureProject(repo, 'notify');

    const withReasonReply = await toolHandler(buildToolServer, 'project_note', { userId: author }).handler({
      project: slug,
      content: NOTE_CONTENT_WITH_REASON,
    });
    const withReasonId = extractNoteId(withReasonReply.content[0].text);
    const withoutReasonReply = await toolHandler(buildToolServer, 'project_note', { userId: author }).handler(
      {
        project: slug,
        content: NOTE_CONTENT_WITHOUT_REASON,
      },
    );
    const withoutReasonId = extractNoteId(withoutReasonReply.content[0].text);

    const sends: Array<{ userId: string; text: string }> = [];
    const adapter = stubAdapter(async (userId: string, text: string) => {
      sends.push({ userId, text });
    });
    const admin = `${RUN}-notify-admin`;

    const withConvo = 'convo-remove-project-note-notify-with';
    const toolWithReason = toolHandler(
      buildToolServer,
      'remove_project_note',
      { userId: admin, role: 'admin', conversationId: withConvo },
      adapter,
    );
    await toolWithReason.handler({ noteId: withReasonId, reason: 'contained a scam link' });
    const withResult = await takePendingAction('discord', withConvo, admin)?.execute();
    assert.match(withResult ?? '', new RegExp(`Removed project note #${withReasonId}`));

    assert.equal(sends.length, 1, 'exactly one DM when a reason is supplied');
    assert.equal(sends[0]?.userId, author, "the DM must reach the note's original author, never the caller");
    assert.notEqual(sends[0]?.userId, admin);
    assert.match(sends[0]?.text ?? '', /removed/i);
    assert.match(sends[0]?.text ?? '', /contained a scam link/);

    const withoutConvo = 'convo-remove-project-note-notify-without';
    const toolWithoutReason = toolHandler(
      buildToolServer,
      'remove_project_note',
      { userId: admin, role: 'admin', conversationId: withoutConvo },
      adapter,
    );
    await toolWithoutReason.handler({ noteId: withoutReasonId });
    const withoutResult = await takePendingAction('discord', withoutConvo, admin)?.execute();
    assert.match(withoutResult ?? '', new RegExp(`Removed project note #${withoutReasonId}`));

    assert.equal(sends.length, 1, 'no DM sent when reason is omitted');

    // The identity reaching the DM comes solely from getProjectNoteAuthor,
    // never from caller/args — confirmed independently against the module's
    // own authorship record for the with-reason note.
    const recordedAuthor = await getProjectNoteAuthor(withReasonId);
    assert.deepEqual(recordedAuthor, { platform: 'discord', userId: author });
  },
);
