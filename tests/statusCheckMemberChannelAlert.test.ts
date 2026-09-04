import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

// Proactive member-channel status alert (issue #1251) — the push complement
// to the super-admin-only DM tests/statusCheckAlert.test.ts already pins.
// Own process because MEMBER_DIGEST_ENABLED/MEMBER_DIGEST_CHANNEL_ID must be
// pinned ON here (opposite of tests/statusCheckAlert.test.ts, which leaves
// them unset, and tests/statusCheckMemberChannelAlertDisabled.test.ts, which
// sets the channel but leaves enabled off) — config is parsed once per
// process at import time, so these three states can't share a file.
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
process.env.MEMBER_DIGEST_ENABLED = 'true';
process.env.MEMBER_DIGEST_CHANNEL_ID = 'member-channel-1';

const { startStatusCheck } = await import('../src/module/backgroundJobs.js');
const {
  pollAnthropicStatus,
  resetStatusCacheForTests,
  formatStatusIncidentAlert,
  formatStatusResolvedAlert,
  getStatusCache,
} = await import('../src/module/status/anthropicStatus.js');

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

function makeAdapter(opts?: { sendMessageFails?: boolean }): {
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
      if (opts?.sendMessageFails) throw new Error('transient Discord API failure');
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
  'SECURITY: on a none -> incident transition with the member-digest gate opted in, the member channel ' +
    'receives exactly one message, byte-identical to formatStatusIncidentAlert with no extra interpolation ' +
    '— no member id, query text, or conversation reference — in addition to the existing super-admin DM ' +
    '(issue #1251 acceptance criteria 2, 5)',
  async (t) => {
    resetStatusCacheForTests();
    const { adapter, dms, channelSends } = makeAdapter();
    let body = ALL_OPERATIONAL_BODY;
    const runOnce = () => pollAnthropicStatus(async () => body);

    t.mock.timers.enable({ apis: ['setInterval'] });
    const timer = startStatusCheck([adapter], runOnce);
    try {
      await flush(); // initial run: operational
      assert.equal(channelSends.length, 0, 'no channel post while status stays operational');

      body = INCIDENT_BODY;
      t.mock.timers.tick(POLL_MS);
      await flush();

      assert.equal(dms.length, 1, 'the existing super-admin DM still fires');
      assert.equal(channelSends.length, 1, 'exactly one member-channel post on the transition');
      assert.equal(channelSends[0]?.conversationId, 'member-channel-1');

      const state = getStatusCache();
      assert.ok(state);
      assert.equal(
        channelSends[0]?.text,
        formatStatusIncidentAlert(state, Date.now()),
        'the channel post body is byte-identical to formatStatusIncidentAlert — SECURITY: no extra interpolation',
      );
    } finally {
      clearInterval(timer!);
    }
  },
);

test(
  'SECURITY: symmetric resolve-edge member-channel post, byte-identical to formatStatusResolvedAlert with no ' +
    'extra interpolation (issue #1251 acceptance criteria 3, 5)',
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
      t.mock.timers.tick(POLL_MS); // start
      await flush();

      body = ALL_OPERATIONAL_BODY;
      t.mock.timers.tick(POLL_MS); // resolve
      await flush();

      assert.equal(dms.length, 2, 'both super-admin DMs (start + resolved) still fire');
      assert.equal(channelSends.length, 2, 'both member-channel posts (start + resolved) fire');

      const state = getStatusCache();
      assert.ok(state);
      assert.equal(
        channelSends[1]?.text,
        formatStatusResolvedAlert(state, Date.now()),
        'the resolved channel post body is byte-identical to formatStatusResolvedAlert',
      );
    } finally {
      clearInterval(timer!);
    }
  },
);

test(
  'SECURITY: a thrown error from the member-channel sendMessage call is caught and logged, never rethrown, ' +
    'and never prevents or delays the existing super-admin DM in the same run() tick (issue #1251 ' +
    'acceptance criterion 6)',
  async (t) => {
    resetStatusCacheForTests();
    const { adapter, dms } = makeAdapter({ sendMessageFails: true });
    let body = ALL_OPERATIONAL_BODY;
    const runOnce = () => pollAnthropicStatus(async () => body);

    t.mock.timers.enable({ apis: ['setInterval'] });
    const timer = startStatusCheck([adapter], runOnce);
    try {
      await flush();
      body = INCIDENT_BODY;

      // The tick itself must not throw even though sendMessage rejects.
      await assert.doesNotReject(async () => {
        t.mock.timers.tick(POLL_MS);
        await flush();
      });

      assert.equal(dms.length, 1, 'the super-admin DM still fires despite the member-channel send failing');
    } finally {
      clearInterval(timer!);
    }
  },
);
