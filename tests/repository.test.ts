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

const skip = hasDb ? false : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
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

    const kId = await saveKnowledge({ content: 'durable fact', title: 'K', scope: 'global', sourceUserId: userId });
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
    assert.equal(knowledgeRow.rows.length, 1, 'knowledge is never touched by purgeOldInteractions regardless of age');

    const auditRow = await pool.query(`SELECT id FROM admin_audit WHERE target_user_id = $1`, [userId]);
    assert.equal(auditRow.rows.length, 1, 'admin_audit is never touched by purgeOldInteractions');

    // Cleanup.
    await pool.query(`DELETE FROM interactions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [kId]);
    await pool.query(`DELETE FROM admin_audit WHERE target_user_id = $1`, [userId]);
  },
);

test('repository: purgeUserData deletes only the target user (interactions + sourced knowledge)', { skip }, async () => {
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
  const targetKnowledgeId = await saveKnowledge({ content: 'from target', sourceUserId: targetUser, scope: 'global' });
  const otherKnowledgeId = await saveKnowledge({ content: 'from other', sourceUserId: otherUser, scope: 'global' });
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
  assert.equal(auditRow.rows.length, 1, 'admin_audit (accountability trail) is retained deliberately, not purged');

  // Cleanup.
  await pool.query(`DELETE FROM interactions WHERE user_id = $1`, [otherUser]);
  await pool.query(`DELETE FROM knowledge WHERE id = $1`, [otherKnowledgeId]);
  await pool.query(`DELETE FROM admin_audit WHERE target_user_id = $1`, [targetUser]);
});

test('repository: knowledge CRUD — insert, search finds it, update re-embeds and bumps updated_at, delete removes it', { skip }, async () => {
  const id = await saveKnowledge({ title: 'Meetup schedule', content: 'We meet monthly on the first Tuesday.', scope: `${RUN}-scope` });

  const foundBefore = await searchKnowledge('monthly meetup schedule', 20);
  assert.ok(foundBefore.some((h) => h.content.includes('first Tuesday')), 'search finds the freshly-saved entry');

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
  assert.ok(
    foundAfterUpdate.some((h) => h.content.includes('SECOND Tuesday')),
    're-embedding means search finds the new content',
  );

  const deleted = await deleteKnowledge(id);
  assert.equal(deleted, true);

  const goneRow = await pool.query(`SELECT 1 FROM knowledge WHERE id = $1`, [id]);
  assert.equal(goneRow.rows.length, 0);

  const deletedAgain = await deleteKnowledge(id);
  assert.equal(deletedAgain, false, 'deleting a nonexistent id returns false, not an error');
});

test('SECURITY: repository: admin conversation scoping excludes conversations outside the given list', { skip }, async () => {
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
  assert.equal(unscoped.length, 2, 'without a scope filter, both conversations are visible (super-admin/no-filter path)');

  const scoped = await userMessages('discord', userId, 20, [inScopeConvo]);
  assert.equal(scoped.length, 1, 'the admin-scoped query returns only the in-scope conversation');
  assert.equal(scoped[0].conversationId, inScopeConvo);
  assert.ok(
    !scoped.some((r) => r.conversationId === outOfScopeConvo),
    'SECURITY: a conversation outside the scope filter must never be returned',
  );

  await pool.query(`DELETE FROM interactions WHERE user_id = $1`, [userId]);
});
