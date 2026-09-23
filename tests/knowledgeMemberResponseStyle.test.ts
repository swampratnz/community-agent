import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

// SECURITY coverage for issue #1448: knowledgeMember.ts's 6 member-facing
// knowledge tools each resolve a `style: ResponseStyle | undefined` via
// `lang === 'mi' ? undefined : await getResponseStyle(...).catch(() =>
// 'standard')` and thread it into their formatter. `getResponseStyle`
// already catches its OWN DB errors and degrades to 'standard' internally
// (storage/repository/preferences.ts) — it never rejects to a caller today
// — so exercising the call site's OWN `.catch()` defensive layer requires
// simulating a THROWING `getResponseStyle`, which (being a named ESM export
// statically imported by knowledgeMember.ts) can only be retargeted via
// `t.mock.module` installed BEFORE that import graph is first evaluated in
// this process (same trap `tests/agentCoreResponseStyle.test.ts` documents).
// A separate file (not tools.test.ts, which already statically imports the
// tool registry at module scope) so the mock can be installed first, same
// "node test runner isolates env per file" convention
// `knowledgeSearchFailSafe.test.ts` uses for its own separate-file split.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

type StyleBehavior = { mode: 'value'; value: string } | { mode: 'throw' };
let styleBehavior: StyleBehavior = { mode: 'value', value: 'standard' };
let styleCalls: Array<{ platform: string; userId: string }> = [];

// Both the tool registry AND `@swampratnz/agent-base/storage/db.js` (for
// cleanup) are dynamically imported inside this cached loader, AFTER the
// mock is installed — a top-level `await import(...)` (the shape every
// sibling knowledge test file uses) would bind the REAL `getResponseStyle`
// before any test body runs, and a later `t.mock.module` call cannot
// retarget an already-evaluated static import.
let loaded: Promise<{
  buildToolServer: typeof import('../src/module/agent/tools.js').buildToolServer;
  pool: typeof import('@swampratnz/agent-base/storage/db.js').pool;
  closeDb: typeof import('@swampratnz/agent-base/storage/db.js').closeDb;
}> | null = null;
async function load(t: TestContext) {
  if (!loaded) {
    const realRepo = await import('@swampratnz/agent-base/storage/repository.js');
    t.mock.module('@swampratnz/agent-base/storage/repository.js', {
      namedExports: {
        ...realRepo,
        getResponseStyle: async (platform: string, userId: string) => {
          styleCalls.push({ platform, userId });
          if (styleBehavior.mode === 'throw') throw new Error('response-style lookup exploded');
          return styleBehavior.value;
        },
      },
    });
    await import('./support/registerNotices.js');
    await import('./support/registerToolRegistry.js');
    const [{ buildToolServer }, { pool, closeDb }] = await Promise.all([
      import('../src/module/agent/tools.js'),
      import('@swampratnz/agent-base/storage/db.js'),
    ]);
    loaded = Promise.resolve({ buildToolServer, pool, closeDb });
  }
  return loaded;
}

after(async () => {
  if (loaded) await (await loaded).closeDb();
});

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

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

async function memberToolsFor(t: TestContext, userId: string) {
  const { buildToolServer } = await load(t);
  const server = buildToolServer(
    {
      platform: 'discord' as const,
      userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: `${RUN}-convo`,
      isDirect: false,
    },
    stubAdapter(),
  );
  return (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: Record<string, unknown>,
          ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
        }
      >;
    }
  )._registeredTools;
}

test(
  "SECURITY: knowledgeMember.ts's list_knowledge_topics, most_helpful_knowledge, suggest_knowledge and " +
    "withdraw_knowledge_tip handlers degrade to a well-formed 'standard' (English) reply, rather than " +
    'throwing or dropping it, when the response-style lookup rejects (issue #1448)',
  { skip },
  async (t) => {
    styleBehavior = { mode: 'throw' };
    try {
      const userId = `${RUN}-style-throw`;
      const tools = await memberToolsFor(t, userId);

      const topics = await tools['list_knowledge_topics'].handler({});
      assert.equal(topics.isError, false);
      assert.ok((topics.content[0]?.text ?? '').length > 0, 'list_knowledge_topics must still return text');

      const helpful = await tools['most_helpful_knowledge'].handler({});
      assert.equal(helpful.isError, false, 'most_helpful_knowledge must not throw or error');
      assert.ok((helpful.content[0]?.text ?? '').length > 0, 'most_helpful_knowledge must still return text');

      const withdrawn = await tools['withdraw_knowledge_tip'].handler({});
      assert.equal(withdrawn.isError, true);
      assert.match(withdrawn.content[0]?.text ?? '', /no pending knowledge tips/i);

      const suggested = await tools['suggest_knowledge'].handler({
        title: `${RUN} response-style throw fixture`,
        content: `${RUN} response-style throw fixture content`,
      });
      assert.equal(suggested.isError, false);
      assert.match(suggested.content[0]?.text ?? '', /queued for admin review/i);
    } finally {
      styleBehavior = { mode: 'value', value: 'standard' };
      // The dedup guard (candidateTopicAlreadyReviewed) matches on semantic
      // similarity, not exact text — an uncleaned candidate from a prior run
      // of this exact fixture wording can make a LATER run's freshly-created
      // candidate look like a dedup bounce instead of a fresh queue. Clean up
      // so this test never pollutes its own next run.
      const { pool } = await load(t);
      await pool.query(`DELETE FROM knowledge_candidates WHERE topic = $1`, [
        `${RUN} response-style throw fixture`,
      ]);
    }
  },
);

test(
  "SECURITY: knowledgeMember.ts's response-style lookups are scoped to exactly the caller's own " +
    '{platform, userId} — never another identity — and most_helpful_knowledge still renders via ' +
    'formatMostHelpfulKnowledge (never the admin-internal formatKnowledgeEntryLine, whose leading ' +
    '`#id [scope] [createdByRole]` tags must never reach a member) once `style` is threaded through ' +
    '(issue #1448)',
  { skip },
  async (t) => {
    const { pool } = await load(t);
    styleCalls = [];
    styleBehavior = { mode: 'value', value: 'plain' };
    const userId = `${RUN}-style-scope`;
    const inserted = await pool.query(
      `INSERT INTO knowledge (scope, title, content, created_by_role) VALUES ($1,$2,$3,'admin') RETURNING id`,
      ['global', `${RUN} most-helpful scope fixture`, 'Content for the member-scope/renderer check.'],
    );
    const id = Number((inserted.rows[0] as { id: string }).id);
    try {
      const tools = await memberToolsFor(t, userId);
      const result = await tools['most_helpful_knowledge'].handler({});
      assert.equal(result.isError, false);
      const rendered = result.content[0]?.text ?? '';
      assert.match(rendered, /most-helpful scope fixture/, 'the fixture entry must render');
      assert.doesNotMatch(
        rendered,
        /#\d+ \[global\] \[admin\]/,
        'must never render via formatKnowledgeEntryLine — those admin-internal tags must not reach a member',
      );

      assert.ok(styleCalls.length > 0, 'getResponseStyle must have been consulted');
      for (const call of styleCalls) {
        assert.deepEqual(
          call,
          { platform: 'discord', userId },
          'every response-style lookup this turn must be scoped to the caller’s own identity',
        );
      }
    } finally {
      await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
      styleBehavior = { mode: 'value', value: 'standard' };
    }
  },
);

test(
  'formatKnowledgeTopics/formatSuggestKnowledgeDedupText/formatSuggestKnowledgeRateLimitText/' +
    'formatSuggestKnowledgeQueuedText/formatWithdrawKnowledgeTipEmptyText/' +
    "formatWithdrawKnowledgeTipConfirmText's 'plain' style renders a materially shorter English string " +
    "than the default for every branch, 'standard'/undefined stays byte-identical to today, and a 'mi' " +
    'language wins over any style (issue #1448 acceptance criteria 2-4)',
  async () => {
    const {
      formatKnowledgeTopics,
      formatSuggestKnowledgeDedupText,
      formatSuggestKnowledgeRateLimitText,
      formatSuggestKnowledgeQueuedText,
      formatWithdrawKnowledgeTipEmptyText,
      formatWithdrawKnowledgeTipConfirmText,
    } = await import('../src/module/agent/tools/helpers.js');

    // formatKnowledgeTopics
    assert.equal(
      formatKnowledgeTopics([], 0, 'en', undefined),
      formatKnowledgeTopics([], 0, 'en'),
      'undefined style must be byte-identical to the pre-#1448 signature',
    );
    assert.equal(
      formatKnowledgeTopics([], 0, 'en', 'standard'),
      formatKnowledgeTopics([], 0, 'en', undefined),
    );
    assert.notEqual(
      formatKnowledgeTopics([], 0, 'en', 'plain'),
      formatKnowledgeTopics([], 0, 'en', undefined),
      "'plain' must render a distinct, shorter string",
    );
    assert.ok(
      formatKnowledgeTopics([], 0, 'en', 'plain').length <
        formatKnowledgeTopics([], 0, 'en', undefined).length,
    );
    assert.equal(
      formatKnowledgeTopics(['a'], 5, 'mi', 'plain'),
      formatKnowledgeTopics(['a'], 5, 'mi', 'standard'),
      "'mi' must win over any style",
    );

    // formatSuggestKnowledgeDedupText
    const dedupDefault = formatSuggestKnowledgeDedupText('en', undefined);
    const dedupPlain = formatSuggestKnowledgeDedupText('en', 'plain');
    assert.equal(formatSuggestKnowledgeDedupText('en', 'standard'), dedupDefault);
    assert.notEqual(dedupPlain, dedupDefault);
    assert.ok(dedupPlain.length < dedupDefault.length);
    assert.equal(
      formatSuggestKnowledgeDedupText('mi', 'plain'),
      formatSuggestKnowledgeDedupText('mi', 'standard'),
    );

    // formatSuggestKnowledgeRateLimitText
    const rlDefault = formatSuggestKnowledgeRateLimitText(3, 'en', undefined);
    const rlPlain = formatSuggestKnowledgeRateLimitText(3, 'en', 'plain');
    assert.equal(formatSuggestKnowledgeRateLimitText(3, 'en', 'standard'), rlDefault);
    assert.notEqual(rlPlain, rlDefault);
    assert.ok(rlPlain.length < rlDefault.length);
    assert.equal(
      formatSuggestKnowledgeRateLimitText(3, 'mi', 'plain'),
      formatSuggestKnowledgeRateLimitText(3, 'mi', 'standard'),
    );

    // formatSuggestKnowledgeQueuedText (both branches: plain queued + correction match)
    const queuedDefault = formatSuggestKnowledgeQueuedText(42, null, 'en', undefined);
    const queuedPlain = formatSuggestKnowledgeQueuedText(42, null, 'en', 'plain');
    assert.equal(formatSuggestKnowledgeQueuedText(42, null, 'en', 'standard'), queuedDefault);
    assert.notEqual(queuedPlain, queuedDefault);
    assert.ok(queuedPlain.length < queuedDefault.length);
    assert.equal(
      formatSuggestKnowledgeQueuedText(42, null, 'mi', 'plain'),
      formatSuggestKnowledgeQueuedText(42, null, 'mi', 'standard'),
    );
    const correctionDefault = formatSuggestKnowledgeQueuedText(42, '"Existing entry"', 'en', undefined);
    const correctionPlain = formatSuggestKnowledgeQueuedText(42, '"Existing entry"', 'en', 'plain');
    assert.notEqual(correctionPlain, correctionDefault);
    assert.ok(correctionPlain.length < correctionDefault.length);
    assert.equal(
      formatSuggestKnowledgeQueuedText(42, '"Existing entry"', 'mi', 'plain'),
      formatSuggestKnowledgeQueuedText(42, '"Existing entry"', 'mi', 'standard'),
    );

    // formatWithdrawKnowledgeTipEmptyText
    const emptyDefault = formatWithdrawKnowledgeTipEmptyText('en', undefined);
    const emptyPlain = formatWithdrawKnowledgeTipEmptyText('en', 'plain');
    assert.equal(formatWithdrawKnowledgeTipEmptyText('en', 'standard'), emptyDefault);
    assert.notEqual(emptyPlain, emptyDefault);
    assert.ok(emptyPlain.length < emptyDefault.length);
    assert.equal(
      formatWithdrawKnowledgeTipEmptyText('mi', 'plain'),
      formatWithdrawKnowledgeTipEmptyText('mi', 'standard'),
    );

    // formatWithdrawKnowledgeTipConfirmText
    const confirmDefault = formatWithdrawKnowledgeTipConfirmText([1, 2], 'en', undefined);
    const confirmPlain = formatWithdrawKnowledgeTipConfirmText([1, 2], 'en', 'plain');
    assert.equal(formatWithdrawKnowledgeTipConfirmText([1, 2], 'en', 'standard'), confirmDefault);
    assert.notEqual(confirmPlain, confirmDefault);
    assert.ok(confirmPlain.length < confirmDefault.length);
    assert.equal(
      formatWithdrawKnowledgeTipConfirmText([1, 2], 'mi', 'plain'),
      formatWithdrawKnowledgeTipConfirmText([1, 2], 'mi', 'standard'),
    );
  },
);

test(
  "formatKnowledgeCitationNote/formatKnowledgeSearchResults/formatMostHelpfulKnowledge's 'plain' style " +
    'renders the shorter knowledgeStaleNote/knowledgeLowRatedCaveat/knowledgeConflictCaveat/' +
    "knowledgeSearchEmpty catalogue variants, 'standard'/undefined stays byte-identical to today, and a " +
    "'mi' language wins over any style (issue #1448 acceptance criteria 1-4)",
  async () => {
    await import('./support/registerNotices.js');
    const { notice } = await import('../src/module/strings/notices.js');
    const { formatKnowledgeCitationNote, formatKnowledgeSearchResults, formatMostHelpfulKnowledge } =
      await import('../src/module/agent/tools/helpers.js');

    const staleHit = {
      updatedAt: new Date('2000-01-01'),
      lastRetrievedAt: null,
    };

    // formatKnowledgeCitationNote — stale note branch.
    const noteDefault = formatKnowledgeCitationNote(staleHit, 1, false, 999999, 'en', undefined);
    const notePlain = formatKnowledgeCitationNote(staleHit, 1, false, 999999, 'en', 'plain');
    assert.equal(formatKnowledgeCitationNote(staleHit, 1, false, 999999, 'en', 'standard'), noteDefault);
    assert.notEqual(notePlain, noteDefault);
    assert.match(noteDefault, /may be outdated/);
    assert.match(notePlain, /might be old/);
    assert.equal(
      formatKnowledgeCitationNote(staleHit, 1, false, 999999, 'mi', 'plain'),
      formatKnowledgeCitationNote(staleHit, 1, false, 999999, 'mi', 'standard'),
    );

    // formatKnowledgeCitationNote — low-rated caveat branch.
    const lowRatedDefault = formatKnowledgeCitationNote(staleHit, 999999, true, 999999, 'en', undefined);
    const lowRatedPlain = formatKnowledgeCitationNote(staleHit, 999999, true, 999999, 'en', 'plain');
    assert.notEqual(lowRatedPlain, lowRatedDefault);
    assert.match(lowRatedDefault, /other members found this unhelpful/);
    assert.match(lowRatedPlain, /other members said this did not help/);

    // formatKnowledgeSearchResults — empty branch (knowledgeSearchEmpty).
    assert.equal(
      formatKnowledgeSearchResults([], 0, 0, false, new Set(), 'en', undefined),
      notice('knowledgeSearchEmpty', { language: 'en' }),
    );
    assert.equal(
      formatKnowledgeSearchResults([], 0, 0, false, new Set(), 'en', 'plain'),
      notice('knowledgeSearchEmpty', { language: 'en', style: 'plain' }),
    );
    assert.notEqual(
      formatKnowledgeSearchResults([], 0, 0, false, new Set(), 'en', 'plain'),
      formatKnowledgeSearchResults([], 0, 0, false, new Set(), 'en', undefined),
    );
    assert.equal(
      formatKnowledgeSearchResults([], 0, 0, false, new Set(), 'mi', 'plain'),
      formatKnowledgeSearchResults([], 0, 0, false, new Set(), 'mi', 'standard'),
      "'mi' must win over any style",
    );

    // formatKnowledgeSearchResults — trailing conflict caveat branch.
    const hit = {
      id: 1,
      title: 'Title',
      content: 'Content',
      similarity: 0.9,
      updatedAt: new Date(),
      lastRetrievedAt: null,
    };
    const conflictDefault = formatKnowledgeSearchResults([hit], 0, 0, true, new Set(), 'en', undefined);
    const conflictPlain = formatKnowledgeSearchResults([hit], 0, 0, true, new Set(), 'en', 'plain');
    assert.notEqual(conflictPlain, conflictDefault);
    assert.match(conflictDefault, /an admin hasn't reconciled them yet/);
    assert.match(conflictPlain, /an admin hasn't checked this yet/);

    // formatMostHelpfulKnowledge — trailing conflict caveat + per-entry note.
    const entry = {
      id: 1,
      title: 'Title',
      content: 'Content',
      scope: 'global',
      createdByRole: 'admin',
      retrievalCount: 3,
      updatedAt: new Date(),
      lastRetrievedAt: null,
      sourceUrl: null,
      sourceTitle: null,
      verifiedAt: null,
      sourceUnreachable: null,
      sourceCheckedAt: null,
    };
    const mostHelpfulDefault = formatMostHelpfulKnowledge([entry], 'en', new Set(), true, undefined);
    const mostHelpfulPlain = formatMostHelpfulKnowledge([entry], 'en', new Set(), true, 'plain');
    assert.notEqual(mostHelpfulPlain, mostHelpfulDefault);
    assert.match(mostHelpfulDefault, /an admin hasn't reconciled them yet/);
    assert.match(mostHelpfulPlain, /an admin hasn't checked this yet/);
    assert.equal(
      formatMostHelpfulKnowledge([entry], 'mi', new Set(), true, 'plain'),
      formatMostHelpfulKnowledge([entry], 'mi', new Set(), true, 'standard'),
      "'mi' must win over any style",
    );
  },
);
