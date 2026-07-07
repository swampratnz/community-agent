import { createHash } from 'node:crypto';
import { pino } from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.log.level,
  redact: {
    // Never let secrets leak into logs.
    paths: [
      'token',
      '*.token',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'DISCORD_BOT_TOKEN',
      'accessToken',
      '*.accessToken',
      'password',
      '*.password',
    ],
    censor: '[redacted]',
  },
  ...(config.log.pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {}),
});

export type Logger = typeof logger;

/**
 * Stable, non-reversible short token for a user/conversation identifier, for
 * usage/telemetry logs (issue #219). Raw platform ids are PII — a WhatsApp
 * conversation id IS the member's phone-number JID, and Discord ids are
 * durable account handles — so logging them at info level to measure adoption
 * leaks who is talking to the bot into whatever ships the logs. Hashing keeps
 * the counter usable (the same person maps to the same token, so per-user
 * volume is still visible) without persisting the identity. Not for security
 * decisions — purely a log-privacy hedge. `null`/`undefined` -> `'none'`.
 */
export function hashId(id: string | null | undefined): string {
  if (!id) return 'none';
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}
