import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { closeDb, pool } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Apply schema.sql. Idempotent — every statement uses IF NOT EXISTS.
 * The embedding dimension is injected from config so the vector columns
 * always match the configured model.
 */
export async function migrate(): Promise<void> {
  const schemaPath = join(__dirname, 'schema.sql');
  const raw = await readFile(schemaPath, 'utf8');
  const sql = raw.replaceAll(':EMBEDDING_DIM', String(config.db.embeddingDim));

  logger.info({ embeddingDim: config.db.embeddingDim }, 'Applying database schema');
  await pool.query(sql);
  logger.info('Database schema applied');
}

// Allow running directly: `npm run migrate`
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  migrate()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}
