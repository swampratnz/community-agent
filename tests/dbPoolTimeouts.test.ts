import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. hasDb must be read BEFORE the
// DATABASE_URL fallback below, same as tests/repository.test.ts.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
// Short bounds (distinct from config.test.ts's default-value assertions) so
// the pg_sleep-based tests below stay fast rather than waiting out the real
// 15s production default.
process.env.DB_STATEMENT_TIMEOUT_MS ??= '1000';
process.env.DB_QUERY_TIMEOUT_MS ??= '1000';
process.env.DB_CONNECT_TIMEOUT_MS ??= '2000';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');

after(async () => {
  await closeDb();
});

test('db: pool is constructed with statement_timeout, query_timeout, and connectionTimeoutMillis sourced from config, not literals (issue #502)', () => {
  assert.equal(pool.options.statement_timeout, config.db.statementTimeoutMs);
  assert.equal(pool.options.query_timeout, config.db.queryTimeoutMs);
  assert.equal(pool.options.connectionTimeoutMillis, config.db.connectTimeoutMs);
});

test(
  'db: a query beyond DB_STATEMENT_TIMEOUT_MS is cancelled and rejects within a bounded time rather than hanging (issue #502)',
  { skip },
  async () => {
    const start = Date.now();
    await assert.rejects(() => pool.query('SELECT pg_sleep(5)'));
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 4_000,
      `expected the query to be cancelled well under the 5s pg_sleep, took ${elapsed}ms`,
    );
  },
);

test(
  '/healthz and /readyz respond 503 with db:false within a bounded time when healthcheck() hangs on a slow query, instead of hanging themselves (issue #502)',
  { skip },
  async (t) => {
    const realDb = await import('../src/storage/db.js');
    t.mock.module('../src/storage/db.js', {
      namedExports: {
        ...realDb,
        // Same slow-query scenario as the pool-level test above, routed
        // through healthcheck() so /healthz and /readyz — which run on this
        // exact call — inherit the same bound instead of hanging forever.
        healthcheck: async () => {
          await realDb.pool.query('SELECT pg_sleep(5)');
        },
      },
    });
    const { handleHealthz, handleReadyz } = await import('../src/health.js');

    function fakeResponse() {
      let statusCode: number | undefined;
      let body = '';
      const res = {
        writeHead(status: number) {
          statusCode = status;
          return res;
        },
        end(chunk?: string) {
          if (chunk) body = chunk;
        },
      };
      return {
        res: res as unknown as ServerResponse,
        status: () => statusCode,
        json: () => JSON.parse(body) as { status: string; db: boolean },
      };
    }

    const healthz = fakeResponse();
    let start = Date.now();
    await handleHealthz([], healthz.res);
    let elapsed = Date.now() - start;
    assert.ok(elapsed < 4_000, `handleHealthz must not hang on a slow query, took ${elapsed}ms`);
    assert.equal(healthz.status(), 503);
    assert.equal(healthz.json().db, false);

    const readyz = fakeResponse();
    start = Date.now();
    await handleReadyz(readyz.res);
    elapsed = Date.now() - start;
    assert.ok(elapsed < 4_000, `handleReadyz must not hang on a slow query, took ${elapsed}ms`);
    assert.equal(readyz.status(), 503);
    assert.equal(readyz.json().db, false);
  },
);
