import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time. This file deliberately sets
// ACCESS_REQUEST_RETENTION_DAYS while leaving BOTH other retention purges at 0
// (disabled), pinning the same independence requirement issue #136 established
// for the roster purge: there are now three retention sweeps, and each must be
// gated solely on its own env var. A shared "is retention on at all" gate would
// mean an operator who wants only the PII-sensitive access-request sweep is
// forced to also age-purge interactions, or gets nothing.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.INTERACTION_RETENTION_DAYS = '0';
process.env.ROSTER_DEPARTED_RETENTION_DAYS = '0';
process.env.ACCESS_REQUEST_RETENTION_DAYS = '30';

const { config } = await import('../src/config.js');
const { startAccessRequestRetentionPurge } = await import('../src/accessRequestRetention.js');

test(
  'startAccessRequestRetentionPurge: creates a timer on its OWN gate, with both the interaction and roster ' +
    'purges disabled (issue #939, following #136)',
  () => {
    assert.equal(
      config.behaviour.interactionRetentionDays,
      0,
      'sanity: the interactions purge is disabled in this scenario',
    );
    assert.equal(
      config.behaviour.rosterDepartedRetentionDays,
      0,
      'sanity: the roster purge is disabled in this scenario',
    );
    assert.equal(config.behaviour.accessRequestRetentionDays, 30);

    // Inject a stub purge, for the same reason tests/rosterRetentionIndependence
    // does: startTrackedJob fires `void run()` immediately rather than on the
    // first interval, and the `void` means the clearInterval below cannot
    // cancel it — so the real purge would run against the shared CI database
    // and race repository.test.ts's own deliberately-backdated fixtures. This
    // test asserts only the timer-creation gate, so it needs no real deletion.
    const timer = startAccessRequestRetentionPurge([], async () => 0);
    assert.notEqual(
      timer,
      null,
      'the access-request purge must run on its own gate — the other purges being disabled must never suppress it',
    );
    if (timer) clearInterval(timer);
  },
);
