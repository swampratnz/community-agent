import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

// Regression guard (issue #1251 acceptance criterion 4b): MEMBER_DIGEST_CHANNEL_ID
// set but MEMBER_DIGEST_ENABLED left off must behave byte-identically to today
// — zero member-channel sends — because a channel-id-only gate would post to a
// channel whose admin explicitly turned digest posts off. Own process because
// config is parsed once per process at import time, and
// tests/statusCheckMemberChannelAlert.test.ts pins MEMBER_DIGEST_ENABLED on.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.STATUS_CHECK_API_URL ??= 'https://status.claude.com/api/v2/summary.json';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS ??= 'admin-open';
process.env.STATUS_CHECK_ENABLED = 'true';
process.env.STATUS_CHECK_POLL_MINUTES = '5';
process.env.MEMBER_DIGEST_CHANNEL_ID = 'member-channel-1';
// MEMBER_DIGEST_ENABLED deliberately left unset (defaults false).

const { startStatusCheck } = await import('../src/module/backgroundJobs.js');
const { pollAnthropicStatus, resetStatusCacheForTests } =
  await import('../src/module/status/anthropicStatus.js');

const POLL_MS = 5 * 60_000;

const ALL_OPERATIONAL_BODY = JSON.stringify({
  status: { indicator: 'none', description: 'All Systems Operational' },
  incidents: [],
});

const INCIDENT_BODY = JSON.stringify({
  status: { indicator: 'major', description: 'Major System Outage' },
  incidents: [
    {
      name: 'Elevated errors on the Messages API',
      impact: 'major',
      status: 'investigating',
      updated_at: '2026-07-07T00:00:00.000Z',
    },
  ],
});

function makeAdapter(): {
  adapter: PlatformAdapter;
  dms: Array<{ userId: string; text: string }>;
  channelSends: Array<{ conversationId: string; text: string }>;
} {
  const dms: Array<{ userId: string; text: string }> = [];
  const channelSends: Array<{ conversationId: string; text: string }> = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage() {},
    async sendMessage(out: OutgoingMessage) {
      channelSends.push({ conversationId: out.conversationId, text: out.text });
    },
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
  return { adapter, dms, channelSends };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test(
  'startStatusCheck: with MEMBER_DIGEST_CHANNEL_ID set but MEMBER_DIGEST_ENABLED false, an incident ' +
    'transition still DMs super admins but sends zero member-channel messages — behaviour byte-identical ' +
    'to an unset channel (issue #1251 acceptance criterion 4b)',
  async (t) => {
    resetStatusCacheForTests();
    const { adapter, dms, channelSends } = makeAdapter();
    let body = ALL_OPERATIONAL_BODY;
    const runOnce = () => pollAnthropicStatus(async () => body);

    t.mock.timers.enable({ apis: ['setInterval'] });
    const timer = startStatusCheck([adapter], runOnce);
    try {
      await flush();
      body = INCIDENT_BODY;
      t.mock.timers.tick(POLL_MS);
      await flush();

      assert.equal(dms.length, 1, 'the super-admin DM is unaffected by the digest-disabled gate');
      assert.equal(
        channelSends.length,
        0,
        'zero member-channel sends when MEMBER_DIGEST_ENABLED is false, even with a channel id configured',
      );

      body = ALL_OPERATIONAL_BODY;
      t.mock.timers.tick(POLL_MS);
      await flush();
      assert.equal(dms.length, 2, 'the resolved super-admin DM also fires');
      assert.equal(channelSends.length, 0, 'the resolved edge posts nothing to the channel either');
    } finally {
      clearInterval(timer!);
    }
  },
);
