import { z } from 'zod';
import { normalizedEnv } from './env.js';
import { dbSlice, dbSection } from './db.js';
import { logSlice, logSection } from './log.js';

/**
 * Boot-path config: ONLY the db + log slices, validated on their own so the
 * storage/logging spine (logger.ts, storage/db.ts, storage/migrate.ts) can
 * run with nothing but DATABASE_URL (+ optional LOG_*) set. Before this
 * existed, `npm run migrate` transitively imported the FULL schema and
 * exited(1) on missing CLAUDE_CODE_OAUTH_TOKEN/DISCORD_BOT_TOKEN/
 * DISCORD_GUILD_ID — vars migrate never uses — which is what forced the
 * `migrate:ci` dummy-token wrapper. The key shapes are EXACTLY
 * `config.db`/`config.log` because both are composed by the same
 * `dbSection`/`logSection` helpers the barrel uses.
 */
const BootEnvSchema = z.object({ ...dbSlice, ...logSlice });

const parsed = BootEnvSchema.safeParse(normalizedEnv);
if (!parsed.success) {
  // Same fail-fast UX as the full barrel (../config.ts), scoped to the boot
  // slices' own issues.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const bootConfig = {
  db: dbSection(parsed.data),
  log: logSection(parsed.data),
} as const;
