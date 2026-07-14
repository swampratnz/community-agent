import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Companion to tests/devTeamWatchAlert.test.ts, pinning the OTHER end of
// statusCheckAlertThreshold's floor (issue #452 acceptance criterion #2):
// a coarse DEV_TEAM_WATCH_POLL_MINUTES floors the threshold at 3 rather than
// scaling down below it. Its own process because config.devTeam.watchPollMinutes
// is parsed once per process at import time, so a second cadence value can't
// share a file with the default-cadence tests.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';
process.env.DEV_TEAM_ENABLED = 'true';
process.env.DEV_TEAM_ENDPOINT_URL = 'https://dev-team.example.internal';
process.env.DEV_TEAM_AUTH_TOKEN = 'test-dev-team-token';
process.env.DEV_TEAM_WATCH_POLL_MINUTES = '60';

const { startDevTeamWatchPoller, statusCheckAlertThreshold } = await import('../src/backgroundJobs.js');

const POLL_MS = 60 * 60_000;
const THRESHOLD = statusCheckAlertThreshold(60);

function makeAdapter(): { adapter: PlatformAdapter; dms: Array<{ userId: string; text: string }> } {
  const dms: Array<{ userId: string; text: string }> = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage() {},
    async sendMessage(_out: OutgoingMessage) {},
    async sendDirectMessage(userId: string, text: string) {
      dms.push({ userId, text });
    },
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return { adapter, dms };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('statusCheckAlertThreshold(60): a 1h cadence floors the dev-team-watch threshold at 3, not 1', () => {
  assert.equal(THRESHOLD, 3);
});

test('startDevTeamWatchPoller: at a coarse 60-min DEV_TEAM_WATCH_POLL_MINUTES, exactly 3 (the floor) consecutive failures alert, not 60', async (t) => {
  const { adapter, dms } = makeAdapter();
  const runOnce = async () => {
    throw new Error('dev-team status endpoint unreachable');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDevTeamWatchPoller([adapter], runOnce);
  try {
    await flush(); // 1st failure
    assert.equal(dms.length, 0);
    t.mock.timers.tick(POLL_MS);
    await flush(); // 2nd failure
    assert.equal(dms.length, 0, 'below the floored threshold of 3');
    t.mock.timers.tick(POLL_MS);
    await flush(); // 3rd failure reaches the floor
    assert.equal(dms.length, 1, 'the floored threshold of 3 alerts, matching the other flat-threshold jobs');
  } finally {
    clearInterval(timer!);
  }
});
