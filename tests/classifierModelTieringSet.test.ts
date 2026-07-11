import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentModelTiering.test.ts. AGENT_MODEL_CLASSIFIER must
// be set BEFORE config.js is first imported in this process (it resolves
// once, at import time), so this scenario needs its own file rather than
// reusing tests/classifierModelTiering.test.ts (which asserts the
// unset/default baseline).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.AGENT_MODEL_CLASSIFIER = 'claude-haiku-4-5-20251001';

let capturedOptions: Record<string, unknown> | null = null;

function mockQuery(args: { prompt: string; options: Record<string, unknown> }) {
  capturedOptions = args.options;
  return (async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      result: 'CLEAN',
      session_id: 'sess-1',
      total_cost_usd: 0,
    };
  })();
}

// Same trap as tests/classifierModelTiering.test.ts: query() is a static
// import in both moderator.ts and builder.ts, so the mock must be installed
// before either module is first imported in this process.
let modulesPromise: Promise<{
  classifyAbuseWithLlm: typeof import('../src/moderation/moderator.js').classifyAbuseWithLlm;
  summarizeCluster: typeof import('../src/context/builder.js').summarizeCluster;
  config: typeof import('../src/config.js').config;
}> | null = null;
async function modules(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!modulesPromise) {
    const real = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...real, query: mockQuery } });
    modulesPromise = Promise.all([
      import('../src/moderation/moderator.js'),
      import('../src/context/builder.js'),
      import('../src/config.js'),
    ]).then(([moderator, builder, cfg]) => ({
      classifyAbuseWithLlm: moderator.classifyAbuseWithLlm,
      summarizeCluster: builder.summarizeCluster,
      config: cfg.config,
    }));
  }
  return modulesPromise;
}

test('config: AGENT_MODEL_CLASSIFIER set resolves to config.llm.classifierModel (issue #394)', async (t) => {
  const { config } = await modules(t);
  assert.equal(config.llm.classifierModel, 'claude-haiku-4-5-20251001');
  assert.notEqual(
    config.llm.classifierModel,
    config.llm.model,
    'fixture must use a value distinct from AGENT_MODEL for the assertions below to be meaningful',
  );
});

test('classifyAbuseWithLlm: AGENT_MODEL_CLASSIFIER set ⇒ options.model resolves to it (issue #394)', async (t) => {
  const { classifyAbuseWithLlm, config } = await modules(t);
  await classifyAbuseWithLlm('some test message');
  assert.equal(capturedOptions?.model, config.llm.classifierModel);
});

test('summarizeCluster: AGENT_MODEL_CLASSIFIER set ⇒ options.model resolves to it (issue #394)', async (t) => {
  const { summarizeCluster, config } = await modules(t);
  await summarizeCluster(['a recurring sample message']);
  assert.equal(capturedOptions?.model, config.llm.classifierModel);
});

test("SECURITY: AGENT_MODEL_CLASSIFIER set ⇒ tools/allowedTools/disallowedTools/maxTurns are byte-for-byte identical to the unset baseline for both call sites (issue #394, mirrors #382's own tiering-vs-gating regression test)", async (t) => {
  const { classifyAbuseWithLlm, summarizeCluster } = await modules(t);

  await classifyAbuseWithLlm('some test message');
  assert.deepEqual(capturedOptions?.tools, []);
  assert.deepEqual(capturedOptions?.allowedTools, []);
  assert.deepEqual(capturedOptions?.disallowedTools, ['Task', 'WebFetch', 'WebSearch']);
  assert.equal(capturedOptions?.maxTurns, 1);

  await summarizeCluster(['a recurring sample message']);
  assert.deepEqual(capturedOptions?.tools, []);
  assert.deepEqual(capturedOptions?.allowedTools, []);
  assert.deepEqual(capturedOptions?.disallowedTools, ['Task', 'WebFetch', 'WebSearch']);
  assert.equal(capturedOptions?.maxTurns, 1);
});
