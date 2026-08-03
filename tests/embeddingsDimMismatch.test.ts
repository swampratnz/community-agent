import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it, matching the convention in
// tests/embeddings.test.ts. This file's whole point is the wrong-width model
// path (audit 2026-07-28 N5), so it lives in its own process with a single
// clean @huggingface/transformers mock and a single import of embeddings.js —
// mocking a module twice within one process can't retarget an already-closed
// binding (see the trap documented in tests/embeddingHealthCheck.test.ts).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { config } = await import('../src/base/config.js');

test('embed(): a model whose output width != EMBEDDING_DIM throws instead of returning a wrong-length vector (audit 2026-07-28 N5)', async (t) => {
  // A model that produces the WRONG number of dims — the config/model drift
  // class. The old warn-and-return-anyway path let this pass startup's column
  // check AND the #376 embedding-health job (which just calls embed() and saw
  // it succeed), then silently degraded every memory recall / knowledge search
  // to [] via their SQL catch. Throwing makes the health check trip on exactly
  // this outage.
  t.mock.module('@huggingface/transformers', {
    namedExports: {
      env: {},
      pipeline:
        async (..._args: unknown[]) =>
        async (_text: string, _opts: unknown) => ({
          data: new Float32Array(config.db.embeddingDim + 1),
          tolist: () => [[]],
        }),
    },
  });

  const { embed } = await import('../src/base/storage/embeddings.js');

  await assert.rejects(
    () => embed('some content'),
    /dimension mismatch/i,
    'a wrong-width model output must reject, not resolve to a mis-sized vector',
  );

  // The empty-input fast path never reaches the model, so it still returns the
  // correctly-sized zero vector rather than throwing.
  const zero = await embed('   ');
  assert.equal(zero.length, config.db.embeddingDim);
  assert.ok(
    zero.every((x) => x === 0),
    'blank input returns a config-width zero vector without invoking the model',
  );
});
