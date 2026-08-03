import pg from 'pg';
import pgvector from 'pgvector/pg';
import { bootConfig } from '../config/boot.js';
import { logger } from '../logger.js';

const { Pool } = pg;

// Reads the BOOT config slice (db+log only), not the full barrel, so the
// storage spine (this file, migrate.ts) never demands the app-level required
// vars (CLAUDE_CODE_OAUTH_TOKEN/DISCORD_*) migrate has no use for.
export const pool = new Pool({
  connectionString: bootConfig.db.url,
  max: 10,
  idleTimeoutMillis: 30_000,
  // Bound every query/connection on the pool (issue #502) so a stuck lock
  // wait, stalled network round-trip, or slow autovacuum can't wedge every
  // connection forever — see config.ts for the rationale behind each knob.
  statement_timeout: bootConfig.db.statementTimeoutMs,
  query_timeout: bootConfig.db.queryTimeoutMs,
  connectionTimeoutMillis: bootConfig.db.connectTimeoutMs,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected idle Postgres client error');
});

/**
 * Register the pgvector type parser on every new connection so `vector`
 * columns round-trip as JS number arrays.
 */
pool.on('connect', (client) => {
  pgvector
    .registerTypes(client)
    .catch((err: unknown) => logger.error({ err }, 'Failed to register pgvector types'));
});

export async function healthcheck(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
