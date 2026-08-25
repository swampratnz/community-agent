import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it, matching the convention in
// tests/tools.test.ts. IMAGE_GEN_ENABLED must be set BEFORE config.js is first
// imported in this process (it resolves once, at import time), so this needs
// its own file/process rather than reusing tests/tools.test.ts (whose shared
// process leaves IMAGE_GEN_ENABLED unset — default off — as the precondition
// for its own generate_image refusal test). IMAGE_GEN_DAILY_LIMIT=1 makes the
// daily-cap refusal path (issue #1157 acceptance criterion 3/4) reachable in
// a single extra call per test, as long as each test uses its own userId so
// the per-key reservation never collides across tests.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.IMAGE_GEN_ENABLED ??= 'true';
process.env.GROK_BIN ??= '/usr/bin/grok';
process.env.IMAGE_GEN_DAILY_LIMIT ??= '1';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');

after(async () => {
  await closeDb();
});

/**
 * generate_image's handler calls src/module/media/grokImage.ts's
 * generateImage(), which spawns a real `grok` CLI subprocess — replace it
 * with a controllable stub so these tests exercise only the audited() wiring
 * (issue #1157), never a real subprocess. Keyed by prompt (each test uses its
 * own unique prompt) so different tests can ask for success, failure, or a
 * generation that stays pending until the test resolves it. node:test module
 * mocking requires a TestContext (`t.mock`) and must be installed before
 * tools.js is first imported in this process, so it's done lazily on first
 * use and the resulting import cached, mirroring the pattern in
 * tests/generateImageCaption.test.ts / tests/knowledgeScope.test.ts.
 */
type GenResult = { data: Buffer; mimeType: string; ext: string };
type GenBehavior =
  { kind: 'success' } | { kind: 'fail'; message: string } | { kind: 'deferred'; promise: Promise<GenResult> };
const genBehaviors = new Map<string, GenBehavior>();

function deferredGeneration(): { promise: Promise<GenResult>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<GenResult>((res) => {
    resolve = () => res({ data: Buffer.from('fake-image-bytes'), mimeType: 'image/jpeg', ext: 'jpg' });
  });
  return { promise, resolve };
}

let toolsPromise: Promise<typeof import('../src/module/agent/tools.js')> | null = null;
function tools(t: TestContext) {
  if (!toolsPromise) {
    t.mock.module('../src/module/media/grokImage.js', {
      namedExports: {
        generateImage: async (prompt: string): Promise<GenResult> => {
          const behavior = genBehaviors.get(prompt) ?? { kind: 'success' as const };
          if (behavior.kind === 'fail') throw new Error(behavior.message);
          if (behavior.kind === 'deferred') return behavior.promise;
          return { data: Buffer.from('fake-image-bytes'), mimeType: 'image/jpeg', ext: 'jpg' };
        },
      },
    });
    // The tool-registry registrations (the manifest's `toolTiers`/
    // `toolServerParts`/`flaggedToolPredicates` in production) load the whole
    // registry, so they must come AFTER the mock above — importing the
    // registry is what caches the real module this test replaces.
    toolsPromise = import('./support/registerToolRegistry.js').then(
      () => import('../src/module/agent/tools.js'),
    );
  }
  return toolsPromise;
}

function stubAdapter(sendImage: PlatformAdapter['sendImage']): PlatformAdapter {
  return {
    platform: 'discord',
    start: async () => {},
    stop: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    sendMessage: async () => {},
    sendDirectMessage: async () => {},
    sendImage,
    conversationsForUser: async () => [],
    adminCapabilities: new Set(),
    performAdminAction: async () => {
      throw new Error('not implemented in stub');
    },
  };
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredServer = {
  instance: { _registeredTools: Record<string, { handler: (args: object) => Promise<ToolResult> }> };
};

function registeredTool(server: unknown, name: string) {
  return (server as RegisteredServer).instance._registeredTools[name];
}

async function auditRows(actorUserId: string) {
  const { rows } = await pool.query<{
    action_kind: string;
    success: boolean;
    conversation_id: string | null;
    params: { prompt?: string };
    result: string | null;
  }>(
    `SELECT action_kind, success, conversation_id, params, result FROM admin_audit
     WHERE actor_user_id = $1 AND action_kind = 'generate_image' ORDER BY created_at ASC`,
    [actorUserId],
  );
  return rows;
}

test(
  'A successful generate_image call writes exactly one admin_audit row with action_kind = generate_image, ' +
    "the calling admin as actor, the caller's conversationId, and the prompt in params (issue #1157 " +
    'acceptance criterion 1)',
  { skip },
  async (t) => {
    const { buildToolServer } = await tools(t);
    const conv = `${RUN}-success`;
    const actor = `${RUN}-success-admin`;
    const prompt = `${RUN} a cat wearing a hat`;
    const calls: Array<{ conversationId: string; caption?: string }> = [];
    const adapter = stubAdapter(async (conversationId, _image, caption) => {
      calls.push({ conversationId, caption });
    });
    const caller = {
      platform: 'discord' as const,
      userId: actor,
      userName: 'Admin',
      role: 'admin' as const,
      conversationId: conv,
      isDirect: false,
    };
    const server = buildToolServer(caller, adapter);
    const result = await registeredTool(server, 'generate_image').handler({ prompt });

    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? '', /posted/i);
    assert.equal(calls.length, 1, 'adapter.sendImage must be called exactly once');

    const rows = await auditRows(actor);
    assert.equal(rows.length, 1, 'exactly one admin_audit row for the successful call');
    assert.equal(rows[0].success, true);
    assert.equal(rows[0].conversation_id, conv);
    assert.equal(rows[0].params.prompt, prompt);
  },
);

test(
  'A generate_image call where generateImage itself rejects still writes an admin_audit row with ' +
    'success: false, and returns an error-flagged reply (issue #1157 acceptance criterion 2)',
  { skip },
  async (t) => {
    const { buildToolServer } = await tools(t);
    const conv = `${RUN}-fail-generate`;
    const actor = `${RUN}-fail-generate-admin`;
    const prompt = `${RUN} a doomed generation`;
    genBehaviors.set(prompt, { kind: 'fail', message: 'grok exploded' });
    const adapter = stubAdapter(async () => {
      throw new Error('sendImage must never be called when generateImage rejects');
    });
    const caller = {
      platform: 'discord' as const,
      userId: actor,
      userName: 'Admin',
      role: 'admin' as const,
      conversationId: conv,
      isDirect: false,
    };
    const server = buildToolServer(caller, adapter);
    const result = await registeredTool(server, 'generate_image').handler({ prompt });

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /Image generation failed:.*grok exploded/);

    const rows = await auditRows(actor);
    assert.equal(rows.length, 1, 'the failure must still be recorded, not silently dropped');
    assert.equal(rows[0].success, false);
    assert.match(rows[0].result ?? '', /grok exploded/);
  },
);

test(
  'A generate_image call where adapter.sendImage rejects (grok succeeded but the post failed) still ' +
    'writes an admin_audit row with success: false (issue #1157 acceptance criterion 2)',
  { skip },
  async (t) => {
    const { buildToolServer } = await tools(t);
    const conv = `${RUN}-fail-send`;
    const actor = `${RUN}-fail-send-admin`;
    const prompt = `${RUN} a fine image that fails to post`;
    const adapter = stubAdapter(async () => {
      throw new Error('discord rejected the attachment');
    });
    const caller = {
      platform: 'discord' as const,
      userId: actor,
      userName: 'Admin',
      role: 'admin' as const,
      conversationId: conv,
      isDirect: false,
    };
    const server = buildToolServer(caller, adapter);
    const result = await registeredTool(server, 'generate_image').handler({ prompt });

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /Image generation failed:.*discord rejected the attachment/);

    const rows = await auditRows(actor);
    assert.equal(rows.length, 1, 'a sendImage failure must still be recorded, not silently dropped');
    assert.equal(rows[0].success, false);
  },
);

test(
  'generate_image refuses with no admin_audit row when the platform adapter lacks sendImage (issue #1157 ' +
    'acceptance criterion 3)',
  { skip },
  async (t) => {
    const { buildToolServer } = await tools(t);
    const conv = `${RUN}-no-sendimage`;
    const actor = `${RUN}-no-sendimage-admin`;
    const adapter = stubAdapter(undefined);
    const caller = {
      platform: 'discord' as const,
      userId: actor,
      userName: 'Admin',
      role: 'admin' as const,
      conversationId: conv,
      isDirect: false,
    };
    const server = buildToolServer(caller, adapter);
    const result = await registeredTool(server, 'generate_image').handler({ prompt: `${RUN} unreachable` });

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /isn't available/);
    assert.equal((await auditRows(actor)).length, 0, 'a pre-audited refusal must never write a row');
  },
);

test(
  'generate_image refuses a second overlapping call for the same admin with no admin_audit row for the ' +
    'refusal, and clears the in-flight guard in finally so the daily-cap refusal (not the in-flight one) ' +
    'is what a later retry sees (issue #1157 acceptance criteria 3 and 4)',
  { skip },
  async (t) => {
    const { buildToolServer } = await tools(t);
    const conv = `${RUN}-inflight`;
    const actor = `${RUN}-inflight-admin`;
    const prompt = `${RUN} a slow generation`;
    const { promise, resolve } = deferredGeneration();
    genBehaviors.set(prompt, { kind: 'deferred', promise });
    const calls: Array<{ conversationId: string }> = [];
    const adapter = stubAdapter(async (conversationId) => {
      calls.push({ conversationId });
    });
    const caller = {
      platform: 'discord' as const,
      userId: actor,
      userName: 'Admin',
      role: 'admin' as const,
      conversationId: conv,
      isDirect: false,
    };
    const server = buildToolServer(caller, adapter);
    const tool = registeredTool(server, 'generate_image');

    const firstCall = tool.handler({ prompt });
    // The in-flight guard is set synchronously, before generate_image's first
    // await, so by the time the line above returns control here the key is
    // already reserved — a second call must see it without needing a real tick.
    const overlapResult = await tool.handler({ prompt });
    assert.equal(overlapResult.isError, true);
    assert.match(overlapResult.content[0]?.text ?? '', /already have an image generating/);

    resolve();
    const firstResult = await firstCall;
    assert.equal(firstResult.isError, false);
    assert.equal(calls.length, 1, 'only the first call may reach adapter.sendImage');

    const rows = await auditRows(actor);
    assert.equal(rows.length, 1, 'the overlapping refusal must never write a row of its own');
    assert.equal(rows[0].success, true);

    // IMAGE_GEN_DAILY_LIMIT=1 in this process, and the first call already
    // consumed the one slot — a retry now must hit the daily cap, proving the
    // in-flight flag was cleared in `finally` (else this would instead be the
    // "already generating" refusal again).
    const retryResult = await tool.handler({ prompt: `${RUN} a slow generation retry` });
    assert.equal(retryResult.isError, true);
    assert.match(retryResult.content[0]?.text ?? '', /hit today's image limit/);
    assert.equal((await auditRows(actor)).length, 1, 'the daily-cap refusal must never write a row either');
  },
);

test(
  "A failed generate_image call still consumes the caller's daily-cap reservation — the reservation is " +
    'not refunded on failure, so an immediate retry hits the daily cap rather than running again ' +
    '(issue #1157 acceptance criterion 4)',
  { skip },
  async (t) => {
    const { buildToolServer } = await tools(t);
    const conv = `${RUN}-cap-not-refunded`;
    const actor = `${RUN}-cap-not-refunded-admin`;
    const prompt = `${RUN} a doomed generation that still spends the cap`;
    genBehaviors.set(prompt, { kind: 'fail', message: 'grok exploded again' });
    const adapter = stubAdapter(async () => {});
    const caller = {
      platform: 'discord' as const,
      userId: actor,
      userName: 'Admin',
      role: 'admin' as const,
      conversationId: conv,
      isDirect: false,
    };
    const server = buildToolServer(caller, adapter);
    const tool = registeredTool(server, 'generate_image');

    const first = await tool.handler({ prompt });
    assert.equal(first.isError, true);
    assert.match(first.content[0]?.text ?? '', /Image generation failed:/);

    const retry = await tool.handler({ prompt: `${RUN} a second attempt` });
    assert.equal(retry.isError, true);
    assert.match(
      retry.content[0]?.text ?? '',
      /hit today's image limit/,
      'IMAGE_GEN_DAILY_LIMIT=1 means the failed attempt already spent the one daily slot',
    );

    const rows = await auditRows(actor);
    assert.equal(rows.length, 1, 'only the failed attempt is audited — the cap refusal writes nothing');
    assert.equal(rows[0].success, false);
  },
);

test(
  'SECURITY: a successful generate_image call is visible to audit_view — the super-admin oversight tool ' +
    'that answers "who did what" now sees image-gen activity it was previously blind to (issue #1157 ' +
    'acceptance criterion 5)',
  { skip },
  async (t) => {
    const { buildToolServer } = await tools(t);
    const conv = `${RUN}-audit-view`;
    const actor = `${RUN}-audit-view-admin`;
    const prompt = `${RUN} a picture only a super admin should be able to see logged`;
    const adapter = stubAdapter(async () => {});
    const adminCaller = {
      platform: 'discord' as const,
      userId: actor,
      userName: 'Admin',
      role: 'admin' as const,
      conversationId: conv,
      isDirect: false,
    };
    const adminServer = buildToolServer(adminCaller, adapter);
    const genResult = await registeredTool(adminServer, 'generate_image').handler({ prompt });
    assert.equal(genResult.isError, false);

    const superCaller = {
      platform: 'discord' as const,
      userId: `${RUN}-super`,
      userName: 'SuperAdmin',
      role: 'super_admin' as const,
      conversationId: conv,
      isDirect: false,
    };
    const superServer = buildToolServer(superCaller, adapter);
    // Generously large so this row survives even if other test files are
    // concurrently writing their own admin_audit rows against the same
    // shared DB — recentAuditEntries has no actionKind/actor filter.
    const auditResult = await registeredTool(superServer, 'audit_view').handler({ limit: 2000 });

    assert.equal(auditResult.isError, false);
    const lines = auditResult.content[0]?.text.split('\n') ?? [];
    const ourLine = lines.find((l) => l.includes(actor) && l.includes('generate_image'));
    assert.ok(ourLine, 'audit_view must surface the generate_image row for this actor');
    assert.match(ourLine ?? '', /✓/, 'the successful call must show as a success in audit_view');
  },
);
