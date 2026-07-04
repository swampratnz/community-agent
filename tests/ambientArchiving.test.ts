import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Ambient archiving ON (issue #48). config.ts parses env once at import, so
// the flag-on behaviour lives in this file and the default-off behaviour in
// tests/ambientArchivingOff.test.ts — the Node test runner gives each file
// its own process. DB-backed: these tests verify what actually lands in (or
// stays out of) the interactions table, so they skip without DATABASE_URL.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.DISCORD_ARCHIVE_ALL_MESSAGES = 'true';
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-ambient-1';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { Router } = await import('../src/router.js');
const { pool, closeDb } = await import('../src/storage/db.js');
const { embed } = await import('../src/storage/embeddings.js');
const {
  purgeUserData,
  purgeOldInteractions,
  recordInteraction,
  deleteInteractionByMessageId,
  updateInteractionByMessageId,
} = await import('../src/storage/repository.js');

// Pre-warm the (lazily loaded) embedding pipeline outside any timed wait.
if (hasDb) await embed('warmup').catch(() => {});

const RUN = `amb${Date.now()}${Math.floor(Math.random() * 1e6)}`;

after(async () => {
  if (hasDb) await pool.query(`DELETE FROM interactions WHERE conversation_id LIKE $1`, [`${RUN}%`]);
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
    platform: 'discord',
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

function channelMessage(overrides: Partial<IncomingMessage>): IncomingMessage {
  return {
    platform: 'discord',
    conversationId: `${RUN}-chan`,
    userId: `${RUN}-someone`,
    userName: 'Someone',
    text: 'ambient chatter',
    isDirect: false,
    addressedToBot: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll for a fire-and-forget insert to land (embedding makes it async). */
async function waitForRows(userId: string, timeoutMs = 30_000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT content, kind, message_id, role, addressed_to_bot FROM interactions WHERE user_id = $1`,
      [userId],
    );
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await sleep(100);
  }
}

test(
  'SECURITY: archiving on — a guest channel message is stored as ambient, but the addressed check still solely gates the agent (no reply, no turn)',
  { skip },
  async () => {
    let turnCalls = 0;
    const router = new Router(async (): Promise<AgentReply> => {
      turnCalls += 1;
      return { text: 'should never happen' };
    }, 1_000_000);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    const userId = `${RUN}-guest`;
    await trigger(channelMessage({ userId, messageId: `${RUN}-m1`, text: 'guest talking among themselves' }));

    const rows = await waitForRows(userId);
    assert.equal(rows.length, 1, 'the guest channel message is archived');
    assert.equal(rows[0].kind, 'ambient');
    assert.equal(rows[0].message_id, `${RUN}-m1`, 'the platform message id is stored');
    assert.equal(rows[0].role, 'guest');
    assert.equal(turnCalls, 0, 'SECURITY: an ambient message never invokes the agent');
    assert.equal(sent.length, 0, 'the bot does not reply to ambient chatter');
  },
);

test(
  'SECURITY: archiving on — a guest DM to the bot is still never stored (the gated-DM guarantee survives)',
  { skip },
  async () => {
    const router = new Router(async (): Promise<AgentReply> => ({ text: 'nope' }), 1_000_000);
    const { adapter, trigger } = makeAdapter();
    router.register(adapter);

    const userId = `${RUN}-dm-guest`;
    await trigger(
      channelMessage({
        userId,
        conversationId: `${RUN}-dm`,
        isDirect: true,
        addressedToBot: true,
        messageId: `${RUN}-m2`,
        text: 'a private message that must not be stored',
      }),
    );
    // Negative assertion: give any (wrong) fire-and-forget write ample time
    // to land before checking nothing did.
    await sleep(1_500);
    const { rows } = await pool.query(`SELECT 1 FROM interactions WHERE user_id = $1`, [userId]);
    assert.equal(rows.length, 0, 'SECURITY: gated guest DM content is never stored, flag or no flag');
    await pool.query(`DELETE FROM access_requests WHERE user_id = $1`, [userId]);
  },
);

test(
  'SECURITY: archiving on — a member+ non-addressed channel message is stored as ambient and the agent still does not run',
  { skip },
  async () => {
    let turnCalls = 0;
    const router = new Router(async (): Promise<AgentReply> => {
      turnCalls += 1;
      return { text: 'should never happen' };
    }, 1_000_000);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    // super-ambient-1 is env-configured as super admin — the highest tier
    // still must not trigger a turn from unaddressed chatter.
    await trigger(
      channelMessage({
        userId: 'super-ambient-1',
        conversationId: `${RUN}-chan-member`,
        messageId: `${RUN}-m3`,
        text: 'admin chatting, not addressing the bot',
      }),
    );

    const deadline = Date.now() + 30_000;
    let rows: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      ({ rows } = await pool.query(`SELECT kind, message_id FROM interactions WHERE conversation_id = $1`, [
        `${RUN}-chan-member`,
      ]));
      if (rows.length > 0) break;
      await sleep(100);
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'ambient', 'a non-addressed member message is kind=ambient');
    assert.equal(rows[0].message_id, `${RUN}-m3`);
    assert.equal(turnCalls, 0, 'SECURITY: addressed-check still solely governs agent invocation');
    assert.equal(sent.length, 0);
  },
);

test(
  'repository: deleting/editing the platform message deletes/updates the stored row (issue #48)',
  { skip },
  async () => {
    const conversationId = `${RUN}-chan-edit`;
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: `${RUN}-editor`,
      role: 'member',
      direction: 'inbound',
      content: 'original text',
      messageId: `${RUN}-m4`,
      kind: 'ambient',
    });

    const updated = await updateInteractionByMessageId('discord', `${RUN}-m4`, 'edited text');
    assert.equal(updated, true);
    const afterEdit = await pool.query(`SELECT content FROM interactions WHERE message_id = $1`, [
      `${RUN}-m4`,
    ]);
    assert.equal(afterEdit.rows[0].content, 'edited text', 'a Discord edit updates the stored copy');

    const deleted = await deleteInteractionByMessageId('discord', `${RUN}-m4`);
    assert.equal(deleted, 1);
    const afterDelete = await pool.query(`SELECT 1 FROM interactions WHERE message_id = $1`, [`${RUN}-m4`]);
    assert.equal(afterDelete.rows.length, 0, 'a Discord delete hard-deletes the stored copy');

    assert.equal(
      await updateInteractionByMessageId('discord', `${RUN}-m4`, 'x'),
      false,
      'updating an unknown message id is a clean no-op',
    );
    assert.equal(await deleteInteractionByMessageId('discord', `${RUN}-m4`), 0);
  },
);

test(
  'SECURITY: ambient rows are covered by forget_me/purge_user_data and the retention purge like any interaction (issue #48)',
  { skip },
  async () => {
    const userId = `${RUN}-purge-ambient`;
    const conversationId = `${RUN}-chan-purge`;
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId,
      role: 'guest',
      direction: 'inbound',
      content: 'ambient content to purge',
      messageId: `${RUN}-m5`,
      kind: 'ambient',
    });

    const purged = await purgeUserData('discord', userId);
    assert.ok(purged >= 1, 'forget_me/purge_user_data removes ambient rows');

    // Retention purge (age-based) is kind-agnostic: an ambient row past the
    // cutoff goes too. Same extreme-age technique as the retention test.
    const HUNDRED_YEARS_DAYS = 36_525;
    await pool.query(
      `INSERT INTO interactions (platform, conversation_id, user_id, role, direction, content, kind, created_at)
       VALUES ('discord', $1, $2, 'guest', 'inbound', 'ancient ambient row', 'ambient',
               now() - interval '${HUNDRED_YEARS_DAYS + 1} days')`,
      [conversationId, userId],
    );
    await purgeOldInteractions(HUNDRED_YEARS_DAYS);
    const { rows } = await pool.query(`SELECT 1 FROM interactions WHERE user_id = $1`, [userId]);
    assert.equal(rows.length, 0, 'the retention purge ages ambient rows out too');
  },
);
