import { test } from 'node:test';
import assert from 'node:assert/strict';

// Issue #920 AC #9: who_is_into's no-query/no-profile browse fallback
// (listRecentInterests) must never call embed() — it's a plain ORDER BY, not
// a similarity search. embed() must be mocked via node:test's module mocking
// BEFORE agent/tools.js/storage/repository.js/storage/embeddings.js are ever
// imported (statically or dynamically) elsewhere in this process, so nothing
// at the top of this file imports any of them — same convention and
// rationale as tests/knowledgeCandidateDedupDegradation.test.ts.

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

test("SECURITY: who_is_into's no-query/no-profile browse fallback never calls embed() (issue #920 AC #9)", async (t) => {
  let embedCalls = 0;
  t.mock.module('@swampratnz/agent-base/storage/embeddings.js', {
    namedExports: {
      embed: async () => {
        embedCalls += 1;
        throw new Error('embed() must never be called on the no-query/no-profile browse fallback path');
      },
    },
  });

  const { pool } = await import('@swampratnz/agent-base/storage/db.js');
  t.mock.method(pool, 'query', (async (sql: string) => {
    // searchMemberInterestsForSelf's self-match query and its existence
    // check both report "no profile" — no rows either way.
    if (sql.includes('WITH me AS') || sql.includes('SELECT 1 FROM member_interests')) {
      return { rows: [], rowCount: 0 };
    }
    // listRecentInterests' plain browse query.
    if (sql.includes('FROM member_interests') && sql.includes('ORDER BY updated_at DESC')) {
      return {
        rows: [
          {
            platform: 'discord',
            user_id: 'browsed-1',
            interests: 'browsable interests',
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);

  await import('./support/registerToolRegistry.js');
  const { buildToolServer } = await import('../src/module/agent/tools.js');
  const { platform, userId, userName, role, conversationId, isDirect } = {
    platform: 'discord' as const,
    userId: 'caller-1',
    userName: 'Caller',
    role: 'member' as const,
    conversationId: 'convo-1',
    isDirect: false,
  };

  const adapter = {
    platform: 'discord' as const,
    start: async () => {},
    stop: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    sendMessage: async () => undefined,
    sendDirectMessage: async () => {},
    conversationsForUser: async () => [],
    adminCapabilities: new Set<string>(),
    performAdminAction: async () => {
      throw new Error('not implemented in stub');
    },
  };

  const server = buildToolServer({ platform, userId, userName, role, conversationId, isDirect }, adapter);
  const whoTool = (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (args: {
            query?: string;
          }) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
        }
      >;
    }
  )._registeredTools['who_is_into'];

  const result = await whoTool.handler({});

  assert.equal(embedCalls, 0, 'embed() must never be called on the browse fallback path');
  assert.equal(result.isError, false);
  assert.match(result.content[0]?.text ?? '', /browsable interests/);
});
