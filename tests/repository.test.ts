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
  setClaudeSessionId,
  getClaudeSession,
  clearUserSessions,
  userMessages,
  purgeOldInteractions,
  purgeUserData,
  saveKnowledge,
  searchKnowledge,
  updateKnowledge,
  deleteKnowledge,
  listKnowledge,
  isKnowledgeStale,
  recordKnowledgeRetrieval,
  insertContextDigest,
  insertKnowledgeCandidate,
  listKnowledgeCandidates,
  acceptKnowledgeCandidate,
  declineKnowledgeCandidate,
  listDuplicateKnowledge,
  countPendingKnowledgeCandidates,
  hasQueuedCandidateForTopic,
  knowledgeCoversTopic,
  recordAdminAction,
  recentQuestionClusters,
  recentKnowledgeGapClusters,
  recordKnowledgeGap,
  KNOWLEDGE_GAP_DAILY_LIMIT,
  recentModerationEntries,
  usageStats,
  createContentReport,
  listReports,
  listOwnReports,
  resolveContentReport,
  withdrawOwnReports,
  countOpenReports,
  countRecentDmReportsByReporterAndTarget,
  REPORT_RATE_LIMIT_PER_DAY,
  recordAccessRequest,
  countAccessRequests,
  clearAccessRequest,
  upsertRosterMember,
  markRosterLeave,
  listRoster,
  rosterCounts,
  purgeDepartedRoster,
  addMemberNote,
  listMemberNotes,
  deleteMemberNote,
  MEMBER_NOTE_MAX_CHARS,
  createSuggestion,
  listSuggestions,
  listOwnSuggestions,
  resolveSuggestion,
  countPendingSuggestions,
  SUGGESTION_RATE_LIMIT_PER_DAY,
  SUGGESTION_MAX_CHARS,
  upsertMember,
  getMemberRole,
  resolveDisplayName,
  removeMember,
  linkMembers,
  unlinkMember,
  resolveLinkedIdentities,
  countRepliesToUser,
  getResponseStyle,
  setResponseStyle,
  getLanguagePreference,
  setLanguagePreference,
  createAnswerFeedback,
  listAnswerFeedback,
  listKnowledgeFeedbackSummary,
  isKnowledgeLowRated,
  RATE_ANSWER_DAILY_LIMIT,
  recordAdminDigestSent,
  getMyDataSummary,
  addWarning,
  countActiveWarnings,
  countStaleKnowledge,
  isKnownMessage,
  deleteInteractionByMessageId,
  getInteractionAuthorByMessageId,
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

    const { id: kId } = await saveKnowledge({
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
  "repository: clearUserSessions resets the target user's active-conversation sessions and only those (role change takes effect immediately)",
  { skip },
  async () => {
    const userA = `${RUN}-cus-A`;
    const userB = `${RUN}-cus-B`;
    const convA1 = `${RUN}-cus-a1`; // A is active here
    const convA2 = `${RUN}-cus-a2`; // A is active here too
    const convB = `${RUN}-cus-b`; // only B is active here

    // A talks in two conversations, B in a third. Each conversation has a live session.
    for (const [conv, user] of [
      [convA1, userA],
      [convA2, userA],
      [convB, userB],
    ] as const) {
      await recordInteraction({
        platform: 'discord',
        conversationId: conv,
        userId: user,
        role: 'member',
        direction: 'inbound',
        content: 'hi',
      });
      await setClaudeSessionId('discord', conv, `sess-${conv}`);
    }

    const cleared = await clearUserSessions('discord', userA);
    assert.equal(cleared, 2, "only A's two conversation sessions are cleared");

    assert.equal(await getClaudeSession('discord', convA1), null, "A's session in convA1 is reset");
    assert.equal(await getClaudeSession('discord', convA2), null, "A's session in convA2 is reset");
    const bSession = await getClaudeSession('discord', convB);
    assert.equal(
      bSession?.sessionId,
      `sess-${convB}`,
      "an unrelated user's session must be untouched — reset is scoped to the target's own conversations",
    );

    // Wrong platform is scoped out too.
    assert.equal(await clearUserSessions('whatsapp', userA), 0, 'platform is part of the scope');

    await pool.query(`DELETE FROM sessions WHERE conversation_id = ANY($1)`, [[convA1, convA2, convB]]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [[convA1, convA2, convB]]);
  },
);

test(
  'SECURITY: repository: isKnownMessage is true only for a message id the bot actually stored, scoped to platform + conversation (issue #231)',
  { skip },
  async () => {
    const conv = `${RUN}-ikm-conv`;
    const otherConv = `${RUN}-ikm-other-conv`;
    const messageId = `${RUN}-ikm-msg`;

    await recordInteraction({
      platform: 'discord',
      conversationId: conv,
      userId: `${RUN}-ikm-user`,
      role: 'member',
      direction: 'inbound',
      content: 'hello',
      messageId,
    });

    assert.equal(
      await isKnownMessage('discord', conv, messageId),
      true,
      'a stored message id in its own conversation is known',
    );
    assert.equal(
      await isKnownMessage('discord', otherConv, messageId),
      false,
      'SECURITY: the same message id must not be known in a different conversation',
    );
    assert.equal(
      await isKnownMessage('whatsapp', conv, messageId),
      false,
      'SECURITY: the same message id must not be known on a different platform',
    );
    assert.equal(
      await isKnownMessage('discord', conv, `${messageId}-never-seen`),
      false,
      'an id the bot never stored is never known',
    );

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conv]);
  },
);

test(
  "SECURITY: repository: withdrawOwnReports only touches the caller's OWN open reports — never another reporter's, never a non-open one",
  { skip },
  async () => {
    const reporterA = `${RUN}-wd-A`;
    const reporterB = `${RUN}-wd-B`;
    const conv = `${RUN}-c-withdraw`;

    // A files two reports; B files one. All start 'open'.
    const a1 = await createContentReport({
      platform: 'discord',
      reporterUserId: reporterA,
      conversationId: conv,
      reason: "A's first report",
    });
    const a2 = await createContentReport({
      platform: 'discord',
      reporterUserId: reporterA,
      conversationId: conv,
      reason: "A's second report",
    });
    const b1 = await createContentReport({
      platform: 'discord',
      reporterUserId: reporterB,
      conversationId: conv,
      reason: "B's report",
    });
    assert.ok(a1 && a2 && b1, 'fixtures recorded');

    // A's second report is already resolved by an admin — withdrawal must skip it.
    await resolveContentReport(a2.id, 'resolved', 'some-admin');

    const withdrawn = await withdrawOwnReports('discord', reporterA);

    assert.deepEqual(withdrawn, [a1.id], "only A's single OPEN report is withdrawn");

    const statusOf = async (id: number) =>
      (await pool.query(`SELECT status FROM content_reports WHERE id = $1`, [id])).rows[0]?.status;
    assert.equal(await statusOf(a1.id), 'withdrawn', "A's open report is now withdrawn");
    assert.equal(await statusOf(a2.id), 'resolved', "A's already-resolved report is untouched");
    assert.equal(
      await statusOf(b1.id),
      'open',
      "SECURITY: B's report must be untouched — a member can only withdraw their own",
    );

    // Wrong platform is also scoped out: withdrawing as A on whatsapp touches nothing.
    assert.deepEqual(await withdrawOwnReports('whatsapp', reporterA), [], 'platform is part of the scope');

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [[a1.id, a2.id, b1.id]]);
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
    const { id: targetKnowledgeId } = await saveKnowledge({
      content: 'from target',
      sourceUserId: targetUser,
      scope: 'global',
    });
    const { id: otherKnowledgeId } = await saveKnowledge({
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
    const scope = `${RUN}-scope`;
    const caller = { platform: 'discord' as const, conversationId: scope };
    const { id } = await saveKnowledge({
      title: 'Meetup schedule',
      content: 'We meet monthly on the first Tuesday.',
      scope,
    });

    const foundBefore = await searchKnowledge('monthly meetup schedule', caller, 20);
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

    const foundAfterUpdate = await searchKnowledge('second Tuesday meetup', caller, 20);
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
  'repository: saveKnowledge/updateKnowledge source_url/source_title (issue #214) — verified_at is set only when a source_url is supplied, and updateKnowledge re-verifies only when the caller explicitly supplies one',
  { skip },
  async () => {
    const noSource = await saveKnowledge({ content: `${RUN} no-source fixture` });
    const noSourceRow = await pool.query(
      `SELECT source_url, source_title, verified_at FROM knowledge WHERE id = $1`,
      [noSource.id],
    );
    assert.equal(noSourceRow.rows[0].source_url, null);
    assert.equal(noSourceRow.rows[0].verified_at, null, 'no source_url means no verified_at either');

    const withSource = await saveKnowledge({
      content: `${RUN} with-source fixture`,
      sourceUrl: 'https://example.com/repo-fixture',
      sourceTitle: 'Repo fixture doc',
    });
    const withSourceRow = await pool.query(
      `SELECT source_url, source_title, verified_at FROM knowledge WHERE id = $1`,
      [withSource.id],
    );
    assert.equal(withSourceRow.rows[0].source_url, 'https://example.com/repo-fixture');
    assert.equal(withSourceRow.rows[0].source_title, 'Repo fixture doc');
    assert.ok(withSourceRow.rows[0].verified_at, 'a source_url at save time sets verified_at');

    // update_knowledge: a content-only edit leaves source_url/verified_at untouched.
    const firstVerifiedAt = new Date(withSourceRow.rows[0].verified_at).getTime();
    await updateKnowledge({ id: withSource.id, content: 'content only, no citation change' });
    const afterContentEdit = await pool.query(`SELECT source_url, verified_at FROM knowledge WHERE id = $1`, [
      withSource.id,
    ]);
    assert.equal(afterContentEdit.rows[0].source_url, 'https://example.com/repo-fixture');
    assert.equal(new Date(afterContentEdit.rows[0].verified_at).getTime(), firstVerifiedAt);

    // Explicitly re-supplying sourceUrl re-verifies (bumps verified_at).
    await new Promise((r) => setTimeout(r, 10));
    await updateKnowledge({ id: withSource.id, sourceUrl: 'https://example.com/repo-fixture-v2' });
    const afterSourceEdit = await pool.query(`SELECT source_url, verified_at FROM knowledge WHERE id = $1`, [
      withSource.id,
    ]);
    assert.equal(afterSourceEdit.rows[0].source_url, 'https://example.com/repo-fixture-v2');
    assert.ok(new Date(afterSourceEdit.rows[0].verified_at).getTime() > firstVerifiedAt);

    // searchKnowledge surfaces the new fields end-to-end.
    const hits = await searchKnowledge(`${RUN} with-source fixture`, {
      platform: 'discord',
      conversationId: 'x',
    });
    const hit = hits.find((h) => h.id === withSource.id);
    assert.ok(hit);
    assert.equal(hit.sourceUrl, 'https://example.com/repo-fixture-v2');

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[noSource.id, withSource.id]]);
  },
);

test(
  "repository: recordKnowledgeRetrieval bumps retrieval_count/last_retrieved_at, listKnowledge exposes them, and updated_at (and #27/#5's ordering/hedging that key off it) is left untouched",
  { skip },
  async () => {
    const scope = `${RUN}-retrieval-scope`;
    const { id } = await saveKnowledge({
      content: 'Never-retrieved-yet entry.',
      scope,
    });

    const [freshEntry] = await listKnowledge({ scope });
    assert.equal(freshEntry.retrievalCount, 0, 'never-retrieved entry starts at 0');
    assert.equal(freshEntry.lastRetrievedAt, null, 'never-retrieved entry has no last_retrieved_at');

    const beforeRow = await pool.query(`SELECT updated_at FROM knowledge WHERE id = $1`, [id]);

    await recordKnowledgeRetrieval([id]);

    const [bumped] = await listKnowledge({ scope });
    assert.equal(bumped.retrievalCount, 1, 'one recorded retrieval increments the counter by 1');
    assert.ok(bumped.lastRetrievedAt, 'last_retrieved_at is set after a recorded retrieval');

    const afterRow = await pool.query(`SELECT updated_at FROM knowledge WHERE id = $1`, [id]);
    assert.equal(
      new Date(afterRow.rows[0].updated_at).getTime(),
      new Date(beforeRow.rows[0].updated_at).getTime(),
      'a retrieval-count bump must NOT touch updated_at — it would otherwise make the most-retrieved ' +
        "(possibly stalest) entries look freshly edited, defeating #27's recency hedging and reshuffling " +
        "list_knowledge's updated_at ordering on every member search (issue #134)",
    );

    await recordKnowledgeRetrieval([id]);
    const [bumpedAgain] = await listKnowledge({ scope });
    assert.equal(bumpedAgain.retrievalCount, 2, 'a second recorded retrieval increments again, not resets');

    await recordKnowledgeRetrieval([]);
    const [unchangedByEmptyBatch] = await listKnowledge({ scope });
    assert.equal(unchangedByEmptyBatch.retrievalCount, 2, 'recording an empty id list is a no-op');

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
  },
);

test(
  'SECURITY: repository: saveKnowledge near-duplicate nudge is scoped — matches within scope, never nudges (or leaks content) across scopes',
  { skip },
  async () => {
    const scope = `${RUN}-dup-scope`;
    const { id: firstId, similarEntry: firstSimilar } = await saveKnowledge({
      title: 'WhatsApp linking steps',
      content: 'To link WhatsApp, open settings and scan the QR code shown in the admin panel.',
      scope,
    });
    assert.equal(firstSimilar, undefined, 'nothing to match against yet');

    const { id: dupId, similarEntry: dupSimilar } = await saveKnowledge({
      title: 'How to link WhatsApp',
      content: 'To link WhatsApp, go to settings and scan the QR code from the admin panel.',
      scope,
    });
    assert.ok(dupSimilar, 'near-duplicate content in the same scope triggers a nudge');
    assert.equal(dupSimilar.id, firstId, 'nudge points at the pre-existing entry, not the new one');
    assert.ok(dupSimilar.similarity >= 0.92, 'reported similarity clears the duplicate threshold');
    assert.equal(dupSimilar.title, 'WhatsApp linking steps');

    const { id: distinctId, similarEntry: distinctSimilar } = await saveKnowledge({
      title: 'Meetup schedule',
      content: 'We meet monthly on the first Tuesday at the community hall.',
      scope,
    });
    assert.equal(distinctSimilar, undefined, 'an unrelated entry does not trigger a nudge');

    const { similarEntry: crossScopeSimilar } = await saveKnowledge({
      title: 'How to link WhatsApp',
      content: 'To link WhatsApp, go to settings and scan the QR code from the admin panel.',
      scope: `${RUN}-other-scope`,
    });
    assert.equal(
      crossScopeSimilar,
      undefined,
      'SECURITY: a near-duplicate in a different scope must never trigger a nudge — that would leak ' +
        "another scope's entry content to an admin saving into a scope they may not be in",
    );

    await pool.query(`DELETE FROM knowledge WHERE scope IN ($1, $2)`, [scope, `${RUN}-other-scope`]);
    void dupId;
    void distinctId;
  },
);

test(
  'repository: listDuplicateKnowledge finds an existing near-duplicate pair, reports each pair exactly once, and excludes a clearly distinct entry (issue #316)',
  { skip },
  async () => {
    const scope = `${RUN}-list-dup-scope`;
    const { id: aId } = await saveKnowledge({
      title: 'WhatsApp linking steps',
      content: 'To link WhatsApp, open settings and scan the QR code shown in the admin panel.',
      scope,
    });
    const { id: bId } = await saveKnowledge({
      title: 'How to link WhatsApp',
      content: 'To link WhatsApp, go to settings and scan the QR code from the admin panel.',
      scope,
    });
    const { id: distinctId } = await saveKnowledge({
      title: 'Meetup schedule',
      content: 'We meet monthly on the first Tuesday at the community hall.',
      scope,
    });

    const pairs = await listDuplicateKnowledge(scope);

    const matching = pairs.filter(
      (p) => (p.aId === aId && p.bId === bId) || (p.aId === bId && p.bId === aId),
    );
    assert.equal(
      matching.length,
      1,
      'the near-duplicate pair is reported exactly once, never as both A↔B and B↔A',
    );
    assert.ok(matching[0].similarity >= 0.92, 'reported similarity clears the duplicate threshold');

    assert.ok(
      !pairs.some((p) => p.aId === distinctId || p.bId === distinctId),
      'a clearly distinct entry must not appear in any pair',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[aId, bId, distinctId]]);
  },
);

test(
  'listDuplicateKnowledge returns an empty array when nothing meets the threshold (issue #316)',
  { skip },
  async () => {
    const scope = `${RUN}-list-dup-empty-scope`;
    const { id } = await saveKnowledge({
      title: 'Meetup schedule',
      content: 'We meet monthly on the first Tuesday at the community hall.',
      scope,
    });

    const pairs = await listDuplicateKnowledge(scope);
    assert.deepEqual(pairs, [], 'a single entry with nothing to pair against yields no pairs');

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
  },
);

test(
  'SECURITY: repository: listDuplicateKnowledge scope filter restricts results to that scope only, and a same-content pair split across different scopes is never returned (issue #316)',
  { skip },
  async () => {
    const scopeX = `${RUN}-list-dup-scope-x`;
    const scopeY = `${RUN}-list-dup-scope-y`;
    const { id: xAId } = await saveKnowledge({
      title: 'WhatsApp linking steps',
      content: 'To link WhatsApp, open settings and scan the QR code shown in the admin panel.',
      scope: scopeX,
    });
    const { id: xBId } = await saveKnowledge({
      title: 'How to link WhatsApp',
      content: 'To link WhatsApp, go to settings and scan the QR code from the admin panel.',
      scope: scopeX,
    });
    // Same content as the scope-X pair, but in a different scope — must never
    // pair with either scope-X entry (a.scope = b.scope in the join) and must
    // not appear when querying scope X.
    const { id: yId } = await saveKnowledge({
      title: 'How to link WhatsApp',
      content: 'To link WhatsApp, go to settings and scan the QR code from the admin panel.',
      scope: scopeY,
    });

    const scopedToX = await listDuplicateKnowledge(scopeX);
    assert.ok(
      scopedToX.some((p) => (p.aId === xAId && p.bId === xBId) || (p.aId === xBId && p.bId === xAId)),
      'the scope-X pair is returned when scoped to X',
    );
    assert.ok(
      !scopedToX.some((p) => p.aId === yId || p.bId === yId),
      'SECURITY: scope filter must exclude an entry from a different scope, even with near-identical content',
    );

    const unscoped = await listDuplicateKnowledge();
    assert.ok(
      !unscoped.some(
        (p) =>
          (p.aId === xAId && p.bId === yId) ||
          (p.aId === yId && p.bId === xAId) ||
          (p.aId === xBId && p.bId === yId) ||
          (p.aId === yId && p.bId === xBId),
      ),
      'SECURITY: a same-content pair split across different scopes must never be reported, even with no scope filter applied — the self-join is scoped a.scope = b.scope',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[xAId, xBId, yId]]);
  },
);

test(
  'repository: listDuplicateKnowledge clamps limit to a sane maximum and tolerates a negative value, matching the recentModerationEntries convention (issue #316)',
  { skip },
  async () => {
    const hugeLimit = await listDuplicateKnowledge(undefined, 10_000);
    assert.ok(hugeLimit.length <= 100, 'limit is clamped to a sane maximum for an admin-only audit tool');

    // A negative limit hits Postgres' "LIMIT must not be negative" if passed
    // through unclamped — must not throw.
    const negativeLimit = await listDuplicateKnowledge(undefined, -5);
    assert.ok(
      Array.isArray(negativeLimit),
      'a negative limit is clamped rather than passed through to LIMIT',
    );
  },
);

test(
  'repository: knowledge candidate CRUD — insert is pending, list filters by status, accept publishes via saveKnowledge (propagating the #93 duplicate nudge) and marks accepted, decline retains the row as declined and never touches knowledge (issue #102)',
  { skip },
  async () => {
    const digestId = await insertContextDigest({
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(),
      topic: `${RUN}-kc-topic`,
      summary: 'aggregate summary',
      exampleRefs: [],
      distinctUsers: 3,
      questionCount: 4,
    });

    const acceptId = await insertKnowledgeCandidate({
      digestId,
      topic: `${RUN}-kc-topic`,
      title: 'Drafted title',
      content: 'Drafted answer content.',
    });
    const declineId = await insertKnowledgeCandidate({
      digestId,
      topic: `${RUN}-kc-topic-2`,
      title: 'Another drafted title',
      content: 'Another drafted answer.',
    });

    const pendingOnly = await listKnowledgeCandidates('pending', 200);
    assert.ok(
      pendingOnly.some((c) => c.id === acceptId),
      'a freshly-inserted candidate is pending',
    );
    assert.ok(pendingOnly.some((c) => c.id === declineId));
    assert.ok(
      pendingOnly.every((c) => c.status === 'pending'),
      'the status filter excludes non-pending rows',
    );

    // Accept with an override — the override text, not the drafted text, must land in knowledge.
    const accepted = await acceptKnowledgeCandidate({
      id: acceptId,
      title: 'Overridden title',
      content: 'Overridden answer content, fixed at accept time.',
      reviewedBy: 'admin-1',
    });
    assert.ok(accepted);
    const knowledgeRow = await pool.query(`SELECT title, content FROM knowledge WHERE id = $1`, [
      accepted.knowledgeId,
    ]);
    assert.equal(knowledgeRow.rows[0].title, 'Overridden title');
    assert.equal(knowledgeRow.rows[0].content, 'Overridden answer content, fixed at accept time.');

    const acceptedRow = (await listKnowledgeCandidates('accepted', 200)).find((c) => c.id === acceptId);
    assert.ok(acceptedRow, 'the accepted candidate now shows up under the accepted filter');
    assert.equal(acceptedRow.reviewedBy, 'admin-1');
    assert.ok(acceptedRow.reviewedAt);

    const reAccept = await acceptKnowledgeCandidate({ id: acceptId, reviewedBy: 'admin-2' });
    assert.equal(reAccept, null, 'accepting an already-accepted candidate is a no-op, not a double publish');

    // Decline the other candidate: retained as 'declined', knowledge untouched.
    const declined = await declineKnowledgeCandidate(declineId, 'admin-1');
    assert.ok(declined);
    assert.equal(declined.status, 'declined');
    const declinedKnowledgeSearch = await pool.query(`SELECT 1 FROM knowledge WHERE content = $1`, [
      'Another drafted answer.',
    ]);
    assert.equal(
      declinedKnowledgeSearch.rows.length,
      0,
      'declining a candidate must never write a knowledge row',
    );

    const reDecline = await declineKnowledgeCandidate(declineId, 'admin-2');
    assert.equal(reDecline, null, 'declining an already-declined candidate is a no-op');

    const unknownAccept = await acceptKnowledgeCandidate({ id: 999_999_999, reviewedBy: 'admin-1' });
    assert.equal(unknownAccept, null, 'accepting an unknown id returns null, not an error');

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [accepted.knowledgeId]);
    await pool.query(`DELETE FROM knowledge_candidates WHERE id = ANY($1)`, [[acceptId, declineId]]);
    await pool.query(`DELETE FROM context_digests WHERE id = $1`, [digestId]);
  },
);

test(
  'repository: countPendingKnowledgeCandidates is exact past the 50-row listKnowledgeCandidates default limit, and counts only status = pending (issue #284)',
  { skip },
  async () => {
    const digestId = await insertContextDigest({
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(),
      topic: `${RUN}-countcandidates-topic`,
      summary: 'aggregate summary',
      exampleRefs: [],
      distinctUsers: 3,
      questionCount: 4,
    });

    const before = await countPendingKnowledgeCandidates();
    const TOTAL_PENDING = 55; // exceeds listKnowledgeCandidates's default limit of 50

    const ids: number[] = [];
    for (let i = 0; i < TOTAL_PENDING; i++) {
      ids.push(
        await insertKnowledgeCandidate({
          digestId,
          topic: `${RUN}-countcandidates-topic-${i}`,
          title: `bulk pending candidate ${i}`,
          content: `content ${i}`,
        }),
      );
    }

    const listed = await listKnowledgeCandidates('pending', 50);
    assert.equal(
      listed.length,
      50,
      'listKnowledgeCandidates is clamped at its default limit, understating the true backlog',
    );
    assert.equal(
      await countPendingKnowledgeCandidates(),
      before + TOTAL_PENDING,
      'countPendingKnowledgeCandidates reports the exact backlog, not the limited list length',
    );

    // Accepting/declining a couple must drop them out of the pending count —
    // exercising both non-pending statuses, not just rows past the row limit.
    const accepted = await acceptKnowledgeCandidate({ id: ids[0], reviewedBy: 'admin-1' });
    assert.ok(accepted);
    const declined = await declineKnowledgeCandidate(ids[1], 'admin-1');
    assert.ok(declined);
    assert.equal(
      await countPendingKnowledgeCandidates(),
      before + TOTAL_PENDING - 2,
      "countPendingKnowledgeCandidates excludes 'accepted'/'declined' rows — only 'pending' counts",
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [accepted.knowledgeId]);
    await pool.query(`DELETE FROM knowledge_candidates WHERE id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM context_digests WHERE id = $1`, [digestId]);
    assert.equal(
      await countPendingKnowledgeCandidates(),
      before,
      'deleting every inserted row restores the prior count',
    );
  },
);

test(
  'SECURITY: repository: a pending knowledge candidate never reaches knowledge/knowledge_search until accept_knowledge_candidate — the human-curation gate (issue #102)',
  { skip },
  async () => {
    const digestId = await insertContextDigest({
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(),
      topic: `${RUN}-kc-gate-topic`,
      summary: 'aggregate summary',
      exampleRefs: [],
      distinctUsers: 3,
      questionCount: 4,
    });
    const uniqueContent = `${RUN} gate fixture: the answer is exactly forty-two.`;
    const candidateId = await insertKnowledgeCandidate({
      digestId,
      topic: `${RUN}-kc-gate-topic`,
      title: 'Gate fixture title',
      content: uniqueContent,
    });

    const beforeAccept = await pool.query(`SELECT 1 FROM knowledge WHERE content = $1`, [uniqueContent]);
    assert.equal(
      beforeAccept.rows.length,
      0,
      'SECURITY: inserting a candidate must never itself create a knowledge row',
    );
    const searchBefore = await searchKnowledge(uniqueContent, { platform: 'discord', conversationId: 'x' });
    assert.ok(
      !searchBefore.some((h) => h.content === uniqueContent),
      'SECURITY: a pending candidate must never surface from knowledge_search',
    );

    const accepted = await acceptKnowledgeCandidate({ id: candidateId, reviewedBy: 'admin-1' });
    assert.ok(accepted);
    const afterAccept = await pool.query(`SELECT 1 FROM knowledge WHERE content = $1`, [uniqueContent]);
    assert.equal(afterAccept.rows.length, 1, 'accepting produces exactly one knowledge row');

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [accepted.knowledgeId]);
    await pool.query(`DELETE FROM knowledge_candidates WHERE id = $1`, [candidateId]);
    await pool.query(`DELETE FROM context_digests WHERE id = $1`, [digestId]);
  },
);

test(
  "repository: the builder's dedup guard — hasQueuedCandidateForTopic matches case-insensitively and INCLUDES declined rows (so a decline sticks), knowledgeCoversTopic flags a topic an existing entry already answers (issue #102)",
  { skip },
  async () => {
    const topic = `${RUN} zylotrix onboarding steps`;
    assert.equal(await hasQueuedCandidateForTopic(topic), false, 'nothing queued yet');

    const digestId = await insertContextDigest({
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(),
      topic,
      summary: 'summary',
      exampleRefs: [],
      distinctUsers: 3,
      questionCount: 4,
    });
    const candidateId = await insertKnowledgeCandidate({ digestId, topic, title: 't', content: 'c' });

    assert.equal(
      await hasQueuedCandidateForTopic(topic),
      true,
      'a queued candidate on this topic blocks re-emission',
    );
    assert.equal(
      await hasQueuedCandidateForTopic(topic.toUpperCase()),
      true,
      'the match is case-insensitive',
    );
    assert.equal(
      await hasQueuedCandidateForTopic(`${RUN} something entirely unrelated`),
      false,
      'a different topic is unaffected',
    );

    await declineKnowledgeCandidate(candidateId, 'admin-1');
    assert.equal(
      await hasQueuedCandidateForTopic(topic),
      true,
      'SECURITY: a DECLINED candidate still blocks re-emission of the same topic on the next builder run',
    );

    // Deliberately RUN-free, invented words (not real English, and not the
    // ${RUN} tag) for the two knowledgeCoversTopic checks below: it scans ALL
    // knowledge unscoped (by design — a digest signal is cross-platform
    // aggregate), so in a full-suite run other files' fixture rows are
    // present too. Sharing the numeric ${RUN} tag between the fixture and a
    // query text is itself a lexical overlap the embedding model can pick up
    // on — an unrelated-in-meaning false positive — so keep it out of both.
    const { id: knowledgeId } = await saveKnowledge({
      title: 'Zyquavexolorpin onboarding',
      content: 'Zyquavexolorpin onboarding: register on the portal and verify your email address.',
      scope: 'global',
    });
    assert.equal(
      await knowledgeCoversTopic('zyquavexolorpin onboarding steps'),
      true,
      'an existing knowledge entry above the relevance floor counts as already answered',
    );
    assert.equal(
      await knowledgeCoversTopic('qzxvbfrobnicator gloopington snorlaxian doorknob'),
      false,
      'an unrelated (and lexically unrelated) topic is not flagged as already covered',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [knowledgeId]);
    await pool.query(`DELETE FROM knowledge_candidates WHERE id = $1`, [candidateId]);
    await pool.query(`DELETE FROM context_digests WHERE id = $1`, [digestId]);
  },
);

test(
  'SECURITY: repository: purgeUserData deletes only a still-PENDING knowledge_candidates row referencing an invalidated digest — an ACCEPTED candidate (and its resulting knowledge entry) survives, keeping the same accountability treatment as knowledge/admin_audit generally (issue #102)',
  { skip },
  async () => {
    const victim = `${RUN}-kc-purge-victim`;
    const conversationId = `${RUN}-c-kc-purge`;

    const { rows: interactionRows } = await pool.query(
      `INSERT INTO interactions (platform, conversation_id, user_id, role, direction, content)
       VALUES ('discord', $1, $2, 'member', 'inbound', 'kc purge fixture') RETURNING id`,
      [conversationId, victim],
    );
    const interactionId = Number(interactionRows[0].id);

    const digestId = await insertContextDigest({
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(),
      topic: `${RUN}-kc-purge-topic`,
      summary: 'summary built partly over the purged user',
      exampleRefs: [interactionId],
      distinctUsers: 3,
      questionCount: 4,
    });

    const pendingId = await insertKnowledgeCandidate({
      digestId,
      topic: `${RUN}-kc-purge-topic`,
      title: 'Still pending',
      content: 'never reviewed',
    });
    const toAcceptId = await insertKnowledgeCandidate({
      digestId,
      topic: `${RUN}-kc-purge-topic`,
      title: 'Will be accepted',
      content: 'accepted candidate content',
    });
    const accepted = await acceptKnowledgeCandidate({ id: toAcceptId, reviewedBy: 'admin-1' });
    assert.ok(accepted);

    await purgeUserData('discord', victim);

    const digestGone = await pool.query(`SELECT 1 FROM context_digests WHERE id = $1`, [digestId]);
    assert.equal(
      digestGone.rows.length,
      0,
      'the digest referencing the purged interaction is invalidated, matching existing #51 behaviour',
    );

    const pendingRow = await pool.query(`SELECT 1 FROM knowledge_candidates WHERE id = $1`, [pendingId]);
    assert.equal(
      pendingRow.rows.length,
      0,
      'SECURITY: the still-pending candidate is deleted along with its invalidated digest',
    );

    const acceptedRow = await pool.query(`SELECT status, digest_id FROM knowledge_candidates WHERE id = $1`, [
      toAcceptId,
    ]);
    assert.equal(acceptedRow.rows.length, 1, 'the accepted candidate row survives the purge');
    assert.equal(acceptedRow.rows[0].status, 'accepted');
    assert.equal(
      acceptedRow.rows[0].digest_id,
      null,
      "ON DELETE SET NULL drops the now-meaningless digest link, but the row itself isn't deleted",
    );

    const knowledgeRow = await pool.query(`SELECT 1 FROM knowledge WHERE id = $1`, [accepted.knowledgeId]);
    assert.equal(
      knowledgeRow.rows.length,
      1,
      'the knowledge entry produced by acceptance is unaffected by the purge',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [accepted.knowledgeId]);
    await pool.query(`DELETE FROM knowledge_candidates WHERE id = ANY($1)`, [[pendingId, toAcceptId]]);
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

test('repository: recordKnowledgeGap inserts a row with a real embedding', { skip }, async () => {
  const conversationId = `${RUN}-c-gap-insert`;
  const userId = `${RUN}-gap-insert-user`;
  const query = 'how do I reset my Zylotrix session';

  const result = await recordKnowledgeGap('discord', conversationId, userId, query);
  assert.ok(result !== 'rate_limited', 'a fresh user is never rate-limited on the first insert');

  const { rows } = await pool.query(
    `SELECT platform, conversation_id, user_id, query_text, embedding FROM knowledge_gaps WHERE id = $1`,
    [result.id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'discord');
  assert.equal(rows[0].conversation_id, conversationId);
  assert.equal(rows[0].user_id, userId);
  assert.equal(rows[0].query_text, query);
  assert.ok(Array.isArray(rows[0].embedding), 'a real embedding vector must be stored');
  assert.equal(rows[0].embedding.length, config.db.embeddingDim);

  await pool.query(`DELETE FROM knowledge_gaps WHERE id = $1`, [result.id]);
});

test(
  'repository: recentKnowledgeGapClusters groups near-duplicate embeddings, separates unrelated ones, and enforces count >= 2',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-gap-cluster`;

    // Hand-crafted vectors (not run through the real embedding model), same
    // determinism convention as the recentQuestionClusters cluster test.
    const dim = config.db.embeddingDim;
    const sameQueryVec = new Array(dim).fill(0);
    sameQueryVec[3] = 1;
    const unrelatedVec = new Array(dim).fill(0);
    unrelatedVec[4] = 1;

    const insertGap = (queryText: string, vec: number[]) =>
      pool.query(
        `INSERT INTO knowledge_gaps (platform, conversation_id, user_id, query_text, embedding)
         VALUES ($1,$2,$3,$4,$5)`,
        ['discord', conversationId, `${RUN}-gap-cluster-user`, queryText, pgvector.toSql(vec)],
      );

    await insertGap('how do I reset my session', sameQueryVec);
    await insertGap('my session keeps resetting, how do I fix it', sameQueryVec);
    await insertGap('what time is the next meetup', unrelatedVec);

    const clusters = await recentKnowledgeGapClusters([conversationId], 7, 10);
    assert.equal(clusters.length, 1, 'only the count >= 2 cluster survives; the singleton is dropped');
    assert.equal(clusters[0].count, 2);
    assert.equal(
      clusters[0].representative,
      'how do I reset my session',
      'representative is the first gap seen',
    );

    await pool.query(`DELETE FROM knowledge_gaps WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  'SECURITY: repository: recentKnowledgeGapClusters excludes conversations outside the given scope',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-gap-scope-in`;
    const outOfScopeConvo = `${RUN}-c-gap-scope-out`;
    const dim = config.db.embeddingDim;
    const vec = new Array(dim).fill(0);
    vec[5] = 1;

    const insertGap = (conversationId: string, queryText: string) =>
      pool.query(
        `INSERT INTO knowledge_gaps (platform, conversation_id, user_id, query_text, embedding)
         VALUES ($1,$2,$3,$4,$5)`,
        ['discord', conversationId, `${RUN}-gap-scope-user`, queryText, pgvector.toSql(vec)],
      );

    await insertGap(inScopeConvo, 'in-scope gap A');
    await insertGap(inScopeConvo, 'in-scope gap B');
    await insertGap(outOfScopeConvo, 'out-of-scope gap A');
    await insertGap(outOfScopeConvo, 'out-of-scope gap B');

    const scoped = await recentKnowledgeGapClusters([inScopeConvo], 7, 10);
    assert.equal(scoped.length, 1, 'clusters only reflect the in-scope conversation');
    assert.equal(scoped[0].count, 2);

    const unscoped = await recentKnowledgeGapClusters(null, 7, 10);
    const totalUnscoped = unscoped.reduce((n, c) => n + c.count, 0);
    assert.ok(totalUnscoped >= 4, 'without a scope filter (super admin), both conversations contribute');

    await pool.query(`DELETE FROM knowledge_gaps WHERE conversation_id = ANY($1)`, [
      [inScopeConvo, outOfScopeConvo],
    ]);
  },
);

test(
  'SECURITY: repository: recordKnowledgeGap enforces a DB-backed rolling-24h cap per (platform, user_id), robust to a simulated process restart',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-gap-cap`;
    const userId = `${RUN}-gap-cap-user`;

    // Seed cap-many rows via direct SQL, as if written by a previous process
    // instance, so an in-memory counter would wrongly admit the next insert
    // but the DB-backed COUNT(*) refuses it — same pattern as
    // createAnswerFeedback/createSuggestion's rate-cap tests.
    for (let i = 0; i < KNOWLEDGE_GAP_DAILY_LIMIT; i++) {
      await pool.query(
        `INSERT INTO knowledge_gaps (platform, conversation_id, user_id, query_text) VALUES ($1,$2,$3,$4)`,
        ['discord', conversationId, userId, `seeded gap ${i}`],
      );
    }

    const rejected = await recordKnowledgeGap('discord', conversationId, userId, 'the (cap+1)th gap');
    assert.equal(rejected, 'rate_limited', 'the (cap+1)th insert in 24h is refused, not silently accepted');

    const countAfterRejection = await pool.query(
      `SELECT count(*) AS n FROM knowledge_gaps WHERE platform = $1 AND user_id = $2`,
      ['discord', userId],
    );
    assert.equal(
      Number(countAfterRejection.rows[0].n),
      KNOWLEDGE_GAP_DAILY_LIMIT,
      'no row is inserted for a refused insert',
    );

    // A different user is unaffected by this user's cap.
    const otherUser = `${RUN}-gap-cap-other`;
    const accepted = await recordKnowledgeGap(
      'discord',
      conversationId,
      otherUser,
      'a different user, own cap',
    );
    assert.ok(accepted !== 'rate_limited', "a different user's cap is independent");

    await pool.query(`DELETE FROM knowledge_gaps WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  "SECURITY: repository: purgeUserData (forget_me/purge_user_data) removes the caller's own knowledge_gaps rows (issue #208)",
  { skip },
  async () => {
    const targetUser = `${RUN}-gap-purge-target`;
    const otherUser = `${RUN}-gap-purge-other`;
    const conversationId = `${RUN}-c-gap-purge`;

    const targetGap = await recordKnowledgeGap(
      'discord',
      conversationId,
      targetUser,
      'target user gap query',
    );
    const otherGap = await recordKnowledgeGap('discord', conversationId, otherUser, 'other user gap query');
    assert.ok(targetGap !== 'rate_limited' && otherGap !== 'rate_limited', 'fixture gaps were recorded');

    const purged = await purgeUserData('discord', targetUser);
    assert.ok(purged >= 1, 'purged count covers the target user gap row');

    const targetRows = await pool.query(`SELECT 1 FROM knowledge_gaps WHERE user_id = $1`, [targetUser]);
    assert.equal(targetRows.rows.length, 0, "the target user's knowledge_gaps rows are gone");

    const otherRows = await pool.query(`SELECT 1 FROM knowledge_gaps WHERE user_id = $1`, [otherUser]);
    assert.equal(otherRows.rows.length, 1, "another user's knowledge_gaps rows are untouched");

    await pool.query(`DELETE FROM knowledge_gaps WHERE user_id = $1`, [otherUser]);
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
  'repository: usageStats clamps an out-of-range days window to [1, 365] (issue #110)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-days-clamp`;
    const userId = `${RUN}-days-clamp`;

    // Min clamp: a negative `days` must behave as the 1-day floor, not a
    // literal negative interval (which would flip to a future timestamp and
    // match nothing — even the row created "now").
    const beforeMin = await usageStats(-3);
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId,
      role: 'member',
      direction: 'outbound',
      content: 'inside a 1-day window — now',
      costUsd: 1,
    });
    await pool.query(
      `INSERT INTO interactions (platform, conversation_id, user_id, role, direction, content, cost_usd, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() - interval '2 days')`,
      ['discord', conversationId, userId, 'member', 'outbound', 'just outside a 1-day window', 1],
    );
    const afterMin = await usageStats(-3);
    assert.equal(
      afterMin.outbound - beforeMin.outbound,
      1,
      'days=-3 clamps to the 1-day floor: the "now" row is counted, the 2-day-old row is not',
    );

    // Max clamp: a huge `days` must behave as the 365-day ceiling, not a
    // literal 10,000-day interval (which would happily include a 400-day-old row).
    const beforeMax = await usageStats(10_000);
    await pool.query(
      `INSERT INTO interactions (platform, conversation_id, user_id, role, direction, content, cost_usd, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() - interval '400 days')`,
      ['discord', conversationId, userId, 'member', 'outbound', 'just outside a 365-day window', 1],
    );
    const afterMax = await usageStats(10_000);
    assert.equal(
      afterMax.outbound - beforeMax.outbound,
      0,
      'days=10_000 clamps to the 365-day ceiling: a 400-day-old row must not become visible',
    );

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
  assert.deepEqual(
    resolved,
    { platform: 'discord', reporterUserId: reporter, reason: 'in scope, open' },
    'resolution returns the row (platform/reporterUserId/reason) so the caller can notify the reporter',
  );

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
  'SECURITY: repository: countOpenReports scopes by conversation and counts only open status',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-countreports-in`;
    const outOfScopeConvo = `${RUN}-c-countreports-out`;
    const reporter = `${RUN}-countreports-reporter`;

    const open1 = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId: inScopeConvo,
      reason: 'in scope, open, one',
    });
    const open2 = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId: inScopeConvo,
      reason: 'in scope, open, two',
    });
    const outOfScope = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId: outOfScopeConvo,
      reason: 'must NOT be counted — admin is not in this conversation',
    });
    assert.ok(open1 && open2 && outOfScope);

    const scopedCount = await countOpenReports([inScopeConvo]);
    assert.equal(scopedCount, 2, 'counts only open reports from the scoped conversation');

    const unscopedCount = await countOpenReports(null);
    assert.ok(
      unscopedCount >= scopedCount + 1,
      'null scope (super admin) is unrestricted and includes the out-of-scope conversation too',
    );

    await resolveContentReport(open1.id, 'resolved', `${RUN}-countreports-resolver`);
    assert.equal(
      await countOpenReports([inScopeConvo]),
      1,
      'a resolved report no longer counts toward the open total',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [[open1.id, open2.id, outOfScope.id]]);
  },
);

test(
  'repository: countOpenReports is exact past the 200-row listReports clamp (issue #133)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-countreports-many`;
    const reporter = `${RUN}-countreports-many-reporter`;
    const TOTAL = 205;

    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < TOTAL; i++) {
      params.push('discord', reporter, conversationId, `bulk report ${i}`);
      values.push(`($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length})`);
    }
    await pool.query(
      `INSERT INTO content_reports (platform, reporter_user_id, conversation_id, reason) VALUES ${values.join(', ')}`,
      params,
    );

    const listed = await listReports([conversationId], 'open', 200);
    assert.equal(listed.length, 200, 'listReports is clamped at 200, understating the true backlog');

    assert.equal(
      await countOpenReports([conversationId]),
      TOTAL,
      'countOpenReports reports the exact backlog, not the clamped list length',
    );

    await pool.query(`DELETE FROM content_reports WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  'repository: countRecentDmReportsByReporterAndTarget counts matching DM reports within the window, inclusive of the just-filed one (issue #305)',
  { skip },
  async () => {
    const reporter = `${RUN}-repeatreport-reporter`;
    const target = `${RUN}-repeatreport-target`;
    const conversationId = `${RUN}-c-repeatreport`;

    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await createContentReport({
        platform: 'discord',
        reporterUserId: reporter,
        conversationId,
        targetUserId: target,
        reason: `repeat report ${i}`,
        isDirect: true,
      });
      assert.ok(created);
      ids.push(created.id);
      assert.equal(
        await countRecentDmReportsByReporterAndTarget('discord', reporter, target),
        i + 1,
        `count is exactly ${i + 1} after the ${i + 1}th matching DM report, inclusive of the just-inserted row`,
      );
    }

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [ids]);
  },
);

test(
  'repository: countRecentDmReportsByReporterAndTarget counts each (reporter, target) pair independently (issue #305)',
  { skip },
  async () => {
    const reporter = `${RUN}-repeatreport-multi-target-reporter`;
    const targetA = `${RUN}-repeatreport-target-a`;
    const targetB = `${RUN}-repeatreport-target-b`;
    const conversationId = `${RUN}-c-repeatreport-multi`;

    const first = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId,
      targetUserId: targetA,
      reason: 'naming target A, first time',
      isDirect: true,
    });
    const second = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId,
      targetUserId: targetA,
      reason: 'naming target A, second time',
      isDirect: true,
    });
    const third = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId,
      targetUserId: targetB,
      reason: 'naming target B, first time',
      isDirect: true,
    });
    assert.ok(first && second && third);

    assert.equal(
      await countRecentDmReportsByReporterAndTarget('discord', reporter, targetA),
      2,
      'target A has 2 matching reports',
    );
    assert.equal(
      await countRecentDmReportsByReporterAndTarget('discord', reporter, targetB),
      1,
      'target B has only 1, counted independently of target A — never aggregated across targets',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [[first.id, second.id, third.id]]);
  },
);

test(
  'repository: countRecentDmReportsByReporterAndTarget does not aggregate across different reporters naming the same target (issue #305)',
  { skip },
  async () => {
    const target = `${RUN}-repeatreport-shared-target`;
    const conversationId = `${RUN}-c-repeatreport-sharedtarget`;
    const reporters = [`${RUN}-repeatreport-r1`, `${RUN}-repeatreport-r2`, `${RUN}-repeatreport-r3`];
    const ids: number[] = [];
    for (const reporter of reporters) {
      const created = await createContentReport({
        platform: 'discord',
        reporterUserId: reporter,
        conversationId,
        targetUserId: target,
        reason: 'each reporter names the same target once',
        isDirect: true,
      });
      assert.ok(created);
      ids.push(created.id);
    }

    for (const reporter of reporters) {
      assert.equal(
        await countRecentDmReportsByReporterAndTarget('discord', reporter, target),
        1,
        'each reporter is counted independently — the count is per-reporter, not per-target-across-reporters',
      );
    }

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [ids]);
  },
);

test(
  'SECURITY: repository: countRecentDmReportsByReporterAndTarget counts only rows matching (platform, reporter_user_id, target_user_id, is_dm = true) within the window (issue #305)',
  { skip },
  async () => {
    const platform = 'discord';
    const reporter = `${RUN}-repeatreport-sec-reporter`;
    const target = `${RUN}-repeatreport-sec-target`;
    const conversationId = `${RUN}-c-repeatreport-sec`;

    // Inserted directly via SQL (like the 200-row clamp test above) so every
    // row's platform/reporter/target/is_dm/created_at is controlled exactly,
    // independent of createContentReport's own per-reporter rate cap.
    const insert = (p: string, r: string, t: string, isDm: boolean) =>
      pool.query(
        `INSERT INTO content_reports (platform, reporter_user_id, conversation_id, target_user_id, reason, is_dm)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [p, r, conversationId, t, 'fixture row', isDm],
      );

    const ids: number[] = [];
    const matching = (await insert(platform, reporter, target, true)).rows[0].id;
    ids.push(matching);

    ids.push((await insert('whatsapp', reporter, target, true)).rows[0].id);
    ids.push((await insert(platform, `${RUN}-repeatreport-sec-other-reporter`, target, true)).rows[0].id);
    ids.push((await insert(platform, reporter, `${RUN}-repeatreport-sec-other-target`, true)).rows[0].id);

    for (let i = 0; i < 5; i++) {
      ids.push((await insert(platform, reporter, target, false)).rows[0].id);
    }

    const stale = (await insert(platform, reporter, target, true)).rows[0].id;
    ids.push(stale);
    await pool.query(`UPDATE content_reports SET created_at = now() - interval '31 days' WHERE id = $1`, [
      stale,
    ]);

    assert.equal(
      await countRecentDmReportsByReporterAndTarget(platform, reporter, target),
      1,
      'SECURITY: only the single exactly-matching in-window DM row is counted — a differing platform, ' +
        'reporter, or target, five non-DM rows past the threshold, and a stale out-of-window row are all excluded',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [ids]);
  },
);

test(
  'SECURITY: repository: listReports/countOpenReports/resolveContentReport broaden a scoped admin to DM-originated reports outside their conversation scope (issue #197)',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-dmreports-in`;
    const outOfScopeConvo = `${RUN}-c-dmreports-out`;
    const dmConvo = `${RUN}-c-dmreports-dm`;
    const reporter = `${RUN}-dmreports-reporter`;
    const viewer = `${RUN}-dmreports-viewer-admin`;

    const dmReport = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId: dmConvo,
      reason: 'DM-originated, no admin naturally scoped to this conversation',
      isDirect: true,
    });
    const channelReport = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId: outOfScopeConvo,
      reason: 'shared-channel report the viewer does not participate in — must stay excluded',
    });
    assert.ok(dmReport && channelReport);

    const withoutViewer = await listReports([inScopeConvo]);
    assert.ok(
      !withoutViewer.some((r) => r.id === dmReport.id),
      'omitting viewerUserId leaves DM-originated reports invisible, same as before #197',
    );

    const scoped = await listReports([inScopeConvo], undefined, 50, [viewer]);
    assert.ok(
      scoped.some((r) => r.id === dmReport.id),
      'a DM-originated report is visible to a scoped admin once viewerUserId is supplied',
    );
    assert.ok(
      !scoped.some((r) => r.id === channelReport.id),
      'SECURITY: the OR is_dm broadening must not leak an out-of-scope, non-DM report',
    );

    const scopedOpenCount = await countOpenReports([inScopeConvo], [viewer]);
    assert.equal(
      scopedOpenCount,
      1,
      'countOpenReports includes the DM-originated open report, not the channel one',
    );

    const resolved = await resolveContentReport(dmReport.id, 'resolved', viewer, [inScopeConvo]);
    assert.ok(resolved, 'a scoped admin can resolve a DM-originated report via the broadened predicate');

    const channelRefused = await resolveContentReport(channelReport.id, 'resolved', viewer, [inScopeConvo]);
    assert.equal(
      channelRefused,
      null,
      'SECURITY: the broadening must not let a scoped admin resolve an out-of-scope, non-DM report',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [[dmReport.id, channelReport.id]]);
  },
);

test(
  'SECURITY: repository: a DM-originated report filed against the viewing admin stays reachable only by a super admin (issue #197)',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-dmself-in`;
    const dmConvo = `${RUN}-c-dmself-dm`;
    const reporter = `${RUN}-dmself-reporter`;
    const accusedAdmin = `${RUN}-dmself-accused-admin`;
    const otherAdmin = `${RUN}-dmself-other-admin`;

    const reportAgainstAccused = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId: dmConvo,
      targetUserId: accusedAdmin,
      reason: 'a member privately reports the accused admin from a DM',
      isDirect: true,
    });
    assert.ok(reportAgainstAccused);

    const accusedView = await listReports([inScopeConvo], undefined, 50, [accusedAdmin]);
    assert.ok(
      !accusedView.some((r) => r.id === reportAgainstAccused.id),
      'SECURITY: the accused admin must not see a DM report filed against themselves',
    );
    assert.equal(
      await countOpenReports([inScopeConvo], [accusedAdmin]),
      0,
      'SECURITY: the accused admin’s open count must not include a report against themselves',
    );
    const selfResolve = await resolveContentReport(reportAgainstAccused.id, 'dismissed', accusedAdmin, [
      inScopeConvo,
    ]);
    assert.equal(
      selfResolve,
      null,
      'SECURITY: the accused admin must not be able to dismiss a report filed against themselves',
    );

    const otherView = await listReports([inScopeConvo], undefined, 50, [otherAdmin]);
    assert.ok(
      otherView.some((r) => r.id === reportAgainstAccused.id),
      'a different scoped admin (not the accused) can still see the DM-originated report',
    );

    const superAdminView = await listReports(null, undefined, 50, [accusedAdmin]);
    assert.ok(
      superAdminView.some((r) => r.id === reportAgainstAccused.id),
      'super-admin (null scope) visibility is unrestricted and unaffected by viewerUserId',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = $1`, [reportAgainstAccused.id]);
  },
);

test(
  'repository: countAccessRequests is exact and unaffected by listAccessRequests default limit (issue #133)',
  { skip },
  async () => {
    const before = await countAccessRequests();
    const TOTAL = 55; // exceeds listAccessRequests's default limit of 50
    const userIds = Array.from({ length: TOTAL }, (_, i) => `${RUN}-countaccessreq-${i}`);
    for (const userId of userIds) {
      await recordAccessRequest({ platform: 'discord', userId, userName: 'tester' });
    }

    assert.equal(
      await countAccessRequests(),
      before + TOTAL,
      "countAccessRequests reflects the full backlog, not capped at listAccessRequests's default 50",
    );

    for (const userId of userIds) {
      await clearAccessRequest('discord', userId);
    }
    assert.equal(
      await countAccessRequests(),
      before,
      'clearing every inserted request restores the prior count',
    );
  },
);

test(
  'repository: countStaleKnowledge judges staleness by whichever of edit or retrieval is more recent (issue #199)',
  { skip },
  async () => {
    const before = await countStaleKnowledge(30);

    const { id: retrievedRecently } = await saveKnowledge({
      content: `${RUN} retrieved recently but edited long ago`,
      title: 'stale-check-retrieved-recently',
      scope: 'global',
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '400 days', last_retrieved_at = now()
        WHERE id = $1`,
      [retrievedRecently],
    );

    const { id: editedRecently } = await saveKnowledge({
      content: `${RUN} edited recently but never retrieved (the COALESCE-only bug)`,
      title: 'stale-check-edited-recently',
      scope: 'global',
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '1 day', last_retrieved_at = now() - interval '400 days'
        WHERE id = $1`,
      [editedRecently],
    );

    const { id: bothOld } = await saveKnowledge({
      content: `${RUN} edited long ago and never retrieved`,
      title: 'stale-check-both-old',
      scope: 'global',
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '400 days', last_retrieved_at = now() - interval '400 days'
        WHERE id = $1`,
      [bothOld],
    );

    const { id: neverRetrievedButOld } = await saveKnowledge({
      content: `${RUN} old edit, never retrieved at all (last_retrieved_at NULL)`,
      title: 'stale-check-never-retrieved',
      scope: 'global',
    });
    await pool.query(`UPDATE knowledge SET updated_at = now() - interval '400 days' WHERE id = $1`, [
      neverRetrievedButOld,
    ]);

    assert.equal(
      await countStaleKnowledge(30),
      before + 2,
      'only the two entries that are BOTH old-edited and old/never-retrieved count as stale',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [
      [retrievedRecently, editedRecently, bothOld, neverRetrievedButOld],
    ]);
    assert.equal(await countStaleKnowledge(30), before, 'cleanup restores the prior stale count');
  },
);

test(
  "repository: listKnowledge staleOnly reuses countStaleKnowledge's exact GREATEST predicate and orders most-overdue first (issue #280)",
  { skip },
  async () => {
    const scope = `${RUN}-stale-only-scope`;

    const { id: retrievedRecently } = await saveKnowledge({
      content: `${RUN} retrieved recently but edited long ago`,
      title: 'stale-only-retrieved-recently',
      scope,
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '400 days', last_retrieved_at = now()
        WHERE id = $1`,
      [retrievedRecently],
    );

    const { id: mostOverdue } = await saveKnowledge({
      content: `${RUN} edited long ago and never retrieved (most overdue)`,
      title: 'stale-only-most-overdue',
      scope,
    });
    await pool.query(`UPDATE knowledge SET updated_at = now() - interval '500 days' WHERE id = $1`, [
      mostOverdue,
    ]);

    const { id: lessOverdue } = await saveKnowledge({
      content: `${RUN} edited long ago and retrieved a while back (less overdue)`,
      title: 'stale-only-less-overdue',
      scope,
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '400 days', last_retrieved_at = now() - interval '350 days'
        WHERE id = $1`,
      [lessOverdue],
    );

    const { id: freshlyEdited } = await saveKnowledge({
      content: `${RUN} edited yesterday, never retrieved`,
      title: 'stale-only-fresh',
      scope,
    });
    await pool.query(`UPDATE knowledge SET updated_at = now() - interval '1 day' WHERE id = $1`, [
      freshlyEdited,
    ]);

    const stale = await listKnowledge({ scope, staleOnly: true, staleDays: 30 });
    assert.deepEqual(
      stale.map((e) => e.id),
      [mostOverdue, lessOverdue],
      'only the two BOTH-old entries are returned, most-overdue (smallest GREATEST) first — the ' +
        'recently-retrieved-but-old-edit entry is excluded, proving GREATEST(updated_at, ' +
        'last_retrieved_at) reuse rather than a raw updated_at sort',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [
      [retrievedRecently, mostOverdue, lessOverdue, freshlyEdited],
    ]);
  },
);

test('repository: listKnowledge staleOnly composes with scope via AND (issue #280)', { skip }, async () => {
  const scopeA = `${RUN}-stale-scope-a`;
  const scopeB = `${RUN}-stale-scope-b`;

  const { id: staleInA } = await saveKnowledge({
    content: `${RUN} stale entry in scope A`,
    title: 'stale-scope-a-entry',
    scope: scopeA,
  });
  await pool.query(`UPDATE knowledge SET updated_at = now() - interval '400 days' WHERE id = $1`, [staleInA]);

  const { id: staleInB } = await saveKnowledge({
    content: `${RUN} stale entry in scope B`,
    title: 'stale-scope-b-entry',
    scope: scopeB,
  });
  await pool.query(`UPDATE knowledge SET updated_at = now() - interval '400 days' WHERE id = $1`, [staleInB]);

  const result = await listKnowledge({ scope: scopeA, staleOnly: true, staleDays: 30 });
  assert.deepEqual(
    result.map((e) => e.id),
    [staleInA],
    'staleOnly combined with scope only returns entries matching that scope',
  );

  await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[staleInA, staleInB]]);
});

test(
  'SECURITY: repository: listKnowledge staleOnly never widens past a caller-supplied scope — no cross-scope leakage (issue #280)',
  { skip },
  async () => {
    const scopeA = `${RUN}-stale-security-scope-a`;
    const scopeB = `${RUN}-stale-security-scope-b`;

    const { id: staleInA } = await saveKnowledge({
      content: `${RUN} stale entry in scope A (security)`,
      title: 'stale-security-scope-a-entry',
      scope: scopeA,
    });
    await pool.query(`UPDATE knowledge SET updated_at = now() - interval '400 days' WHERE id = $1`, [
      staleInA,
    ]);

    const { id: staleInB } = await saveKnowledge({
      content: `${RUN} stale entry in scope B (security) — must never leak into an A-scoped query`,
      title: 'stale-security-scope-b-entry',
      scope: scopeB,
    });
    await pool.query(`UPDATE knowledge SET updated_at = now() - interval '400 days' WHERE id = $1`, [
      staleInB,
    ]);

    const result = await listKnowledge({ scope: scopeA, staleOnly: true, staleDays: 30 });
    assert.ok(
      result.every((e) => e.scope === scopeA),
      'every returned entry must be in the requested scope',
    );
    assert.ok(
      !result.some((e) => e.id === staleInB),
      'the stale entry in scope B must never leak into a scope-A-filtered staleOnly query — the new ' +
        'predicate is AND-composed with the existing scope clause, never replacing or bypassing it',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[staleInA, staleInB]]);
  },
);

test(
  'repository: listKnowledge provenance filters to entries by created_by_role (issue #294)',
  { skip },
  async () => {
    const scope = `${RUN}-provenance-scope`;

    const { id: autoId } = await saveKnowledge({
      content: `${RUN} auto-researched entry`,
      title: 'provenance-auto-entry',
      scope,
      createdByRole: 'auto',
    });
    const { id: docsId } = await saveKnowledge({
      content: `${RUN} docs-ingested entry`,
      title: 'provenance-docs-entry',
      scope,
      createdByRole: 'docs',
    });
    const { id: adminId } = await saveKnowledge({
      content: `${RUN} admin-authored entry`,
      title: 'provenance-admin-entry',
      scope,
      createdByRole: 'admin',
    });

    const autoOnly = await listKnowledge({ scope, provenance: 'auto' });
    assert.deepEqual(
      autoOnly.map((e) => e.id),
      [autoId],
      'provenance: "auto" returns only the auto-researched entry',
    );

    const docsOnly = await listKnowledge({ scope, provenance: 'docs' });
    assert.deepEqual(
      docsOnly.map((e) => e.id),
      [docsId],
      'provenance: "docs" returns only the docs-ingested entry',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[autoId, docsId, adminId]]);
  },
);

test('repository: listKnowledge provenance composes with scope via AND (issue #294)', { skip }, async () => {
  const scopeA = `${RUN}-provenance-scope-a`;
  const scopeB = `${RUN}-provenance-scope-b`;

  const { id: autoInA } = await saveKnowledge({
    content: `${RUN} auto entry in scope A`,
    title: 'provenance-scope-a-auto',
    scope: scopeA,
    createdByRole: 'auto',
  });
  const { id: adminInA } = await saveKnowledge({
    content: `${RUN} admin entry in scope A`,
    title: 'provenance-scope-a-admin',
    scope: scopeA,
    createdByRole: 'admin',
  });
  const { id: autoInB } = await saveKnowledge({
    content: `${RUN} auto entry in scope B`,
    title: 'provenance-scope-b-auto',
    scope: scopeB,
    createdByRole: 'auto',
  });

  const result = await listKnowledge({ scope: scopeA, provenance: 'auto' });
  assert.deepEqual(
    result.map((e) => e.id),
    [autoInA],
    'provenance combined with scope only returns entries matching both filters (the intersection)',
  );

  await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[autoInA, adminInA, autoInB]]);
});

test(
  'SECURITY: repository: listKnowledge provenance never widens or bypasses scope — no cross-scope leakage, and the filter is parameterized (issue #294)',
  { skip },
  async () => {
    const scopeA = `${RUN}-provenance-security-scope-a`;
    const scopeB = `${RUN}-provenance-security-scope-b`;

    const { id: autoInA } = await saveKnowledge({
      content: `${RUN} auto entry in scope A (security)`,
      title: 'provenance-security-scope-a-auto',
      scope: scopeA,
      createdByRole: 'auto',
    });
    const { id: autoInB } = await saveKnowledge({
      content: `${RUN} auto entry in scope B (security) — must never leak into an A-scoped query`,
      title: 'provenance-security-scope-b-auto',
      scope: scopeB,
      createdByRole: 'auto',
    });

    const result = await listKnowledge({ scope: scopeA, provenance: 'auto' });
    assert.ok(
      result.every((e) => e.scope === scopeA),
      'every returned entry must be in the requested scope',
    );
    assert.ok(
      !result.some((e) => e.id === autoInB),
      'the auto entry in scope B must never leak into a scope-A-filtered provenance query — the new ' +
        'predicate is AND-composed with the existing scope clause, never replacing or bypassing it',
    );

    const maliciousProvenance = `auto' OR '1'='1`;
    const injectionResult = await listKnowledge({ scope: scopeA, provenance: maliciousProvenance });
    assert.deepEqual(
      injectionResult.map((e) => e.id),
      [],
      'a provenance value crafted to look like SQL injection must be treated as a literal bound ' +
        'parameter (no created_by_role equals that literal string), never interpolated into the query',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[autoInA, autoInB]]);
  },
);

test("isKnowledgeStale (issue #214) mirrors countStaleKnowledge's edit-or-retrieval-whichever-is-newer definition, as a pure function", () => {
  const oldDate = new Date(Date.now() - 400 * 86_400_000);
  const recentDate = new Date(Date.now() - 1 * 86_400_000);

  assert.equal(
    isKnowledgeStale({ updatedAt: oldDate, lastRetrievedAt: recentDate }, 30),
    false,
    'retrieved recently but edited long ago is NOT stale',
  );
  assert.equal(
    isKnowledgeStale({ updatedAt: recentDate, lastRetrievedAt: oldDate }, 30),
    false,
    'edited recently but never-recently-retrieved is NOT stale (the COALESCE-only bug)',
  );
  assert.equal(
    isKnowledgeStale({ updatedAt: oldDate, lastRetrievedAt: oldDate }, 30),
    true,
    'both old is stale',
  );
  assert.equal(
    isKnowledgeStale({ updatedAt: oldDate, lastRetrievedAt: null }, 30),
    true,
    'old edit, never retrieved at all, is stale',
  );
  assert.equal(
    isKnowledgeStale({ updatedAt: oldDate, lastRetrievedAt: null }, 0),
    false,
    'staleDays=0 (KNOWLEDGE_STALE_DAYS unset) disables the feature entirely, regardless of age',
  );
});

test(
  'repository: createSuggestion enforces a DB-backed rolling-24h cap per user, robust to a simulated restart (issue #46)',
  { skip },
  async () => {
    const userId = `${RUN}-suggester`;

    // Seed cap-many suggestions via direct SQL — as if written by a previous
    // process instance — so an in-memory counter would wrongly admit the next
    // one, but the DB-backed COUNT(*) refuses it (same pattern as the
    // content_reports cap test).
    for (let i = 0; i < SUGGESTION_RATE_LIMIT_PER_DAY; i++) {
      await pool.query(`INSERT INTO suggestions (platform, user_id, content) VALUES ($1,$2,$3)`, [
        'discord',
        userId,
        `prior-process suggestion ${i}`,
      ]);
    }

    const rejected = await createSuggestion({
      platform: 'discord',
      userId,
      content: 'the one over the cap — must be refused',
    });
    assert.equal(rejected, null, 'the (cap+1)th suggestion in 24h is refused');

    const countAfter = await pool.query(`SELECT count(*) AS n FROM suggestions WHERE user_id = $1`, [userId]);
    assert.equal(
      Number(countAfter.rows[0].n),
      SUGGESTION_RATE_LIMIT_PER_DAY,
      'no row is inserted for a refused suggestion',
    );

    // Age one out of the window — a slot frees up.
    await pool.query(
      `UPDATE suggestions SET created_at = now() - interval '25 hours'
        WHERE id = (SELECT id FROM suggestions WHERE user_id = $1 ORDER BY id LIMIT 1)`,
      [userId],
    );
    const accepted = await createSuggestion({
      platform: 'discord',
      userId,
      displayName: 'Suggester',
      content: 'x'.repeat(SUGGESTION_MAX_CHARS + 200),
    });
    assert.ok(accepted, 'accepted once an old suggestion ages out of the rolling window');

    // Another user's cap is independent.
    const other = await createSuggestion({
      platform: 'discord',
      userId: `${RUN}-suggester-other`,
      content: 'a different user has their own cap',
    });
    assert.ok(other, 'the cap is per-user, not global');

    const rows = await listSuggestions('new', 200);
    const stored = rows.find((s) => s.id === accepted.id);
    assert.ok(stored, 'the accepted suggestion is listed');
    assert.equal(stored.content.length, SUGGESTION_MAX_CHARS, 'over-long content is capped server-side');

    // Triage transitions and the status filter.
    const resolvedRow = await resolveSuggestion(accepted.id, 'done', `${RUN}-resolver`);
    assert.deepEqual(
      resolvedRow,
      { platform: 'discord', userId, content: 'x'.repeat(SUGGESTION_MAX_CHARS) },
      'resolution returns the row (platform/userId/content) so the caller can notify the submitter',
    );
    const doneRows = await listSuggestions('done', 200);
    assert.ok(
      doneRows.some((s) => s.id === accepted.id && s.reviewedBy === `${RUN}-resolver`),
      'resolution records status and reviewer',
    );
    const newRows = await listSuggestions('new', 200);
    assert.ok(!newRows.some((s) => s.id === accepted.id), 'a resolved suggestion leaves the new queue');
    assert.equal(await resolveSuggestion(999_999_999, 'done', 'x'), null, 'unknown id returns null');

    // forget_me / purge_user_data removes the user's suggestions.
    const purged = await purgeUserData('discord', userId);
    assert.ok(purged >= 1, 'purge count includes suggestions');
    const afterPurge = await pool.query(`SELECT 1 FROM suggestions WHERE user_id = $1`, [userId]);
    assert.equal(afterPurge.rows.length, 0, "the user's suggestions are gone after purge");

    await pool.query(`DELETE FROM suggestions WHERE user_id = $1`, [`${RUN}-suggester-other`]);
  },
);

test(
  'repository: countPendingSuggestions is exact past the 50-row listSuggestions default limit, and counts only status = new (issue #193)',
  { skip },
  async () => {
    const userId = `${RUN}-countsuggestions-many`;
    const before = await countPendingSuggestions();
    const TOTAL_NEW = 55; // exceeds listSuggestions's default limit of 50

    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < TOTAL_NEW; i++) {
      params.push('discord', userId, `bulk pending suggestion ${i}`);
      values.push(`($${params.length - 2}, $${params.length - 1}, $${params.length})`);
    }
    await pool.query(
      `INSERT INTO suggestions (platform, user_id, content) VALUES ${values.join(', ')}`,
      params,
    );

    const listed = await listSuggestions('new', 50);
    assert.equal(
      listed.length,
      50,
      'listSuggestions is clamped at its default limit, understating the true backlog',
    );
    assert.equal(
      await countPendingSuggestions(),
      before + TOTAL_NEW,
      'countPendingSuggestions reports the exact backlog, not the limited list length',
    );

    // A mix of non-'new' statuses must be excluded from the count, not just
    // ones past the row limit.
    for (const status of ['reviewed', 'declined', 'done']) {
      await pool.query(`INSERT INTO suggestions (platform, user_id, content, status) VALUES ($1,$2,$3,$4)`, [
        'discord',
        userId,
        `a ${status} suggestion`,
        status,
      ]);
    }
    assert.equal(
      await countPendingSuggestions(),
      before + TOTAL_NEW,
      "countPendingSuggestions excludes 'reviewed'/'declined'/'done' rows — only 'new' is pending",
    );

    await pool.query(`DELETE FROM suggestions WHERE user_id = $1`, [userId]);
    assert.equal(
      await countPendingSuggestions(),
      before,
      'deleting every inserted row restores the prior count',
    );
  },
);

test(
  "SECURITY: repository: listOwnSuggestions only returns the caller's OWN suggestions — never another user's, never cross-platform (issue #160)",
  { skip },
  async () => {
    const userA = `${RUN}-my-sub-A`;
    const userB = `${RUN}-my-sub-B`;

    const a1 = await createSuggestion({
      platform: 'discord',
      userId: userA,
      content: "A's first suggestion",
    });
    const a2 = await createSuggestion({
      platform: 'discord',
      userId: userA,
      content: "A's second suggestion",
    });
    const b1 = await createSuggestion({ platform: 'discord', userId: userB, content: "B's suggestion" });
    assert.ok(a1 && a2 && b1, 'fixtures recorded');

    const ownA = await listOwnSuggestions('discord', userA);
    assert.deepEqual(
      ownA.map((s) => s.id).sort(),
      [a1.id, a2.id].sort(),
      "only A's own suggestions are returned",
    );
    assert.ok(
      !ownA.some((s) => s.id === b1.id),
      "SECURITY: B's suggestion must never appear in A's own-submissions list",
    );

    assert.deepEqual(
      await listOwnSuggestions('whatsapp', userA),
      [],
      'platform is part of the scope — A has no whatsapp suggestions',
    );

    await pool.query(`DELETE FROM suggestions WHERE id = ANY($1)`, [[a1.id, a2.id, b1.id]]);
  },
);

test(
  "SECURITY: repository: listOwnReports only returns reports the caller filed — never another reporter's, and never rows where they're only the target (issue #160)",
  { skip },
  async () => {
    const reporterA = `${RUN}-my-rep-A`;
    const reporterB = `${RUN}-my-rep-B`;
    const conv = `${RUN}-c-my-submissions`;

    const a1 = await createContentReport({
      platform: 'discord',
      reporterUserId: reporterA,
      conversationId: conv,
      reason: "A's report",
    });
    const b1 = await createContentReport({
      platform: 'discord',
      reporterUserId: reporterB,
      conversationId: conv,
      reason: "B's report",
    });
    // A report naming A only as the *target* (reported by B) must never
    // surface in A's own-submissions list — A didn't file it.
    const aIsTarget = await createContentReport({
      platform: 'discord',
      reporterUserId: reporterB,
      conversationId: conv,
      targetUserId: reporterA,
      reason: 'B reports A for something',
    });
    assert.ok(a1 && b1 && aIsTarget, 'fixtures recorded');

    const ownA = await listOwnReports('discord', reporterA);
    assert.deepEqual(
      ownA.map((r) => r.id),
      [a1.id],
      "only A's own filed report is returned",
    );
    assert.ok(
      !ownA.some((r) => r.id === b1.id),
      "SECURITY: B's report must never appear in A's own-submissions list",
    );
    assert.ok(
      !ownA.some((r) => r.id === aIsTarget.id),
      'SECURITY: a report where A is only the target (not the filer) must never appear here',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [[a1.id, b1.id, aIsTarget.id]]);
  },
);

test(
  'repository: member notes CRUD — add (capped), list newest-first, delete (issue #45)',
  { skip },
  async () => {
    const userId = `${RUN}-notes-user`;
    const admin = `${RUN}-notes-admin`;

    const id1 = await addMemberNote({
      platform: 'discord',
      userId,
      note: 'runs the Christchurch meetup',
      createdBy: admin,
    });
    const id2 = await addMemberNote({
      platform: 'discord',
      userId,
      note: 'x'.repeat(MEMBER_NOTE_MAX_CHARS + 500),
      createdBy: admin,
    });

    const notes = await listMemberNotes('discord', userId);
    assert.equal(notes.length, 2);
    assert.equal(notes[0].id, id2, 'newest note first');
    assert.equal(
      notes[0].note.length,
      MEMBER_NOTE_MAX_CHARS,
      'over-long note text is capped server-side, not trusted from the caller',
    );
    assert.equal(notes[1].note, 'runs the Christchurch meetup');
    assert.equal(notes[1].createdBy, admin, 'authorship is recorded');

    assert.equal(await deleteMemberNote(id1), true);
    assert.equal(await deleteMemberNote(id1), false, 'deleting a nonexistent id returns false');
    assert.equal((await listMemberNotes('discord', userId)).length, 1);

    await pool.query(`DELETE FROM member_notes WHERE user_id = $1`, [userId]);
  },
);

test(
  'SECURITY: repository: member notes never land in member-reachable tables, and purgeUserData removes them (issue #45)',
  { skip },
  async () => {
    const userId = `${RUN}-notes-sec-user`;
    const marker = `${RUN}-note-marker-must-not-leak`;

    await addMemberNote({
      platform: 'discord',
      userId,
      note: marker,
      createdBy: `${RUN}-notes-sec-admin`,
    });

    // Notes must be unreachable through every member-facing read path. Those
    // paths only query `knowledge` (knowledge_search) and `interactions`
    // (remember_search / recall), so pin that the note text exists in
    // neither table — the member_notes table has no embedding column and no
    // other reader than listMemberNotes.
    const { rows: inKnowledge } = await pool.query(`SELECT 1 FROM knowledge WHERE content LIKE $1`, [
      `%${marker}%`,
    ]);
    assert.equal(inKnowledge.length, 0, 'note text never reaches the knowledge table (knowledge_search)');
    const { rows: inInteractions } = await pool.query(`SELECT 1 FROM interactions WHERE content LIKE $1`, [
      `%${marker}%`,
    ]);
    assert.equal(inInteractions.length, 0, 'note text never reaches interactions (memory recall)');

    // The subject's purge (forget_me / purge_user_data) removes notes about them.
    const purged = await purgeUserData('discord', userId);
    assert.ok(purged >= 1, 'purge count includes the note');
    const remaining = await listMemberNotes('discord', userId);
    assert.equal(remaining.length, 0, 'notes about the purged member are gone');
  },
);

test(
  'repository: roster join/leave/rejoin lifecycle and idempotent backfill upsert (issue #47)',
  { skip },
  async () => {
    const userId = `${RUN}-roster-user`;

    // Join + a second identical upsert (the backfill path): one row, no
    // rejoin counted, joined_at unchanged.
    await upsertRosterMember({ platform: 'discord', userId, displayName: 'Roster Person' });
    const first = await pool.query(
      `SELECT joined_at, left_at, rejoined_count FROM server_roster WHERE platform = 'discord' AND user_id = $1`,
      [userId],
    );
    assert.equal(first.rows.length, 1);
    assert.equal(first.rows[0].left_at, null);
    assert.equal(Number(first.rows[0].rejoined_count), 0);

    await upsertRosterMember({ platform: 'discord', userId, displayName: 'Roster Person' });
    const second = await pool.query(
      `SELECT joined_at, left_at, rejoined_count,
              (SELECT count(*) FROM server_roster WHERE platform = 'discord' AND user_id = $1) AS n
         FROM server_roster WHERE platform = 'discord' AND user_id = $1`,
      [userId],
    );
    assert.equal(Number(second.rows[0].n), 1, 'backfill re-upsert is idempotent: still exactly one row');
    assert.equal(Number(second.rows[0].rejoined_count), 0, 'a re-upsert while present is not a rejoin');
    assert.equal(
      new Date(second.rows[0].joined_at).getTime(),
      new Date(first.rows[0].joined_at).getTime(),
      'joined_at does not move on an idempotent re-upsert',
    );

    // Leave marks left_at; a second leave is a no-op.
    assert.equal(await markRosterLeave('discord', userId), true);
    assert.equal(await markRosterLeave('discord', userId), false, 'already-left row is not re-marked');

    // Rejoin clears left_at, bumps rejoined_count, resets joined_at.
    await upsertRosterMember({ platform: 'discord', userId });
    const rejoined = await pool.query(
      `SELECT left_at, rejoined_count, display_name FROM server_roster WHERE platform = 'discord' AND user_id = $1`,
      [userId],
    );
    assert.equal(rejoined.rows[0].left_at, null, 'rejoin clears left_at');
    assert.equal(Number(rejoined.rows[0].rejoined_count), 1, 'rejoin increments rejoined_count');
    assert.equal(
      rejoined.rows[0].display_name,
      'Roster Person',
      'an upsert without a display name preserves the stored one',
    );

    await pool.query(`DELETE FROM server_roster WHERE user_id = $1`, [userId]);
  },
);

test(
  'repository: listRoster surfaces the joined-but-not-a-member onboarding queue and growth counts (issue #47)',
  { skip },
  async () => {
    const lurker = `${RUN}-roster-lurker`;
    const member = `${RUN}-roster-member`;
    const leaver = `${RUN}-roster-leaver`;

    await upsertRosterMember({ platform: 'discord', userId: lurker, displayName: 'Lurker' });
    await upsertRosterMember({ platform: 'discord', userId: member, displayName: 'Member' });
    await upsertRosterMember({ platform: 'discord', userId: leaver, displayName: 'Leaver' });
    await upsertMember({ platform: 'discord', userId: member, role: 'member', addedBy: `${RUN}-admin` });
    await markRosterLeave('discord', leaver);

    const notMembers = await listRoster('discord', 'not_members', 7, 200);
    assert.ok(
      notMembers.some((r) => r.userId === lurker && !r.isMember),
      'a present non-member appears in the onboarding queue',
    );
    assert.ok(
      !notMembers.some((r) => r.userId === member),
      'a registered member is not in the onboarding queue',
    );
    assert.ok(
      !notMembers.some((r) => r.userId === leaver),
      'someone who left is not in the onboarding queue',
    );

    const recent = await listRoster('discord', 'recent', 7, 200);
    assert.ok(
      recent.some((r) => r.userId === member && r.isMember),
      'recent joins are flagged with membership status',
    );

    const left = await listRoster('discord', 'left', 7, 200);
    assert.ok(
      left.some((r) => r.userId === leaver && r.leftAt !== null),
      'recent leavers appear under the left filter',
    );

    const counts = await rosterCounts('discord');
    assert.ok(counts.total >= 2, 'present count includes the two still-present fixtures');
    assert.ok(counts.joinedThisWeek >= 2, 'this-week join count includes the fixtures');
    assert.ok(counts.leftThisWeek >= 1, 'this-week leave count includes the leaver');

    await pool.query(`DELETE FROM server_roster WHERE user_id = ANY($1)`, [[lurker, member, leaver]]);
    await pool.query(`DELETE FROM community_users WHERE platform_user_id = $1`, [member]);
  },
);

test(
  'SECURITY: repository: roster stores identity metadata only — no content column exists and no roster write touches interactions (issue #47)',
  { skip },
  async () => {
    const userId = `${RUN}-roster-security`;

    // Structural pin: the table cannot hold message content because no such
    // column exists. A future migration adding one must consciously break
    // this list (and re-argue the SECURITY.md posture).
    const { rows: columns } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'server_roster' ORDER BY column_name`,
    );
    assert.deepEqual(
      columns.map((c) => c.column_name).sort(),
      ['display_name', 'id', 'joined_at', 'left_at', 'platform', 'rejoined_count', 'updated_at', 'user_id'],
      'server_roster columns are identity metadata only — adding a content-bearing column is a posture change',
    );

    // Behavioural pin: the full roster lifecycle writes nothing to the
    // message-content table.
    await upsertRosterMember({ platform: 'discord', userId, displayName: 'No Content' });
    await markRosterLeave('discord', userId);
    await upsertRosterMember({ platform: 'discord', userId });
    const { rows: interactionRows } = await pool.query(
      `SELECT 1 FROM interactions WHERE platform = 'discord' AND user_id = $1`,
      [userId],
    );
    assert.equal(interactionRows.length, 0, 'no roster code path ever writes message content');

    await pool.query(`DELETE FROM server_roster WHERE user_id = $1`, [userId]);
  },
);

test(
  'SECURITY: repository: purgeUserData (forget_me and purge_user_data) removes the roster row (issue #47)',
  { skip },
  async () => {
    // forget_me and purge_user_data both execute purgeUserData; exercise it
    // twice on fresh rows so each caller's path is covered by the assertion.
    for (const via of ['forget_me', 'purge_user_data']) {
      const userId = `${RUN}-roster-purge-${via}`;
      await upsertRosterMember({ platform: 'discord', userId, displayName: 'Purge Me' });
      const purged = await purgeUserData('discord', userId);
      assert.ok(purged >= 1, `${via}: purge count includes the roster row`);
      const { rows } = await pool.query(
        `SELECT 1 FROM server_roster WHERE platform = 'discord' AND user_id = $1`,
        [userId],
      );
      assert.equal(rows.length, 0, `${via}: the roster row is gone after purgeUserData`);
    }
  },
);

test(
  'repository: purgeDepartedRoster deletes only departed rows past the cutoff, never left_at IS NULL rows (issue #136)',
  { skip },
  async () => {
    const stillPresent = `${RUN}-roster-departed-present`;
    const justUnderCutoff = `${RUN}-roster-departed-under`;
    const justOverCutoff = `${RUN}-roster-departed-over`;

    // Use an extreme window (~100 years) for the cutoff assertions so
    // they're correct regardless of what else lives in the table, mirroring
    // purgeOldInteractions's convention.
    const HUNDRED_YEARS_DAYS = 36_525;

    await upsertRosterMember({ platform: 'discord', userId: stillPresent, displayName: 'Still Here' });
    await upsertRosterMember({ platform: 'discord', userId: justUnderCutoff, displayName: 'Under' });
    await upsertRosterMember({ platform: 'discord', userId: justOverCutoff, displayName: 'Over' });

    await pool.query(
      `UPDATE server_roster SET left_at = now() - interval '${HUNDRED_YEARS_DAYS - 1} days'
        WHERE platform = 'discord' AND user_id = $1`,
      [justUnderCutoff],
    );
    await pool.query(
      `UPDATE server_roster SET left_at = now() - interval '${HUNDRED_YEARS_DAYS + 1} days'
        WHERE platform = 'discord' AND user_id = $1`,
      [justOverCutoff],
    );

    const deleted = await purgeDepartedRoster(HUNDRED_YEARS_DAYS);
    assert.ok(deleted >= 1, 'at least the over-the-cutoff fixture was deleted');

    const remaining = await pool.query(`SELECT user_id, left_at FROM server_roster WHERE user_id = ANY($1)`, [
      [stillPresent, justUnderCutoff, justOverCutoff],
    ]);
    const remainingIds = remaining.rows.map((r) => r.user_id);
    assert.ok(
      remainingIds.includes(stillPresent),
      'a currently-present member (left_at IS NULL) is never touched',
    );
    assert.ok(remainingIds.includes(justUnderCutoff), 'a departed row just under the cutoff survives');
    assert.ok(!remainingIds.includes(justOverCutoff), 'a departed row past the cutoff is purged');

    const stillPresentRow = remaining.rows.find((r) => r.user_id === stillPresent);
    assert.equal(stillPresentRow?.left_at, null, 'the surviving present member still has left_at IS NULL');

    await pool.query(`DELETE FROM server_roster WHERE user_id = ANY($1)`, [
      [stillPresent, justUnderCutoff, justOverCutoff],
    ]);
  },
);

test(
  'repository: purgeDepartedRoster at the 30-day floor spares a departed row aged between the 7-day churn window and the floor (issue #136)',
  { skip },
  async () => {
    const atFloorBoundary = `${RUN}-roster-departed-floor`;

    await upsertRosterMember({ platform: 'discord', userId: atFloorBoundary, displayName: 'Floor' });
    // Aged past list_roster's 7-day "left this week" churn window, but
    // comfortably under the 30-day floor MIN_ROSTER_DEPARTED_RETENTION_DAYS
    // enforces — must survive a purge run at exactly that floor.
    await pool.query(
      `UPDATE server_roster SET left_at = now() - interval '20 days'
        WHERE platform = 'discord' AND user_id = $1`,
      [atFloorBoundary],
    );

    await purgeDepartedRoster(30);

    const survivors = await pool.query(`SELECT 1 FROM server_roster WHERE user_id = $1`, [atFloorBoundary]);
    assert.equal(
      survivors.rows.length,
      1,
      'a departed row aged between 7 and 30 days survives a purge run at the 30-day floor',
    );

    await pool.query(`DELETE FROM server_roster WHERE user_id = $1`, [atFloorBoundary]);
  },
);

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
    assert.equal(refused, null, 'SECURITY: resolving a report outside the caller scope must fail');

    const stillOpen = await pool.query(`SELECT status FROM content_reports WHERE id = $1`, [report.id]);
    assert.equal(stillOpen.rows[0].status, 'open', 'the out-of-scope report is left untouched');

    const allowed = await resolveContentReport(report.id, 'dismissed', `${RUN}-super-admin`, undefined);
    assert.deepEqual(
      allowed,
      {
        platform: 'discord',
        reporterUserId: reporter,
        reason: 'an admin scoped only to inScopeConvo must not be able to resolve this',
      },
      'an unrestricted (super-admin) scope can resolve any report and returns the row',
    );

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
  'SECURITY: repository: the accused-admin report exclusion covers a LINKED identity — an admin cannot see/resolve a DM report filed against their other-platform id (advisory C)',
  { skip },
  async () => {
    const dA = `${RUN}-cadv-dA`; // Discord identity of admin A
    const wA = `${RUN}-cadv-wA`; // WhatsApp identity of admin A (linked to dA)
    const reporter = `${RUN}-cadv-reporter`;
    const other = `${RUN}-cadv-other`; // an unrelated admin
    const inScopeConvo = `${RUN}-cadv-in`;
    const dmConvo = `${RUN}-cadv-dm`;

    await upsertMember({ platform: 'discord', userId: dA, role: 'admin', addedBy: `${RUN}-super` });
    await upsertMember({ platform: 'whatsapp', userId: wA, role: 'admin', addedBy: `${RUN}-super` });
    await linkMembers('discord', dA, 'whatsapp', wA);

    // A member DMs the bot on WhatsApp and reports admin A by A's WhatsApp number.
    const report = await createContentReport({
      platform: 'whatsapp',
      reporterUserId: reporter,
      conversationId: dmConvo,
      targetUserId: wA,
      reason: 'reporting the admin, by their other-platform id, from a DM',
      isDirect: true,
    });
    assert.ok(report);

    const linked = (await resolveLinkedIdentities('discord', dA)).map((i) => i.userId);
    assert.ok(linked.includes(dA) && linked.includes(wA), 'admin A resolves to both linked identities');

    // With only the raw current-platform id, the whatsapp-id target IS DISTINCT,
    // so the report leaks to the accused admin — the gap the fix closes.
    const rawIdOnly = await listReports([inScopeConvo], undefined, 50, [dA]);
    assert.ok(
      rawIdOnly.some((r) => r.id === report.id),
      'a single raw id leaves the cross-platform gap open (this is what the fix must close)',
    );

    // With the full linked set the report is hidden, uncountable, unresolvable.
    const withLinked = await listReports([inScopeConvo], undefined, 50, linked);
    assert.ok(
      !withLinked.some((r) => r.id === report.id),
      'SECURITY: a report against A’s LINKED identity is hidden from A',
    );
    assert.equal(
      await countOpenReports([inScopeConvo], linked),
      0,
      'SECURITY: and excluded from A’s open-report count',
    );
    assert.equal(
      await resolveContentReport(report.id, 'dismissed', dA, [inScopeConvo], linked),
      null,
      'SECURITY: A cannot dismiss a report filed against their linked identity',
    );

    // A genuinely unrelated admin is unaffected and can still act on it.
    const otherView = await listReports([inScopeConvo], undefined, 50, [other]);
    assert.ok(
      otherView.some((r) => r.id === report.id),
      'an unrelated admin still sees the DM-originated report',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = $1`, [report.id]);
    await pool.query(`DELETE FROM community_users WHERE platform_user_id = ANY($1)`, [[dA, wA]]);
  },
);

test(
  'SECURITY: repository: purgeUserData clears session continuity so purged messages are not recallable in a resumed transcript (advisory B1)',
  { skip },
  async () => {
    const user = `${RUN}-b1-user`;
    const convo = `${RUN}-b1-convo`;
    await recordInteraction({
      platform: 'discord',
      conversationId: convo,
      userId: user,
      role: 'member',
      direction: 'inbound',
      content: 'a secret the member later asks to forget',
    });
    await setClaudeSessionId('discord', convo, `sess-${convo}`);
    assert.equal(
      (await getClaudeSession('discord', convo))?.sessionId,
      `sess-${convo}`,
      'a live resumable session exists before the purge',
    );

    await purgeUserData('discord', user);

    assert.equal(
      await getClaudeSession('discord', convo),
      null,
      'SECURITY: purge nulls the resumed-session id, so the purged content cannot survive in a live Claude transcript',
    );

    await pool.query(`DELETE FROM sessions WHERE conversation_id = $1`, [convo]);
  },
);

test(
  'SECURITY: repository: deleting/editing a stored message by id invalidates any context digest built over it, scoped to its conversation (advisory B5/D)',
  { skip },
  async () => {
    const user = `${RUN}-b5-user`;
    const convo = `${RUN}-b5-convo`;
    const otherConvo = `${RUN}-b5-other`;
    const messageId = `${RUN}-b5-msg`;
    await recordInteraction({
      platform: 'discord',
      conversationId: convo,
      userId: user,
      role: 'member',
      direction: 'inbound',
      content: 'a message a digest is later built over',
      messageId,
    });
    const { rows } = await pool.query(
      `SELECT id FROM interactions WHERE platform = 'discord' AND conversation_id = $1 AND message_id = $2`,
      [convo, messageId],
    );
    const interactionId = Number(rows[0].id);
    const digestId = await insertContextDigest({
      periodStart: new Date(0),
      periodEnd: new Date(),
      platform: 'discord',
      topic: `${RUN}-b5-topic`,
      summary: 'distilled from the member message',
      exampleRefs: [interactionId],
      distinctUsers: 2,
      questionCount: 2,
    });

    // A revoke/delete keyed to the same id but a DIFFERENT conversation is a
    // no-op (cross-conversation tamper guard) and leaves the digest intact.
    assert.equal(await deleteInteractionByMessageId('discord', otherConvo, messageId), 0);
    assert.equal(
      (await pool.query(`SELECT 1 FROM context_digests WHERE id = $1`, [digestId])).rows.length,
      1,
      'SECURITY: a wrong-conversation delete neither removes the row nor invalidates the digest',
    );

    // The correctly-scoped delete removes the row AND invalidates the digest.
    assert.equal(await deleteInteractionByMessageId('discord', convo, messageId), 1);
    assert.equal(
      (await pool.query(`SELECT 1 FROM context_digests WHERE id = $1`, [digestId])).rows.length,
      0,
      'SECURITY: the digest built over the deleted message is invalidated, matching the purge path',
    );

    await pool.query(`DELETE FROM context_digests WHERE id = $1`, [digestId]);
  },
);

test(
  'repository: getInteractionAuthorByMessageId returns the stored author, scoped to its conversation',
  { skip },
  async () => {
    const author = `${RUN}-author`;
    const convo = `${RUN}-author-convo`;
    const messageId = `${RUN}-author-msg`;
    await recordInteraction({
      platform: 'whatsapp',
      conversationId: convo,
      userId: author,
      role: 'member',
      direction: 'inbound',
      content: 'authored message',
      messageId,
    });
    assert.equal(await getInteractionAuthorByMessageId('whatsapp', convo, messageId), author);
    assert.equal(
      await getInteractionAuthorByMessageId('whatsapp', `${convo}-other`, messageId),
      null,
      'a wrong-conversation lookup finds nothing — the authorship check fails safe',
    );
    await pool.query(`DELETE FROM interactions WHERE platform = 'whatsapp' AND message_id = $1`, [messageId]);
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
  'resolveDisplayName prefers the membership row, falls back to the roster, else null',
  { skip },
  async () => {
    const uid = `${RUN}-name`;
    assert.equal(await resolveDisplayName('discord', uid), null, 'unknown user has no stored name');

    await pool.query(
      `INSERT INTO server_roster (platform, user_id, display_name) VALUES ('discord', $1, 'Roster Name')`,
      [uid],
    );
    assert.equal(await resolveDisplayName('discord', uid), 'Roster Name', 'falls back to the roster name');

    await upsertMember({
      platform: 'discord',
      userId: uid,
      role: 'member',
      addedBy: `${RUN}-admin`,
      displayName: 'Member Name',
    });
    assert.equal(
      await resolveDisplayName('discord', uid),
      'Member Name',
      'the membership display name takes precedence over the roster',
    );

    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      uid,
    ]);
    await pool.query(`DELETE FROM server_roster WHERE platform = 'discord' AND user_id = $1`, [uid]);
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

test(
  'repository: getResponseStyle defaults to standard with no row, and round-trips through setResponseStyle (issue #126)',
  { skip },
  async () => {
    const userId = `${RUN}-response-style-user`;

    assert.equal(
      await getResponseStyle('discord', userId),
      'standard',
      "a caller who never called set_response_style gets today's default behaviour",
    );

    await setResponseStyle('discord', userId, 'plain');
    assert.equal(await getResponseStyle('discord', userId), 'plain');

    // Calling it again (upsert) updates in place rather than erroring or duplicating.
    await setResponseStyle('discord', userId, 'standard');
    assert.equal(await getResponseStyle('discord', userId), 'standard');
    const { rows } = await pool.query(
      `SELECT count(*) AS n FROM response_style_prefs WHERE platform = 'discord' AND user_id = $1`,
      [userId],
    );
    assert.equal(Number(rows[0].n), 1, 'setResponseStyle upserts one row, never duplicates');

    await pool.query(`DELETE FROM response_style_prefs WHERE platform = 'discord' AND user_id = $1`, [
      userId,
    ]);
  },
);

test(
  'SECURITY: repository: purgeUserData (forget_me/purge_user_data) removes the response-style preference (issue #126)',
  { skip },
  async () => {
    const userId = `${RUN}-response-style-purge-user`;

    await setResponseStyle('discord', userId, 'plain');
    assert.equal(await getResponseStyle('discord', userId), 'plain');

    const purged = await purgeUserData('discord', userId);
    assert.ok(purged >= 1, 'purge count includes the response-style row');
    assert.equal(
      await getResponseStyle('discord', userId),
      'standard',
      'SECURITY: after purge, the caller reverts to the default as if they never set a preference',
    );
  },
);

test(
  'repository: getLanguagePreference defaults to auto with no row, and round-trips through setLanguagePreference (issue #189)',
  { skip },
  async () => {
    const userId = `${RUN}-language-preference-user`;

    assert.equal(
      await getLanguagePreference('discord', userId),
      'auto',
      "a caller who never called set_language_preference gets today's default mirroring behaviour",
    );

    await setLanguagePreference('discord', userId, 'mi');
    assert.equal(await getLanguagePreference('discord', userId), 'mi');

    await setLanguagePreference('discord', userId, 'en');
    assert.equal(await getLanguagePreference('discord', userId), 'en');

    // Calling it again (upsert) updates in place rather than erroring or duplicating.
    await setLanguagePreference('discord', userId, 'auto');
    assert.equal(await getLanguagePreference('discord', userId), 'auto');
    const { rows } = await pool.query(
      `SELECT count(*) AS n FROM language_prefs WHERE platform = 'discord' AND user_id = $1`,
      [userId],
    );
    assert.equal(Number(rows[0].n), 1, 'setLanguagePreference upserts one row, never duplicates');

    await pool.query(`DELETE FROM language_prefs WHERE platform = 'discord' AND user_id = $1`, [userId]);
  },
);

test(
  'SECURITY: repository: purgeUserData (forget_me/purge_user_data) removes the language preference (issue #189)',
  { skip },
  async () => {
    const userId = `${RUN}-language-preference-purge-user`;

    await setLanguagePreference('discord', userId, 'mi');
    assert.equal(await getLanguagePreference('discord', userId), 'mi');

    const purged = await purgeUserData('discord', userId);
    assert.ok(purged >= 1, 'purge count includes the language-preference row');
    assert.equal(
      await getLanguagePreference('discord', userId),
      'auto',
      'SECURITY: after purge, the caller reverts to the default as if they never set a preference',
    );
  },
);

// --- Answer feedback (member rating of the bot's own answers, issue #118) ---

/** Narrows createAnswerFeedback's result, failing the test with a clear message on a refusal. */
function expectFeedbackId(
  result: Awaited<ReturnType<typeof createAnswerFeedback>>,
  message = 'expected the rating to be recorded',
): number {
  if (result === 'no_recent_answer' || result === 'rate_limited') {
    assert.fail(`${message} (got "${result}")`);
  }
  return result.id;
}

test(
  "repository: createAnswerFeedback binds to the caller's most recent outbound reply and listAnswerFeedback returns it",
  { skip },
  async () => {
    const userId = `${RUN}-rate-answer-user`;
    const conversationId = `${RUN}-c-rate-answer`;

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId,
      role: 'member',
      direction: 'inbound',
      content: 'what does the bot do?',
    });
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'here is the answer',
      meta: { replyToUserId: userId },
    });

    const feedbackId = expectFeedbackId(
      await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: true }),
    );

    const listed = await listAnswerFeedback([conversationId]);
    const row = listed.find((r) => r.id === feedbackId);
    assert.ok(row, 'the rating is visible via listAnswerFeedback');
    assert.equal(row.helpful, true);
    assert.equal(row.userId, userId);
    assert.ok(row.interactionId !== null, 'bound to the resolved outbound interaction');
    assert.equal(row.content, 'here is the answer', 'the rated answer text is joined in (issue #269)');
    assert.equal(row.knowledgeEntryId, null, 'not shortcut-served, so no knowledge entry linkage');

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  "SECURITY: repository: createAnswerFeedback binds to the caller's OWN outbound reply, never a concurrent reply to a different member in the same busy conversation",
  { skip },
  async () => {
    const conversationId = `${RUN}-c-rate-answer-group`;
    const memberA = `${RUN}-rate-answer-member-a`;
    const memberB = `${RUN}-rate-answer-member-b`;

    // The bot answers member A first...
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'answer for member A',
      meta: { replyToUserId: memberA },
    });
    // ...then answers member B more recently. Without caller-scoped
    // resolution, a naive "most recent outbound in this conversation" query
    // would wrongly bind member A's rating below to THIS reply.
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'answer for member B',
      meta: { replyToUserId: memberB },
    });

    expectFeedbackId(
      await createAnswerFeedback({ platform: 'discord', conversationId, userId: memberA, helpful: true }),
    );

    const rows = await pool.query(
      `SELECT content FROM interactions WHERE id = (
         SELECT interaction_id FROM answer_feedback WHERE platform = 'discord' AND user_id = $1
       )`,
      [memberA],
    );
    assert.equal(
      rows.rows[0]?.content,
      'answer for member A',
      "SECURITY: member A's rating must bind to the answer the bot gave THEM, not the more-recent reply to member B",
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = $1`, [memberA]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  "repository: createAnswerFeedback falls back to the conversation's most-recent outbound reply when no caller-scoped match exists (e.g. a legacy row with no replyToUserId)",
  { skip },
  async () => {
    const conversationId = `${RUN}-c-rate-answer-fallback`;
    const userId = `${RUN}-rate-answer-fallback-user`;

    // Simulate a legacy outbound row predating the replyToUserId meta field —
    // inserted directly, since recordInteraction always sets meta now.
    await pool.query(
      `INSERT INTO interactions (platform, conversation_id, user_id, role, direction, content, meta)
       VALUES ('discord', $1, 'bot', 'member', 'outbound', 'legacy reply with no replyToUserId meta', '{}'::jsonb)`,
      [conversationId],
    );

    expectFeedbackId(
      await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: false }),
      'falls back to the conversation-most-recent reply',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  "repository: createAnswerFeedback declines gracefully with 'no_recent_answer' when there is nothing to rate yet",
  { skip },
  async () => {
    const conversationId = `${RUN}-c-rate-answer-empty`;
    const userId = `${RUN}-rate-answer-empty-user`;

    const result = await createAnswerFeedback({
      platform: 'discord',
      conversationId,
      userId,
      helpful: true,
    });
    assert.equal(result, 'no_recent_answer');

    const rows = await pool.query(`SELECT 1 FROM answer_feedback WHERE user_id = $1`, [userId]);
    assert.equal(rows.rows.length, 0, 'no row is inserted when there is no answer to bind to');
  },
);

test(
  'SECURITY: repository: createAnswerFeedback enforces a DB-backed rolling-24h cap per rater, robust to a simulated process restart',
  { skip },
  async () => {
    const userId = `${RUN}-rate-answer-cap-user`;
    const conversationId = `${RUN}-c-rate-answer-cap`;

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'the answer being rated repeatedly',
      meta: { replyToUserId: userId },
    });

    // Seed cap-many ratings via direct SQL, as if written by a previous
    // process instance, so an in-memory counter would wrongly admit the next
    // one but the DB-backed COUNT(*) refuses it (same pattern as
    // createContentReport/createSuggestion's rate-cap tests).
    for (let i = 0; i < RATE_ANSWER_DAILY_LIMIT; i++) {
      await pool.query(
        `INSERT INTO answer_feedback (platform, conversation_id, user_id, helpful) VALUES ($1,$2,$3,$4)`,
        ['discord', conversationId, userId, i % 2 === 0],
      );
    }

    const rejected = await createAnswerFeedback({
      platform: 'discord',
      conversationId,
      userId,
      helpful: true,
    });
    assert.equal(rejected, 'rate_limited', 'the (cap+1)th rating in 24h is refused, not silently accepted');

    const countAfterRejection = await pool.query(
      `SELECT count(*) AS n FROM answer_feedback WHERE user_id = $1`,
      [userId],
    );
    assert.equal(
      Number(countAfterRejection.rows[0].n),
      RATE_ANSWER_DAILY_LIMIT,
      'no row is inserted for a refused rating',
    );

    // Age one rating past the 24h window — it should no longer count.
    await pool.query(
      `UPDATE answer_feedback SET created_at = now() - interval '25 hours'
        WHERE id = (SELECT id FROM answer_feedback WHERE user_id = $1 ORDER BY id LIMIT 1)`,
      [userId],
    );
    expectFeedbackId(
      await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: false }),
      'a rating should be accepted again once an old one falls outside the rolling window',
    );

    // A different rater is unaffected by another user's cap.
    const otherUser = `${RUN}-rate-answer-cap-other`;
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'answer for the other rater',
      meta: { replyToUserId: otherUser },
    });
    expectFeedbackId(
      await createAnswerFeedback({ platform: 'discord', conversationId, userId: otherUser, helpful: true }),
      'the cap should be per-rater, not global',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [[userId, otherUser]]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  'SECURITY: repository: listAnswerFeedback scopes by conversation and filters by unhelpfulOnly',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-feedback-list-in`;
    const outOfScopeConvo = `${RUN}-c-feedback-list-out`;
    const helpfulUser = `${RUN}-feedback-list-helpful`;
    const unhelpfulUser = `${RUN}-feedback-list-unhelpful`;
    const outOfScopeUser = `${RUN}-feedback-list-outscope`;

    for (const [convo, user] of [
      [inScopeConvo, helpfulUser],
      [inScopeConvo, unhelpfulUser],
      [outOfScopeConvo, outOfScopeUser],
    ] as const) {
      await recordInteraction({
        platform: 'discord',
        conversationId: convo,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `answer for ${user}`,
        meta: { replyToUserId: user },
      });
    }

    const inScopeHelpfulId = expectFeedbackId(
      await createAnswerFeedback({
        platform: 'discord',
        conversationId: inScopeConvo,
        userId: helpfulUser,
        helpful: true,
      }),
    );
    const inScopeUnhelpfulId = expectFeedbackId(
      await createAnswerFeedback({
        platform: 'discord',
        conversationId: inScopeConvo,
        userId: unhelpfulUser,
        helpful: false,
      }),
    );
    const outOfScopeId = expectFeedbackId(
      await createAnswerFeedback({
        platform: 'discord',
        conversationId: outOfScopeConvo,
        userId: outOfScopeUser,
        helpful: false,
      }),
    );

    const scoped = await listAnswerFeedback([inScopeConvo]);
    assert.ok(
      scoped.some((r) => r.id === inScopeHelpfulId),
      'the in-scope helpful rating is visible',
    );
    assert.ok(
      !scoped.some((r) => r.id === outOfScopeId),
      'SECURITY: a rating outside the scope filter must never be returned',
    );

    const unscoped = await listAnswerFeedback(null);
    assert.ok(
      unscoped.some((r) => r.id === outOfScopeId),
      'null scope (super admin) sees every conversation',
    );

    const unhelpfulOnly = await listAnswerFeedback([inScopeConvo], true);
    assert.ok(
      unhelpfulOnly.some((r) => r.id === inScopeUnhelpfulId),
      'unhelpfulOnly includes the unhelpful rating',
    );
    assert.ok(
      !unhelpfulOnly.some((r) => r.id === inScopeHelpfulId),
      'unhelpfulOnly excludes the helpful rating',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [
      [helpfulUser, unhelpfulUser, outOfScopeUser],
    ]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [
      [inScopeConvo, outOfScopeConvo],
    ]);
  },
);

// listKnowledgeFeedbackSummary (issue #287): the grouped complement to
// listAnswerFeedback, aggregating answer_feedback per knowledgeEntryId.
test(
  'repository: listKnowledgeFeedbackSummary aggregates per knowledge entry, applies the minUnhelpful threshold, sorts by unhelpfulCount descending, and never counts ratings on non-shortcut-served answers',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-knowledge-feedback-summary`;
    const { id: hotEntryId } = await saveKnowledge({
      content: `${RUN} hot entry content`,
      title: `${RUN} hot entry`,
    });
    const { id: mediumEntryId } = await saveKnowledge({
      content: `${RUN} medium entry content`,
      title: `${RUN} medium entry`,
    });
    const { id: warmEntryId } = await saveKnowledge({
      content: `${RUN} warm entry content`,
      title: `${RUN} warm entry`,
    });

    async function rateShortcut(entryId: number, userSuffix: string, helpful: boolean) {
      const userId = `${RUN}-summary-${userSuffix}`;
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `shortcut answer for ${userId}`,
        meta: { replyToUserId: userId, knowledgeShortcut: true, knowledgeEntryId: entryId },
      });
      expectFeedbackId(await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful }));
      return userId;
    }

    const users: string[] = [];
    // hotEntry: 3 unhelpful, 1 helpful — clears the default threshold with the highest unhelpfulCount.
    users.push(await rateShortcut(hotEntryId, 'hot-u1', false));
    users.push(await rateShortcut(hotEntryId, 'hot-u2', false));
    users.push(await rateShortcut(hotEntryId, 'hot-u3', false));
    users.push(await rateShortcut(hotEntryId, 'hot-u4', true));
    // mediumEntry: exactly 2 unhelpful — clears the default threshold, fewer than hotEntry.
    users.push(await rateShortcut(mediumEntryId, 'medium-u1', false));
    users.push(await rateShortcut(mediumEntryId, 'medium-u2', false));
    // warmEntry: exactly 1 unhelpful — below the default threshold of 2.
    users.push(await rateShortcut(warmEntryId, 'warm-u1', false));

    // Non-shortcut-served rating: must never be counted toward any entry.
    const plainUser = `${RUN}-summary-plain`;
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'a plain non-shortcut answer',
      meta: { replyToUserId: plainUser },
    });
    expectFeedbackId(
      await createAnswerFeedback({ platform: 'discord', conversationId, userId: plainUser, helpful: false }),
    );
    users.push(plainUser);

    const defaultSummary = await listKnowledgeFeedbackSummary([conversationId]);
    const hotRow = defaultSummary.find((s) => s.knowledgeEntryId === hotEntryId);
    assert.ok(hotRow, 'hotEntry clears the default threshold and is aggregated');
    assert.equal(hotRow?.unhelpfulCount, 3, 'hotEntry unhelpfulCount is correct');
    assert.equal(hotRow?.helpfulCount, 1, 'hotEntry helpfulCount is correct');
    assert.ok(
      defaultSummary.some((s) => s.knowledgeEntryId === mediumEntryId && s.unhelpfulCount === 2),
      'mediumEntry (exactly 2 unhelpful) clears the default threshold',
    );
    assert.ok(
      !defaultSummary.some((s) => s.knowledgeEntryId === warmEntryId),
      'warmEntry (1 unhelpful) is excluded at the default minUnhelpful threshold of 2',
    );
    const hotIndex = defaultSummary.findIndex((s) => s.knowledgeEntryId === hotEntryId);
    const mediumIndex = defaultSummary.findIndex((s) => s.knowledgeEntryId === mediumEntryId);
    assert.ok(
      hotIndex >= 0 && mediumIndex >= 0 && hotIndex < mediumIndex,
      'entries are sorted by unhelpfulCount descending (hotEntry before mediumEntry)',
    );

    const lowerThreshold = await listKnowledgeFeedbackSummary([conversationId], 1);
    assert.ok(
      lowerThreshold.some((s) => s.knowledgeEntryId === warmEntryId && s.unhelpfulCount === 1),
      'warmEntry is included once minUnhelpful is lowered to 1',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[hotEntryId, mediumEntryId, warmEntryId]]);
  },
);

test(
  'SECURITY: repository: listKnowledgeFeedbackSummary scopes by conversation — a rating recorded outside the calling admin scope is excluded from the aggregate entirely, while a null (super admin) scope sees it',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-knowledge-feedback-scope-in`;
    const outOfScopeConvo = `${RUN}-c-knowledge-feedback-scope-out`;
    const { id: entryId } = await saveKnowledge({ content: `${RUN} scope-test entry content` });

    async function rateShortcut(conversationId: string, userSuffix: string) {
      const userId = `${RUN}-summary-scope-${userSuffix}`;
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `shortcut answer for ${userId}`,
        meta: { replyToUserId: userId, knowledgeShortcut: true, knowledgeEntryId: entryId },
      });
      expectFeedbackId(
        await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: false }),
      );
      return userId;
    }

    const inScopeUsers = [await rateShortcut(inScopeConvo, 'in-1'), await rateShortcut(inScopeConvo, 'in-2')];
    const outOfScopeUsers = [
      await rateShortcut(outOfScopeConvo, 'out-1'),
      await rateShortcut(outOfScopeConvo, 'out-2'),
    ];

    const scoped = await listKnowledgeFeedbackSummary([inScopeConvo], 1);
    const scopedRow = scoped.find((s) => s.knowledgeEntryId === entryId);
    assert.ok(scopedRow, 'the in-scope ratings are aggregated');
    assert.equal(
      scopedRow?.unhelpfulCount,
      2,
      'SECURITY: only the 2 in-scope ratings are counted, never the 2 out-of-scope ratings',
    );

    const unscoped = await listKnowledgeFeedbackSummary(null, 1);
    const unscopedRow = unscoped.find((s) => s.knowledgeEntryId === entryId);
    assert.equal(
      unscopedRow?.unhelpfulCount,
      4,
      'null scope (super admin) sees ratings from every conversation, including out-of-scope ones',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [
      [...inScopeUsers, ...outOfScopeUsers],
    ]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [
      [inScopeConvo, outOfScopeConvo],
    ]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [entryId]);
  },
);

// isKnowledgeLowRated (issue #337): the entry-scoped, threshold-decision-only
// lookup behind the member knowledge-shortcut's low-rated caveat. Deliberately
// UNSCOPED by conversation (there is no admin identity to scope to at serve
// time), the opposite of listKnowledgeFeedbackSummary's admin-tier scoping
// tested just above.
test(
  'SECURITY: repository: isKnowledgeLowRated counts feedback for the served entry id only, globally across conversations, and crosses the boundary as a boolean threshold decision — never the raw count',
  { skip },
  async () => {
    const convoA = `${RUN}-c-low-rated-a`;
    const convoB = `${RUN}-c-low-rated-b`;
    const { id: lowRatedEntryId } = await saveKnowledge({ content: `${RUN} low-rated entry content` });
    const { id: otherEntryId } = await saveKnowledge({ content: `${RUN} other entry content` });

    async function rateShortcut(
      conversationId: string,
      entryId: number,
      userSuffix: string,
      helpful: boolean,
    ) {
      const userId = `${RUN}-low-rated-${userSuffix}`;
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `shortcut answer for ${userId}`,
        meta: { replyToUserId: userId, knowledgeShortcut: true, knowledgeEntryId: entryId },
      });
      expectFeedbackId(await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful }));
      return userId;
    }

    const users: string[] = [];
    // 2 unhelpful spread across two DIFFERENT conversations — must still be
    // counted globally (unscoped), unlike listKnowledgeFeedbackSummary above.
    users.push(await rateShortcut(convoA, lowRatedEntryId, 'a1', false));
    users.push(await rateShortcut(convoB, lowRatedEntryId, 'b1', false));
    // A helpful rating and a rating on a DIFFERENT entry must never count
    // toward lowRatedEntryId's threshold.
    users.push(await rateShortcut(convoA, lowRatedEntryId, 'a2', true));
    users.push(await rateShortcut(convoA, otherEntryId, 'other', false));

    const belowThreshold = await isKnowledgeLowRated(lowRatedEntryId, 3);
    assert.equal(
      typeof belowThreshold,
      'boolean',
      'SECURITY: must cross the boundary as a boolean, never a number',
    );
    assert.equal(belowThreshold, false, '2 unhelpful ratings does not clear a threshold of 3');

    const atThreshold = await isKnowledgeLowRated(lowRatedEntryId, 2);
    assert.equal(typeof atThreshold, 'boolean');
    assert.equal(
      atThreshold,
      true,
      '2 unhelpful ratings clears a threshold of 2, summed across BOTH conversations',
    );

    const otherEntryLowRated = await isKnowledgeLowRated(otherEntryId, 2);
    assert.equal(
      otherEntryLowRated,
      false,
      "SECURITY: a different entry with only 1 unhelpful rating of its own must never inherit lowRatedEntryId's count",
    );

    const neverServedEntryId = otherEntryId + 1_000_000;
    const neverServed = await isKnowledgeLowRated(neverServedEntryId, 2);
    assert.equal(neverServed, false, 'an entry id with no feedback rows at all is never low-rated');

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [[convoA, convoB]]);
    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[lowRatedEntryId, otherEntryId]]);
  },
);

test(
  "SECURITY: repository: purgeUserData deletes the rater's OWN answer_feedback rows, and separately purging the RATED interaction's recipient nulls interaction_id via ON DELETE SET NULL rather than deleting the feedback row",
  { skip },
  async () => {
    const conversationId = `${RUN}-c-feedback-purge`;
    const rater = `${RUN}-feedback-purge-rater`;
    const recipient = `${RUN}-feedback-purge-recipient`;

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'the answer that will later be purged',
      meta: { replyToUserId: recipient },
    });
    const feedbackId = expectFeedbackId(
      await createAnswerFeedback({ platform: 'discord', conversationId, userId: rater, helpful: true }),
    );

    // Purging the RECIPIENT (the person the rated answer was sent to) deletes
    // their outbound interaction, which must SET NULL on the FK rather than
    // deleting or orphaning the rater's feedback row.
    await purgeUserData('discord', recipient);
    const afterRecipientPurge = await pool.query(`SELECT interaction_id FROM answer_feedback WHERE id = $1`, [
      feedbackId,
    ]);
    assert.equal(afterRecipientPurge.rows.length, 1, "the rater's feedback row itself survives");
    assert.equal(
      afterRecipientPurge.rows[0].interaction_id,
      null,
      'SECURITY: interaction_id is nulled (ON DELETE SET NULL), not left dangling, once the rated reply is purged',
    );

    const purgedRater = await purgeUserData('discord', rater);
    assert.ok(purgedRater >= 1, "purge count includes the rater's own feedback rows");
    const afterRaterPurge = await pool.query(`SELECT 1 FROM answer_feedback WHERE user_id = $1`, [rater]);
    assert.equal(afterRaterPurge.rows.length, 0, "the rater's own feedback rows are gone after their purge");
  },
);

// --- Self-service data summary (my_data, issue #188 — the IPP6 access-right
// counterpart to forget_me/purge_user_data's deletion path) --------------------

test(
  'SECURITY: repository: getMyDataSummary counts reconcile PER-TABLE with forget_me/purgeUserData, and never counts member_notes/member_warnings/server_roster/admin_digest_sends/answer_feedback even though purgeUserData deletes all of them too (issue #188)',
  { skip },
  async () => {
    const userId = `${RUN}-my-data-user`;
    const conversationId = `${RUN}-c-my-data`;

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId,
      role: 'member',
      direction: 'inbound',
      content: 'my own message one',
    });
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId,
      role: 'member',
      direction: 'inbound',
      content: 'my own message two',
    });
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'a reply to me',
      meta: { replyToUserId: userId },
    });

    await saveKnowledge({ content: 'a fact sourced from this user', sourceUserId: userId });
    const suggestion = await createSuggestion({ platform: 'discord', userId, content: 'my idea' });
    const report = await createContentReport({
      platform: 'discord',
      reporterUserId: userId,
      conversationId,
      reason: 'my report',
    });
    assert.ok(suggestion && report, 'fixtures recorded');
    await setResponseStyle('discord', userId, 'plain');

    // Fixtures for tables getMyDataSummary must NEVER count or query, even
    // though forget_me/purgeUserData deletes every one of them too (issue
    // #45 for member_notes specifically; the others by the same "purge-only,
    // never member-readable" boundary).
    await addMemberNote({
      platform: 'discord',
      userId,
      note: 'admin-only context about this member',
      createdBy: `${RUN}-my-data-admin`,
    });
    await addWarning({
      platform: 'discord',
      userId,
      reason: 'test',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    await upsertRosterMember({ platform: 'discord', userId, displayName: 'Roster Name' });
    await recordAdminDigestSent('discord', userId);
    expectFeedbackId(
      await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: true }),
      'answer_feedback fixture must be recorded',
    );

    const summary = await getMyDataSummary('discord', userId);
    assert.equal(summary.ownMessages, 2, "counts the caller's own inbound messages");
    assert.equal(summary.repliesToThem, 1, "counts the bot's replies to the caller");
    assert.equal(summary.knowledgeEntries, 1);
    assert.equal(summary.reportsFiled, 1);
    assert.equal(summary.suggestionsFiled, 1);
    assert.equal(summary.responseStyle, 'plain');
    assert.deepEqual(
      Object.keys(summary).sort(),
      [
        'knowledgeEntries',
        'ownMessages',
        'repliesToThem',
        'reportsFiled',
        'responseStyle',
        'suggestionsFiled',
      ],
      'SECURITY: getMyDataSummary never grows a member_notes/warnings/roster/digest-sends/feedback field',
    );

    // Per-table reconcile (NOT total): forget_me/purgeUserData deletes a
    // strict SUPERSET of what getMyDataSummary reports. This asserts the
    // divergence is intended, not a bug a naive "reconcile the totals"
    // implementation would paper over by adding a member_notes count.
    const reportedTotal =
      summary.ownMessages +
      summary.repliesToThem +
      summary.knowledgeEntries +
      summary.reportsFiled +
      summary.suggestionsFiled;
    const purged = await purgeUserData('discord', userId);
    assert.ok(
      purged > reportedTotal,
      'SECURITY: forget_me deletes strictly more than my_data ever reported — member_notes, member_warnings, ' +
        'server_roster, admin_digest_sends, and answer_feedback are purged despite never being surfaced',
    );

    const afterPurge = await getMyDataSummary('discord', userId);
    assert.deepEqual(
      afterPurge,
      {
        ownMessages: 0,
        repliesToThem: 0,
        knowledgeEntries: 0,
        reportsFiled: 0,
        suggestionsFiled: 0,
        responseStyle: 'standard',
      },
      'every table getMyDataSummary reports is empty after purge — reconciled per-table with the DELETE',
    );

    // And the excluded tables are indeed gone too, proving purgeUserData's
    // superset claim above rather than just asserting a bigger number.
    const remainingNotes = await listMemberNotes('discord', userId);
    assert.equal(
      remainingNotes.length,
      0,
      'member_notes purged even though my_data never reported it (issue #45)',
    );
    assert.equal(
      await countActiveWarnings('discord', userId),
      0,
      'member_warnings purged though never reported',
    );
    const { rows: rosterRows } = await pool.query(
      `SELECT 1 FROM server_roster WHERE platform = 'discord' AND user_id = $1`,
      [userId],
    );
    assert.equal(rosterRows.length, 0, 'server_roster purged though never reported');
    const { rows: digestRows } = await pool.query(
      `SELECT 1 FROM admin_digest_sends WHERE platform = 'discord' AND platform_user_id = $1`,
      [userId],
    );
    assert.equal(digestRows.length, 0, 'admin_digest_sends purged though never reported');
    const { rows: feedbackRows } = await pool.query(
      `SELECT 1 FROM answer_feedback WHERE platform = 'discord' AND user_id = $1`,
      [userId],
    );
    assert.equal(feedbackRows.length, 0, 'answer_feedback purged though never reported');
  },
);

test(
  'SECURITY: repository: getMyDataSummary aggregates across identities linked via link_member, exactly like forget_me/purgeUserData does — so the counts a member sees always match what forget_me would actually erase',
  { skip },
  async () => {
    const discordUser = `${RUN}-my-data-cascade-d`;
    const whatsappUser = `${RUN}-my-data-cascade-w`;
    const conversationId = `${RUN}-c-my-data-cascade`;
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
      userId: discordUser,
      role: 'member',
      direction: 'inbound',
      content: 'discord-side message',
    });
    await recordInteraction({
      platform: 'whatsapp',
      conversationId,
      userId: whatsappUser,
      role: 'member',
      direction: 'inbound',
      content: 'whatsapp-side message',
    });

    assert.equal(
      (await getMyDataSummary('discord', discordUser)).ownMessages,
      1,
      'before linking, each identity is independent',
    );
    assert.equal((await getMyDataSummary('whatsapp', whatsappUser)).ownMessages, 1);

    await linkMembers('discord', discordUser, 'whatsapp', whatsappUser);

    assert.equal(
      (await getMyDataSummary('discord', discordUser)).ownMessages,
      2,
      'SECURITY: after linking, the summary from the discord identity includes the linked whatsapp message too — matching exactly what forget_me from either identity would erase',
    );
    assert.equal(
      (await getMyDataSummary('whatsapp', whatsappUser)).ownMessages,
      2,
      'symmetric: the whatsapp identity sees the linked discord message too',
    );

    const purged = await purgeUserData('discord', discordUser);
    assert.ok(purged >= 2, 'a single forget_me call from either linked identity purges both');

    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      discordUser,
    ]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'whatsapp' AND platform_user_id = $1`, [
      whatsappUser,
    ]);
  },
);
