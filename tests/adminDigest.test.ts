import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. ADMIN_DIGEST_ENABLED is
// deliberately left unset so it exercises the disabled-by-default path;
// DATABASE_URL gates the DB-integration tests below (skipped cleanly when
// unset, per CLAUDE.md).
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { upsertMember, recordAdminDigestSent, wasAdminDigestSentRecently, listAdmins, purgeUserData } =
  await import('../src/storage/repository.js');
const { buildAdminDigestMessage, runAdminDigestOnce, startAdminDigest } =
  await import('../src/adminDigest.js');
const pgvector = (await import('pgvector/pg')).default;
const { config } = await import('../src/config.js');

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

after(async () => {
  await closeDb();
});

test('startAdminDigest: ADMIN_DIGEST_ENABLED unset (default) creates no timer', () => {
  const timer = startAdminDigest([]);
  assert.equal(timer, null, 'disabled by default — no timer, no extra queries');
});

test('buildAdminDigestMessage: empty clusters -> null (no send, no noise on a quiet week)', () => {
  assert.equal(buildAdminDigestMessage([]), null);
});

test('buildAdminDigestMessage: clusters -> a message capped at 5 snippets, each length-bounded', () => {
  const longQuestion = 'q'.repeat(400);
  const clusters = Array.from({ length: 7 }, (_, i) => ({
    representative: `${longQuestion}${i}`,
    count: i + 2,
  }));

  const message = buildAdminDigestMessage(clusters);
  assert.ok(message, 'non-empty clusters produce a message');
  assert.match(message, /^🔔 7 recurring question\(s\)/);
  assert.ok(message.includes('question_digest'), 'points the admin at the on-demand tool for full detail');

  const snippetLines = message.split('\n').filter((l) => /^\d+\./.test(l));
  assert.equal(snippetLines.length, 5, 'snippet count is capped at 5 even though 7 clusters were passed');
  for (const line of snippetLines) {
    const match = line.match(/^\d+\. \(\d+x\) (.*)$/);
    assert.ok(match, `line matches the expected format: ${line}`);
    assert.ok(match[1].length <= 300, 'each snippet is truncated to 300 chars, mirroring question_digest');
  }
});

function fakeAdapter(opts: {
  platform: 'discord' | 'whatsapp';
  conversationIds: string[];
  sent: Array<{ userId: string; text: string }>;
  connected?: boolean;
}): PlatformAdapter {
  return {
    platform: opts.platform,
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => opts.connected ?? true,
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
  'repository: listAdmins returns only community_users admins, never members or super admins',
  { skip },
  async () => {
    const adminId = `${RUN}-listadmins-admin`;
    const memberId = `${RUN}-listadmins-member`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });
    await upsertMember({ platform: 'discord', userId: memberId, role: 'member', addedBy: `${RUN}-actor` });

    const admins = await listAdmins();
    assert.ok(
      admins.some((a) => a.platform === 'discord' && a.platformUserId === adminId),
      'the admin identity is listed',
    );
    assert.ok(
      !admins.some((a) => a.platform === 'discord' && a.platformUserId === memberId),
      'a plain member is never listed as a digest recipient',
    );

    await pool.query(`DELETE FROM community_users WHERE platform_user_id = ANY($1)`, [[adminId, memberId]]);
  },
);

test(
  'repository: wasAdminDigestSentRecently is true within the freshness window, false past it',
  { skip },
  async () => {
    const adminId = `${RUN}-freshness-admin`;

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      false,
      'no send recorded yet — not fresh',
    );

    await recordAdminDigestSent('discord', adminId);
    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'a send just recorded is within the 7-day freshness window',
    );

    await pool.query(
      `UPDATE admin_digest_sends SET sent_at = now() - interval '8 days'
        WHERE platform = $1 AND platform_user_id = $2`,
      ['discord', adminId],
    );
    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      false,
      'a send older than the window no longer counts as fresh',
    );

    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  "SECURITY: repository: purgeUserData removes an offboarded admin's admin_digest_sends row",
  { skip },
  async () => {
    const adminId = `${RUN}-purge-admin`;
    await recordAdminDigestSent('discord', adminId);

    await purgeUserData('discord', adminId);

    const rows = await pool.query(
      `SELECT 1 FROM admin_digest_sends WHERE platform = $1 AND platform_user_id = $2`,
      ['discord', adminId],
    );
    assert.equal(rows.rows.length, 0, 'the freshness row is gone after purgeUserData');
  },
);

test(
  'runAdminDigestOnce: an admin within the freshness window is skipped even with fresh clusters',
  { skip },
  async () => {
    const adminId = `${RUN}-run-skip-admin`;
    const conversationId = `${RUN}-c-run-skip`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });
    await recordAdminDigestSent('discord', adminId); // sent moments ago — still fresh

    const dim = config.db.embeddingDim;
    const vec = new Array(dim).fill(0);
    vec[3] = 1;
    const insert = (content: string) =>
      pool.query(
        `INSERT INTO interactions
         (platform, conversation_id, user_id, role, direction, content, addressed_to_bot, embedding)
       VALUES ($1,$2,$3,$4,'inbound',$5,true,$6)`,
        ['discord', conversationId, `${RUN}-run-skip-user`, 'member', content, pgvector.toSql(vec)],
      );
    await insert('recurring question A');
    await insert('recurring question A again');

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    await runAdminDigestOnce([adapter]);
    assert.equal(sent.length, 0, 'an admin already sent within the freshness window gets no DM');

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'runAdminDigestOnce: an admin past the window with zero clusters sends nothing and does not update the freshness row',
  { skip },
  async () => {
    const adminId = `${RUN}-run-quiet-admin`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [`${RUN}-c-empty`], sent });

    await runAdminDigestOnce([adapter]);
    assert.equal(sent.length, 0, 'no clusters in scope — no DM sent');

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      false,
      'a quiet run must not touch the freshness row (so a later clustered week is not skipped)',
    );

    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
  },
);

test(
  'SECURITY: runAdminDigestOnce: an admin past the window with in-scope clusters is sent exactly one DM scoped to their own conversations, and the freshness row is updated',
  { skip },
  async () => {
    const adminId = `${RUN}-run-send-admin`;
    const inScopeConvo = `${RUN}-c-run-send-in`;
    const outOfScopeConvo = `${RUN}-c-run-send-out`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const dim = config.db.embeddingDim;
    const inScopeVec = new Array(dim).fill(0);
    inScopeVec[4] = 1;
    const outOfScopeVec = new Array(dim).fill(0);
    outOfScopeVec[5] = 1;
    const insert = (conversationId: string, content: string, vec: number[]) =>
      pool.query(
        `INSERT INTO interactions
         (platform, conversation_id, user_id, role, direction, content, addressed_to_bot, embedding)
       VALUES ($1,$2,$3,$4,'inbound',$5,true,$6)`,
        ['discord', conversationId, `${RUN}-run-send-user`, 'member', content, pgvector.toSql(vec)],
      );
    await insert(inScopeConvo, 'in-scope recurring question', inScopeVec);
    await insert(inScopeConvo, 'in-scope recurring question again', inScopeVec);
    await insert(outOfScopeConvo, 'out-of-scope recurring question', outOfScopeVec);
    await insert(outOfScopeConvo, 'out-of-scope recurring question again', outOfScopeVec);

    const sent: Array<{ userId: string; text: string }> = [];
    // The fake adapter only reports the in-scope conversation, mirroring what
    // adapter.conversationsForUser would return for this admin's real membership.
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [inScopeConvo], sent });

    await runAdminDigestOnce([adapter]);

    assert.equal(sent.length, 1, 'exactly one DM is sent');
    assert.equal(sent[0].userId, adminId);
    assert.ok(sent[0].text.includes('in-scope recurring question'), 'the DM includes the in-scope cluster');
    assert.ok(
      !sent[0].text.includes('out-of-scope recurring question'),
      'SECURITY: a cluster from a conversation outside the admin scope must never appear in the DM',
    );

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'the freshness row is updated after a successful send',
    );

    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [
      [inScopeConvo, outOfScopeConvo],
    ]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);
