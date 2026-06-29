import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Local text embeddings via transformers.js (no external API, no extra key —
 * fits the subscription-only auth model). The model is downloaded once to a
 * local cache on first use. Default: Xenova/all-MiniLM-L6-v2 (384 dims).
 */

// transformers.js is ESM and heavy; load lazily so migrations/CLIs that don't
// need embeddings don't pay the import cost.
type FeatureExtractor = (
  text: string | string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; tolist: () => number[][] }>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Keep everything local/offline-friendly after first download.
      env.allowLocalModels = true;
      logger.info({ model: config.db.embeddingModel }, 'Loading embedding model');
      const pipe = (await pipeline('feature-extraction', config.db.embeddingModel)) as unknown as FeatureExtractor;
      logger.info('Embedding model ready');
      return pipe;
    })();
  }
  return extractorPromise;
}

/** Embed a single string into a fixed-length, L2-normalised vector. */
export async function embed(text: string): Promise<number[]> {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 4000);
  if (!clean) return new Array(config.db.embeddingDim).fill(0);
  const extractor = await getExtractor();
  const output = await extractor(clean, { pooling: 'mean', normalize: true });
  const vec = Array.from(output.data as ArrayLike<number>);
  if (vec.length !== config.db.embeddingDim) {
    logger.warn(
      { got: vec.length, expected: config.db.embeddingDim },
      'Embedding dimension mismatch — check EMBEDDING_DIM matches EMBEDDING_MODEL',
    );
  }
  return vec;
}
