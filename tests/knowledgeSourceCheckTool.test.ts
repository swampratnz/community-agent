import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// check_knowledge_source (issue #1188): the on-demand, single-entry
// counterpart to the weekly runKnowledgeLinkCheck job (linkCheck.ts), which
// is otherwise the only path that can clear source_unreachable back to
// false. Both `classifySourceUrl` and the repository's `listKnowledgeSourceUrls`/
// `recordKnowledgeSourceCheck` are module-mocked (spreading the real module so
// every OTHER export used elsewhere in knowledgeAdmin.ts stays real), so this
// never touches the network or a database — the pure-classification and SSRF
// guard behaviour of classifySourceUrl itself already has its own suite in
// tests/linkCheck.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

type Outcome = 'reachable' | 'unreachable' | 'refused';

const ENTRIES: Array<{ id: number; sourceUrl: string }> = [{ id: 1, sourceUrl: 'https://example.com/a' }];

/** Mutated per test. */
let classifyOutcome: Outcome = 'reachable';
const classifyCalls: string[] = [];
const recordCalls: Array<{ id: number; unreachable: boolean }> = [];

// Installed BEFORE the dynamic import of knowledgeAdmin.ts below — importing
// the tool file caches its own bindings to these modules, and a mock
// installed afterwards cannot retarget them (see fetchPageTool.test.ts /
// agentCoreKnowledgeEntryId.test.ts for the same pattern). Spreading the real
// module keeps every export knowledgeAdmin.ts's OTHER tools rely on
// (saveKnowledge, updateKnowledge, listKnowledge, …) working exactly as
// before; only the two exports this tool actually calls are overridden.
const realRepo = await import('@swampratnz/agent-base/storage/repository.js');
mock.module('@swampratnz/agent-base/storage/repository.js', {
  namedExports: {
    ...realRepo,
    listKnowledgeSourceUrls: async () => ENTRIES,
    recordKnowledgeSourceCheck: async (id: number, unreachable: boolean) => {
      recordCalls.push({ id, unreachable });
    },
  },
});

const realLinkCheck = await import('../src/module/context/linkCheck.js');
mock.module('../src/module/context/linkCheck.js', {
  namedExports: {
    ...realLinkCheck,
    classifySourceUrl: async (sourceUrl: string) => {
      classifyCalls.push(sourceUrl);
      return classifyOutcome;
    },
  },
});

const { knowledgeAdminTools } = await import('../src/module/agent/tools/knowledgeAdmin.js');
const { COMMUNITY_TOOL_TIERS } = await import('../src/module/agent/tools/index.js');

const tool = knowledgeAdminTools.find((t) => t.name === 'check_knowledge_source');
if (!tool) throw new Error('check_knowledge_source tool not found');

interface Captured {
  auditKind?: string;
  auditParams?: Record<string, unknown>;
  auditResult?: string;
  auditSuccess?: boolean;
  ran: boolean;
}

/**
 * A context whose `audited` mirrors the real one in tools/context.ts: it runs
 * the callback, and a THROWN error becomes `success: false` rather than
 * propagating — see fetchPageTool.test.ts for the same shape.
 */
function ctxFor(role: 'guest' | 'member' | 'admin' | 'super_admin', captured: Captured) {
  return {
    caller: {
      platform: 'discord',
      userId: `u-${Math.random().toString(36).slice(2)}`,
      userName: 'Admin',
      conversationId: 'c1',
      role,
    },
    audited: async (input: {
      actionKind: string;
      params?: Record<string, unknown>;
      run: () => Promise<string>;
    }) => {
      captured.auditKind = input.actionKind;
      captured.auditParams = input.params;
      captured.ran = true;
      try {
        const result = await input.run();
        captured.auditResult = result;
        captured.auditSuccess = true;
        return { success: true, result };
      } catch (err) {
        const result = err instanceof Error ? err.message : String(err);
        captured.auditResult = result;
        captured.auditSuccess = false;
        return { success: false, result };
      }
    },
  } as never;
}

function fresh(): Captured {
  return { ran: false };
}

function textOf(res: { content: ReadonlyArray<{ type: string }> }): string {
  const first = res.content[0];
  return first && 'text' in first ? String((first as { text: unknown }).text) : '';
}

test.beforeEach(() => {
  classifyOutcome = 'reachable';
  classifyCalls.length = 0;
  recordCalls.length = 0;
});

test('SECURITY: check_knowledge_source is admin-tier — absent from the member and guest tool surface, and a below-admin caller is refused by the in-handler assertion, not merely surface filtering', async () => {
  assert.equal(tool.minTier, 'admin');
  assert.equal(
    COMMUNITY_TOOL_TIERS.member.some((t) => t.endsWith('check_knowledge_source')),
    false,
    'a member must never be offered an on-demand egress trigger',
  );
  assert.equal(
    COMMUNITY_TOOL_TIERS.admin.some((t) => t.endsWith('check_knowledge_source')),
    true,
    'and it must be registered at admin, not silently absent from every tier',
  );

  for (const role of ['guest', 'member'] as const) {
    const cap = fresh();
    await assert.rejects(
      () => tool.handler({ id: 1 }, ctxFor(role, cap)),
      `${role} must be refused`,
    );
    assert.equal(cap.ran, false, 'SECURITY: nothing may run for a below-admin caller');
    assert.equal(classifyCalls.length, 0, 'SECURITY: no probe may be issued for a below-admin caller');
    assert.equal(recordCalls.length, 0);
  }
});

test('a reachable outcome persists source_unreachable=false and reports it to the caller', async () => {
  classifyOutcome = 'reachable';
  const cap = fresh();
  const res = await tool.handler({ id: 1 }, ctxFor('admin', cap));

  assert.equal(res.isError, false);
  assert.deepEqual(classifyCalls, ['https://example.com/a']);
  assert.deepEqual(recordCalls, [{ id: 1, unreachable: false }]);
  assert.match(textOf(res), /reachable/);
  assert.equal(cap.auditKind, 'check_knowledge_source');
  assert.deepEqual(cap.auditParams, { id: 1 });
});

test('an unreachable outcome persists source_unreachable=true — a genuine outage is still recorded, not silently cleared', async () => {
  classifyOutcome = 'unreachable';
  const cap = fresh();
  const res = await tool.handler({ id: 1 }, ctxFor('admin', cap));

  assert.equal(res.isError, false);
  assert.deepEqual(recordCalls, [{ id: 1, unreachable: true }]);
  assert.match(textOf(res), /unreachable/);
});

test('SECURITY: a refused outcome (SSRF guard blocks the target) is reported to the caller but never persisted', async () => {
  classifyOutcome = 'refused';
  const cap = fresh();
  const res = await tool.handler({ id: 1 }, ctxFor('admin', cap));

  assert.equal(res.isError, false, 'reporting a refusal is not itself a tool failure');
  assert.equal(
    recordCalls.length,
    0,
    'SECURITY: a refused outcome must never reach recordKnowledgeSourceCheck — mirrors runKnowledgeLinkCheck',
  );
  assert.match(textOf(res), /refused/i);
  assert.equal(cap.auditSuccess, true, 'the probe itself succeeded — refusal is a reported outcome, not a thrown error');
});

test('an id with no sourceUrl (absent from listKnowledgeSourceUrls) returns a clear error and writes nothing', async () => {
  const cap = fresh();
  const res = await tool.handler({ id: 999 }, ctxFor('admin', cap));

  assert.equal(res.isError, true);
  assert.match(textOf(res), /No knowledge entry with id 999/);
  assert.equal(classifyCalls.length, 0, 'never probes a nonexistent/sourceUrl-less entry');
  assert.equal(recordCalls.length, 0);
  assert.equal(cap.auditSuccess, false, 'audited as a failure, not a success');
});
