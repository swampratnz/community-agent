import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time. This file deliberately sets
// ROSTER_DEPARTED_RETENTION_DAYS while leaving INTERACTION_RETENTION_DAYS at
// 0 (disabled), to pin the adversarial-review requirement from issue #136:
// the roster purge timer must not be gated behind the interactions purge's
// enabled state — each is controlled by its own, independent env var.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.INTERACTION_RETENTION_DAYS = '0';
process.env.ROSTER_DEPARTED_RETENTION_DAYS = '30';

const { config } = await import('../src/config.js');
const { startRosterRetentionPurge } = await import('../src/rosterRetention.js');

test(
  'startRosterRetentionPurge: creates a timer when ROSTER_DEPARTED_RETENTION_DAYS is set, even though ' +
    'INTERACTION_RETENTION_DAYS is 0/disabled (issue #136)',
  () => {
    assert.equal(
      config.behaviour.interactionRetentionDays,
      0,
      'sanity: the interactions purge is disabled in this scenario',
    );
    const timer = startRosterRetentionPurge([]);
    assert.notEqual(
      timer,
      null,
      'the roster purge must run on its own gate — the interactions purge being disabled must never suppress it',
    );
    if (timer) clearInterval(timer);
  },
);
