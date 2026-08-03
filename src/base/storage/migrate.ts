import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootConfig } from '../config/boot.js';
import { logger } from '../logger.js';
import { closeDb, pool } from './db.js';
import { loadSchemaSql } from './schema/manifest.js';

/**
 * Apply the schema (src/storage/schema/ fragments, concatenated in manifest
 * order). Idempotent — every statement uses IF NOT EXISTS. The embedding
 * dimension is injected from config so the vector columns always match the
 * configured model. Still ONE pool.query: the single multi-statement query is
 * what rolls the whole migration back on any failure.
 */
export async function migrate(): Promise<void> {
  const raw = await loadSchemaSql();
  const sql = raw.replaceAll(':EMBEDDING_DIM', String(bootConfig.db.embeddingDim));

  logger.info({ embeddingDim: bootConfig.db.embeddingDim }, 'Applying database schema');
  await pool.query(sql);
  logger.info('Database schema applied');
}

// Allow running directly: `npm run migrate` (tsx) or `npm run migrate:prod` (node dist).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  migrate()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}
