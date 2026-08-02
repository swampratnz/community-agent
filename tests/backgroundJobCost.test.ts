import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/strings/notices.js';

// Issue #401: classifyAbuseWithLlm, summarizeCluster, and researchTopic each
// spawn a standalone query() against the shared Max pool but wrote no
// interactions row, so their cost never reached usageStats(). This file pins
// the new recordBackgroundJobCost call each of the three now makes.
//
// No DB needed: recordBackgroundJobCost itself is mocked out as a spy (see
// tests/agentCoreLanguagePreference.test.ts for the same repository-mocking
// pattern), so these assert on the CALL, not a real row — avoiding the race
// between a fire-and-forget insert and the test reading it back.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

type MockResult = { result?: string; totalCostUsd?: unknown; structuredOutput?: unknown };
let nextResult: MockResult = { result: 'CLEAN', totalCostUsd: 0, structuredOutput: { verdict: 'CLEAN' } };

function mockQuery() {
  return (async function* () {
    const msg: Record<string, unknown> = {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
    };
    if (nextResult.result !== undefined) msg.result = nextResult.result;
    if (nextResult.totalCostUsd !== undefined) msg.total_cost_usd = nextResult.totalCostUsd;
    if (nextResult.structuredOutput !== undefined) msg.structured_output = nextResult.structuredOutput;
    yield msg;
  })();
}

interface RecordCall {
  job: string;
  costUsd: number;
}
let recordCalls: RecordCall[] = [];
let recordShouldReject = false;

async function spyRecordBackgroundJobCost(job: string, costUsd: number): Promise<void> {
  recordCalls.push({ job, costUsd });
  if (recordShouldReject) throw new Error('background_job_costs insert failed (simulated)');
}

// query() and recordBackgroundJobCost are static imports inside
// moderator.ts/builder.ts/knowledgeRefresh.ts, so once any of those modules
// has been imported anywhere in this process the bindings are fixed (same
// trap as tests/classifierModelTiering.test.ts) — install both mocks once
// and reuse the cached imports across every test in this file.
let modulesPromise: Promise<{
  classifyAbuseWithLlm: typeof import('../src/moderation/moderator.js').classifyAbuseWithLlm;
  summarizeCluster: typeof import('../src/context/builder.js').summarizeCluster;
  researchTopic: typeof import('../src/context/knowledgeRefresh.js').researchTopic;
}> | null = null;
async function modules(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!modulesPromise) {
    const realSdk = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...realSdk, query: mockQuery } });
    const realRepo = await import('../src/storage/repository.js');
    t.mock.module('../src/storage/repository.js', {
      namedExports: { ...realRepo, recordBackgroundJobCost: spyRecordBackgroundJobCost },
    });
    // builder.ts/knowledgeRefresh.ts import recordBackgroundJobCost from the
    // owning domain module directly (the storage-split cycle break repointed
    // src/context/ off the barrel), so the spy must cover that specifier too —
    // moderator.ts still reaches it through the barrel mock above.
    const realAdminStats = await import('../src/storage/repository/adminStats.js');
    t.mock.module('../src/storage/repository/adminStats.js', {
      namedExports: { ...realAdminStats, recordBackgroundJobCost: spyRecordBackgroundJobCost },
    });
    modulesPromise = Promise.all([
      import('../src/moderation/moderator.js'),
      import('../src/context/builder.js'),
      import('../src/context/knowledgeRefresh.js'),
    ]).then(([moderator, builder, knowledgeRefresh]) => ({
      classifyAbuseWithLlm: moderator.classifyAbuseWithLlm,
      summarizeCluster: builder.summarizeCluster,
      researchTopic: knowledgeRefresh.researchTopic,
    }));
  }
  return modulesPromise;
}

// --- classifyAbuseWithLlm ----------------------------------------------------

test('classifyAbuseWithLlm: a positive total_cost_usd records a moderation_llm background job cost (issue #401)', async (t) => {
  const { classifyAbuseWithLlm } = await modules(t);
  recordCalls = [];
  recordShouldReject = false;
  nextResult = { result: 'CLEAN', totalCostUsd: 0.0042, structuredOutput: { verdict: 'CLEAN' } };

  await classifyAbuseWithLlm('some test message');

  assert.deepEqual(recordCalls, [{ job: 'moderation_llm', costUsd: 0.0042 }]);
});

test('classifyAbuseWithLlm: total_cost_usd absent, 0, or non-numeric records no background job cost (issue #401)', async (t) => {
  const { classifyAbuseWithLlm } = await modules(t);

  for (const totalCostUsd of [undefined, 0, NaN, 'not-a-number']) {
    recordCalls = [];
    recordShouldReject = false;
    nextResult = { result: 'CLEAN', totalCostUsd, structuredOutput: { verdict: 'CLEAN' } };
    await classifyAbuseWithLlm('some test message');
    assert.deepEqual(recordCalls, [], `no row recorded for total_cost_usd = ${String(totalCostUsd)}`);
  }
});

test('SECURITY: classifyAbuseWithLlm still returns its normal result when recordBackgroundJobCost rejects (issue #401)', async (t) => {
  const { classifyAbuseWithLlm } = await modules(t);
  recordCalls = [];
  recordShouldReject = true;
  nextResult = {
    result: 'ABUSE: targeted insult',
    totalCostUsd: 0.01,
    structuredOutput: { verdict: 'ABUSE', reason: 'targeted insult' },
  };

  const detection = await classifyAbuseWithLlm('some test message');

  assert.ok(detection, 'classification result is unaffected by a failed cost-recording insert');
  assert.match(detection.reason, /abuse/);
});

// --- summarizeCluster --------------------------------------------------------

const SUMMARIZE_STRUCTURED_OUTPUT = {
  topic: 'recurring theme',
  summary: 'a short aggregate summary.',
  isCandidate: false,
};

test('summarizeCluster: a positive total_cost_usd records a context_builder background job cost (issue #401)', async (t) => {
  const { summarizeCluster } = await modules(t);
  recordCalls = [];
  recordShouldReject = false;
  nextResult = { result: 'ok', totalCostUsd: 0.0088, structuredOutput: SUMMARIZE_STRUCTURED_OUTPUT };

  await summarizeCluster(['a recurring sample message']);

  assert.deepEqual(recordCalls, [{ job: 'context_builder', costUsd: 0.0088 }]);
});

test('summarizeCluster: total_cost_usd absent, 0, or non-numeric records no background job cost (issue #401)', async (t) => {
  const { summarizeCluster } = await modules(t);

  for (const totalCostUsd of [undefined, 0, NaN, 'not-a-number']) {
    recordCalls = [];
    recordShouldReject = false;
    nextResult = { result: 'ok', totalCostUsd, structuredOutput: SUMMARIZE_STRUCTURED_OUTPUT };
    await summarizeCluster(['a recurring sample message']);
    assert.deepEqual(recordCalls, [], `no row recorded for total_cost_usd = ${String(totalCostUsd)}`);
  }
});

test('SECURITY: summarizeCluster still returns its normal result when recordBackgroundJobCost rejects (issue #401)', async (t) => {
  const { summarizeCluster } = await modules(t);
  recordCalls = [];
  recordShouldReject = true;
  nextResult = { result: 'ok', totalCostUsd: 0.02, structuredOutput: SUMMARIZE_STRUCTURED_OUTPUT };

  const digest = await summarizeCluster(['a recurring sample message']);

  assert.equal(
    digest.topic,
    'recurring theme',
    'digest result is unaffected by a failed cost-recording insert',
  );
});

// --- researchTopic ------------------------------------------------------------

test('researchTopic: a positive total_cost_usd records a knowledge_refresh background job cost (issue #401)', async (t) => {
  const { researchTopic } = await modules(t);
  recordCalls = [];
  recordShouldReject = false;
  nextResult = {
    result: '- a sourced briefing bullet',
    totalCostUsd: 0.15,
    structuredOutput: { hasUpdate: true, briefing: '- a sourced briefing bullet' },
  };

  await researchTopic('some fixed topic query');

  assert.deepEqual(recordCalls, [{ job: 'knowledge_refresh', costUsd: 0.15 }]);
});

test('researchTopic: total_cost_usd absent, 0, or non-numeric records no background job cost (issue #401)', async (t) => {
  const { researchTopic } = await modules(t);

  for (const totalCostUsd of [undefined, 0, NaN, 'not-a-number']) {
    recordCalls = [];
    recordShouldReject = false;
    nextResult = {
      result: '- a sourced briefing bullet',
      totalCostUsd,
      structuredOutput: { hasUpdate: true, briefing: '- a sourced briefing bullet' },
    };
    await researchTopic('some fixed topic query');
    assert.deepEqual(recordCalls, [], `no row recorded for total_cost_usd = ${String(totalCostUsd)}`);
  }
});

test('SECURITY: researchTopic still returns its normal result when recordBackgroundJobCost rejects (issue #401)', async (t) => {
  const { researchTopic } = await modules(t);
  recordCalls = [];
  recordShouldReject = true;
  nextResult = {
    result: '- a sourced briefing bullet',
    totalCostUsd: 0.2,
    structuredOutput: { hasUpdate: true, briefing: '- a sourced briefing bullet' },
  };

  const briefing = await researchTopic('some fixed topic query');

  assert.equal(
    briefing,
    '- a sourced briefing bullet',
    'research result is unaffected by a failed cost-recording insert',
  );
});
