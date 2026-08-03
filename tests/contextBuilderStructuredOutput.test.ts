import { test } from 'node:test';
import assert from 'node:assert/strict';

// Issue #831: summarizeCluster used to parse the model's raw text with five
// regexes (TOPIC:/SUMMARY:/CANDIDATE:/CANDIDATE_TITLE:/CANDIDATE_ANSWER:) and
// silently default on ANY non-conforming shape — a preamble, a reformat, a
// refusal — to `{ topic: 'Community discussion', summary: <raw slice> }` with
// no error and no distinguishing log line, and dropped a genuine candidate
// with no signal at all. It now reads the SDK's schema-constrained
// `structured_output` instead (mirroring #720's classifyAbuseWithLlm fix).
// This file pins both directions: a well-formed structured_output still
// yields today's shape, and a missing/malformed one throws rather than
// silently degrading to a defaulted digest.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

type MockResultMessage = {
  result?: string;
  structuredOutput?: unknown;
  omitStructuredOutput?: boolean;
};
let nextResult: MockResultMessage = {
  result: 'ok',
  structuredOutput: { topic: 'General chat', summary: 'People chatted.', isCandidate: false },
};
let queryCallCount = 0;

function mockQuery() {
  queryCallCount++;
  return (async function* () {
    const msg: Record<string, unknown> = {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      total_cost_usd: 0,
    };
    if (nextResult.result !== undefined) msg.result = nextResult.result;
    if (!nextResult.omitStructuredOutput) msg.structured_output = nextResult.structuredOutput;
    yield msg;
  })();
}

// query() is a static import inside builder.ts, so once the module has been
// imported anywhere in this process the binding is fixed (same trap as
// tests/abuseClassifierStructuredOutput.test.ts) — install the mock once and
// reuse the cached import across every test in this file.
let modulesPromise: Promise<{
  summarizeCluster: typeof import('../src/module/context/builder.js').summarizeCluster;
}> | null = null;
async function modules(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!modulesPromise) {
    const real = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...real, query: mockQuery } });
    modulesPromise = import('../src/module/context/builder.js').then((builder) => ({
      summarizeCluster: builder.summarizeCluster,
    }));
  }
  return modulesPromise;
}

test('summarizeCluster: a well-formed structured_output yields the same shape as today, truncated to the same caps (issue #831)', async (t) => {
  const { summarizeCluster } = await modules(t);
  nextResult = {
    result: 'ok',
    structuredOutput: {
      topic: 'a'.repeat(130),
      summary: 'b'.repeat(1010),
      isCandidate: true,
      candidateTitle: 'c'.repeat(130),
      candidateAnswer: 'd'.repeat(1010),
    },
  };

  const { topic, summary, candidate } = await summarizeCluster(['sample message']);

  assert.equal(topic, 'a'.repeat(120));
  assert.equal(summary, 'b'.repeat(1000));
  assert.ok(candidate);
  assert.equal(candidate?.title, 'c'.repeat(120));
  assert.equal(candidate?.content, 'd'.repeat(1000));
});

test('summarizeCluster: isCandidate false yields candidate: null, matching today\'s "not a candidate" behaviour (issue #831)', async (t) => {
  const { summarizeCluster } = await modules(t);
  nextResult = {
    result: 'ok',
    structuredOutput: { topic: 'Weather chat', summary: 'People discussed the weather.', isCandidate: false },
  };

  const { candidate } = await summarizeCluster(['sample message']);

  assert.equal(candidate, null);
});

test('SECURITY: summarizeCluster throws when structured_output is absent, never returns a defaulted digest (issue #831)', async (t) => {
  const { summarizeCluster } = await modules(t);
  nextResult = { result: 'ok', omitStructuredOutput: true };

  await assert.rejects(summarizeCluster(['sample message']));
});

test('SECURITY: summarizeCluster throws when structured_output is missing topic/summary/isCandidate, never defaults to "Community discussion" (issue #831)', async (t) => {
  const { summarizeCluster } = await modules(t);

  nextResult = { result: 'ok', structuredOutput: { summary: 'x', isCandidate: false } };
  await assert.rejects(summarizeCluster(['sample message']), /topic/);

  nextResult = { result: 'ok', structuredOutput: { topic: 'x', isCandidate: false } };
  await assert.rejects(summarizeCluster(['sample message']), /summary/);

  nextResult = { result: 'ok', structuredOutput: { topic: 'x', summary: 'y', isCandidate: 'yes' } };
  await assert.rejects(summarizeCluster(['sample message']), /isCandidate/);
});

test('SECURITY: a candidate is only constructed when isCandidate is true, never inferred from a coincidentally-present candidateTitle/candidateAnswer (issue #831)', async (t) => {
  const { summarizeCluster } = await modules(t);
  nextResult = {
    result: 'ok',
    structuredOutput: {
      topic: 'Off-topic banter',
      summary: 'Members chatted casually.',
      isCandidate: false,
      candidateTitle: 'How do I reset my password?',
      candidateAnswer: 'Use the /reset command.',
    },
  };

  const { candidate } = await summarizeCluster(['sample message']);

  assert.equal(candidate, null, 'isCandidate: false must win even when title/answer fields are present');
});
