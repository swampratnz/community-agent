import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment before
// anything that (transitively) loads it, matching tests/tools.test.ts. The
// GitHub issue tool is feature-flagged, so enable it (with a token, which the
// config refine requires) for the handler to reach past its gate.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.GITHUB_ISSUE_ENABLED ??= 'true';
process.env.GITHUB_ISSUE_TOKEN ??= 'ghp_testtoken';

const hasDb = Boolean(process.env.DATABASE_URL) && !process.env.DATABASE_URL.includes('test:test');

const { closeDb } = await import('../src/storage/db.js');
const { takePendingAction } = await import('../src/agent/pendingActions.js');

after(async () => {
  await closeDb();
});

// Records what the mocked GitHub client is asked to file. `createIssue` really
// hits api.github.com, so mock it — the module must be mocked before tools.js
// is first imported (node:test module mocks bake into the cached import), so
// it's done lazily on first use, like tests/generateImageCaption.test.ts.
const issueCalls: Array<{ title: string; body: string; labels: readonly string[] }> = [];
let toolsPromise: Promise<typeof import('../src/agent/tools.js')> | null = null;
function tools(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!toolsPromise) {
    t.mock.module('../src/github/issues.js', {
      namedExports: {
        createIssue: async (input: { title: string; body: string; labels: readonly string[] }) => {
          issueCalls.push(input);
          return { number: 4242, url: 'https://github.com/swampratnz/community-agent/issues/4242' };
        },
      },
    });
    toolsPromise = import('../src/agent/tools.js');
  }
  return toolsPromise;
}

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

type Handler = (args: {
  title: string;
  body: string;
}) => Promise<{ content: Array<{ type: string; text: string }> }>;

async function suggestIssueHandler(
  t: Parameters<typeof tools>[0],
  role: 'member' | 'admin' | 'super_admin',
  userId = 'super-1',
): Promise<Handler> {
  const { buildToolServer } = await tools(t);
  const caller = {
    platform: 'discord' as const,
    userId,
    userName: 'Tester',
    role,
    conversationId: 'convo-1',
    isDirect: true,
  };
  const server = buildToolServer(caller, stubAdapter());
  return (server.instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })
    ._registeredTools['suggest_issue'].handler;
}

test('SECURITY: suggest_issue rejects a non-super-admin caller at the handler (assertAtLeast re-check)', async (t) => {
  const handler = await suggestIssueHandler(t, 'admin', 'admin-1');
  await assert.rejects(() => handler({ title: 'x', body: 'y' }), /Permission denied/);
  assert.equal(issueCalls.length, 0, 'no issue may be filed for a rejected caller');
});

test('SECURITY: suggest_issue requires CONFIRM — a single call never files directly', async (t) => {
  const before = issueCalls.length;
  const handler = await suggestIssueHandler(t, 'super_admin');
  const result = await handler({ title: 'Add X', body: 'It would help members do Y.' });
  assert.match(result.content[0].text, /CONFIRM/, 'must ask for confirmation, not file immediately');
  assert.equal(issueCalls.length, before, 'createIssue must not run before CONFIRM');
  const pending = takePendingAction('discord', 'convo-1', 'super-1');
  assert.ok(pending, 'suggest_issue must register a pending action');
});

test(
  'SECURITY: suggest_issue scrubs secrets from the body before it reaches GitHub',
  { skip: !hasDb },
  async (t) => {
    const secret = 'sk-ant-' + 'y'.repeat(30);
    const handler = await suggestIssueHandler(t, 'super_admin');
    await handler({ title: 'A bug', body: `Here is my key ${secret} — please look` });
    const pending = takePendingAction('discord', 'convo-1', 'super-1');
    assert.ok(pending, 'must register a pending action');
    await pending?.execute();

    const filed = issueCalls.at(-1);
    assert.ok(filed, 'the confirmed action must file exactly one issue');
    assert.ok(!filed.body.includes(secret), 'the raw secret must never reach the issue body');
    assert.match(filed.body, /\[redacted\]/, 'the secret must be redacted, not dropped');
  },
);
