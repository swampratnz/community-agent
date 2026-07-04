import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// WhatsApp group ambient archiving (issue #103, extends Discord's #48).
// config.ts parses env once at import, so the allowlisted-on behaviour lives
// here and the default-off behaviour lives alongside Discord's in
// tests/ambientArchivingOff.test.ts — the Node test runner gives each file
// its own process. DB-backed: these tests verify what actually lands in (or
// stays out of) the interactions table, so they skip without DATABASE_URL.
const hasDb = Boolean(process.env.DATABASE_URL);

const ARCHIVED_GROUP = 'wa-archived-group@g.us';
const OTHER_GROUP = 'wa-not-archived-group@g.us';

process.env.WHATSAPP_ARCHIVE_GROUP_JIDS = ARCHIVED_GROUP;
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { Router } = await import('../src/router.js');
const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const { embed } = await import('../src/storage/embeddings.js');
const { recordInteraction, deleteInteractionByMessageId, updateInteractionByMessageId } =
  await import('../src/storage/repository.js');

// Pre-warm the (lazily loaded) embedding pipeline outside any timed wait.
if (hasDb) await embed('warmup').catch(() => {});

const RUN = `wamb${Date.now()}${Math.floor(Math.random() * 1e6)}`;

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

function groupMessage(overrides: Partial<IncomingMessage>): IncomingMessage {
  return {
    platform: 'whatsapp',
    conversationId: ARCHIVED_GROUP,
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
  'SECURITY: WhatsApp — a guest message in an allowlisted group is stored as ambient, but the addressed check still solely gates the agent (no reply, no turn)',
  { skip },
  async () => {
    assert.ok(
      config.whatsapp.archiveGroupJids.includes(ARCHIVED_GROUP),
      'precondition: the test group is in the archive allowlist',
    );
    let turnCalls = 0;
    const router = new Router(async (): Promise<AgentReply> => {
      turnCalls += 1;
      return { text: 'should never happen' };
    }, 1_000_000);
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    const userId = `${RUN}-guest`;
    await trigger(groupMessage({ userId, messageId: `${RUN}-m1`, text: 'guest talking among themselves' }));

    const rows = await waitForRows(userId);
    assert.equal(rows.length, 1, 'the guest group message is archived');
    assert.equal(rows[0].kind, 'ambient');
    assert.equal(rows[0].message_id, `${RUN}-m1`, 'the WhatsApp message id is stored');
    assert.equal(rows[0].role, 'guest');
    assert.equal(turnCalls, 0, 'SECURITY: an ambient message never invokes the agent');
    assert.equal(sent.length, 0, 'the bot does not reply to ambient chatter');
  },
);

test(
  'SECURITY: WhatsApp — a guest 1:1 DM to the bot is still never stored, allowlist or no allowlist',
  { skip },
  async () => {
    const router = new Router(async (): Promise<AgentReply> => ({ text: 'nope' }), 1_000_000);
    const { adapter, trigger } = makeAdapter();
    router.register(adapter);

    const userId = `${RUN}-dm-guest`;
    await trigger(
      groupMessage({
        userId,
        conversationId: `${userId}@s.whatsapp.net`,
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
    assert.equal(
      rows.length,
      0,
      'SECURITY: gated guest DM content is never stored, allowlist or no allowlist',
    );
    await pool.query(`DELETE FROM access_requests WHERE user_id = $1`, [userId]);
  },
);

test(
  'SECURITY: WhatsApp — a guest message in a group NOT on the archive allowlist is not stored',
  { skip },
  async () => {
    assert.ok(
      !config.whatsapp.archiveGroupJids.includes(OTHER_GROUP),
      'precondition: the other group is not in the archive allowlist',
    );
    const router = new Router(async (): Promise<AgentReply> => ({ text: 'never' }), 1_000_000);
    const { adapter, trigger } = makeAdapter();
    router.register(adapter);

    const userId = `${RUN}-guest-other-group`;
    await trigger(
      groupMessage({
        userId,
        conversationId: OTHER_GROUP,
        messageId: `${RUN}-m3`,
        text: 'chatter in a group the operator never allowlisted',
      }),
    );

    await sleep(1_500);
    const { rows } = await pool.query(`SELECT 1 FROM interactions WHERE user_id = $1`, [userId]);
    assert.equal(rows.length, 0, 'SECURITY: a non-allowlisted group is not archived for a gated guest');
  },
);

test(
  'repository: deleting/editing a WhatsApp message by id deletes/updates the stored row (issue #103, same helpers as #48)',
  { skip },
  async () => {
    const conversationId = `${RUN}-chan-edit`;
    await recordInteraction({
      platform: 'whatsapp',
      conversationId,
      userId: `${RUN}-editor`,
      role: 'member',
      direction: 'inbound',
      content: 'original text',
      messageId: `${RUN}-m4`,
      kind: 'ambient',
    });

    const updated = await updateInteractionByMessageId('whatsapp', `${RUN}-m4`, 'edited text');
    assert.equal(updated, true);
    const afterEdit = await pool.query(`SELECT content FROM interactions WHERE message_id = $1`, [
      `${RUN}-m4`,
    ]);
    assert.equal(afterEdit.rows[0].content, 'edited text', 'a WhatsApp edit updates the stored copy');

    const deleted = await deleteInteractionByMessageId('whatsapp', `${RUN}-m4`);
    assert.equal(deleted, 1);
    const afterDelete = await pool.query(`SELECT 1 FROM interactions WHERE message_id = $1`, [`${RUN}-m4`]);
    assert.equal(afterDelete.rows.length, 0, 'a WhatsApp delete hard-deletes the stored copy');
  },
);
