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
  createContentReport,
  listReports,
  resolveContentReport,
  REPORT_RATE_LIMIT_PER_DAY,
  upsertMember,
  getMemberRole,
  removeMember,
  linkMembers,
  unlinkMember,
  resolveLinkedIdentities,
  countRepliesToUser,
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
  'repository: purgeUserData deletes only the target user (interactions + sourced knowledge + own reports)',
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
    // The target user's own submitted report (as reporter) must be purged...
    const ownReport = await createContentReport({
      platform: 'discord',
      reporterUserId: targetUser,
      conversationId,
      reason: 'reported by the target user themself',
    });
    assert.ok(ownReport, 'fixture report was recorded');
    // ...but a report naming them only as the *target* (someone else reporting
    // them) is accountability data and must survive their own purge request.
    const reportAboutThem = await createContentReport({
      platform: 'discord',
      reporterUserId: otherUser,
      conversationId,
      targetUserId: targetUser,
      reason: 'reported by someone else, targeting this user',
    });
    assert.ok(reportAboutThem, 'fixture report about the target was recorded');

    const purged = await purgeUserData('discord', targetUser);
    assert.ok(purged >= 3, 'purged count covers the target interaction + knowledge row + own report');

    const targetRows = await pool.query(`SELECT 1 FROM interactions WHERE user_id = $1`, [targetUser]);
    assert.equal(targetRows.rows.length, 0, 'target user interactions are gone');

    const otherRows = await pool.query(`SELECT content FROM interactions WHERE user_id = $1`, [otherUser]);
    assert.equal(otherRows.rows.length, 1, 'other user interactions are untouched');

    const targetKnowledge = await pool.query(`SELECT 1 FROM knowledge WHERE id = $1`, [targetKnowledgeId]);
    assert.equal(targetKnowledge.rows.length, 0, 'knowledge sourced from the target user is gone');

    const otherKnowledge = await pool.query(`SELECT 1 FROM knowledge WHERE id = $1`, [otherKnowledgeId]);
    assert.equal(otherKnowledge.rows.length, 1, "other user's knowledge is untouched");

    const ownReportRow = await pool.query(`SELECT 1 FROM content_reports WHERE id = $1`, [ownReport.id]);
    assert.equal(ownReportRow.rows.length, 0, "the target's own submitted report is purged");

    const targetedReportRow = await pool.query(`SELECT 1 FROM content_reports WHERE id = $1`, [
      reportAboutThem.id,
    ]);
    assert.equal(
      targetedReportRow.rows.length,
      1,
      'a report where the user is only the target (not reporter) is retained as accountability data',
    );

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
    await pool.query(`DELETE FROM content_reports WHERE id = $1`, [reportAboutThem.id]);
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
  'repository: recentModerationEntries filters by targetUserId and actionKind (issue #80)',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-modfilter-in`;
    const outOfScopeConvo = `${RUN}-c-modfilter-out`;
    const actor = `${RUN}-modfilter-admin`;
    const targetA = `${RUN}-modfilter-target-a`;
    const targetB = `${RUN}-modfilter-target-b`;

    // Two members warned in the same conversation.
    await recordAdminAction({
      platform: 'discord',
      actorUserId: actor,
      actionKind: 'warn_user',
      targetUserId: targetA,
      conversationId: inScopeConvo,
      params: { reason: 'first warning' },
      result: 'warned',
      success: true,
    });
    await recordAdminAction({
      platform: 'discord',
      actorUserId: actor,
      actionKind: 'warn_user',
      targetUserId: targetB,
      conversationId: inScopeConvo,
      result: 'warned',
      success: true,
    });
    // Same member, different (allow-listed) action kind — for the actionKind filter.
    await recordAdminAction({
      platform: 'discord',
      actorUserId: actor,
      actionKind: 'timeout_user',
      targetUserId: targetA,
      conversationId: inScopeConvo,
      result: 'timed out',
      success: true,
    });
    // Same target, same action kind, but in a conversation the admin can't see —
    // must not leak in even though targetUserId/actionKind would otherwise match.
    await recordAdminAction({
      platform: 'discord',
      actorUserId: actor,
      actionKind: 'warn_user',
      targetUserId: targetA,
      conversationId: outOfScopeConvo,
      result: 'warned',
      success: true,
    });

    const byTarget = await recentModerationEntries([inScopeConvo], 20, targetA);
    assert.equal(byTarget.length, 2, 'only targetA rows in-scope survive (warn_user + timeout_user)');
    assert.ok(
      byTarget.every((r) => r.targetUserId === targetA),
      'targetB never appears when filtering by targetA',
    );
    assert.ok(!('params' in byTarget[0]), 'params is still omitted through the filtered path');

    const byKind = await recentModerationEntries([inScopeConvo], 20, undefined, 'warn_user');
    assert.equal(byKind.length, 2, 'both warn_user rows (targetA and targetB) survive the actionKind filter');
    assert.ok(
      byKind.every((r) => r.actionKind === 'warn_user'),
      'timeout_user is excluded when filtering by warn_user',
    );

    const both = await recentModerationEntries([inScopeConvo], 20, targetA, 'warn_user');
    assert.equal(both.length, 1, 'combining filters narrows to their intersection');
    assert.equal(both[0].targetUserId, targetA);
    assert.equal(both[0].actionKind, 'warn_user');

    const scopedNegative = await recentModerationEntries([inScopeConvo], 20, targetA, 'timeout_user');
    assert.ok(
      scopedNegative.every((r) => r.conversationId !== outOfScopeConvo),
      'a valid target/kind filter never surfaces rows from a conversation outside the caller scope',
    );

    const noFilters = await recentModerationEntries([inScopeConvo], 20);
    assert.equal(
      noFilters.length,
      3,
      'omitting both filters is unchanged from today: all 3 in-scope allow-listed rows returned',
    );

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

test(
  'repository: createContentReport enforces a DB-backed rolling-24h cap per reporter, robust to a simulated process restart',
  { skip },
  async () => {
    const reporter = `${RUN}-reporter`;
    const conversationId = `${RUN}-c-report-cap`;

    // Simulate reports written by a *previous* process instance: inserted
    // directly via SQL rather than through createContentReport, so nothing in
    // this test process's memory "knows" about them. An in-memory counter
    // would see zero prior reports here and wrongly accept the next one; a
    // DB-backed COUNT(*) sees them regardless of which process wrote them.
    for (let i = 0; i < REPORT_RATE_LIMIT_PER_DAY; i++) {
      await pool.query(
        `INSERT INTO content_reports (platform, reporter_user_id, conversation_id, reason)
         VALUES ($1,$2,$3,$4)`,
        ['discord', reporter, conversationId, `prior-process report ${i}`],
      );
    }

    const rejected = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId,
      reason: 'the one that should be refused',
    });
    assert.equal(rejected, null, 'the (cap+1)th report is refused, not silently accepted');

    const countAfterRejection = await pool.query(
      `SELECT count(*) AS n FROM content_reports WHERE reporter_user_id = $1`,
      [reporter],
    );
    assert.equal(
      Number(countAfterRejection.rows[0].n),
      REPORT_RATE_LIMIT_PER_DAY,
      'no row is inserted for a refused report',
    );

    // Age one report past the 24h window — it should no longer count, freeing a slot.
    await pool.query(
      `UPDATE content_reports SET created_at = now() - interval '25 hours'
        WHERE id = (SELECT id FROM content_reports WHERE reporter_user_id = $1 ORDER BY id LIMIT 1)`,
      [reporter],
    );
    const accepted = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId,
      reason: 'accepted once one prior report aged out of the 24h window',
    });
    assert.ok(accepted, 'a report is accepted again once an old one falls outside the rolling window');

    // A different reporter is unaffected by another user's cap.
    const otherReporter = `${RUN}-reporter-other`;
    const otherAccepted = await createContentReport({
      platform: 'discord',
      reporterUserId: otherReporter,
      conversationId,
      reason: 'a different reporter has their own independent cap',
    });
    assert.ok(otherAccepted, 'the cap is per-reporter, not global');

    await pool.query(`DELETE FROM content_reports WHERE reporter_user_id = ANY($1)`, [
      [reporter, otherReporter],
    ]);
  },
);

test(
  'repository: createContentReport truncates an over-long reason to 500 characters',
  { skip },
  async () => {
    const reporter = `${RUN}-reporter-long`;
    const conversationId = `${RUN}-c-report-long`;
    const longReason = 'x'.repeat(1000);

    const created = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId,
      reason: longReason,
    });
    assert.ok(created);

    const row = await pool.query(`SELECT reason FROM content_reports WHERE id = $1`, [created.id]);
    assert.equal(row.rows[0].reason.length, 500, 'stored reason is capped at 500 characters');

    await pool.query(`DELETE FROM content_reports WHERE id = $1`, [created.id]);
  },
);

test('SECURITY: repository: listReports scopes by conversation and filters by status', { skip }, async () => {
  const inScopeConvo = `${RUN}-c-reports-in`;
  const outOfScopeConvo = `${RUN}-c-reports-out`;
  const reporter = `${RUN}-reports-list-reporter`;

  const inScope = await createContentReport({
    platform: 'discord',
    reporterUserId: reporter,
    conversationId: inScopeConvo,
    reason: 'in scope, open',
  });
  const outOfScope = await createContentReport({
    platform: 'discord',
    reporterUserId: reporter,
    conversationId: outOfScopeConvo,
    reason: 'must NOT be visible — admin is not in this conversation',
  });
  assert.ok(inScope && outOfScope);

  const scoped = await listReports([inScopeConvo]);
  assert.ok(
    scoped.some((r) => r.id === inScope.id),
    'the in-scope report is visible',
  );
  assert.ok(
    !scoped.some((r) => r.id === outOfScope.id),
    'SECURITY: a report outside the scope filter must never be returned',
  );

  const unscoped = await listReports(null);
  assert.ok(
    unscoped.some((r) => r.id === inScope.id) && unscoped.some((r) => r.id === outOfScope.id),
    'null scope (super admin) sees both conversations',
  );

  const resolved = await resolveContentReport(inScope.id, 'resolved', `${RUN}-resolver`);
  assert.ok(resolved);

  const openOnly = await listReports([inScopeConvo], 'open');
  assert.ok(!openOnly.some((r) => r.id === inScope.id), 'status filter excludes the now-resolved report');
  const resolvedOnly = await listReports([inScopeConvo], 'resolved');
  assert.ok(
    resolvedOnly.some((r) => r.id === inScope.id),
    'status filter surfaces the resolved report',
  );

  await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [[inScope.id, outOfScope.id]]);
});

test(
  'SECURITY: repository: resolveContentReport refuses to update a report outside the given conversation scope',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-resolve-in`;
    const outOfScopeConvo = `${RUN}-c-resolve-out`;
    const reporter = `${RUN}-resolve-reporter`;

    const report = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId: outOfScopeConvo,
      reason: 'an admin scoped only to inScopeConvo must not be able to resolve this',
    });
    assert.ok(report);

    const refused = await resolveContentReport(report.id, 'dismissed', `${RUN}-scoped-admin`, [inScopeConvo]);
    assert.equal(refused, false, 'SECURITY: resolving a report outside the caller scope must fail');

    const stillOpen = await pool.query(`SELECT status FROM content_reports WHERE id = $1`, [report.id]);
    assert.equal(stillOpen.rows[0].status, 'open', 'the out-of-scope report is left untouched');

    const allowed = await resolveContentReport(report.id, 'dismissed', `${RUN}-super-admin`, undefined);
    assert.ok(allowed, 'an unrestricted (super-admin) scope can resolve any report');

    await pool.query(`DELETE FROM content_reports WHERE id = $1`, [report.id]);
  },
);

// --- Cross-platform identity linking (issue #44) ----------------------------

test(
  'repository: linkMembers merges two members into one person; idempotent re-link; unlinkMember dissolves the group cleanly, leaving no dangling person_id or orphaned persons row',
  { skip },
  async () => {
    const discordUser = `${RUN}-link-d`;
    const whatsappUser = `${RUN}-link-w`;
    await upsertMember({ platform: 'discord', userId: discordUser, role: 'member', addedBy: `${RUN}-admin` });
    await upsertMember({
      platform: 'whatsapp',
      userId: whatsappUser,
      role: 'member',
      addedBy: `${RUN}-admin`,
    });

    const solo = await resolveLinkedIdentities('discord', discordUser);
    assert.deepEqual(
      solo,
      [{ platform: 'discord', userId: discordUser }],
      'unlinked member resolves to itself',
    );

    const { personId } = await linkMembers('discord', discordUser, 'whatsapp', whatsappUser);
    assert.ok(personId);

    const linked = await resolveLinkedIdentities('discord', discordUser);
    assert.equal(linked.length, 2, 'both identities now resolve together');
    assert.ok(linked.some((l) => l.platform === 'whatsapp' && l.userId === whatsappUser));
    const linkedFromOtherSide = await resolveLinkedIdentities('whatsapp', whatsappUser);
    assert.equal(linkedFromOtherSide.length, 2, 'the link is symmetric — resolvable from either identity');

    // Re-linking the same pair is a no-op success, not an error.
    const again = await linkMembers('discord', discordUser, 'whatsapp', whatsappUser);
    assert.equal(again.personId, personId, 're-linking an already-linked pair returns the same person id');

    const unlinked = await unlinkMember('discord', discordUser);
    assert.equal(unlinked, true);

    const afterUnlinkA = await resolveLinkedIdentities('discord', discordUser);
    assert.deepEqual(afterUnlinkA, [{ platform: 'discord', userId: discordUser }]);
    const afterUnlinkB = await resolveLinkedIdentities('whatsapp', whatsappUser);
    assert.deepEqual(
      afterUnlinkB,
      [{ platform: 'whatsapp', userId: whatsappUser }],
      'the OTHER identity is also independently resolvable again — unlinking one side dissolves the whole group, not just the caller side',
    );

    const personIdRows = await pool.query(
      `SELECT person_id FROM community_users
        WHERE (platform = 'discord' AND platform_user_id = $1) OR (platform = 'whatsapp' AND platform_user_id = $2)`,
      [discordUser, whatsappUser],
    );
    assert.ok(
      personIdRows.rows.every((r) => r.person_id === null),
      'no dangling person_id survives on either row after unlink',
    );
    const orphanedPersonsRow = await pool.query(`SELECT 1 FROM persons WHERE id = $1`, [personId]);
    assert.equal(
      orphanedPersonsRow.rows.length,
      0,
      'the now-empty persons row is deleted, not left dangling for a future link to reattach to unexpectedly',
    );

    const unlinkingAgain = await unlinkMember('discord', discordUser);
    assert.equal(unlinkingAgain, false, 'unlinking an already-unlinked identity reports false, not an error');

    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      discordUser,
    ]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'whatsapp' AND platform_user_id = $1`, [
      whatsappUser,
    ]);
  },
);

test(
  'repository: linkMembers merges two pre-existing person groups when linking across them',
  { skip },
  async () => {
    const d1 = `${RUN}-merge-d1`;
    const w1 = `${RUN}-merge-w1`;
    const d2 = `${RUN}-merge-d2`;
    const w2 = `${RUN}-merge-w2`;
    for (const [platform, userId] of [
      ['discord', d1],
      ['whatsapp', w1],
      ['discord', d2],
      ['whatsapp', w2],
    ] as const) {
      await upsertMember({ platform, userId, role: 'member', addedBy: `${RUN}-admin` });
    }

    const groupOne = await linkMembers('discord', d1, 'whatsapp', w1);
    const groupTwo = await linkMembers('discord', d2, 'whatsapp', w2);
    assert.notEqual(
      groupOne.personId,
      groupTwo.personId,
      'two independent links start as two separate groups',
    );

    // Link across the two existing groups (via one member of each).
    const merged = await linkMembers('whatsapp', w1, 'discord', d2);
    assert.ok(merged.personId === groupOne.personId || merged.personId === groupTwo.personId);

    const finalGroup = await resolveLinkedIdentities('discord', d1);
    assert.equal(finalGroup.length, 4, 'all four identities now share one person after the cross-group link');

    const remainingPersonsRows = await pool.query(`SELECT count(*) AS n FROM persons WHERE id = ANY($1)`, [
      [groupOne.personId, groupTwo.personId],
    ]);
    assert.equal(
      Number(remainingPersonsRows.rows[0].n),
      1,
      "the losing group's now-empty persons row is deleted on merge, not left dangling",
    );

    await pool.query(
      `DELETE FROM community_users WHERE (platform = 'discord' AND platform_user_id = ANY($1))
                                       OR (platform = 'whatsapp' AND platform_user_id = ANY($2))`,
      [
        [d1, d2],
        [w1, w2],
      ],
    );
  },
);

test(
  'SECURITY: repository: linkMembers refuses an identity that is not already a known community member',
  { skip },
  async () => {
    const knownMember = `${RUN}-known-for-link`;
    const unknownUser = `${RUN}-never-added`;
    await upsertMember({
      platform: 'discord',
      userId: knownMember,
      role: 'member',
      addedBy: `${RUN}-admin`,
    });

    await assert.rejects(
      linkMembers('discord', knownMember, 'whatsapp', unknownUser),
      /must already be known community members/,
      'SECURITY: linking must refuse a target the bot has no community_users row for',
    );

    const row = await pool.query(
      `SELECT person_id FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`,
      [knownMember],
    );
    assert.equal(row.rows[0].person_id, null, 'the known identity is left unlinked, not partially linked');

    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      knownMember,
    ]);
  },
);

test(
  'SECURITY: repository: purgeUserData (forget_me/purge_user_data) cascades across linked identities — linking deliberately expands the blast radius, so forget_me from EITHER identity erases BOTH (see docs/SECURITY.md)',
  { skip },
  async () => {
    const discordUser = `${RUN}-cascade-d`;
    const whatsappUser = `${RUN}-cascade-w`;
    const conversationId = `${RUN}-c-cascade`;
    await upsertMember({ platform: 'discord', userId: discordUser, role: 'member', addedBy: `${RUN}-admin` });
    await upsertMember({
      platform: 'whatsapp',
      userId: whatsappUser,
      role: 'member',
      addedBy: `${RUN}-admin`,
    });
    await linkMembers('discord', discordUser, 'whatsapp', whatsappUser);

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: discordUser,
      role: 'member',
      direction: 'inbound',
      content: 'discord-side message that must be purged by a whatsapp-side forget_me',
    });
    await recordInteraction({
      platform: 'whatsapp',
      conversationId,
      userId: whatsappUser,
      role: 'member',
      direction: 'inbound',
      content: 'whatsapp-side message',
    });

    // forget_me/purge_user_data invoked from the WHATSAPP identity only.
    const purged = await purgeUserData('whatsapp', whatsappUser);
    assert.ok(purged >= 2, 'both linked identities contribute to the purged count from a single call');

    const discordRows = await pool.query(
      `SELECT 1 FROM interactions WHERE platform = 'discord' AND user_id = $1`,
      [discordUser],
    );
    assert.equal(
      discordRows.rows.length,
      0,
      'SECURITY: forget_me from the linked WhatsApp identity also erases the Discord identity — the intended cascade',
    );
    const whatsappRows = await pool.query(
      `SELECT 1 FROM interactions WHERE platform = 'whatsapp' AND user_id = $1`,
      [whatsappUser],
    );
    assert.equal(whatsappRows.rows.length, 0);

    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      discordUser,
    ]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'whatsapp' AND platform_user_id = $1`, [
      whatsappUser,
    ]);
  },
);

test(
  'repository: removeMember dissolves a person group it would leave with a single member (no orphaned persons row)',
  { skip },
  async () => {
    const d = `${RUN}-rm-d`;
    const w = `${RUN}-rm-w`;
    await upsertMember({ platform: 'discord', userId: d, role: 'member', addedBy: `${RUN}-admin` });
    await upsertMember({ platform: 'whatsapp', userId: w, role: 'member', addedBy: `${RUN}-admin` });
    const { personId } = await linkMembers('discord', d, 'whatsapp', w);

    const removed = await removeMember('discord', d);
    assert.equal(removed, true, 'the linked member row is removed');

    // The surviving identity must not be stranded in a one-member group...
    const survivors = await resolveLinkedIdentities('whatsapp', w);
    assert.deepEqual(
      survivors,
      [{ platform: 'whatsapp', userId: w }],
      'the surviving identity is unlinked once its only co-member is removed',
    );
    // ...and the now-empty persons row must be deleted, not orphaned.
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM persons WHERE id = $1', [personId]);
    assert.equal(rows[0].n, 0, 'the emptied persons row is deleted');

    await pool.query(`DELETE FROM community_users WHERE platform = 'whatsapp' AND platform_user_id = $1`, [
      w,
    ]);
  },
);

test(
  'SECURITY: repository: linking a member to an admin never propagates tier — each identity keeps its own role',
  { skip },
  async () => {
    const memberUser = `${RUN}-notier-member`;
    const adminUser = `${RUN}-notier-admin`;
    await upsertMember({ platform: 'discord', userId: memberUser, role: 'member', addedBy: `${RUN}-admin` });
    await upsertMember({ platform: 'whatsapp', userId: adminUser, role: 'admin', addedBy: `${RUN}-admin` });

    await linkMembers('discord', memberUser, 'whatsapp', adminUser);

    // The link must actually have taken effect, else the role assertions below
    // are vacuously true (getMemberRole is per-row) and this guards nothing.
    const linked = await resolveLinkedIdentities('discord', memberUser);
    assert.equal(linked.length, 2, 'precondition: the two identities resolve as one linked person');

    assert.equal(
      await getMemberRole('discord', memberUser),
      'member',
      'SECURITY: a member linked to an admin must still resolve as member-only, never inheriting the admin tier',
    );
    assert.equal(
      await getMemberRole('whatsapp', adminUser),
      'admin',
      'the admin identity keeps its own role too — linking is symmetric-safe',
    );

    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      memberUser,
    ]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'whatsapp' AND platform_user_id = $1`, [
      adminUser,
    ]);
  },
);

test(
  'SECURITY: repository: countRepliesToUser (daily reply budget) aggregates across linked identities so the budget cannot be double-dipped cross-platform',
  { skip },
  async () => {
    const discordUser = `${RUN}-budget-d`;
    const whatsappUser = `${RUN}-budget-w`;
    const conversationId = `${RUN}-c-budget`;
    await upsertMember({ platform: 'discord', userId: discordUser, role: 'member', addedBy: `${RUN}-admin` });
    await upsertMember({
      platform: 'whatsapp',
      userId: whatsappUser,
      role: 'member',
      addedBy: `${RUN}-admin`,
    });

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'reply on discord',
      meta: { replyToUserId: discordUser },
    });
    await recordInteraction({
      platform: 'whatsapp',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'reply on whatsapp',
      meta: { replyToUserId: whatsappUser },
    });

    assert.equal(
      await countRepliesToUser('discord', discordUser),
      1,
      'before linking, each identity is independent',
    );
    assert.equal(await countRepliesToUser('whatsapp', whatsappUser), 1);

    await linkMembers('discord', discordUser, 'whatsapp', whatsappUser);

    assert.equal(
      await countRepliesToUser('discord', discordUser),
      2,
      'SECURITY: after linking, the count from the discord identity includes the linked whatsapp replies too',
    );
    assert.equal(
      await countRepliesToUser('whatsapp', whatsappUser),
      2,
      'symmetric: the count from the whatsapp identity includes the linked discord replies too',
    );

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      discordUser,
    ]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'whatsapp' AND platform_user_id = $1`, [
      whatsappUser,
    ]);
  },
);
