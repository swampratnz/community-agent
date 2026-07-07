import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
process.env.ROSTER_DEPARTED_RETENTION_DAYS = '';

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

test('config: ROSTER_DEPARTED_RETENTION_DAYS unset (default) is disabled — zero behaviour change (issue #136)', () => {
  assert.equal(config.behaviour.rosterDepartedRetentionDays, 0);
});

test('config: MODERATION_STRIKE_WINDOW_DAYS unset (default) is undefined — unbounded strike accumulation, unchanged from before this option existed (issue #194)', () => {
  assert.equal(config.moderation.strikeWindowDays, undefined);
});

test('config: WhatsApp group welcome is off by default with a sensible cooldown', () => {
  assert.equal(config.whatsapp.welcome.enabled, false);
  assert.equal(config.whatsapp.welcome.cooldownMinutes, 180);
});

test('SECURITY: default CONTEXT_EXPORT_PATH is untracked (issue #108) — the unattended exporter must never dirty a tracked file the nightly redeploy checks', () => {
  assert.equal(config.contextExport.path, 'var/community-context.md');
  assert.notEqual(
    config.contextExport.path,
    'docs/COMMUNITY-CONTEXT.md',
    'must not default to the committed, human-curated file',
  );

  const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.ok(
    gitignore.split('\n').some((line) => line.trim() === '/var/'),
    ".gitignore must exclude the export default path's directory",
  );
});
