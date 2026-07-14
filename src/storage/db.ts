import pg from 'pg';
import pgvector from 'pgvector/pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.db.url,
  max: 10,
  idleTimeoutMillis: 30_000,
  // Bound every query/connection on the pool (issue #502) so a stuck lock
  // wait, stalled network round-trip, or slow autovacuum can't wedge every
  // connection forever — see config.ts for the rationale behind each knob.
  statement_timeout: config.db.statementTimeoutMs,
  query_timeout: config.db.queryTimeoutMs,
  connectionTimeoutMillis: config.db.connectTimeoutMs,
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
