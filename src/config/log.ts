import { z } from 'zod';

/**
 * Logging slice: parsed by both the boot path (src/config/boot.ts, so the
 * logger can exist before the full schema is validated) and the composition
 * barrel (src/config.ts). `logSection` is the single source of the
 * `config.log` key shape, so the two parses can never drift apart.
 */
export const logSlice = {
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
  LOG_PRETTY: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
};

export type LogEnv = z.infer<z.ZodObject<typeof logSlice>>;

/** Compose the `config.log` section from a parsed environment. */
export function logSection(env: LogEnv) {
  return {
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY ?? false,
  } as const;
}
