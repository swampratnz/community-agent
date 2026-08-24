import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';
import type { OutgoingMessage, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

// config.ts validates env at import time, and config is a process-wide
// singleton read once — so the 'open'-access-mode suppression (acceptance
// criterion 5) needs its own file, in its own process, with
// ACCESS_MODE_DISCORD set BEFORE the first import of anything that
// transitively loads config. Every other rosterStaleAlert test lives in
// tests/rosterStaleAlert.test.ts, which relies on the 'gated' default and
// must never set this var.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.ACCESS_MODE_DISCORD = 'open';

const { makeDefaultRosterStaleAlertRun } = await import('../src/module/rosterStaleAlert.js');

type Platform = 'discord' | 'whatsapp';
type RosterEntry = {
  userId: string;
  displayName: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  rejoinedCount: number;
  isMember: boolean;
};
type AdminIdentity = { platform: Platform; platformUserId: string };

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

test(
  "SECURITY: on an 'open'-access-mode platform, no alert ever fires regardless of a stale not_members " +
    'backlog — an open-mode not_members row already has full member-tool access, so its age is meaningless ' +
    "(mirrors adminDigest.ts:1252's suppression)",
  async () => {
    const { adapter, dms } = makeAdapter();
    // A large, very stale backlog — if the gate were missing, this would
    // trip the crossing latch on the very first tick.
    const listNotMembers = async () =>
      Array.from({ length: 5 }, (_, i) => ({
        userId: `guest-${i}`,
        displayName: `Guest ${i}`,
        joinedAt: new Date(Date.now() - 9_999 * 3_600_000),
        leftAt: null,
        rejoinedCount: 0,
        isMember: false,
      }));
    const listAdminIdentities = async (): Promise<AdminIdentity[]> => [
      { platform: 'discord', platformUserId: 'admin-0' },
    ];
    const runOnce = makeDefaultRosterStaleAlertRun([adapter], listNotMembers, listAdminIdentities);

    await runOnce();
    await runOnce();

    assert.equal(dms.length, 0, "an 'open'-mode platform must never alert on its not_members backlog");
  },
);
