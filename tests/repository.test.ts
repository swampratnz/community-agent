import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts.
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
const { config } = await import('../src/config.js');
const pgvector = (await import('pgvector/pg')).default;
const {
  recordInteraction,
  userMessages,
  purgeOldInteractions,
  purgeUserData,
  saveKnowledge,
  searchKnowledge,
  updateKnowledge,
  deleteKnowledge,
  recordAdminAction,
  recentQuestionClusters,
  recentModerationEntries,
  usageStats,
} = await import('../src/storage/repository.js');

// Unique per test-run tag so fixtures never collide across runs and can be
// cleaned up precisely, whether this runs against a throwaway CI Postgres or
// a developer's real local instance.
const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

after(async () => {
  await closeDb();
});

test(
  'repository: purgeOldInteractions deletes only rows past the cutoff, never knowledge/admin_audit',
  { skip },
  async () => {
    const userId = `${RUN}-purge`;
    const conversationId = `${RUN}-c-purge`;

    // Use an extreme age (~100 years) rather than a realistic retention
    // window: this makes the boundary assertions correct regardless of what
    // else lives in the table (real interactions can't predate the schema),
    // so this test is safe to run against a populated local dev DB too.
    const HUNDRED_YEARS_DAYS = 36_525;

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId,
      role: 'member',
      direction: 'inbound',
      content: 'recent — must survive',
    });
    await pool.query(
      `INSERT INTO interactions (platform, conversation_id, user_id, role, direction, content, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() - interval '${HUNDRED_YEARS_DAYS - 1} days')`,
      ['discord', conversationId, userId, 'member', 'inbound', 'just under the cutoff — must survive'],
    );
    await pool.query(
      `INSERT INTO interactions (platform, conversation_id, user_id, role, direction, content, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() - interval '${HUNDRED_YEARS_DAYS + 1} days')`,
      ['discord', conversationId, userId, 'member', 'inbound', 'just over the cutoff — must be purged'],
    );

    const kId = await saveKnowledge({
      content: 'durable fact',
      title: 'K',
      scope: 'global',
      sourceUserId: userId,
    });
    await pool.query(
      `UPDATE knowledge SET created_at = now() - interval '${HUNDRED_YEARS_DAYS + 1} days',
                            updated_at = now() - interval '${HUNDRED_YEARS_DAYS + 1} days'
        WHERE id = $1`,
      [kId],
    );
    await recordAdminAction({
      platform: 'discord',
      actorUserId: `${RUN}-actor`,
      actionKind: 'test_fixture',
      targetUserId: userId,
      success: true,
    });

    const deleted = await purgeOldInteractions(HUNDRED_YEARS_DAYS);
    assert.ok(deleted >= 1, 'at least our over-the-cutoff fixture was deleted');

    const remaining = await pool.query(
      `SELECT content FROM interactions WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    assert.deepEqual(
      remaining.rows.map((r) => r.content).sort(),
      ['just under the cutoff — must survive', 'recent — must survive'].sort(),
      'only the row older than the cutoff is removed',
    );

    const knowledgeRow = await pool.query(`SELECT id FROM knowledge WHERE id = $1`, [kId]);
    assert.equal(
      knowledgeRow.rows.length,
      1,
      'knowledge is never touched by purgeOldInteractions regardless of age',
    );

    const auditRow = await pool.query(`SELECT id FROM admin_audit WHERE target_user_id = $1`, [userId]);
    assert.equal(auditRow.rows.length, 1, 'admin_audit is never touched by purgeOldInteractions');

    // Cleanup.
    await pool.query(`DELETE FROM interactions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [kId]);
    await pool.query(`DELETE FROM admin_audit WHERE target_user_id = $1`, [userId]);
  },
);

test(
  'repository: purgeUserData deletes only the target user (interactions + sourced knowledge)',
  { skip },
  async () => {
    const targetUser = `${RUN}-target`;
    const otherUser = `${RUN}-other`;
    const conversationId = `${RUN}-c-purge-user`;

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: targetUser,
      role: 'member',
      direction: 'inbound',
      content: 'target message',
    });
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: otherUser,
      role: 'member',
      direction: 'inbound',
      content: 'other user message',
    });
    const targetKnowledgeId = await saveKnowledge({
      content: 'from target',
      sourceUserId: targetUser,
      scope: 'global',
    });
    const otherKnowledgeId = await saveKnowledge({
      content: 'from other',
      sourceUserId: otherUser,
      scope: 'global',
    });
    await recordAdminAction({
      platform: 'discord',
      actorUserId: `${RUN}-actor2`,
      actionKind: 'test_fixture',
      targetUserId: targetUser,
      success: true,
    });

    const purged = await purgeUserData('discord', targetUser);
    assert.ok(purged >= 2, 'purged count covers the target interaction + knowledge row');

    const targetRows = await pool.query(`SELECT 1 FROM interactions WHERE user_id = $1`, [targetUser]);
    assert.equal(targetRows.rows.length, 0, 'target user interactions are gone');

    const otherRows = await pool.query(`SELECT content FROM interactions WHERE user_id = $1`, [otherUser]);
    assert.equal(otherRows.rows.length, 1, 'other user interactions are untouched');

    const targetKnowledge = await pool.query(`SELECT 1 FROM knowledge WHERE id = $1`, [targetKnowledgeId]);
    assert.equal(targetKnowledge.rows.length, 0, 'knowledge sourced from the target user is gone');

    const otherKnowledge = await pool.query(`SELECT 1 FROM knowledge WHERE id = $1`, [otherKnowledgeId]);
    assert.equal(otherKnowledge.rows.length, 1, "other user's knowledge is untouched");

    const auditRow = await pool.query(`SELECT 1 FROM admin_audit WHERE target_user_id = $1`, [targetUser]);
    assert.equal(
      auditRow.rows.length,
      1,
      'admin_audit (accountability trail) is retained deliberately, not purged',
    );

    // Cleanup.
    await pool.query(`DELETE FROM interactions WHERE user_id = $1`, [otherUser]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [otherKnowledgeId]);
    await pool.query(`DELETE FROM admin_audit WHERE target_user_id = $1`, [targetUser]);
  },
);

test(
  'repository: knowledge CRUD — insert, search finds it, update re-embeds and bumps updated_at, delete removes it',
  { skip },
  async () => {
    const id = await saveKnowledge({
      title: 'Meetup schedule',
      content: 'We meet monthly on the first Tuesday.',
      scope: `${RUN}-scope`,
    });

    const foundBefore = await searchKnowledge('monthly meetup schedule', 20);
    const hitBefore = foundBefore.find((h) => h.content.includes('first Tuesday'));
    assert.ok(hitBefore, 'search finds the freshly-saved entry');
    assert.ok(hitBefore.updatedAt, 'search result carries updatedAt');

    const beforeRow = await pool.query(`SELECT updated_at FROM knowledge WHERE id = $1`, [id]);
    const updated = await updateKnowledge({ id, content: 'We meet monthly on the SECOND Tuesday now.' });
    assert.equal(updated, true);

    const afterRow = await pool.query(`SELECT title, content, updated_at FROM knowledge WHERE id = $1`, [id]);
    assert.equal(afterRow.rows[0].title, 'Meetup schedule', 'unspecified field (title) is preserved');
    assert.equal(afterRow.rows[0].content, 'We meet monthly on the SECOND Tuesday now.');
    assert.ok(
      new Date(afterRow.rows[0].updated_at).getTime() > new Date(beforeRow.rows[0].updated_at).getTime(),
      'updated_at is bumped',
    );

    const foundAfterUpdate = await searchKnowledge('second Tuesday meetup', 20);
    const hitAfter = foundAfterUpdate.find((h) => h.content.includes('SECOND Tuesday'));
    assert.ok(hitAfter, 're-embedding means search finds the new content');
    assert.equal(
      new Date(hitAfter.updatedAt).getTime(),
      new Date(afterRow.rows[0].updated_at).getTime(),
      'searchKnowledge reflects the bumped updatedAt from update_knowledge',
    );

    const deleted = await deleteKnowledge(id);
    assert.equal(deleted, true);

    const goneRow = await pool.query(`SELECT 1 FROM knowledge WHERE id = $1`, [id]);
    assert.equal(goneRow.rows.length, 0);

    const deletedAgain = await deleteKnowledge(id);
    assert.equal(deletedAgain, false, 'deleting a nonexistent id returns false, not an error');
  },
);

test(
  'SECURITY: repository: admin conversation scoping excludes conversations outside the given list',
  { skip },
  async () => {
    const userId = `${RUN}-scoped-user`;
    const inScopeConvo = `${RUN}-c-in-scope`;
    const outOfScopeConvo = `${RUN}-c-out-of-scope`;

    await recordInteraction({
      platform: 'discord',
      conversationId: inScopeConvo,
      userId,
      role: 'member',
      direction: 'inbound',
      content: 'visible to the scoped admin',
    });
    await recordInteraction({
      platform: 'discord',
      conversationId: outOfScopeConvo,
      userId,
      role: 'member',
      direction: 'inbound',
      content: 'must NOT be visible — admin is not in this conversation',
    });

    const unscoped = await userMessages('discord', userId, 20);
    assert.equal(
      unscoped.length,
      2,
      'without a scope filter, both conversations are visible (super-admin/no-filter path)',
    );

    const scoped = await userMessages('discord', userId, 20, [inScopeConvo]);
    assert.equal(scoped.length, 1, 'the admin-scoped query returns only the in-scope conversation');
    assert.equal(scoped[0].conversationId, inScopeConvo);
    assert.ok(
      !scoped.some((r) => r.conversationId === outOfScopeConvo),
      'SECURITY: a conversation outside the scope filter must never be returned',
    );

    await pool.query(`DELETE FROM interactions WHERE user_id = $1`, [userId]);
  },
);

test(
  'repository: recentQuestionClusters groups near-duplicate embeddings, separates unrelated ones, and enforces count >= 2',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-digest`;

    // Hand-crafted vectors (not run through the real embedding model) so
    // similarity is deterministic: two identical "same question" vectors
    // cluster together; an orthogonal vector stays its own singleton cluster
    // and is dropped by the count >= 2 filter.
    const dim = config.db.embeddingDim;
    const sameQuestionVec = new Array(dim).fill(0);
    sameQuestionVec[0] = 1;
    const unrelatedVec = new Array(dim).fill(0);
    unrelatedVec[1] = 1;

    const insertAddressed = (content: string, vec: number[]) =>
      pool.query(
        `INSERT INTO interactions
         (platform, conversation_id, user_id, role, direction, content, addressed_to_bot, embedding)
       VALUES ($1,$2,$3,$4,'inbound',$5,true,$6)`,
        ['discord', conversationId, `${RUN}-digest-user`, 'member', content, pgvector.toSql(vec)],
      );

    await insertAddressed('How do I reset my password?', sameQuestionVec);
    await insertAddressed('I forgot my password, how do I reset it?', sameQuestionVec);
    await insertAddressed('What time is the next meetup?', unrelatedVec);

    const clusters = await recentQuestionClusters([conversationId], 7, 10);
    assert.equal(clusters.length, 1, 'only the count >= 2 cluster survives; the singleton is dropped');
    assert.equal(clusters[0].count, 2);
    assert.equal(
      clusters[0].representative,
      'How do I reset my password?',
      'representative is the first message seen',
    );

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  'SECURITY: repository: recentQuestionClusters excludes conversations outside the given scope',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-digest-in`;
    const outOfScopeConvo = `${RUN}-c-digest-out`;
    const dim = config.db.embeddingDim;
    const vec = new Array(dim).fill(0);
    vec[2] = 1;

    const insertAddressed = (conversationId: string, content: string) =>
      pool.query(
        `INSERT INTO interactions
         (platform, conversation_id, user_id, role, direction, content, addressed_to_bot, embedding)
       VALUES ($1,$2,$3,$4,'inbound',$5,true,$6)`,
        ['discord', conversationId, `${RUN}-digest-scope-user`, 'member', content, pgvector.toSql(vec)],
      );

    await insertAddressed(inScopeConvo, 'in-scope question A');
    await insertAddressed(inScopeConvo, 'in-scope question B');
    await insertAddressed(outOfScopeConvo, 'out-of-scope question A');
    await insertAddressed(outOfScopeConvo, 'out-of-scope question B');

    const scoped = await recentQuestionClusters([inScopeConvo], 7, 10);
    assert.equal(scoped.length, 1, 'clusters only reflect the in-scope conversation');
    assert.equal(scoped[0].count, 2);

    const unscoped = await recentQuestionClusters(null, 7, 10);
    const totalUnscoped = unscoped.reduce((n, c) => n + c.count, 0);
    assert.ok(totalUnscoped >= 4, 'without a scope filter (super admin), both conversations contribute');

    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [
      [inScopeConvo, outOfScopeConvo],
    ]);
  },
);

test(
  'SECURITY: repository: recentModerationEntries scopes by conversation, allow-lists action_kind, and omits params',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-modhist-in`;
    const outOfScopeConvo = `${RUN}-c-modhist-out`;
    const actor = `${RUN}-modhist-admin`;
    const target = `${RUN}-modhist-target`;

    await recordAdminAction({
      platform: 'discord',
      actorUserId: actor,
      actionKind: 'warn_user',
      targetUserId: target,
      conversationId: inScopeConvo,
      params: { reason: 'be nice please — this is sensitive free text' },
      result: 'warned',
      success: true,
    });
    // Same conversation, but a privileged non-moderation kind — must never appear,
    // even scoped to a conversation the admin belongs to (allow-list, not deny-list).
    await recordAdminAction({
      platform: 'discord',
      actorUserId: actor,
      actionKind: 'grant_admin',
      targetUserId: target,
      conversationId: inScopeConvo,
      result: 'granted',
      success: true,
    });
    // Different conversation, otherwise-whitelisted kind — must not leak into an
    // admin's scoped view of inScopeConvo.
    await recordAdminAction({
      platform: 'discord',
      actorUserId: actor,
      actionKind: 'timeout_user',
      targetUserId: target,
      conversationId: outOfScopeConvo,
      result: 'timed out',
      success: true,
    });

    const scoped = await recentModerationEntries([inScopeConvo], 20);
    assert.equal(scoped.length, 1, 'only the whitelisted, in-scope entry survives');
    assert.equal(scoped[0].actionKind, 'warn_user');
    assert.equal(scoped[0].conversationId, inScopeConvo, 'conversation_id is surfaced');
    assert.ok(!('params' in scoped[0]), 'params (may carry free-text PII) is never returned');
    assert.ok(
      scoped.every((r) => r.actionKind !== 'grant_admin'),
      "grant_admin never appears, even within the admin's own conversation",
    );

    const unscoped = await recentModerationEntries(null, 20);
    const kinds = unscoped
      .filter((r) => r.conversationId === inScopeConvo || r.conversationId === outOfScopeConvo)
      .map((r) => r.actionKind);
    assert.ok(
      kinds.includes('warn_user') && kinds.includes('timeout_user'),
      'super admin (null scope) sees both conversations',
    );
    assert.ok(!kinds.includes('grant_admin'), 'allow-list applies regardless of scope');

    const clamped = await recentModerationEntries(null, 10_000);
    assert.ok(clamped.length <= 100, 'limit is clamped to a sane maximum for a non-super-admin-only tool');

    await pool.query(`DELETE FROM admin_audit WHERE actor_user_id = $1`, [actor]);
  },
);

test(
  'repository: usageStats.costByRole aggregates cost_usd by role over outbound rows only, ordered deterministically',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-cost-role`;
    const adminUser = `${RUN}-cost-admin`;
    const memberUser = `${RUN}-cost-member`;
    const guestUser = `${RUN}-cost-guest`;

    const days = 1;
    const before = await usageStats(days);
    const beforeByRole = new Map(before.costByRole.map((r) => [r.role, r]));

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: adminUser,
      role: 'admin',
      direction: 'outbound',
      content: 'admin reply 1',
      costUsd: 2.5,
    });
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: adminUser,
      role: 'admin',
      direction: 'outbound',
      content: 'admin reply 2',
      costUsd: 1.5,
    });
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: memberUser,
      role: 'member',
      direction: 'outbound',
      content: 'member reply',
      costUsd: 0.25,
    });
    // Inbound-only role: costByRole is scoped to direction = 'outbound', so this
    // must not create or bump a 'guest' entry.
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: guestUser,
      role: 'guest',
      direction: 'inbound',
      content: 'guest asks a question',
    });

    const after = await usageStats(days);
    const afterByRole = new Map(after.costByRole.map((r) => [r.role, r]));

    const adminBeforeCost = beforeByRole.get('admin')?.costUsd ?? 0;
    const adminBeforeReplies = beforeByRole.get('admin')?.replies ?? 0;
    const adminAfter = afterByRole.get('admin');
    assert.ok(adminAfter, 'admin role appears after seeding outbound admin cost');
    assert.equal(adminAfter.costUsd - adminBeforeCost, 4, 'admin cost sums the seeded 2.5 + 1.5');
    assert.equal(adminAfter.replies - adminBeforeReplies, 2, 'admin reply count reflects both outbound rows');

    const memberBeforeCost = beforeByRole.get('member')?.costUsd ?? 0;
    const memberBeforeReplies = beforeByRole.get('member')?.replies ?? 0;
    const memberAfter = afterByRole.get('member');
    assert.ok(memberAfter, 'member role appears after seeding outbound member cost');
    assert.equal(memberAfter.costUsd - memberBeforeCost, 0.25, 'member cost reflects the seeded 0.25');
    assert.equal(memberAfter.replies - memberBeforeReplies, 1);

    assert.deepEqual(
      afterByRole.get('guest'),
      beforeByRole.get('guest'),
      'guest had only an inbound row in this test, so its costByRole entry (or absence) is unchanged — not a spurious zero-cost row',
    );

    for (let i = 1; i < after.costByRole.length; i++) {
      const prev = after.costByRole[i - 1];
      const curr = after.costByRole[i];
      assert.ok(
        prev.costUsd > curr.costUsd || (prev.costUsd === curr.costUsd && prev.role < curr.role),
        'costByRole is ordered by cost_usd desc, then role asc as a deterministic tiebreaker',
      );
    }

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
  },
);
