import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. A regression of the bug this
// guards against (empty optional numeric env vars failing
// z.coerce.number().positive()) would make this whole test file exit(1)
// during import instead of failing a single assertion.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
// Reproduce the shipped .env.example: blank optional numeric vars.
process.env.HEALTH_PORT = '';
process.env.WHATSAPP_CLOUD_WEBHOOK_PORT = '';
process.env.INTERACTION_RETENTION_DAYS = '';

const { config, emptyStringsToUndefined } = await import('../src/config.js');

test('emptyStringsToUndefined: blank values become undefined, everything else passes through', () => {
  const result = emptyStringsToUndefined({
    HEALTH_PORT: '',
    WHATSAPP_CLOUD_WEBHOOK_PORT: '',
    AGENT_MODEL: 'claude-sonnet-5',
    DISCORD_GUILD_ID: '0',
  });
  assert.equal(result.HEALTH_PORT, undefined);
  assert.equal(result.WHATSAPP_CLOUD_WEBHOOK_PORT, undefined);
  assert.equal(result.AGENT_MODEL, 'claude-sonnet-5');
  assert.equal(result.DISCORD_GUILD_ID, '0', 'a literal "0" is a real value, not blank — must survive');
});

test('config: blank HEALTH_PORT (as shipped in .env.example) is treated as unset, not 0', () => {
  assert.equal(config.behaviour.healthPort, undefined);
});

test('config: blank optional coerced-number env var falls back to its default', () => {
  assert.equal(config.whatsapp.cloud.webhookPort, 8080);
  assert.equal(config.behaviour.interactionRetentionDays, 0);
});
