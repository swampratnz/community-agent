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
