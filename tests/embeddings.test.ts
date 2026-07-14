import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. This file mocks
// @huggingface/transformers itself (via node:test's module mocking) so it
// never downloads or runs the real model — it pins issue #376's wedge fix:
// a rejected model load must not permanently cache that rejection.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { config } = await import('../src/config.js');

test('embed(): a rejected model load does not wedge getExtractor forever — the NEXT call retries pipeline() instead of replaying the cached rejection (issue #376)', async (t) => {
  let pipelineCalls = 0;
  let shouldFail = true;

  t.mock.module('@huggingface/transformers', {
    namedExports: {
      env: {},
      pipeline: async (..._args: unknown[]) => {
        pipelineCalls++;
        if (shouldFail) throw new Error('sentinel-model-load-failure');
        return async (_text: string, _opts: unknown) => ({
          data: new Float32Array(config.db.embeddingDim),
          tolist: () => [[]],
        });
      },
    },
  });

  const { embed } = await import('../src/storage/embeddings.js');

  await assert.rejects(() => embed('first call'), /sentinel-model-load-failure/);
  assert.equal(pipelineCalls, 1, 'the first call attempts the model load exactly once');

  shouldFail = false;
  const vec = await embed('second call');
  assert.equal(
    pipelineCalls,
    2,
    'the second call retries pipeline() from scratch instead of replaying the cached rejection',
  );
  assert.equal(vec.length, config.db.embeddingDim);
});
