import { z } from 'zod';

/**
 * Database slice: parsed by both the boot path (src/config/boot.ts, so
 * storage/db.ts and storage/migrate.ts can run without the full schema's
 * unrelated required vars) and the composition barrel (src/config.ts).
 * `dbSection` is the single source of the `config.db` key shape, so the two
 * parses can never drift apart.
 */
export const dbSlice = {
  // Database
  DATABASE_URL: z.string().min(1),
  EMBEDDING_MODEL: z.string().default('Xenova/all-MiniLM-L6-v2'),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(384),
  // Pool-level query/connection bounds (issue #502): `pg`'s own default for
  // all three is "wait forever," so a stuck lock wait, stalled network
  // round-trip, or slow autovacuum on the single shared `pool` (every hot
  // path, including /healthz's own `healthcheck()`) can wedge every
  // connection with no ceiling. On by default (not opt-in) — these are pure
  // safety hardening with no happy-path behaviour change, sized well above
  // any legitimate query this codebase runs. STATEMENT_TIMEOUT is enforced
  // server-side (a session parameter Postgres itself cancels the query on);
  // QUERY_TIMEOUT is the client-side mirror (bounds an in-flight query even
  // if the server-side timer never starts, e.g. a stalled network
  // round-trip); CONNECT_TIMEOUT bounds how long a caller waits to
  // acquire/establish a connection before failing instead of queuing
  // forever. A timeout firing surfaces as an ordinary rejection through the
  // exact same #52 degrade-gracefully `.catch()` paths already in
  // storage/repository.ts — this doesn't touch that logic, it just makes
  // sure a hang eventually becomes the rejection that logic already
  // handles.
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
};

export type DbEnv = z.infer<z.ZodObject<typeof dbSlice>>;

/** Compose the `config.db` section from a parsed environment. */
export function dbSection(env: DbEnv) {
  return {
    url: env.DATABASE_URL,
    embeddingModel: env.EMBEDDING_MODEL,
    embeddingDim: env.EMBEDDING_DIM,
    statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    queryTimeoutMs: env.DB_QUERY_TIMEOUT_MS,
    connectTimeoutMs: env.DB_CONNECT_TIMEOUT_MS,
  } as const;
}
