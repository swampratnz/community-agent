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
const {
  upsertMember,
  recordAdminDigestSent,
  wasAdminDigestSentRecently,
  listAdmins,
  purgeUserData,
  recordAccessRequest,
  clearAccessRequest,
  countAccessRequests,
  countPendingSuggestions,
  countStaleKnowledge,
  createContentReport,
  createSuggestion,
  saveKnowledge,
  recordKnowledgeRetrieval,
  deleteKnowledge,
} = await import('../src/storage/repository.js');
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

test('buildAdminDigestMessage: all five signals zero -> null (no send, no noise on a quiet week)', () => {
  assert.equal(buildAdminDigestMessage([], 0, 0, 0, 0, 0), null);
});

test('buildAdminDigestMessage: clusters -> a message capped at 5 snippets, each length-bounded', () => {
  const longQuestion = 'q'.repeat(400);
  const clusters = Array.from({ length: 7 }, (_, i) => ({
    representative: `${longQuestion}${i}`,
    count: i + 2,
  }));

  const message = buildAdminDigestMessage(clusters, 0, 0, 0, 0, 0);
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

test('buildAdminDigestMessage: pending-access-request line appears only when count > 0 (issue #133)', () => {
  assert.equal(
    buildAdminDigestMessage([], 0, 0, 0, 0, 0),
    null,
    'zero pending requests alongside zero clusters/reports/suggestions/stale-knowledge is still a quiet week',
  );

  const message = buildAdminDigestMessage([], 3, 0, 0, 0, 0);
  assert.ok(message, 'a non-zero pending-request count alone still produces a DM');
  assert.match(message, /⏳ 3 pending access request\(s\) — run `list_access_requests`\./);
  assert.ok(!message.includes('🔔'), 'no cluster line when there are no clusters');
  assert.ok(!message.includes('🚩'), 'no report line when there are no open reports');
  assert.ok(!message.includes('💡'), 'no suggestion line when the count is zero');
  assert.ok(!message.includes('📚'), 'no stale-knowledge line when the count is zero');
});

test('buildAdminDigestMessage: open-report line appears only when count > 0 (issue #133)', () => {
  const message = buildAdminDigestMessage([], 0, 2, 0, 0, 0);
  assert.ok(message, 'a non-zero open-report count alone still produces a DM');
  assert.match(message, /🚩 2 open report\(s\) in your conversations — run `list_reports`\./);
  assert.ok(!message.includes('⏳'), 'no pending-request line when the count is zero');
  assert.ok(!message.includes('💡'), 'no suggestion line when the count is zero');
});

test('buildAdminDigestMessage: pending-suggestion line appears only when count > 0, independent of the other signals (issue #193)', () => {
  const message = buildAdminDigestMessage([], 0, 0, 4, 0, 0);
  assert.ok(message, 'a non-zero pending-suggestion count alone still produces a DM');
  assert.match(message, /^💡 4 pending suggestion\(s\) — run `list_suggestions`\.$/);
  assert.ok(!message.includes('🔔'), 'no cluster line when there are no clusters');
  assert.ok(!message.includes('⏳'), 'no pending-request line when the count is zero');
  assert.ok(!message.includes('🚩'), 'no report line when there are no open reports');

  assert.equal(
    buildAdminDigestMessage([], 0, 0, 0, 0, 0),
    null,
    'zero pending suggestions alongside zero clusters/requests/reports/stale-knowledge is still a quiet week',
  );
});

test('buildAdminDigestMessage: the DM never contains suggestion content, display name, or user id — only the bare count (issue #193 privacy pin)', () => {
  const message = buildAdminDigestMessage([], 0, 0, 4, 0, 0);
  assert.ok(message);
  assert.ok(
    !/suggest_improvement|display_name|reviewed_by/i.test(message),
    'no suggestion field name or content ever leaks into the digest text',
  );
});

test('buildAdminDigestMessage: stale-knowledge line appears only when count > 0, independent of the other signals (issue #199)', () => {
  const message = buildAdminDigestMessage([], 0, 0, 0, 5, 30);
  assert.ok(message, 'a non-zero stale-knowledge count alone still produces a DM');
  assert.match(message, /^📚 5 knowledge entries untouched for 30d\+ — run `list_knowledge` to review\.$/);
  assert.ok(!message.includes('🔔'), 'no cluster line when there are no clusters');
  assert.ok(!message.includes('⏳'), 'no pending-request line when the count is zero');
  assert.ok(!message.includes('🚩'), 'no report line when there are no open reports');
  assert.ok(!message.includes('💡'), 'no suggestion line when the count is zero');

  assert.equal(
    buildAdminDigestMessage([], 0, 0, 0, 0, 0),
    null,
    'zero stale-knowledge alongside zero clusters/requests/reports/suggestions is still a quiet week',
  );
});

test('buildAdminDigestMessage: stale-knowledge singular/plural wording and threshold-day substitution (issue #199)', () => {
  const singular = buildAdminDigestMessage([], 0, 0, 0, 1, 45);
  assert.ok(singular);
  assert.match(singular, /^📚 1 knowledge entry untouched for 45d\+ — run `list_knowledge` to review\.$/);
});

test('buildAdminDigestMessage: the stale-knowledge line never contains entry titles or content — only the bare count (issue #199 privacy pin)', () => {
  const message = buildAdminDigestMessage([], 0, 0, 0, 3, 30);
  assert.ok(message);
  assert.ok(
    !/title|content/i.test(message),
    'no knowledge entry field name or content ever leaks into the digest text',
  );
});

test('buildAdminDigestMessage: all five signals non-zero -> all five lines present', () => {
  const clusters = [{ representative: 'a repeated question', count: 4 }];
  const message = buildAdminDigestMessage(clusters, 1, 1, 1, 1, 30);
  assert.ok(message);
  assert.ok(message.includes('🔔'), 'cluster line present');
  assert.ok(message.includes('⏳'), 'pending-request line present');
  assert.ok(message.includes('🚩'), 'open-report line present');
  assert.ok(message.includes('💡'), 'pending-suggestion line present');
  assert.ok(message.includes('📚'), 'stale-knowledge line present');
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
  'runAdminDigestOnce: an admin past the window with all four signals at zero sends nothing and does not update the freshness row (issue #133, extended #193)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-quiet-admin`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const sent: Array<{ userId: string; text: string }> = [];
    // A conversation id unique to this test guarantees zero clusters and zero
    // open reports in scope. countAccessRequests/countPendingSuggestions are
    // guild-wide by design (issue #133, #193) and so are NOT test-isolated by
    // a unique id — snapshot them immediately beforehand so this assertion
    // holds even if another test file concurrently has a pending access
    // request or suggestion in flight.
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [`${RUN}-c-empty`], sent });
    const pendingAccessRequestsBefore = await countAccessRequests();
    const pendingSuggestionsBefore = await countPendingSuggestions();

    await runAdminDigestOnce([adapter]);

    if (pendingAccessRequestsBefore === 0 && pendingSuggestionsBefore === 0) {
      assert.equal(
        sent.length,
        0,
        'zero clusters, zero pending requests, zero open reports, zero pending suggestions — no DM sent',
      );
      assert.equal(
        await wasAdminDigestSentRecently('discord', adminId, 7),
        false,
        'a quiet run must not touch the freshness row (so a later clustered week is not skipped)',
      );
    } else {
      // Extremely rare in practice, but countAccessRequests/countPendingSuggestions
      // are intentionally unscoped — a concurrently-running test file's pending
      // access request or suggestion legitimately makes this a non-quiet week,
      // so the digest correctly sends.
      assert.equal(
        sent.length,
        1,
        'a pre-existing pending access request or suggestion still legitimately triggers a digest',
      );
      assert.ok(!sent[0].text.includes('🔔'), 'no cluster line — this admin has zero clusters in scope');
      assert.ok(!sent[0].text.includes('🚩'), 'no report line — this admin has zero open reports in scope');
    }

    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
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

test(
  'runAdminDigestOnce: an admin with zero recurring-question clusters but a pending access request and an open report still receives a digest (issue #133 acceptance criteria)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-queues-admin`;
    const conversationId = `${RUN}-c-run-queues`;
    const requesterId = `${RUN}-run-queues-requester`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const report = await createContentReport({
      platform: 'discord',
      reporterUserId: `${RUN}-run-queues-reporter`,
      conversationId,
      reason: 'open report with zero recurring-question clusters',
    });
    assert.ok(report);
    await recordAccessRequest({ platform: 'discord', userId: requesterId, userName: 'guest' });

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    await runAdminDigestOnce([adapter]);

    assert.equal(
      sent.length,
      1,
      'zero clusters today would previously mean no DM — the pending queue signals now still trigger one',
    );
    assert.ok(!sent[0].text.includes('🔔'), 'no cluster line — this admin has zero clusters in scope');
    assert.match(
      sent[0].text,
      /⏳ \d+ pending access request\(s\) — run `list_access_requests`\./,
      'the pending-access-request line is present',
    );
    assert.match(
      sent[0].text,
      /🚩 1 open report\(s\) in your conversations — run `list_reports`\./,
      'the open-report line is present with the exact scoped count',
    );

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'the freshness row is updated after a successful send',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = $1`, [report.id]);
    await clearAccessRequest('discord', requesterId);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'SECURITY: runAdminDigestOnce: an admin with zero clusters/requests/reports but ≥1 pending suggestion still receives a digest containing only the bare count (issue #193 acceptance criteria)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-suggestions-admin`;
    const suggesterId = `${RUN}-run-suggestions-suggester`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const created = await createSuggestion({
      platform: 'discord',
      userId: suggesterId,
      displayName: 'a very identifiable display name',
      content: 'private suggestion content that must never leak into the digest',
    });
    assert.ok(created);

    // countAccessRequests is guild-wide by design (issue #133) and so is NOT
    // test-isolated by a unique id — snapshot it beforehand, same pattern as
    // the "all four signals at zero" test above, so this assertion holds
    // even if another test file concurrently has a pending access request.
    const pendingAccessRequestsBefore = await countAccessRequests();

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({
      platform: 'discord',
      conversationIds: [`${RUN}-c-suggestions-empty`],
      sent,
    });

    await runAdminDigestOnce([adapter]);

    assert.equal(
      sent.length,
      1,
      'zero clusters/requests/reports today would previously mean no DM — a pending suggestion now still triggers one',
    );
    assert.ok(!sent[0].text.includes('🔔'), 'no cluster line — this admin has zero clusters in scope');
    if (pendingAccessRequestsBefore === 0) {
      assert.ok(!sent[0].text.includes('⏳'), 'no pending-request line — zero pending access requests');
    }
    assert.match(
      sent[0].text,
      /💡 \d+ pending suggestion\(s\) — run `list_suggestions`\./,
      'the pending-suggestion line is present',
    );
    assert.ok(
      !sent[0].text.includes('private suggestion content'),
      'SECURITY: the raw suggestion content must never appear in the digest DM',
    );
    assert.ok(
      !sent[0].text.includes('a very identifiable display name'),
      'SECURITY: the submitter display name must never appear in the digest DM',
    );
    assert.ok(
      !sent[0].text.includes(suggesterId),
      'SECURITY: the submitter user id must never appear in the digest DM',
    );

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'the freshness row is updated after a successful send',
    );

    await pool.query(`DELETE FROM suggestions WHERE id = $1`, [created.id]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'SECURITY: runAdminDigestOnce: the open-report count is scoped to the conversations the admin participates in, excluding others (issue #133)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-reportscope-admin`;
    const inScopeConvo = `${RUN}-c-run-reportscope-in`;
    const outOfScopeConvo = `${RUN}-c-run-reportscope-out`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const inScope = await createContentReport({
      platform: 'discord',
      reporterUserId: `${RUN}-run-reportscope-reporter`,
      conversationId: inScopeConvo,
      reason: 'in-scope open report',
    });
    const outOfScope = await createContentReport({
      platform: 'discord',
      reporterUserId: `${RUN}-run-reportscope-reporter`,
      conversationId: outOfScopeConvo,
      reason: 'must NOT be counted — admin does not participate in this conversation',
    });
    assert.ok(inScope && outOfScope);

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [inScopeConvo], sent });

    await runAdminDigestOnce([adapter]);

    assert.equal(sent.length, 1);
    assert.match(
      sent[0].text,
      /🚩 1 open report\(s\)/,
      'SECURITY: the count reflects only the in-scope conversation, never the out-of-scope one',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [[inScope.id, outOfScope.id]]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'runAdminDigestOnce: a still-open report re-appears in the digest on the next weekly tick (persistent-nag by design, issue #133)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-nag-admin`;
    const conversationId = `${RUN}-c-run-nag`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const report = await createContentReport({
      platform: 'discord',
      reporterUserId: `${RUN}-run-nag-reporter`,
      conversationId,
      reason: 'left open across two weekly ticks',
    });
    assert.ok(report);

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    await runAdminDigestOnce([adapter]);
    assert.equal(sent.length, 1, 'first tick sends the digest with the open report');

    // Simulate the freshness window elapsing, exactly like the freshness test above.
    await pool.query(
      `UPDATE admin_digest_sends SET sent_at = now() - interval '8 days'
        WHERE platform = $1 AND platform_user_id = $2`,
      ['discord', adminId],
    );

    await runAdminDigestOnce([adapter]);
    assert.equal(sent.length, 2, 'the still-open report triggers a second digest on the next weekly tick');
    assert.match(
      sent[1].text,
      /🚩 1 open report\(s\)/,
      'the persistent-nag behaviour is intended, not a bug — the same open report resurfaces every week',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = $1`, [report.id]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);
