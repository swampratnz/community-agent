import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — dev-team feature ENABLED, same
// preamble as tests/devTeamTools.test.ts. This lives in its OWN file/process
// because it must mock ../src/storage/repository.js (insertDevTeamWatch), and
// module mocks bake into the shared import cache for a whole process —
// devTeamTools.test.ts needs the real repository module for its other tests.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.DEV_TEAM_ENABLED ??= 'true';
process.env.DEV_TEAM_ENDPOINT_URL ??= 'http://ubuntudevagent:8738';
process.env.DEV_TEAM_AUTH_TOKEN ??= 'dev-team-secret-token';

const hasDb = Boolean(process.env.DATABASE_URL) && !process.env.DATABASE_URL.includes('test:test');

const { closeDb } = await import('../src/storage/db.js');
after(async () => {
  await closeDb();
});

// Real modules, imported before the mocks are registered: the mocks spread
// them so every export tools.ts needs stays present, with ONLY the two
// functions under test replaced.
const realClient = await import('../src/devTeam/client.js');
const realRepo = await import('../src/storage/repository.js');

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

test(
  'SECURITY: dev_team_dispatch reports PARTIAL SUCCESS (job id + no-DM caveat), never "failed", when the watch insert fails after the POST succeeded',
  { skip: !hasDb },
  async (t) => {
    // The POST succeeds (a real remote job is now running and costing money);
    // the follow-up watch insert throws. Reporting that as a dispatch failure
    // would invite a retry that doubles a real job — the reply must carry the
    // job id and the explicit no-completion-DM caveat instead.
    t.mock.module('../src/devTeam/client.js', {
      namedExports: {
        ...realClient,
        dispatchJob: async () => ({ id: 'job-partial-1', state: 'queued', position: 0 }),
      },
    });
    t.mock.module('../src/storage/repository.js', {
      namedExports: {
        ...realRepo,
        insertDevTeamWatch: async () => {
          throw new Error('simulated watch-insert failure');
        },
      },
    });
    const { buildToolServer } = await import('../src/agent/tools.js');
    const caller = {
      platform: 'discord' as const,
      userId: 'super-1',
      userName: 'Tester',
      role: 'super_admin' as const,
      conversationId: 'convo-partial',
      isDirect: true,
    };
    const server = buildToolServer(caller, stubAdapter());
    const handler = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (args: {
              mode: string;
              repo: string;
            }) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
          }
        >;
      }
    )._registeredTools['dev_team_dispatch'].handler;

    const res = await handler({ mode: 'assess', repo: 'owner/name' });
    const replyText = res.content[0].text;
    assert.match(replyText, /job-partial-1/, 'the job id must be surfaced for manual reconciliation');
    assert.match(replyText, /NO completion DM/i, 'the reply must carry the no-completion-DM caveat');
    assert.match(replyText, /dev_team_status/, 'the reply must point at the manual status tool');
    assert.ok(
      !/Failed to dispatch/i.test(replyText),
      'a job that WAS dispatched must never be reported as a dispatch failure (retry incentive doubles a real job)',
    );
  },
);
