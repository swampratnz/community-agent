import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Configure the process environment so the Claude Agent SDK authenticates
 * using the Claude *subscription* (OAuth token from `claude setup-token`)
 * rather than a pay-as-you-go API key.
 *
 * The SDK spawns the Claude Code binary, which reads CLAUDE_CODE_OAUTH_TOKEN
 * from the environment. We also clear ANTHROPIC_API_KEY so a stray key can't
 * silently switch billing to the metered API.
 */
export function configureSubscriptionAuth(): void {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = config.llm.oauthToken;

  if (process.env.ANTHROPIC_API_KEY) {
    logger.warn(
      'ANTHROPIC_API_KEY is set but subscription-only auth is configured; clearing it for this process.',
    );
    delete process.env.ANTHROPIC_API_KEY;
  }
  logger.info('Claude subscription auth configured (CLAUDE_CODE_OAUTH_TOKEN).');
}
