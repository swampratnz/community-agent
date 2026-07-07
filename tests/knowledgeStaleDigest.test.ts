import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// knowledgeShortcutRouter.test.ts. This file is the ONLY place
// KNOWLEDGE_STALE_DAYS is set to a non-zero value — adminDigest.test.ts
// leaves it unset so the default-off (byte-for-byte unchanged) path stays
// covered untouched, and the node test runner isolates env per test file.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.KNOWLEDGE_STALE_DAYS = '30';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const { upsertMember, saveKnowledge, countAccessRequests, countPendingSuggestions } =
  await import('../src/storage/repository.js');
const { runAdminDigestOnce } = await import('../src/adminDigest.js');

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

after(async () => {
  await closeDb();
});

test('config: KNOWLEDGE_STALE_DAYS=30 is reflected in config.adminDigest.knowledgeStaleDays', () => {
  assert.equal(config.adminDigest.knowledgeStaleDays, 30);
});

function fakeAdapter(opts: {
  conversationIds: string[];
  sent: Array<{ userId: string; text: string }>;
}): PlatformAdapter {
  return {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage() {},
    async sendMessage() {},
    async sendDirectMessage(userId, text) {
      opts.sent.push({ userId, text });
    },
    async conversationsForUser() {
      return opts.conversationIds;
    },
    async performAdminAction() {
      return '';
    },
  };
}

test(
  'runAdminDigestOnce: with KNOWLEDGE_STALE_DAYS configured, a stale entry alone triggers a digest with the exact count (issue #199 acceptance criteria)',
  { skip },
  async () => {
    const adminId = `${RUN}-stale-admin`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const { id: staleId } = await saveKnowledge({
      content: `${RUN} an entry nobody has touched in a long time`,
      title: 'stale-digest-entry',
      scope: 'global',
    });
    await pool.query(`UPDATE knowledge SET updated_at = now() - interval '400 days' WHERE id = $1`, [
      staleId,
    ]);

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ conversationIds: [`${RUN}-c-stale-empty`], sent });

    await runAdminDigestOnce([adapter]);

    assert.equal(
      sent.length,
      1,
      'zero clusters/requests/reports/suggestions today would previously mean no DM — a stale entry now still triggers one',
    );
    assert.match(
      sent[0].text,
      /📚 \d+ knowledge entr(y|ies) untouched for 30d\+ — run `list_knowledge` to review\./,
    );
    assert.ok(
      !sent[0].text.includes('stale-digest-entry'),
      'SECURITY: the entry title must never appear in the digest DM — only the bare count',
    );
    assert.ok(
      !sent[0].text.includes(`${RUN} an entry nobody has touched`),
      'SECURITY: the entry content must never appear in the digest DM — only the bare count',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [staleId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'runAdminDigestOnce: an entry retrieved recently is never counted as stale regardless of updated_at age (issue #199 acceptance criteria)',
  { skip },
  async () => {
    const adminId = `${RUN}-notstale-admin`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const { id: notStaleId } = await saveKnowledge({
      content: `${RUN} old edit but retrieved recently`,
      title: 'not-stale-digest-entry',
      scope: 'global',
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '400 days', last_retrieved_at = now()
        WHERE id = $1`,
      [notStaleId],
    );

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ conversationIds: [`${RUN}-c-notstale-empty`], sent });

    // countAccessRequests/countPendingSuggestions are guild-wide (issue #133,
    // #193) and so are NOT test-isolated by a unique id — snapshot them
    // beforehand, same pattern as adminDigest.test.ts's quiet-week test, so
    // this assertion holds even if another concurrently-running test file has
    // a pending access request or suggestion in flight.
    const pendingAccessRequestsBefore = await countAccessRequests();
    const pendingSuggestionsBefore = await countPendingSuggestions();

    await runAdminDigestOnce([adapter]);

    if (pendingAccessRequestsBefore === 0 && pendingSuggestionsBefore === 0) {
      assert.equal(
        sent.length,
        0,
        'an entry retrieved recently must not be counted as stale — a quiet week produces no DM',
      );
    } else {
      assert.equal(
        sent.length,
        1,
        'a pre-existing pending access request or suggestion still legitimately triggers a digest',
      );
      assert.ok(
        !sent[0].text.includes('📚'),
        'no stale-knowledge line — the only knowledge entry in scope was retrieved recently',
      );
    }

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [notStaleId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);
