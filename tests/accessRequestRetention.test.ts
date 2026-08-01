import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it, matching the convention in
// tests/rosterRetention.test.ts. ACCESS_REQUEST_RETENTION_DAYS is deliberately
// left unset so this exercises the disabled-by-default path: enabling a purge
// that deletes rows is an operator decision, never something an upgrade does
// silently.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { startAccessRequestRetentionPurge } = await import('../src/accessRequestRetention.js');

test('startAccessRequestRetentionPurge: ACCESS_REQUEST_RETENTION_DAYS unset (default) creates no timer', () => {
  const timer = startAccessRequestRetentionPurge([]);
  assert.equal(timer, null, 'disabled by default — no timer, no deletions, no extra queries');
});
