import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReply } from '../src/agent/core.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// Ambient archiving OFF — the default (issue #48). This file pins the "flag
// off means zero behaviour change" acceptance criterion: a gated guest's
// channel message stores nothing, exactly as before the feature existed.
// Counterpart to tests/ambientArchiving.test.ts (flag on, own process).
const hasDb = Boolean(process.env.DATABASE_URL);

delete process.env.DISCORD_ARCHIVE_ALL_MESSAGES;
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

const RUN = `amboff${Date.now()}${Math.floor(Math.random() * 1e6)}`;

after(async () => {
  await closeDb();
});

test(
  'SECURITY: archiving off (default) — a gated guest channel message stores nothing at all, identical to pre-#48 behaviour',
  { skip },
  async () => {
    const router = new Router(async (): Promise<AgentReply> => ({ text: 'never' }), 1_000_000);
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
    router.register(adapter);

    const userId = `${RUN}-guest`;
    await handler!({
      platform: 'discord',
      conversationId: `${RUN}-chan`,
      userId,
      userName: 'Guest',
      text: 'channel chatter that must not be stored while the flag is off',
      isDirect: false,
      addressedToBot: false,
      messageId: `${RUN}-m1`,
      timestamp: Date.now(),
    });

    // Ample time for any (wrong) fire-and-forget write to land.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const { rows } = await pool.query(`SELECT 1 FROM interactions WHERE user_id = $1`, [userId]);
    assert.equal(rows.length, 0, 'SECURITY: with the flag off, guest channel content is never stored');
    assert.equal(sent.length, 0, 'and the bot stays silent, as before');
  },
);
