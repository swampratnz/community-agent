import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. Captured before the DATABASE_URL
// fallback below so the knowledge_search DB-backed test can tell a real DB
// apart from the dummy placeholder, matching tests/knowledgeEval.test.ts.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

// notifyMemberApproved holds all of add_member's new (issue #75) behaviour —
// deciding whether to send the approval DM and swallowing send failures. It's
// exported and tested directly here rather than through the full MCP
// tool-call transport, which the rest of add_member (upsertMember/audited/
// clearAccessRequest, all DB-backed) already exercises via repository.test.ts.
const {
  notifyMemberApproved,
  buildToolServer,
  formatKnowledgeSearchResults,
  KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD,
} = await import('../src/agent/tools.js');
const { MODERATION_ACTION_KINDS, saveKnowledge } = await import('../src/storage/repository.js');
const { pool, closeDb } = await import('../src/storage/db.js');

// Unique per test-run scope so the knowledge_search handler test's fixture
// row never collides across runs, mirroring the RUN-tag convention in
// tests/repository.test.ts and tests/knowledgeEval.test.ts.
const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const KNOWLEDGE_SEARCH_HANDLER_SCOPE = `${RUN}-knowledge-search-handler`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM knowledge WHERE scope = $1`, [KNOWLEDGE_SEARCH_HANDLER_SCOPE]);
  }
  await closeDb();
});

function stubAdapter(sendDirectMessage: PlatformAdapter['sendDirectMessage']): PlatformAdapter {
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

test('notifyMemberApproved sends exactly one confirmation DM on a fresh grant', async () => {
  const calls: Array<[string, string]> = [];
  const adapter = stubAdapter(async (userId, text) => {
    calls.push([userId, text]);
  });

  await notifyMemberApproved(adapter, 'user-1', false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'user-1');
  assert.match(calls[0][1], /approved/i);
});

test('notifyMemberApproved sends nothing when the user was already a member (re-add is a no-op)', async () => {
  const calls: string[] = [];
  const adapter = stubAdapter(async (userId) => {
    calls.push(userId);
  });

  await notifyMemberApproved(adapter, 'user-1', true);

  assert.equal(calls.length, 0);
});

test('notifyMemberApproved swallows a DM failure rather than throwing (grant stays the source of truth)', async () => {
  const adapter = stubAdapter(async () => {
    throw new Error('DMs closed');
  });

  await assert.doesNotReject(notifyMemberApproved(adapter, 'user-1', false));
});

test('SECURITY: moderation_history rejects an actionKind outside the allow-list at the zod schema boundary', () => {
  const adapter = stubAdapter(async () => {});
  const caller = {
    platform: 'discord' as const,
    userId: 'admin-1',
    userName: 'Admin',
    role: 'admin' as const,
    conversationId: 'convo-1',
  };
  const server = buildToolServer(caller, adapter);
  const registeredTool = (
    server.instance as unknown as {
      _registeredTools: Record<string, { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }>;
    }
  )._registeredTools['moderation_history'];

  assert.equal(
    registeredTool.inputSchema.safeParse({ actionKind: 'grant_admin' }).success,
    false,
    'a privileged kind outside MODERATION_ACTION_KINDS must fail validation, never reach SQL',
  );
  for (const kind of MODERATION_ACTION_KINDS) {
    assert.equal(
      registeredTool.inputSchema.safeParse({ actionKind: kind }).success,
      true,
      `${kind} is allow-listed`,
    );
  }
  assert.equal(registeredTool.inputSchema.safeParse({}).success, true, 'actionKind stays optional');
});

// formatKnowledgeSearchResults holds all of knowledge_search's relevance-
// filtering behaviour (issue #95) — it's exported and unit-tested directly
// here with synthetic similarity values, same rationale as
// notifyMemberApproved above: it's the exact function the handler calls
// unmodified, and testing it directly is deterministic and independent of
// the embedding model, unlike going through real embeddings end-to-end
// (which tests/knowledgeEval.test.ts already covers for ranking quality and
// for grounding KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD itself).
const fakeHit = (similarity: number, title = 'Some entry') => ({
  title,
  content: 'Some content.',
  similarity,
  updatedAt: new Date(),
});

test('formatKnowledgeSearchResults returns "no matching" when every hit is below the relevance threshold, even though hits exist', () => {
  const hits = [
    fakeHit(KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD - 0.01),
    fakeHit(KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD - 0.2),
  ];
  assert.equal(formatKnowledgeSearchResults(hits), 'No matching knowledge entries.');
});

test('formatKnowledgeSearchResults returns "no matching" for an empty hit list (table empty, unchanged behaviour)', () => {
  assert.equal(formatKnowledgeSearchResults([]), 'No matching knowledge entries.');
});

test('formatKnowledgeSearchResults keeps hits at/above the threshold and drops only the sub-threshold ones', () => {
  const relevant = fakeHit(KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD, 'Relevant entry');
  const borderlineAbove = fakeHit(0.99, 'Very relevant entry');
  const irrelevant = fakeHit(0.01, 'Irrelevant entry');
  const text = formatKnowledgeSearchResults([borderlineAbove, relevant, irrelevant]);

  assert.match(text, /Very relevant entry/);
  assert.match(text, /Relevant entry/);
  assert.doesNotMatch(text, /Irrelevant entry/);
});

test('formatKnowledgeSearchResults annotates surviving hits with an exact "(NN% match)" — same rounding/wording as remember_search', () => {
  const text = formatKnowledgeSearchResults([fakeHit(0.876, 'Rounds to 88')]);
  assert.match(text, /\(88% match\)/);
  assert.match(text, /Rounds to 88/);
});

test(
  'knowledge_search tool handler wires searchKnowledge into formatKnowledgeSearchResults end-to-end (real DB + embeddings)',
  { skip },
  async () => {
    const uniqueTitle = `Zylotrix onboarding steps ${RUN}`;
    await saveKnowledge({
      title: uniqueTitle,
      content: 'To onboard to Zylotrix, request an invite from an admin and complete the setup wizard.',
      scope: KNOWLEDGE_SEARCH_HANDLER_SCOPE,
    });

    const adapter = stubAdapter(async () => {});
    const caller = {
      platform: 'discord' as const,
      userId: 'member-1',
      userName: 'Member',
      role: 'member' as const,
      // Matches the scope the fixture entry was saved under, so this exercises
      // the in-scope (conversation-scoped) retrieval path (issue #106); the
      // out-of-scope paths are covered in tests/knowledgeScope.test.ts.
      conversationId: KNOWLEDGE_SEARCH_HANDLER_SCOPE,
    };
    const server = buildToolServer(caller, adapter);
    const registeredTool = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (args: { query: string }) => Promise<{ content: Array<{ type: string; text: string }> }>;
          }
        >;
      }
    )._registeredTools['knowledge_search'];

    const result = await registeredTool.handler({ query: 'how do I get set up on Zylotrix' });
    const text = result.content[0]?.text ?? '';

    assert.match(text, /% match\)/, 'a genuinely relevant hit must surface its match percentage');
    assert.match(text, new RegExp(uniqueTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  },
);
