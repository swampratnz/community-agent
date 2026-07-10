import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/repository.test.ts.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');

// Unique per test-run tag so fixtures never collide across runs and can be
// cleaned up precisely, mirroring the RUN-tag convention in
// tests/repository.test.ts. Every fixture's content starts with this tag, so
// cleanup can match on content regardless of which scope ('global', a
// platform, or a conversation id) it was saved under.
const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM knowledge WHERE content LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

/**
 * Hand-crafted, deterministic embeddings (no model download) — same
 * technique as the one-hot vectors in tests/repository.test.ts's
 * recentQuestionClusters test. Each fixture string maps to its own
 * orthogonal unit vector, so similarity is exactly 1 for an identical string
 * and ~0 for any other, independent of the real embedding model's semantics.
 *
 * This is mocked once, at module scope, rather than per-test: `embed` is a
 * static import inside src/storage/repository.ts, so once that module has
 * been dynamically imported anywhere in this process it's cached — a second
 * `t.mock.module` call in a later test does not retarget the binding
 * `repository.js` already closed over. One shared map covering every fixture
 * string used below, set up before the first import, avoids that trap.
 */
const CONV_SCOPED_CONTENT = `${RUN} conv-scope fact: standup is at 9am`;
const PLATFORM_SCOPED_CONTENT = `${RUN} platform-scope fact: discord role colours are cosmetic only`;
const GLOBAL_CONTENT = `${RUN} global fact: the community meets monthly`;

const DIM = config.db.embeddingDim;
function oneHot(i: number): number[] {
  const v = new Array(DIM).fill(0);
  v[((i % DIM) + DIM) % DIM] = 1;
  return v;
}

const EMBED_FIXTURES: Record<string, number[]> = {
  [CONV_SCOPED_CONTENT]: oneHot(1),
  [PLATFORM_SCOPED_CONTENT]: oneHot(2),
  [GLOBAL_CONTENT]: oneHot(3),
};

// node:test module mocking requires a TestContext (`t.mock`), but we need the
// mock installed before any of this file's tests dynamically import
// repository.js — so install it via the first test's context and reuse the
// same imported bindings across the remaining tests (a module-scope variable
// populated on first use), rather than re-mocking per test.
let repoPromise: Promise<typeof import('../src/storage/repository.js')> | null = null;
function repo(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!repoPromise) {
    t.mock.module('../src/storage/embeddings.js', {
      namedExports: {
        embed: async (text: string) => {
          const vec = EMBED_FIXTURES[text];
          if (!vec) throw new Error(`knowledgeScope test fixture: no hand-crafted vector for "${text}"`);
          return vec;
        },
      },
    });
    repoPromise = import('../src/storage/repository.js');
  }
  return repoPromise;
}

test(
  'SECURITY: repository: searchKnowledge returns a conversation-scoped knowledge entry only in its own conversation (issue #106)',
  { skip },
  async (t) => {
    const { saveKnowledge, searchKnowledge } = await repo(t);
    const convA = `${RUN}-conv-a`;
    const convB = `${RUN}-conv-b`;

    await saveKnowledge({ content: CONV_SCOPED_CONTENT, scope: convA });

    const inScope = await searchKnowledge(
      CONV_SCOPED_CONTENT,
      { platform: 'discord', conversationId: convA },
      5,
    );
    assert.ok(
      inScope.some((h) => h.content === CONV_SCOPED_CONTENT),
      'the saving conversation can retrieve its own conversation-scoped entry',
    );

    const otherConvo = await searchKnowledge(
      CONV_SCOPED_CONTENT,
      { platform: 'discord', conversationId: convB },
      5,
    );
    assert.ok(
      !otherConvo.some((h) => h.content === CONV_SCOPED_CONTENT),
      'SECURITY: a different conversation on the same platform must never see a conversation-scoped entry',
    );

    const otherPlatform = await searchKnowledge(
      CONV_SCOPED_CONTENT,
      { platform: 'whatsapp', conversationId: `${RUN}-conv-a-whatsapp-view` },
      5,
    );
    assert.ok(
      !otherPlatform.some((h) => h.content === CONV_SCOPED_CONTENT),
      'SECURITY: the other platform must never see a conversation-scoped entry from the first platform',
    );
  },
);

test(
  'SECURITY: repository: searchKnowledgeLexical returns a conversation-scoped knowledge entry only in its own conversation (issue #362) — same cross-scope isolation guarantee as searchKnowledge (issue #106)',
  { skip },
  async (t) => {
    const { saveKnowledge, searchKnowledgeLexical } = await repo(t);
    const identifier = `SCOPETEST_${RUN}_LEXICAL_TOKEN`;
    const convA = `${RUN}-lexical-conv-a`;
    const convB = `${RUN}-lexical-conv-b`;
    const content = `The onboarding script accepts the ${identifier} flag to skip the confirmation prompt.`;

    await saveKnowledge({ content, scope: convA });

    const inScope = await searchKnowledgeLexical(
      identifier,
      { platform: 'discord', conversationId: convA },
      5,
    );
    assert.ok(
      inScope.some((h) => h.content === content),
      'the saving conversation can retrieve its own conversation-scoped entry via the lexical fallback',
    );

    const otherConvo = await searchKnowledgeLexical(
      identifier,
      { platform: 'discord', conversationId: convB },
      5,
    );
    assert.ok(
      !otherConvo.some((h) => h.content === content),
      'SECURITY: a different conversation on the same platform must never see a conversation-scoped entry via the lexical fallback',
    );

    const otherPlatform = await searchKnowledgeLexical(
      identifier,
      { platform: 'whatsapp', conversationId: `${RUN}-lexical-conv-a-whatsapp-view` },
      5,
    );
    assert.ok(
      !otherPlatform.some((h) => h.content === content),
      'SECURITY: the other platform must never see a conversation-scoped entry via the lexical fallback',
    );
  },
);

test(
  'SECURITY: repository: searchKnowledge treats a platform-name scope as platform-wide, never cross-platform (issue #106)',
  { skip },
  async (t) => {
    const { saveKnowledge, searchKnowledge } = await repo(t);

    await saveKnowledge({ content: PLATFORM_SCOPED_CONTENT, scope: 'discord' });

    const convA = await searchKnowledge(
      PLATFORM_SCOPED_CONTENT,
      { platform: 'discord', conversationId: `${RUN}-conv-a` },
      5,
    );
    assert.ok(
      convA.some((h) => h.content === PLATFORM_SCOPED_CONTENT),
      'visible from one discord conversation',
    );

    const convB = await searchKnowledge(
      PLATFORM_SCOPED_CONTENT,
      { platform: 'discord', conversationId: `${RUN}-conv-b` },
      5,
    );
    assert.ok(
      convB.some((h) => h.content === PLATFORM_SCOPED_CONTENT),
      'visible from a different discord conversation too — the scope is platform-wide',
    );

    const whatsapp = await searchKnowledge(
      PLATFORM_SCOPED_CONTENT,
      { platform: 'whatsapp', conversationId: `${RUN}-conv-a` },
      5,
    );
    assert.ok(
      !whatsapp.some((h) => h.content === PLATFORM_SCOPED_CONTENT),
      'SECURITY: a platform-scoped entry must never leak to the other platform',
    );
  },
);

test(
  "SECURITY: repository: searchKnowledge returns a 'global'-scoped entry regardless of caller platform/conversation (issue #106 regression pin)",
  { skip },
  async (t) => {
    const { saveKnowledge, searchKnowledge } = await repo(t);

    await saveKnowledge({ content: GLOBAL_CONTENT, scope: 'global' });

    const discordHit = await searchKnowledge(
      GLOBAL_CONTENT,
      { platform: 'discord', conversationId: `${RUN}-conv-a` },
      5,
    );
    assert.ok(
      discordHit.some((h) => h.content === GLOBAL_CONTENT),
      'global entries remain visible on discord',
    );

    const whatsappHit = await searchKnowledge(
      GLOBAL_CONTENT,
      { platform: 'whatsapp', conversationId: `${RUN}-conv-x` },
      5,
    );
    assert.ok(
      whatsappHit.some((h) => h.content === GLOBAL_CONTENT),
      'global entries remain visible on whatsapp too',
    );
  },
);
