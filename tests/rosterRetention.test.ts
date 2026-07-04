import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/usageAlert.test.ts. ROSTER_DEPARTED_RETENTION_DAYS is
// deliberately left unset so it exercises the disabled-by-default path.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { startRosterRetentionPurge } = await import('../src/rosterRetention.js');

test('startRosterRetentionPurge: ROSTER_DEPARTED_RETENTION_DAYS unset (default) creates no timer', () => {
  const timer = startRosterRetentionPurge();
  assert.equal(timer, null, 'disabled by default — no timer, no extra queries');
});
