import { test, after } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/module/strings/notices.js';
import type { AgentReply } from '../src/base/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/base/platforms/types.js';

// Blanket WhatsApp group archiving (`WHATSAPP_ARCHIVE_ALL_GROUPS`) — the
// counterpart to DISCORD_ARCHIVE_ALL_MESSAGES, so every group the bot is in is
// archived without a per-group JID.
//
// Its own file, and deliberately with NO allowlist set: config.ts parses env
// once at import, and the point of these tests is that the blanket flag works
// ALONE. If the allowlist were also set, a passing test would prove nothing
// about which setting did the work. The Node test runner gives each file its
// own process, which is what makes that isolation possible.
//
// DB-backed: these assert what actually lands in (or stays out of) the
// interactions table, so they skip without DATABASE_URL.
const hasDb = Boolean(process.env.DATABASE_URL);

const ANY_GROUP = 'wa-blanket-group@g.us';

process.env.WHATSAPP_ARCHIVE_ALL_GROUPS = 'true';
delete process.env.WHATSAPP_ARCHIVE_GROUP_JIDS; // prove the blanket flag alone does it
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { Router } = await import('../src/base/router.js');
const { makeRouterDeps } = await import('../src/module/routerWiring.js');
const { pool, closeDb } = await import('../src/base/storage/db.js');
const { config } = await import('../src/base/config.js');

const RUN = `wall${Date.now()}${Math.floor(Math.random() * 1e6)}`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM interactions WHERE user_id LIKE $1 OR conversation_id LIKE $2`, [
      `${RUN}%`,
      `${RUN}%`,
    ]);
  }
  await closeDb();
});

function makeAdapter(): {
  adapter: PlatformAdapter;
  sent: OutgoingMessage[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const adapter: PlatformAdapter = {
    platform: 'whatsapp',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage(h) {
      handler = h;
    },
    async sendMessage(out) {
      sent.push(out);
    },
    async sendDirectMessage() {},
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return {
    adapter,
    sent,
    trigger: async (msg) => {
      if (!handler) throw new Error('router.register() was never called');
      await handler(msg);
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRows(userId: string, timeoutMs = 30_000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT content, kind, role, direction, addressed_to_bot FROM interactions WHERE user_id = $1`,
      [userId],
    );
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await sleep(100);
  }
}

test('WHATSAPP_ARCHIVE_ALL_GROUPS archives a group that is on NO allowlist', { skip }, async () => {
  assert.equal(config.whatsapp.archiveAllGroups, true, 'precondition: blanket flag on');
  assert.deepEqual(config.whatsapp.archiveGroupJids, [], 'precondition: allowlist deliberately empty');

  let turnCalls = 0;
  const router = new Router(
    makeRouterDeps({
      runTurn: async (): Promise<AgentReply> => {
        turnCalls += 1;
        return { text: 'should never happen' };
      },
      typingRefireMs: 1_000_000,
    }),
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  const userId = `${RUN}-guest`;
  await trigger({
    platform: 'whatsapp',
    conversationId: ANY_GROUP,
    userId,
    userName: 'Someone',
    text: 'ambient chatter in a group nobody allowlisted',
    isDirect: false,
    addressedToBot: false,
    timestamp: Date.now(),
    messageId: `${RUN}-m1`,
  });

  const rows = await waitForRows(userId);
  assert.equal(rows.length, 1, 'the group message is archived on the blanket flag alone');
  assert.equal(rows[0].kind, 'ambient');
  assert.equal(rows[0].role, 'guest');
  assert.equal(rows[0].direction, 'inbound');
  // The posture change is storage ONLY — it must not make the bot start
  // answering ambient chatter.
  assert.equal(turnCalls, 0, 'an ambient message still never invokes the agent');
  assert.equal(sent.length, 0, 'the bot still does not reply to ambient chatter');
});

test(
  'SECURITY: a guest 1:1 DM is STILL never stored, even with blanket group archiving on',
  { skip },
  async () => {
    // The invariant the blanket flag must not erode. It widens WHICH GROUPS are
    // archived, never whether private 1:1 conversations are — `!msg.isDirect`
    // remains the outer gate in both the router and `inArchiveScope`.
    const router = new Router(
      makeRouterDeps({
        runTurn: async (): Promise<AgentReply> => ({ text: 'nope' }),
        typingRefireMs: 1_000_000,
      }),
    );
    const { adapter, trigger } = makeAdapter();
    router.register(adapter);

    const userId = `${RUN}-dm-guest`;
    await trigger({
      platform: 'whatsapp',
      conversationId: `${RUN}-dm`,
      userId,
      userName: 'Guest',
      text: 'a private message to the bot',
      isDirect: true,
      addressedToBot: true,
      timestamp: Date.now(),
      messageId: `${RUN}-m2`,
    });

    await sleep(1_500); // give any (incorrect) fire-and-forget insert time to land
    const { rows } = await pool.query(`SELECT 1 FROM interactions WHERE user_id = $1`, [userId]);
    assert.equal(rows.length, 0, 'SECURITY: a guest DM must never be archived, blanket flag or not');
  },
);
