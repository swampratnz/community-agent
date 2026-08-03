import { closeDb } from '@swampratnz/agent-base/storage/db.js';
import { logger } from '@swampratnz/agent-base/logger.js';
import { migrate } from '@swampratnz/agent-base/storage/migrate.js';
import { COMMUNITY_MIGRATIONS } from './module/storage/schema/manifest.js';

/**
 * `npm run migrate` — apply the schema: agent-base's fragments first, then
 * this module's, as ONE atomic multi-statement query (storage/migrate.ts).
 *
 * This file exists because the package's own `migrate` entry point knows
 * nothing about a consumer's fragments; running it directly would apply the
 * base schema and silently skip `src/module/storage/schema/`. In the running
 * process `createAgent().start()` does the same concatenation.
 *
 * Deliberately imports NOTHING but the storage slice and this module's SQL —
 * no `config.js`, no tool registry, no manifest. The boot config validates
 * only db+log (agent-base's `config/boot.ts`), which is what lets a bare
 * `npm run migrate` run with just `DATABASE_URL` set — a property the
 * pipeline's conflict-resolver loop depends on (see CLAUDE.md).
 */
migrate(COMMUNITY_MIGRATIONS)
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'Migration failed');
    process.exit(1);
  });
