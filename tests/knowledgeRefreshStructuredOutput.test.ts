import { test } from 'node:test';
import assert from 'node:assert/strict';

// Issue #835: researchTopic used to parse the model's raw text, treating any
// non-empty response that didn't start a line with the literal marker
// NO_UPDATE as a valid briefing — a preamble, a refusal, or a reformatted
// answer would silently get written into the knowledge base. It now reads the
// SDK's schema-constrained `structured_output` instead, mirroring #720's fix
// for the abuse classifier. This file pins both directions of that fix: a
// well-formed update is read decisively, and a missing/malformed
// structured_output (or a hasUpdate:true with no briefing) throws rather than
// silently publishing raw/malformed text.
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
let nextResult: MockResultMessage = { result: 'ok', structuredOutput: { hasUpdate: false } };

function mockQuery() {
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

// query() is a static import inside knowledgeRefresh.ts, so once the module
// has been imported anywhere in this process the binding is fixed (same trap
// as tests/abuseClassifierStructuredOutput.test.ts) — install the mock once
// and reuse the cached import across every test in this file.
let modulesPromise: Promise<{
  researchTopic: typeof import('../src/context/knowledgeRefresh.js').researchTopic;
  parseResearchResult: typeof import('../src/context/knowledgeRefresh.js').parseResearchResult;
}> | null = null;
async function modules(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!modulesPromise) {
    const real = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...real, query: mockQuery } });
    modulesPromise = import('../src/context/knowledgeRefresh.js').then((mod) => ({
      researchTopic: mod.researchTopic,
      parseResearchResult: mod.parseResearchResult,
    }));
  }
  return modulesPromise;
}

test('researchTopic: a well-formed hasUpdate:true briefing is returned truncated at 4000 chars, identical to today (issue #835)', async (t) => {
  const { researchTopic } = await modules(t);
  nextResult = {
    result: 'irrelevant free text',
    structuredOutput: { hasUpdate: true, briefing: 'x'.repeat(5000) },
  };

  const briefing = await researchTopic('some topic');

  assert.ok(briefing);
  assert.equal(briefing.length, 4000, 'still truncated at 4000 chars');
});

test("researchTopic: hasUpdate:false returns null, identical to today's NO_UPDATE behaviour (issue #835)", async (t) => {
  const { researchTopic } = await modules(t);
  nextResult = { result: 'ok', structuredOutput: { hasUpdate: false } };

  const briefing = await researchTopic('some topic');

  assert.equal(briefing, null);
});

test('SECURITY: researchTopic throws when structured_output is absent, never returns raw text as a briefing (issue #835)', async (t) => {
  const { researchTopic } = await modules(t);
  nextResult = {
    result: 'some free-text preamble the old regex would have mishandled',
    omitStructuredOutput: true,
  };

  await assert.rejects(researchTopic('some topic'));
});

test('SECURITY: researchTopic throws when structured_output.hasUpdate is missing or not a boolean (issue #835)', async (t) => {
  const { researchTopic } = await modules(t);

  nextResult = { result: 'ok', structuredOutput: { briefing: 'no hasUpdate field' } };
  await assert.rejects(researchTopic('some topic'));

  nextResult = { result: 'ok', structuredOutput: { hasUpdate: 'yes' } };
  await assert.rejects(researchTopic('some topic'));
});

test('SECURITY: researchTopic throws when hasUpdate:true but briefing is missing or empty (issue #835)', async (t) => {
  const { researchTopic } = await modules(t);

  nextResult = { result: 'ok', structuredOutput: { hasUpdate: true } };
  await assert.rejects(researchTopic('some topic'));

  nextResult = { result: 'ok', structuredOutput: { hasUpdate: true, briefing: '   ' } };
  await assert.rejects(researchTopic('some topic'));
});

test('SECURITY: hasUpdate:false gates publication regardless of a coincidentally-present, non-empty briefing (issue #835)', async (t) => {
  const { researchTopic } = await modules(t);
  nextResult = {
    result: 'ok',
    structuredOutput: { hasUpdate: false, briefing: 'this text must never be read' },
  };

  const briefing = await researchTopic('some topic');

  assert.equal(briefing, null, 'briefing content is never read when hasUpdate is false');
});

test('parseResearchResult: narrows a well-formed payload and throws on malformed shapes (issue #835)', async (t) => {
  const { parseResearchResult } = await modules(t);

  assert.deepEqual(parseResearchResult({ hasUpdate: true, briefing: 'hi' }), {
    hasUpdate: true,
    briefing: 'hi',
  });
  assert.deepEqual(parseResearchResult({ hasUpdate: false }), { hasUpdate: false });
  assert.throws(() => parseResearchResult(null));
  assert.throws(() => parseResearchResult('not an object'));
  assert.throws(() => parseResearchResult({ hasUpdate: true }));
});
