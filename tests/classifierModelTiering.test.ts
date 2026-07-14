import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentCoreMaxTurns.test.ts. AGENT_MODEL_CLASSIFIER is
// deliberately left unset here (the default/opt-out baseline) — the "set"
// scenario lives in tests/classifierModelTieringSet.test.ts because config.js
// resolves env once, at import time, so the two scenarios need separate
// processes (same reasoning as agentOptions.test.ts vs agentModelTiering.test.ts).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

let capturedOptions: Record<string, unknown> | null = null;

function mockQuery() {
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

function trackingMockQuery(args: { prompt: string; options: Record<string, unknown> }) {
  capturedOptions = args.options;
  return mockQuery();
}

// query() is a static import inside both src/moderation/moderator.ts and
// src/context/builder.ts, so once either module has been imported anywhere in
// this process the binding is fixed — a later t.mock.module call can't
// retarget it (see tests/agentCoreMaxTurns.test.ts for the same trap).
// Install the mock once and reuse the cached imports.
let modulesPromise: Promise<{
  classifyAbuseWithLlm: typeof import('../src/moderation/moderator.js').classifyAbuseWithLlm;
  summarizeCluster: typeof import('../src/context/builder.js').summarizeCluster;
}> | null = null;
async function modules(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!modulesPromise) {
    const real = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...real, query: trackingMockQuery } });
    modulesPromise = Promise.all([
      import('../src/moderation/moderator.js'),
      import('../src/context/builder.js'),
    ]).then(([moderator, builder]) => ({
      classifyAbuseWithLlm: moderator.classifyAbuseWithLlm,
      summarizeCluster: builder.summarizeCluster,
    }));
  }
  return modulesPromise;
}

test('classifyAbuseWithLlm: AGENT_MODEL_CLASSIFIER unset ⇒ options.model === config.llm.model (issue #394)', async (t) => {
  const { config } = await import('../src/config.js');
  const { classifyAbuseWithLlm } = await modules(t);
  await classifyAbuseWithLlm('some test message');
  assert.equal(capturedOptions?.model, config.llm.model);
});

test('summarizeCluster: AGENT_MODEL_CLASSIFIER unset ⇒ options.model === config.llm.model (issue #394)', async (t) => {
  const { config } = await import('../src/config.js');
  const { summarizeCluster } = await modules(t);
  await summarizeCluster(['a recurring sample message']);
  assert.equal(capturedOptions?.model, config.llm.model);
});
