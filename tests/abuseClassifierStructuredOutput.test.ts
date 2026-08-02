import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/strings/notices.js';

// Issue #720: classifyAbuseWithLlm used to parse the model's raw text with
// /^\s*ABUSE:\s*(.+)$/im and silently return null (== "clean") on ANY
// non-conforming shape — a preamble, a refusal, reformatted commentary. It
// now reads the SDK's schema-constrained `structured_output` instead. This
// file pins both directions of that fix: a messy-but-decisive verdict is no
// longer lost, and a missing/malformed structured_output throws rather than
// silently degrading to clean.
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
let nextResult: MockResultMessage = { result: 'CLEAN', structuredOutput: { verdict: 'CLEAN' } };
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

// query() is a static import inside moderator.ts, so once the module has been
// imported anywhere in this process the binding is fixed (same trap as
// tests/classifierModelTiering.test.ts) — install the mock once and reuse the
// cached import across every test in this file.
let modulesPromise: Promise<{
  classifyAbuseWithLlm: typeof import('../src/moderation/moderator.js').classifyAbuseWithLlm;
  makeClassifier: typeof import('../src/moderation/moderator.js').makeClassifier;
}> | null = null;
async function modules(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!modulesPromise) {
    const real = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...real, query: mockQuery } });
    modulesPromise = import('../src/moderation/moderator.js').then((moderator) => ({
      classifyAbuseWithLlm: moderator.classifyAbuseWithLlm,
      makeClassifier: moderator.makeClassifier,
    }));
  }
  return modulesPromise;
}

test('classifyAbuseWithLlm: a structured ABUSE verdict is decisive even when the raw prose would have failed the old ABUSE: regex (issue #720)', async (t) => {
  const { classifyAbuseWithLlm } = await modules(t);
  nextResult = {
    // A preamble + reformatted line — this would NOT match
    // /^\s*ABUSE:\s*(.+)$/im and used to silently return null.
    result: "I'll evaluate this message.\nVerdict: abusive, targeted insult toward another member.",
    structuredOutput: { verdict: 'ABUSE', reason: 'targeted insult' },
  };

  const detection = await classifyAbuseWithLlm('you are worthless and everyone hates you');

  assert.ok(detection, 'a messy-but-decisive ABUSE verdict must not be dropped to null');
  assert.match(detection.reason, /abuse/);
  assert.match(detection.reason, /targeted insult/);
});

test('classifyAbuseWithLlm: a structured CLEAN verdict returns null, identical to today (issue #720)', async (t) => {
  const { classifyAbuseWithLlm } = await modules(t);
  nextResult = { result: 'CLEAN', structuredOutput: { verdict: 'CLEAN' } };

  const detection = await classifyAbuseWithLlm('just disagreeing about tabs vs spaces');

  assert.equal(detection, null);
});

test('SECURITY: classifyAbuseWithLlm throws when structured_output is absent, never returns null (issue #720)', async (t) => {
  const { classifyAbuseWithLlm } = await modules(t);
  nextResult = { result: 'CLEAN', omitStructuredOutput: true };

  await assert.rejects(classifyAbuseWithLlm('some message'));
});

test('SECURITY: classifyAbuseWithLlm throws when structured_output is null, never returns null (issue #720)', async (t) => {
  const { classifyAbuseWithLlm } = await modules(t);
  nextResult = { result: 'CLEAN', structuredOutput: null };

  await assert.rejects(classifyAbuseWithLlm('some message'));
});

test('SECURITY: classifyAbuseWithLlm throws when structured_output.verdict is missing or an unknown enum value, never returns null (issue #720)', async (t) => {
  const { classifyAbuseWithLlm } = await modules(t);

  nextResult = { result: 'CLEAN', structuredOutput: { reason: 'no verdict field' } };
  await assert.rejects(classifyAbuseWithLlm('some message'));

  nextResult = { result: 'CLEAN', structuredOutput: { verdict: 'MAYBE' } };
  await assert.rejects(classifyAbuseWithLlm('some message'));
});

test('SECURITY: a classifyAbuseWithLlm throw (malformed structured_output) propagates uncached through makeClassifier — the next identical message re-invokes the LLM (issue #720)', async (t) => {
  const { makeClassifier } = await modules(t);
  const classify = makeClassifier({ badWords: [], llmAbuseEnabled: true });
  const scope = { platform: 'discord' as const, channelId: 'c1' };

  queryCallCount = 0;
  nextResult = { result: 'CLEAN', omitStructuredOutput: true };
  await assert.rejects(classify('some subtle harassment the wordlist misses', scope));
  assert.equal(queryCallCount, 1);

  nextResult = { result: 'CLEAN', structuredOutput: { verdict: 'CLEAN' } };
  await classify('some subtle harassment the wordlist misses', scope);
  assert.equal(queryCallCount, 2, 'the thrown call must not have been cached — a fresh call was made');
});
