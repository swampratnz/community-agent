import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const { embed } = await import('../src/storage/embeddings.js');
const pgvector = (await import('pgvector/pg')).default;
const {
  recordInteraction,
  recentConversationTail,
  searchMemory,
  setClaudeSessionId,
  getClaudeSession,
  clearUserSessions,
  userMessages,
  purgeOldInteractions,
  purgeUserData,
  saveKnowledge,
  searchKnowledge,
  searchKnowledgeLexical,
  KNOWLEDGE_TRIGRAM_THRESHOLD,
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
  listKnowledgeConflictCandidates,
  countDuplicateKnowledge,
  countKnowledgeConflictCandidates,
  hasConflictAmongIds,
  countPendingKnowledgeCandidates,
  countStalePendingKnowledgeCandidates,
  hasQueuedCandidateForTopic,
  knowledgeCoversTopic,
  candidateTopicAlreadyReviewed,
  recordAdminAction,
  recentQuestionClusters,
  recentKnowledgeGapClusters,
  recordKnowledgeGap,
  countKnowledgeGaps,
  recordEscalatedKnowledgeGap,
  countEscalatedKnowledgeGaps,
  KNOWLEDGE_GAP_DAILY_LIMIT,
  KNOWLEDGE_GAP_QUERY_MAX_CHARS,
  recentModerationEntries,
  adminActivitySummary,
  autoEnrollMemberWithAudit,
  AUTO_ENROLL_ACTOR,
  usageStats,
  recordBackgroundJobCost,
  sumBackgroundJobCosts,
  recordShortcutHit,
  sumShortcutHits,
  createContentReport,
  listReports,
  listOwnReports,
  resolveContentReport,
  withdrawOwnReports,
  countOpenReports,
  oldestOpenReportAgeDays,
  countRecentDmReportsByReporterAndTarget,
  REPORT_RATE_LIMIT_PER_DAY,
  recordAccessRequest,
  countAccessRequests,
  oldestAccessRequestAgeDays,
  clearAccessRequest,
  upsertRosterMember,
  markRosterLeave,
  listRoster,
  rosterCounts,
  engagementStats,
  wasEngagementAlertSentRecently,
  recordEngagementAlertSent,
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
  oldestPendingSuggestionAgeDays,
  SUGGESTION_RATE_LIMIT_PER_DAY,
  SUGGESTION_MAX_CHARS,
  upsertMember,
  getMemberRole,
  resolveDisplayName,
  listAdminDisplayNames,
  listAdminRoster,
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
  areKnowledgeEntriesLowRated,
  countLowRatedKnowledge,
  answerFeedbackOriginSummary,
  RATE_ANSWER_DAILY_LIMIT,
  recordAdminDigestSent,
  getMyDataSummary,
  addWarning,
  countActiveWarnings,
  countStaleKnowledge,
  countUnreachableSourceKnowledge,
  isKnownMessage,
  deleteInteractionByMessageId,
  getInteractionAuthorByMessageId,
  getInteractionContentByMessageId,
  createModerationAppeal,
  listAppeals,
  resolveModerationAppeal,
  countOpenAppeals,
} = await import('../src/storage/repository.js');

// Unique per test-run tag so fixtures never collide across runs and can be
// cleaned up precisely, whether this runs against a throwaway CI Postgres or
// a developer's real local instance.
const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

/**
 * Retry an assertion block that reads shared, cross-file-visible aggregates.
 * usageStats/sumShortcutHits read the WHOLE interactions/shortcut_hits tables
 * over a sliding now()-anchored window, and the Node test runner executes
 * test FILES in parallel against this one database — so another file's
 * insert can land between a block's before/after reads and shift an exact
 * delta (the 2026-07-20 CI flakes: byPlatform delta "2 !== 1", shortcut-hit
 * inbound "122 !== 121"). Re-running the whole read-seed-read sequence gets
 * a quiet window with overwhelming probability, while a REAL regression
 * fails deterministically on every attempt — so retrying masks nothing, and
 * the final attempt's assertion error propagates with real values.
 */
async function retryOnSharedTableInterference(attempts: number, run: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run();
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      // Loud, not silent (PR #643 review): a persistently-interfered-but-
      // eventually-passing test should be visible in CI output, so a real
      // ordering bug that only mostly-fails can't hide behind the retries.
      console.warn(
        `retryOnSharedTableInterference: attempt ${attempt}/${attempts} hit interference, retrying:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

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
    assert.equal(updated.updated, true);

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
  'repository: searchKnowledgeLexical resolves an exact SNAKE_CASE identifier embedded in realistic multi-sentence content (issue #362) — pins word_similarity, not symmetric similarity()',
  { skip },
  async () => {
    const scope = `${RUN}-lexical-scope`;
    const caller = { platform: 'discord' as const, conversationId: scope };
    const identifier = `ZYLOFAX_${RUN}_RETRY_LIMIT`;
    const { id } = await saveKnowledge({
      title: 'Retry configuration',
      content:
        `When a delivery attempt fails, the worker retries with exponential backoff until it hits the ` +
        `configured ceiling; an admin can raise or lower that ceiling by tuning the ${identifier} setting, ` +
        `which defaults to a conservative value chosen to avoid hammering a struggling downstream service.`,
      scope,
    });

    // A symmetric similarity() over a short query against this realistic,
    // multi-sentence entry would score far below any sane threshold (tiny
    // intersection-over-union) — this test only passes because
    // searchKnowledgeLexical uses word_similarity, which finds the
    // best-matching extent within the longer text instead.
    const hits = await searchKnowledgeLexical(identifier, caller, 5);
    const hit = hits.find((h) => h.id === id);
    assert.ok(hit, 'the exact identifier embedded in realistic-length content is found');
    assert.ok(
      hit.similarity >= KNOWLEDGE_TRIGRAM_THRESHOLD,
      `matched hit's word_similarity score (${hit.similarity}) must clear KNOWLEDGE_TRIGRAM_THRESHOLD`,
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
  },
);

test(
  "repository: searchKnowledgeLexical matches a null-title entry (issue #362) — COALESCE(title, '') must not silently drop null-titled rows from the lexical path",
  { skip },
  async () => {
    const scope = `${RUN}-lexical-null-title-scope`;
    const caller = { platform: 'discord' as const, conversationId: scope };
    const identifier = `QUOKKAWEB_${RUN}_MAX_RETRIES`;
    const { id } = await saveKnowledge({
      content:
        `Requests that time out are automatically retried by the client, up to the ${identifier} cap, before ` +
        `the failure is finally surfaced back to the caller as an error.`,
      scope,
    });

    const titleRow = await pool.query(`SELECT title FROM knowledge WHERE id = $1`, [id]);
    assert.equal(titleRow.rows[0].title, null, 'fixture entry genuinely has a null title');

    const hits = await searchKnowledgeLexical(identifier, caller, 5);
    assert.ok(
      hits.some((h) => h.id === id),
      'a null-titled entry is still matchable via the lexical fallback',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
  },
);

test(
  'repository: searchKnowledgeLexical returns nothing for an unrelated query below KNOWLEDGE_TRIGRAM_THRESHOLD (issue #362)',
  { skip },
  async () => {
    const scope = `${RUN}-lexical-negative-scope`;
    const caller = { platform: 'discord' as const, conversationId: scope };
    const { id } = await saveKnowledge({
      title: `Quazzledorf ${RUN}`,
      content: 'Quazzledorf accounts are activated by emailing the treasurer with your membership number.',
      scope,
    });

    const hits = await searchKnowledgeLexical(
      'what time does the ferry to Waiheke leave on Saturdays',
      caller,
      5,
    );
    assert.ok(
      !hits.some((h) => h.id === id),
      'an unrelated query with no meaningful trigram overlap must not clear the threshold',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
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
  'repository: searchKnowledge and searchKnowledgeLexical both surface source_unreachable/source_checked_at (issue #465) — the weekly link-rot checker (#448) verdict, previously only threaded into the admin-only listKnowledge',
  { skip },
  async () => {
    const { id } = await saveKnowledge({
      content: `${RUN} dead link fixture, distinctively worded for both search paths`,
      sourceUrl: 'https://example.com/rotted-page',
      sourceTitle: 'Rotted page',
    });
    const checkedAt = new Date();
    await pool.query(`UPDATE knowledge SET source_unreachable = true, source_checked_at = $2 WHERE id = $1`, [
      id,
      checkedAt,
    ]);

    const caller = { platform: 'discord' as const, conversationId: 'x' };
    const semanticHits = await searchKnowledge(`${RUN} dead link fixture`, caller);
    const semanticHit = semanticHits.find((h) => h.id === id);
    assert.ok(semanticHit, 'searchKnowledge must still return the flagged entry');
    assert.equal(semanticHit.sourceUnreachable, true);
    assert.ok(semanticHit.sourceCheckedAt);
    assert.equal(new Date(semanticHit.sourceCheckedAt).getTime(), checkedAt.getTime());

    const lexicalHits = await searchKnowledgeLexical(`${RUN} dead link fixture`, caller, 5);
    const lexicalHit = lexicalHits.find((h) => h.id === id);
    assert.ok(lexicalHit, 'searchKnowledgeLexical must still return the flagged entry');
    assert.equal(lexicalHit.sourceUnreachable, true);
    assert.ok(lexicalHit.sourceCheckedAt);
    assert.equal(new Date(lexicalHit.sourceCheckedAt).getTime(), checkedAt.getTime());

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
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
  'repository: updateKnowledge surfaces the same near-duplicate nudge saveKnowledge does, but excludes the entry being edited from its own candidate set (issue #584)',
  { skip },
  async () => {
    const scope = `${RUN}-update-dup-scope`;
    const { id: firstId } = await saveKnowledge({
      title: 'WhatsApp linking steps',
      content: 'To link WhatsApp, open settings and scan the QR code shown in the admin panel.',
      scope,
    });
    const { id: secondId } = await saveKnowledge({
      title: 'Meetup schedule',
      content: 'We meet monthly on the first Tuesday at the community hall.',
      scope,
    });

    // A near-no-op edit (whitespace-only tweak) re-embeds to something ~1.0
    // similar to the entry's OWN pre-edit content — without exclusion this
    // would always self-nudge.
    const selfEdit = await updateKnowledge({
      id: secondId,
      content: 'We meet monthly on the first Tuesday at the community hall.',
      scope,
    });
    assert.equal(
      selfEdit.similarEntry,
      undefined,
      'SECURITY: the entry being edited must never be reported as its own near-duplicate',
    );

    // Editing secondId's content to converge onto firstId's topic DOES nudge,
    // pointing at the other (pre-existing) entry.
    const convergingEdit = await updateKnowledge({
      id: secondId,
      title: 'How to link WhatsApp',
      content: 'To link WhatsApp, go to settings and scan the QR code from the admin panel.',
      scope,
    });
    assert.ok(convergingEdit.similarEntry, 'a converging edit onto a different entry triggers a nudge');
    assert.equal(convergingEdit.similarEntry.id, firstId, 'nudge points at the other entry, not itself');
    assert.ok(
      convergingEdit.similarEntry.similarity >= 0.92,
      'reported similarity clears the duplicate threshold',
    );
    assert.equal(convergingEdit.similarEntry.title, 'WhatsApp linking steps');

    await pool.query(`DELETE FROM knowledge WHERE scope = $1`, [scope]);
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

// Hand-crafted, orthonormal-basis embeddings (not run through the real
// embedding model) so pairwise cosine similarity is exact and deterministic —
// same technique as recentQuestionClusters above. All vectors are unit
// length, so `1 - (a <=> b)` equals the plain dot product.
const insertKnowledgeWithEmbedding = (scope: string, title: string, vec: number[]) =>
  pool
    .query(`INSERT INTO knowledge (scope, title, content, embedding) VALUES ($1,$2,$3,$4) RETURNING id`, [
      scope,
      title,
      `content for ${title}`,
      pgvector.toSql(vec),
    ])
    .then((r) => Number(r.rows[0].id));

test(
  'repository: listKnowledgeConflictCandidates returns a mid-band pair, excludes a near-duplicate pair (>= 0.92, owned by listDuplicateKnowledge), and excludes a pair below the conflict floor (issue #330)',
  { skip },
  async () => {
    const scope = `${RUN}-list-conflict-scope`;
    const dim = config.db.embeddingDim;

    const anchorVec = new Array(dim).fill(0);
    anchorVec[0] = 1;

    // similarity to anchor = 0.7 — inside [0.55, 0.92)
    const midBandVec = new Array(dim).fill(0);
    midBandVec[0] = 0.7;
    midBandVec[1] = Math.sqrt(1 - 0.7 ** 2);

    // similarity to anchor = 0.95 — near-duplicate band, must be excluded here
    const nearDupVec = new Array(dim).fill(0);
    nearDupVec[0] = 0.95;
    nearDupVec[2] = Math.sqrt(1 - 0.95 ** 2);

    // orthogonal to anchor (similarity 0) — clearly unrelated, below the floor
    const unrelatedVec = new Array(dim).fill(0);
    unrelatedVec[3] = 1;

    const anchorId = await insertKnowledgeWithEmbedding(scope, 'anchor entry', anchorVec);
    const midBandId = await insertKnowledgeWithEmbedding(scope, 'mid-band entry', midBandVec);
    const nearDupId = await insertKnowledgeWithEmbedding(scope, 'near-dup entry', nearDupVec);
    const unrelatedId = await insertKnowledgeWithEmbedding(scope, 'unrelated entry', unrelatedVec);

    const pairs = await listKnowledgeConflictCandidates(scope);

    const midBandPair = pairs.filter(
      (p) => (p.aId === anchorId && p.bId === midBandId) || (p.aId === midBandId && p.bId === anchorId),
    );
    assert.equal(
      midBandPair.length,
      1,
      'the mid-band pair is reported exactly once, never as both A↔B and B↔A',
    );
    assert.ok(midBandPair[0].similarity >= 0.55 && midBandPair[0].similarity < 0.92);

    assert.ok(
      !pairs.some(
        (p) => (p.aId === anchorId && p.bId === nearDupId) || (p.aId === nearDupId && p.bId === anchorId),
      ),
      'a pair at >= 0.92 similarity is a near-duplicate, not a conflict candidate — owned by listDuplicateKnowledge',
    );
    assert.ok(
      !pairs.some(
        (p) => (p.aId === anchorId && p.bId === unrelatedId) || (p.aId === unrelatedId && p.bId === anchorId),
      ),
      'a clearly unrelated pair below the conflict floor must not be reported',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [
      [anchorId, midBandId, nearDupId, unrelatedId],
    ]);
  },
);

test(
  'SECURITY: repository: listKnowledgeConflictCandidates is scoped — a mid-band pair split across different scopes must never be reported, even with no scope filter applied (issue #330)',
  { skip },
  async () => {
    const scopeX = `${RUN}-list-conflict-scope-x`;
    const scopeY = `${RUN}-list-conflict-scope-y`;
    const dim = config.db.embeddingDim;

    const anchorVec = new Array(dim).fill(0);
    anchorVec[0] = 1;
    const midBandVec = new Array(dim).fill(0);
    midBandVec[0] = 0.7;
    midBandVec[1] = Math.sqrt(1 - 0.7 ** 2);

    const xAnchorId = await insertKnowledgeWithEmbedding(scopeX, 'anchor entry x', anchorVec);
    const xMidBandId = await insertKnowledgeWithEmbedding(scopeX, 'mid-band entry x', midBandVec);
    // Same embedding as the scope-X mid-band entry, but in a different scope —
    // must never pair with the scope-X anchor (a.scope = b.scope in the join).
    const yMidBandId = await insertKnowledgeWithEmbedding(scopeY, 'mid-band entry y', midBandVec);

    const scopedToX = await listKnowledgeConflictCandidates(scopeX);
    assert.ok(
      scopedToX.some(
        (p) => (p.aId === xAnchorId && p.bId === xMidBandId) || (p.aId === xMidBandId && p.bId === xAnchorId),
      ),
      'the scope-X pair is returned when scoped to X',
    );
    assert.ok(
      !scopedToX.some((p) => p.aId === yMidBandId || p.bId === yMidBandId),
      'SECURITY: scope filter must exclude an entry from a different scope, even with near-identical embeddings',
    );

    const unscoped = await listKnowledgeConflictCandidates();
    assert.ok(
      !unscoped.some(
        (p) => (p.aId === xAnchorId && p.bId === yMidBandId) || (p.aId === yMidBandId && p.bId === xAnchorId),
      ),
      'SECURITY: a candidate pair split across different scopes must never be reported, even with no ' +
        "scope filter applied — the self-join is scoped a.scope = b.scope, so one scope's entry can " +
        "never leak into another scope's admin's conflict audit",
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[xAnchorId, xMidBandId, yMidBandId]]);
  },
);

test(
  "repository: countDuplicateKnowledge is an exact COUNT(*) past listDuplicateKnowledge's own default limit of 20, and scopes identically (issue #378)",
  { skip },
  async () => {
    const scope = `${RUN}-count-dup-scope`;
    const dim = config.db.embeddingDim;

    // Seven mutually near-duplicate entries (pairwise similarity 0.95, via
    // the equal-pairwise-dot-product construction: v_i = sqrt(rho)*e0 +
    // sqrt(1-rho)*e_i for orthogonal e_i) yield C(7,2) = 21 pairs — one past
    // listDuplicateKnowledge's default limit of 20, so its own list() call
    // understates the true backlog while the count must not.
    const rho = 0.95;
    const ids: number[] = [];
    for (let i = 1; i <= 7; i++) {
      const vec = new Array(dim).fill(0);
      vec[0] = Math.sqrt(rho);
      vec[i] = Math.sqrt(1 - rho);
      ids.push(await insertKnowledgeWithEmbedding(scope, `near-dup entry ${i}`, vec));
    }
    // One clearly unrelated entry that must not be counted in any pair.
    const unrelatedVec = new Array(dim).fill(0);
    unrelatedVec[dim - 1] = 1;
    const unrelatedId = await insertKnowledgeWithEmbedding(scope, 'unrelated entry', unrelatedVec);

    const listed = await listDuplicateKnowledge(scope);
    assert.equal(listed.length, 20, "listDuplicateKnowledge's default limit understates the true 21 pairs");

    const listedUnbounded = await listDuplicateKnowledge(scope, 100);
    assert.equal(listedUnbounded.length, 21, 'the full unbounded pair count is 21 (C(7,2))');

    assert.equal(
      await countDuplicateKnowledge(scope),
      21,
      'countDuplicateKnowledge reports the exact backlog, matching the unbounded list length, not the limited one',
    );
    assert.ok(
      !listedUnbounded.some((p) => p.aId === unrelatedId || p.bId === unrelatedId),
      'the unrelated entry never appears in a pair',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[...ids, unrelatedId]]);
    assert.equal(await countDuplicateKnowledge(scope), 0, 'deleting every inserted row empties the scope');
  },
);

test(
  'SECURITY: repository: countDuplicateKnowledge scopes identically to listDuplicateKnowledge — a same-content pair split across different scopes is never counted (issue #378)',
  { skip },
  async () => {
    const scopeX = `${RUN}-count-dup-scope-x`;
    const scopeY = `${RUN}-count-dup-scope-y`;
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
    const { id: yId } = await saveKnowledge({
      title: 'How to link WhatsApp',
      content: 'To link WhatsApp, go to settings and scan the QR code from the admin panel.',
      scope: scopeY,
    });

    assert.equal(await countDuplicateKnowledge(scopeX), 1, 'the scope-X pair is counted when scoped to X');
    assert.equal(
      await countDuplicateKnowledge(scopeY),
      0,
      'SECURITY: scope filter must exclude a cross-scope pair even with near-identical content',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[xAId, xBId, yId]]);
  },
);

test(
  "repository: countKnowledgeConflictCandidates is an exact COUNT(*) past listKnowledgeConflictCandidates's own default limit of 20, and excludes near-duplicate and below-floor pairs (issue #378)",
  { skip },
  async () => {
    const scope = `${RUN}-count-conflict-scope`;
    const dim = config.db.embeddingDim;

    // Seven entries with pairwise similarity 0.7 (inside the [0.55, 0.92)
    // mid-band) yield C(7,2) = 21 conflict-candidate pairs — one past
    // listKnowledgeConflictCandidates's default limit of 20.
    const rho = 0.7;
    const ids: number[] = [];
    for (let i = 1; i <= 7; i++) {
      const vec = new Array(dim).fill(0);
      vec[0] = Math.sqrt(rho);
      vec[i] = Math.sqrt(1 - rho);
      ids.push(await insertKnowledgeWithEmbedding(scope, `mid-band entry ${i}`, vec));
    }
    // A near-duplicate pair (>= 0.92) that must be excluded from the conflict count.
    const dupVecA = new Array(dim).fill(0);
    dupVecA[dim - 2] = 1;
    const dupVecB = new Array(dim).fill(0);
    dupVecB[dim - 2] = 0.95;
    dupVecB[dim - 1] = Math.sqrt(1 - 0.95 ** 2);
    const dupAId = await insertKnowledgeWithEmbedding(scope, 'near-dup entry a', dupVecA);
    const dupBId = await insertKnowledgeWithEmbedding(scope, 'near-dup entry b', dupVecB);

    const listed = await listKnowledgeConflictCandidates(scope);
    assert.equal(
      listed.length,
      20,
      "listKnowledgeConflictCandidates's default limit understates the true 21 pairs",
    );

    const listedUnbounded = await listKnowledgeConflictCandidates(scope, 100);
    assert.equal(listedUnbounded.length, 21, 'the full unbounded conflict-candidate count is 21 (C(7,2))');

    assert.equal(
      await countKnowledgeConflictCandidates(scope),
      21,
      'countKnowledgeConflictCandidates reports the exact backlog, matching the unbounded list length',
    );
    assert.ok(
      !listedUnbounded.some(
        (p) => (p.aId === dupAId && p.bId === dupBId) || (p.aId === dupBId && p.bId === dupAId),
      ),
      'the near-duplicate pair (>= 0.92) is excluded from the conflict-candidate count',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[...ids, dupAId, dupBId]]);
    assert.equal(
      await countKnowledgeConflictCandidates(scope),
      0,
      'deleting every inserted row empties the scope',
    );
  },
);

test(
  'SECURITY: repository: countKnowledgeConflictCandidates scopes identically to listKnowledgeConflictCandidates — a mid-band pair split across different scopes is never counted (issue #378)',
  { skip },
  async () => {
    const scopeX = `${RUN}-count-conflict-scope-x`;
    const scopeY = `${RUN}-count-conflict-scope-y`;
    const dim = config.db.embeddingDim;

    const anchorVec = new Array(dim).fill(0);
    anchorVec[0] = 1;
    const midBandVec = new Array(dim).fill(0);
    midBandVec[0] = 0.7;
    midBandVec[1] = Math.sqrt(1 - 0.7 ** 2);

    const xAnchorId = await insertKnowledgeWithEmbedding(scopeX, 'anchor entry x', anchorVec);
    const xMidBandId = await insertKnowledgeWithEmbedding(scopeX, 'mid-band entry x', midBandVec);
    const yMidBandId = await insertKnowledgeWithEmbedding(scopeY, 'mid-band entry y', midBandVec);

    assert.equal(
      await countKnowledgeConflictCandidates(scopeX),
      1,
      'the scope-X pair is counted when scoped to X',
    );
    assert.equal(
      await countKnowledgeConflictCandidates(scopeY),
      0,
      'SECURITY: scope filter must exclude a cross-scope near-identical-embedding pair',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[xAnchorId, xMidBandId, yMidBandId]]);
  },
);

test(
  'repository: hasConflictAmongIds returns true for a mid-band pair among the given ids, false when the only pair is below the floor, and false when the only pair is a near-duplicate at/above the ceiling (issue #389)',
  { skip },
  async () => {
    const scope = `${RUN}-has-conflict-scope`;
    const dim = config.db.embeddingDim;

    const anchorVec = new Array(dim).fill(0);
    anchorVec[0] = 1;

    // similarity to anchor = 0.7 — inside [0.55, 0.92)
    const midBandVec = new Array(dim).fill(0);
    midBandVec[0] = 0.7;
    midBandVec[1] = Math.sqrt(1 - 0.7 ** 2);

    // similarity to anchor = 0.95 — at/above the near-duplicate ceiling, must not count
    const nearDupVec = new Array(dim).fill(0);
    nearDupVec[0] = 0.95;
    nearDupVec[2] = Math.sqrt(1 - 0.95 ** 2);

    // orthogonal to anchor (similarity 0) — below the conflict floor
    const unrelatedVec = new Array(dim).fill(0);
    unrelatedVec[3] = 1;

    const anchorId = await insertKnowledgeWithEmbedding(scope, 'anchor entry', anchorVec);
    const midBandId = await insertKnowledgeWithEmbedding(scope, 'mid-band entry', midBandVec);
    const nearDupId = await insertKnowledgeWithEmbedding(scope, 'near-dup entry', nearDupVec);
    const unrelatedId = await insertKnowledgeWithEmbedding(scope, 'unrelated entry', unrelatedVec);

    assert.equal(
      await hasConflictAmongIds([anchorId, midBandId]),
      true,
      'a pair inside the [0.55, 0.92) band among the given ids is a conflict',
    );
    assert.equal(
      await hasConflictAmongIds([anchorId, unrelatedId]),
      false,
      'a pair below the conflict floor is not a conflict',
    );
    assert.equal(
      await hasConflictAmongIds([anchorId, nearDupId]),
      false,
      'a pair at/above the near-duplicate ceiling is not a conflict candidate — owned by listDuplicateKnowledge',
    );
    assert.equal(
      await hasConflictAmongIds([anchorId, midBandId, unrelatedId]),
      true,
      'a conflicting pair is found even alongside an unrelated third id',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [
      [anchorId, midBandId, nearDupId, unrelatedId],
    ]);
  },
);

test(
  'repository: hasConflictAmongIds does not flag a mid-band-similar pair as a conflict when the two entries are in DIFFERENT scopes — a conversation-scoped override of a global entry is an intended pattern, not a conflict (review on #393)',
  { skip },
  async () => {
    const dim = config.db.embeddingDim;

    const anchorVec = new Array(dim).fill(0);
    anchorVec[0] = 1;

    // similarity to anchor = 0.7 — inside [0.55, 0.92), same as the
    // same-scope mid-band case above, but this time the two entries live in
    // different scopes.
    const midBandVec = new Array(dim).fill(0);
    midBandVec[0] = 0.7;
    midBandVec[1] = Math.sqrt(1 - 0.7 ** 2);

    const globalId = await insertKnowledgeWithEmbedding(
      'global',
      `${RUN}-cross-scope global entry`,
      anchorVec,
    );
    const conversationId = await insertKnowledgeWithEmbedding(
      `${RUN}-cross-scope-conversation`,
      `${RUN}-cross-scope conversation override`,
      midBandVec,
    );

    assert.equal(
      await hasConflictAmongIds([globalId, conversationId]),
      false,
      'a mid-band-similar pair across different scopes must not be flagged — it is a supported scope override, ' +
        'not a conflict admins need to reconcile',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[globalId, conversationId]]);
  },
);

test('SECURITY: repository: hasConflictAmongIds issues zero SQL queries and returns false when fewer than 2 ids are given (issue #389)', async (t) => {
  const calls: unknown[] = [];
  t.mock.method(pool, 'query', (...args: unknown[]) => {
    calls.push(args);
    throw new Error('pool.query must not be called for fewer than 2 ids');
  });

  assert.equal(await hasConflictAmongIds([]), false);
  assert.equal(await hasConflictAmongIds([1]), false);
  assert.equal(calls.length, 0, 'hasConflictAmongIds must not query the database for fewer than 2 ids');
});

test('SECURITY: repository: areKnowledgeEntriesLowRated issues zero SQL queries and returns an empty set for an empty ids array (issue #432)', async (t) => {
  const calls: unknown[] = [];
  t.mock.method(pool, 'query', (...args: unknown[]) => {
    calls.push(args);
    throw new Error('pool.query must not be called for an empty ids array');
  });

  assert.deepEqual(await areKnowledgeEntriesLowRated([], 2), new Set());
  assert.equal(
    calls.length,
    0,
    'areKnowledgeEntriesLowRated must not query the database for an empty ids array',
  );
});

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
  'repository: listKnowledgeCandidates defaults to created_at DESC (byte-identical to pre-#398), and oldestFirst flips it to ASC (issue #398)',
  { skip },
  async () => {
    const digestId = await insertContextDigest({
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(),
      topic: `${RUN}-kc-sort-topic`,
      summary: 'aggregate summary',
      exampleRefs: [],
      distinctUsers: 3,
      questionCount: 4,
    });

    const oldest = await insertKnowledgeCandidate({
      digestId,
      topic: `${RUN}-kc-sort-topic-oldest`,
      title: 'oldest',
      content: 'oldest content',
    });
    const middle = await insertKnowledgeCandidate({
      digestId,
      topic: `${RUN}-kc-sort-topic-middle`,
      title: 'middle',
      content: 'middle content',
    });
    const newest = await insertKnowledgeCandidate({
      digestId,
      topic: `${RUN}-kc-sort-topic-newest`,
      title: 'newest',
      content: 'newest content',
    });

    // Force distinct, known ages — insertKnowledgeCandidate has no created_at
    // param (it always defaults to now()).
    await pool.query(`UPDATE knowledge_candidates SET created_at = now() - interval '3 days' WHERE id = $1`, [
      oldest,
    ]);
    await pool.query(`UPDATE knowledge_candidates SET created_at = now() - interval '2 days' WHERE id = $1`, [
      middle,
    ]);
    await pool.query(`UPDATE knowledge_candidates SET created_at = now() - interval '1 days' WHERE id = $1`, [
      newest,
    ]);

    const defaultOrder = (await listKnowledgeCandidates('pending', 200)).filter((c) =>
      [oldest, middle, newest].includes(c.id),
    );
    assert.deepEqual(
      defaultOrder.map((c) => c.id),
      [newest, middle, oldest],
      'no sort argument -> created_at DESC, unchanged from today',
    );

    const oldestFirstOrder = (await listKnowledgeCandidates('pending', 200, true)).filter((c) =>
      [oldest, middle, newest].includes(c.id),
    );
    assert.deepEqual(
      oldestFirstOrder.map((c) => c.id),
      [oldest, middle, newest],
      'oldestFirst=true -> created_at ASC',
    );

    // SECURITY: the new sort option is a read, not a review action — it must
    // never itself change a candidate's status. accept_knowledge_candidate/
    // decline_knowledge_candidate remain the only status-mutating paths
    // (issue #102's human-curation invariant, unchanged by #398).
    const statusesAfter = await pool.query(`SELECT status FROM knowledge_candidates WHERE id = ANY($1)`, [
      [oldest, middle, newest],
    ]);
    assert.ok(
      statusesAfter.rows.every((r: { status: string }) => r.status === 'pending'),
      'SECURITY: listKnowledgeCandidates (with or without oldestFirst) never mutates a candidate status',
    );

    await pool.query(`DELETE FROM knowledge_candidates WHERE id = ANY($1)`, [[oldest, middle, newest]]);
    await pool.query(`DELETE FROM context_digests WHERE id = $1`, [digestId]);
  },
);

test(
  'repository: countStalePendingKnowledgeCandidates counts only pending rows older than the threshold — accepted/declined rows never inflate it (issue #398)',
  { skip },
  async () => {
    const digestId = await insertContextDigest({
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(),
      topic: `${RUN}-kc-stale-topic`,
      summary: 'aggregate summary',
      exampleRefs: [],
      distinctUsers: 3,
      questionCount: 4,
    });

    const before = await countStalePendingKnowledgeCandidates(14);

    const stalePending = await insertKnowledgeCandidate({
      digestId,
      topic: `${RUN}-kc-stale-topic-1`,
      title: 'stale pending',
      content: 'content',
    });
    const freshPending = await insertKnowledgeCandidate({
      digestId,
      topic: `${RUN}-kc-stale-topic-2`,
      title: 'fresh pending',
      content: 'content',
    });
    const staleButAccepted = await insertKnowledgeCandidate({
      digestId,
      topic: `${RUN}-kc-stale-topic-3`,
      title: 'stale but accepted',
      content: 'content',
    });
    const staleButDeclined = await insertKnowledgeCandidate({
      digestId,
      topic: `${RUN}-kc-stale-topic-4`,
      title: 'stale but declined',
      content: 'content',
    });

    await pool.query(
      `UPDATE knowledge_candidates SET created_at = now() - interval '30 days' WHERE id = ANY($1)`,
      [[stalePending, staleButAccepted, staleButDeclined]],
    );
    await pool.query(`UPDATE knowledge_candidates SET created_at = now() - interval '1 days' WHERE id = $1`, [
      freshPending,
    ]);

    const accepted = await acceptKnowledgeCandidate({ id: staleButAccepted, reviewedBy: 'admin-1' });
    assert.ok(accepted);
    const declined = await declineKnowledgeCandidate(staleButDeclined, 'admin-1');
    assert.ok(declined);

    // Only stalePending should count — freshPending is too recent, and the
    // other two are no longer 'pending' despite being just as old.
    assert.equal(
      await countStalePendingKnowledgeCandidates(14),
      before + 1,
      'only the stale, still-pending row is counted',
    );
    assert.equal(
      await countStalePendingKnowledgeCandidates(31),
      before,
      'a 31-day threshold excludes a 30-day-old row',
    );

    const ids = [stalePending, freshPending, staleButAccepted, staleButDeclined];
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [accepted.knowledgeId]);
    await pool.query(`DELETE FROM knowledge_candidates WHERE id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM context_digests WHERE id = $1`, [digestId]);
    assert.equal(
      await countStalePendingKnowledgeCandidates(14),
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
    // knowledgeCoversTopic (issue #503) now takes the already-computed
    // embedding rather than re-embedding internally — mirrors how the
    // builder threads candidateTopicAlreadyReviewed's vector through.
    assert.equal(
      await knowledgeCoversTopic(await embed('zyquavexolorpin onboarding steps')),
      true,
      'an existing knowledge entry above the relevance floor counts as already answered',
    );
    assert.equal(
      await knowledgeCoversTopic(await embed('qzxvbfrobnicator gloopington snorlaxian doorknob')),
      false,
      'an unrelated (and lexically unrelated) topic is not flagged as already covered',
    );
    assert.equal(await knowledgeCoversTopic(null), false, 'a null vector fails open to "not covered"');

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [knowledgeId]);
    await pool.query(`DELETE FROM knowledge_candidates WHERE id = $1`, [candidateId]);
    await pool.query(`DELETE FROM context_digests WHERE id = $1`, [digestId]);
  },
);

test(
  "SECURITY: candidateTopicAlreadyReviewed's semantic half blocks a reworded topic that is NOT an exact string match but is >= KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD similar to an existing (even declined) candidate's topic_embedding — and does NOT block a genuinely dissimilar topic (issue #503, AC2/AC3)",
  { skip },
  async () => {
    const newTopic = `${RUN} when does the community meetup usually happen`;
    // The exact vector candidateTopicAlreadyReviewed will itself compute for
    // newTopic — used as the anchor for controlled-similarity fixtures below
    // (Gram-Schmidt technique, same as memoryAtCosineSimilarity's other
    // uses in this file), so this test lands precisely on either side of the
    // 0.92 threshold regardless of what the real model thinks these
    // deliberately-different label strings mean.
    const anchor = await embed(newTopic);

    const priorDigestId = await insertContextDigest({
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(),
      topic: `${RUN} unrelated-string topic label`,
      summary: 'summary',
      exampleRefs: [],
      distinctUsers: 3,
      questionCount: 3,
    });
    const similarCandidateId = await insertKnowledgeCandidate({
      digestId: priorDigestId,
      // Deliberately NOT an exact match to newTopic, so hasQueuedCandidateForTopic misses.
      topic: `${RUN} unrelated-string topic label`,
      title: 't',
      content: 'c',
    });
    await declineKnowledgeCandidate(similarCandidateId, 'admin-1');
    await pool.query(`UPDATE knowledge_candidates SET topic_embedding = $2 WHERE id = $1`, [
      similarCandidateId,
      pgvector.toSql(memoryAtCosineSimilarity(anchor, 0.95)),
    ]);

    const semanticResult = await candidateTopicAlreadyReviewed(newTopic);
    assert.equal(
      semanticResult.blocked,
      true,
      'a >=0.92-similar declined topic blocks re-emission even without an exact string match',
    );
    assert.ok(
      Array.isArray(semanticResult.embedding) && semanticResult.embedding.length === anchor.length,
      'the computed embedding is returned for reuse by knowledgeCoversTopic/insertKnowledgeCandidate',
    );

    await pool.query(`DELETE FROM knowledge_candidates WHERE id = $1`, [similarCandidateId]);

    // A genuinely dissimilar topic (0.5 similarity, well under the 0.92 floor) must NOT be blocked.
    const dissimilarCandidateId = await insertKnowledgeCandidate({
      digestId: priorDigestId,
      topic: `${RUN} another unrelated label`,
      title: 't2',
      content: 'c2',
    });
    await declineKnowledgeCandidate(dissimilarCandidateId, 'admin-1');
    await pool.query(`UPDATE knowledge_candidates SET topic_embedding = $2 WHERE id = $1`, [
      dissimilarCandidateId,
      pgvector.toSql(memoryAtCosineSimilarity(anchor, 0.5)),
    ]);

    const noFalsePositive = await candidateTopicAlreadyReviewed(newTopic);
    assert.equal(noFalsePositive.blocked, false, 'a dissimilar topic (below the 0.92 floor) is not blocked');

    await pool.query(`DELETE FROM knowledge_candidates WHERE id = $1`, [dissimilarCandidateId]);
    await pool.query(`DELETE FROM context_digests WHERE id = $1`, [priorDigestId]);
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
  'repository: recordEscalatedKnowledgeGap inserts a row with escalated = true, a real embedding, and is NOT gated by KNOWLEDGE_GAP_DAILY_LIMIT (issue #514, acceptance criterion 2)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-gap-escalated-insert`;
    const userId = `${RUN}-gap-escalated-insert-user`;
    const query = 'how do I reset my Zylotrix session — escalated';

    // Seed the caller's daily gap cap so an ordinary recordKnowledgeGap
    // insert would be refused, proving the escalated path is genuinely
    // unconditional rather than merely under the cap by coincidence.
    for (let i = 0; i < KNOWLEDGE_GAP_DAILY_LIMIT; i++) {
      await pool.query(
        `INSERT INTO knowledge_gaps (platform, conversation_id, user_id, query_text) VALUES ($1,$2,$3,$4)`,
        ['discord', conversationId, userId, `seeded escalated-cap gap ${i}`],
      );
    }
    const capped = await recordKnowledgeGap('discord', conversationId, userId, 'would be capped');
    assert.equal(capped, 'rate_limited', 'sanity check — the ordinary daily cap is indeed exhausted');

    const result = await recordEscalatedKnowledgeGap('discord', conversationId, userId, query);

    const { rows } = await pool.query(
      `SELECT platform, conversation_id, user_id, query_text, embedding, escalated FROM knowledge_gaps WHERE id = $1`,
      [result.id],
    );
    assert.equal(rows.length, 1, 'the escalated insert succeeds despite the exhausted daily cap');
    assert.equal(rows[0].platform, 'discord');
    assert.equal(rows[0].conversation_id, conversationId);
    assert.equal(rows[0].user_id, userId);
    assert.equal(rows[0].query_text, query);
    assert.equal(rows[0].escalated, true);
    assert.ok(Array.isArray(rows[0].embedding), 'a real embedding vector must be stored');
    assert.equal(rows[0].embedding.length, config.db.embeddingDim);

    await pool.query(`DELETE FROM knowledge_gaps WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  'repository: recordEscalatedKnowledgeGap query_text is truncated to KNOWLEDGE_GAP_QUERY_MAX_CHARS, identically to recordKnowledgeGap',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-gap-escalated-truncate`;
    const userId = `${RUN}-gap-escalated-truncate-user`;
    const longQuery = 'x'.repeat(1000);

    const result = await recordEscalatedKnowledgeGap('discord', conversationId, userId, longQuery);
    const { rows } = await pool.query(`SELECT query_text FROM knowledge_gaps WHERE id = $1`, [result.id]);
    assert.equal(
      rows[0].query_text.length,
      KNOWLEDGE_GAP_QUERY_MAX_CHARS,
      'truncated to KNOWLEDGE_GAP_QUERY_MAX_CHARS',
    );

    await pool.query(`DELETE FROM knowledge_gaps WHERE id = $1`, [result.id]);
  },
);

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
  'repository: saveKnowledge resolves a matching unresolved knowledge_gaps row once the new entry clears the relevance floor (issue #422)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-gap-resolve-save`;
    const userId = `${RUN}-gap-resolve-save-user`;
    // No title on either side, so saveKnowledge embeds this exact string —
    // identical to what recordKnowledgeGap embedded for the gap query — for
    // a deterministic same-vector match (similarity 1.0) instead of relying
    // on the embedding model's semantic judgement of a paraphrase.
    const matchingQuery = `${RUN} how do I reset my zylotrix session`;
    const unrelatedQuery = `${RUN} what time is the community bake sale`;

    const matchingGap = await recordKnowledgeGap('discord', conversationId, userId, matchingQuery);
    const unrelatedGap = await recordKnowledgeGap('discord', conversationId, userId, unrelatedQuery);
    assert.ok(matchingGap !== 'rate_limited' && unrelatedGap !== 'rate_limited', 'fixture gaps recorded');

    const { id: knowledgeId } = await saveKnowledge({ content: matchingQuery });

    const { rows } = await pool.query(`SELECT id, resolved_at FROM knowledge_gaps WHERE id = ANY($1)`, [
      [matchingGap.id, unrelatedGap.id],
    ]);
    const matchingRow = rows.find((r) => Number(r.id) === matchingGap.id);
    const unrelatedRow = rows.find((r) => Number(r.id) === unrelatedGap.id);
    assert.ok(matchingRow?.resolved_at, 'the gap the new entry now confidently answers is marked resolved');
    assert.equal(
      unrelatedRow?.resolved_at,
      null,
      'an unrelated standing gap is left untouched by an unrelated save',
    );

    await pool.query(`DELETE FROM knowledge_gaps WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [knowledgeId]);
  },
);

test(
  'repository: updateKnowledge resolves a standing gap when the edited content newly clears the relevance floor (issue #422)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-gap-resolve-update`;
    const userId = `${RUN}-gap-resolve-update-user`;
    const gapQuery = `${RUN} how do I link my whatsapp account`;

    const gap = await recordKnowledgeGap('discord', conversationId, userId, gapQuery);
    assert.ok(gap !== 'rate_limited', 'fixture gap recorded');

    const { id: knowledgeId } = await saveKnowledge({
      content: `${RUN} the quarterly bake sale raises funds for the youth choir`,
    });
    const afterSave = await pool.query(`SELECT resolved_at FROM knowledge_gaps WHERE id = $1`, [gap.id]);
    assert.equal(
      afterSave.rows[0].resolved_at,
      null,
      "an entry that doesn't answer the gap's query leaves it unresolved",
    );

    const updated = await updateKnowledge({ id: knowledgeId, content: gapQuery });
    assert.ok(updated.updated, 'update applied');

    const afterUpdate = await pool.query(`SELECT resolved_at FROM knowledge_gaps WHERE id = $1`, [gap.id]);
    assert.ok(
      afterUpdate.rows[0].resolved_at,
      'editing the entry to now confidently answer the query resolves the standing gap',
    );

    await pool.query(`DELETE FROM knowledge_gaps WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [knowledgeId]);
  },
);

test(
  "SECURITY: repository: unreviewed 'auto' provenance never resolves a knowledge_gaps row — only a 'docs' backfill or a human-authored entry may, even when the content clears the relevance floor (issue #422)",
  { skip },
  async () => {
    const conversationId = `${RUN}-c-gap-resolve-auto`;
    const userId = `${RUN}-gap-resolve-auto-user`;
    const autoQuery = `${RUN} how do I configure the zylotrix webhook`;
    const docsQuery = `${RUN} how do I rotate the zylotrix api key`;

    const autoGap = await recordKnowledgeGap('discord', conversationId, userId, autoQuery);
    const docsGap = await recordKnowledgeGap('discord', conversationId, userId, docsQuery);
    assert.ok(autoGap !== 'rate_limited' && docsGap !== 'rate_limited', 'fixture gaps recorded');

    // 'auto' (unreviewed web-research) content matching a gap must NOT
    // resolve it, even though it clears the relevance floor.
    const { id: autoId } = await saveKnowledge({ content: autoQuery, createdByRole: 'auto' });
    const afterAutoSave = await pool.query(`SELECT resolved_at FROM knowledge_gaps WHERE id = $1`, [
      autoGap.id,
    ]);
    assert.equal(
      afterAutoSave.rows[0].resolved_at,
      null,
      "SECURITY: an 'auto'-provenance save must never resolve a matching gap",
    );

    // Editing that same 'auto' row (e.g. the daily refresh's updateKnowledge
    // call) must also not resolve gaps — created_by_role never changes.
    const autoUpdated = await updateKnowledge({ id: autoId, content: `${autoQuery} refreshed` });
    assert.ok(autoUpdated.updated, 'update applied');
    const afterAutoUpdate = await pool.query(`SELECT resolved_at FROM knowledge_gaps WHERE id = $1`, [
      autoGap.id,
    ]);
    assert.equal(
      afterAutoUpdate.rows[0].resolved_at,
      null,
      "SECURITY: updating an 'auto'-provenance row must never resolve a gap either",
    );

    // A trusted 'docs' backfill matching a different gap DOES resolve it —
    // the gate is provenance-specific, not a blanket disable.
    const { id: docsId } = await saveKnowledge({ content: docsQuery, createdByRole: 'docs' });
    const afterDocsSave = await pool.query(`SELECT resolved_at FROM knowledge_gaps WHERE id = $1`, [
      docsGap.id,
    ]);
    assert.ok(afterDocsSave.rows[0].resolved_at, "a trusted 'docs'-provenance save still resolves a gap");

    await pool.query(`DELETE FROM knowledge_gaps WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[autoId, docsId]]);
  },
);

test(
  "SECURITY: repository: knowledge-gap resolution scope filter mirrors searchKnowledge's visibility model — a conversation-scoped entry resolves only gaps on the same platform AND conversation, a platform-scoped entry resolves only gaps on that platform, and neither ever crosses conversation or platform boundaries (issue #422)",
  { skip },
  async () => {
    const convA = `${RUN}-c-gap-scope-a`;
    const convB = `${RUN}-c-gap-scope-b`;
    const userId = `${RUN}-gap-resolve-scope-user`;
    const convQuery = `${RUN} conversation-scoped gap resolution query`;

    // Same query text on three different (platform, conversation) shapes —
    // deterministic identical embeddings, so any resolution difference
    // between them is purely down to the scope filter, not embedding noise.
    const sameConvSamePlatform = await recordKnowledgeGap('discord', convA, userId, convQuery);
    const diffConvSamePlatform = await recordKnowledgeGap('discord', convB, userId, convQuery);
    // Same conversation id string as convA, but a DIFFERENT platform — the
    // cross-platform collision this AC specifically requires guarding
    // against (a real conversation id is very unlikely to collide across
    // platforms, but the resolve path must not rely on that).
    const sameConvDiffPlatform = await recordKnowledgeGap('whatsapp', convA, userId, convQuery);
    assert.ok(
      sameConvSamePlatform !== 'rate_limited' &&
        diffConvSamePlatform !== 'rate_limited' &&
        sameConvDiffPlatform !== 'rate_limited',
      'fixture gaps recorded',
    );

    const { id: convScopedId } = await saveKnowledge({
      content: convQuery,
      scope: convA,
      callerPlatform: 'discord',
    });

    const convRows = await pool.query(`SELECT id, resolved_at FROM knowledge_gaps WHERE id = ANY($1)`, [
      [sameConvSamePlatform.id, diffConvSamePlatform.id, sameConvDiffPlatform.id],
    ]);
    const byId = new Map(convRows.rows.map((r) => [Number(r.id), r.resolved_at]));
    assert.ok(
      byId.get(sameConvSamePlatform.id),
      'a conversation-scoped entry resolves a gap in that same platform+conversation',
    );
    assert.equal(
      byId.get(diffConvSamePlatform.id),
      null,
      'SECURITY: a conversation-scoped entry must never resolve a gap logged in a different conversation',
    );
    assert.equal(
      byId.get(sameConvDiffPlatform.id),
      null,
      'SECURITY: a conversation-scoped entry must never resolve a gap on a different platform, even when ' +
        'the conversation id string is identical',
    );

    // Platform-scoped case: resolves any matching gap on that platform,
    // regardless of conversation, and never crosses to a different platform.
    const platformQuery = `${RUN} platform-scoped gap resolution query`;
    const convC = `${RUN}-c-gap-scope-c`;
    const convD = `${RUN}-c-gap-scope-d`;
    const onWhatsapp = await recordKnowledgeGap('whatsapp', convC, userId, platformQuery);
    const onDiscord = await recordKnowledgeGap('discord', convD, userId, platformQuery);
    assert.ok(onWhatsapp !== 'rate_limited' && onDiscord !== 'rate_limited', 'fixture gaps recorded');

    const { id: platformScopedId } = await saveKnowledge({
      content: platformQuery,
      scope: 'whatsapp',
      callerPlatform: 'discord', // deliberately mismatched: scope alone governs, not the caller's own platform
    });

    const platformRows = await pool.query(`SELECT id, resolved_at FROM knowledge_gaps WHERE id = ANY($1)`, [
      [onWhatsapp.id, onDiscord.id],
    ]);
    const platformById = new Map(platformRows.rows.map((r) => [Number(r.id), r.resolved_at]));
    assert.ok(
      platformById.get(onWhatsapp.id),
      'a platform-scoped entry resolves a matching gap on that platform',
    );
    assert.equal(
      platformById.get(onDiscord.id),
      null,
      'SECURITY: a platform-scoped entry must never resolve a gap on a different platform',
    );

    await pool.query(`DELETE FROM knowledge_gaps WHERE conversation_id = ANY($1)`, [
      [convA, convB, convC, convD],
    ]);
    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[convScopedId, platformScopedId]]);
  },
);

test(
  'repository: recentKnowledgeGapClusters and countKnowledgeGaps exclude a resolved gap immediately, not only after the created_at window ages out (issue #422)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-gap-resolve-listing`;
    const userA = `${RUN}-gap-resolve-listing-a`;
    const userB = `${RUN}-gap-resolve-listing-b`;
    const query = `${RUN} listing-exclusion gap query`;

    const gapA = await recordKnowledgeGap('discord', conversationId, userA, query);
    const gapB = await recordKnowledgeGap('discord', conversationId, userB, query);
    assert.ok(gapA !== 'rate_limited' && gapB !== 'rate_limited', 'fixture gaps recorded');

    const beforeClusters = await recentKnowledgeGapClusters([conversationId], 7, 10);
    assert.equal(beforeClusters.length, 1, 'the two identical-query gaps form one cluster');
    assert.equal(beforeClusters[0].count, 2);
    const beforeCount = await countKnowledgeGaps([conversationId], 7);
    assert.equal(beforeCount, 2);

    // Both gaps share the exact query text, so a global-scope save that
    // answers it resolves both in one shot (same as saveKnowledge's own
    // resolution test above).
    const { id: knowledgeId } = await saveKnowledge({ content: query });

    const afterClusters = await recentKnowledgeGapClusters([conversationId], 7, 10);
    assert.equal(
      afterClusters.length,
      0,
      'a resolved gap drops out of the cluster list immediately — the created_at window (7 days) has not changed',
    );
    const afterCount = await countKnowledgeGaps([conversationId], 7);
    assert.equal(afterCount, 0, 'a resolved gap drops out of the digest count immediately');

    await pool.query(`DELETE FROM knowledge_gaps WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [knowledgeId]);
  },
);

test(
  'repository: countEscalatedKnowledgeGaps counts only escalated=true rows, conversation-scoped and day-windowed, mirroring countKnowledgeGaps (issue #514, acceptance criterion 4)',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-gap-escalated-count-in`;
    const outOfScopeConvo = `${RUN}-c-gap-escalated-count-out`;
    const userId = `${RUN}-gap-escalated-count-user`;

    const escalatedA = await recordEscalatedKnowledgeGap(
      'discord',
      inScopeConvo,
      userId,
      'escalated count query A',
    );
    const escalatedB = await recordEscalatedKnowledgeGap(
      'discord',
      inScopeConvo,
      userId,
      'escalated count query B',
    );
    const passive = await recordKnowledgeGap('discord', inScopeConvo, userId, 'passive count query');
    assert.ok(passive !== 'rate_limited', 'fixture passive gap recorded');
    const outOfScopeEscalated = await recordEscalatedKnowledgeGap(
      'discord',
      outOfScopeConvo,
      userId,
      'out-of-scope escalated query',
    );

    const scopedCount = await countEscalatedKnowledgeGaps([inScopeConvo], 7);
    assert.equal(scopedCount, 2, 'counts only the two escalated rows in-scope, excluding the passive gap');

    const outOfScopeCount = await countEscalatedKnowledgeGaps([outOfScopeConvo], 7);
    assert.equal(outOfScopeCount, 1);

    const noScopeCount = await countEscalatedKnowledgeGaps([], 7);
    assert.equal(noScopeCount, 0, 'an empty conversation scope always returns 0, never a guild-wide count');

    await pool.query(`DELETE FROM knowledge_gaps WHERE id = ANY($1)`, [
      [escalatedA.id, escalatedB.id, passive.id, outOfScopeEscalated.id],
    ]);
  },
);

test(
  'repository: countEscalatedKnowledgeGaps excludes a resolved escalated gap immediately, mirroring countKnowledgeGaps (issue #422 + #514)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-gap-escalated-resolve`;
    const userId = `${RUN}-gap-escalated-resolve-user`;
    const query = `${RUN} escalated resolve-exclusion query`;

    const escalated = await recordEscalatedKnowledgeGap('discord', conversationId, userId, query);
    const beforeCount = await countEscalatedKnowledgeGaps([conversationId], 7);
    assert.equal(beforeCount, 1);

    const { id: knowledgeId } = await saveKnowledge({ content: query });

    const afterCount = await countEscalatedKnowledgeGaps([conversationId], 7);
    assert.equal(afterCount, 0, 'a resolved escalated gap drops out of the count immediately');

    await pool.query(`DELETE FROM knowledge_gaps WHERE id = $1`, [escalated.id]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [knowledgeId]);
  },
);

test(
  'repository: purgeUserData (forget_me/purge_user_data) deletes a knowledge_gaps row regardless of resolved_at (issue #422)',
  { skip },
  async () => {
    const targetUser = `${RUN}-gap-purge-resolved-target`;
    const conversationId = `${RUN}-c-gap-purge-resolved`;

    const gap = await recordKnowledgeGap('discord', conversationId, targetUser, 'a resolved gap query');
    assert.ok(gap !== 'rate_limited', 'fixture gap recorded');
    await pool.query(`UPDATE knowledge_gaps SET resolved_at = now() WHERE id = $1`, [gap.id]);

    const purged = await purgeUserData('discord', targetUser);
    assert.ok(purged >= 1, 'purged count covers the resolved gap row');

    const rows = await pool.query(`SELECT 1 FROM knowledge_gaps WHERE user_id = $1`, [targetUser]);
    assert.equal(rows.rows.length, 0, 'a resolved gap is deleted by purge just like an unresolved one');
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
  'repository: adminActivitySummary groups by (platform, actor_user_id), computes correct counts/lastActionAt, sorted by actionCount descending, excludes rows outside the window (issue #488)',
  { skip },
  async () => {
    const actorA = `${RUN}-aas-actor-a`;
    const actorB = `${RUN}-aas-actor-b`;

    // actorA: 3 in-window rows on discord (2 success, 1 failure).
    await recordAdminAction({
      platform: 'discord',
      actorUserId: actorA,
      actionKind: 'warn_user',
      result: 'warned',
      success: true,
    });
    await recordAdminAction({
      platform: 'discord',
      actorUserId: actorA,
      actionKind: 'warn_user',
      result: 'warned',
      success: true,
    });
    await recordAdminAction({
      platform: 'discord',
      actorUserId: actorA,
      actionKind: 'kick_user',
      result: 'failed: not found',
      success: false,
    });
    // actorB: 1 in-window row on whatsapp.
    await recordAdminAction({
      platform: 'whatsapp',
      actorUserId: actorB,
      actionKind: 'timeout_user',
      result: 'timed out',
      success: true,
    });
    // Outside the 1-day window — must be excluded entirely.
    await pool.query(
      `INSERT INTO admin_audit (platform, actor_user_id, action_kind, result, success, created_at)
       VALUES ($1,$2,$3,$4,$5, now() - interval '2 days')`,
      ['discord', actorA, 'ban_user', 'banned', true],
    );

    const rows = await adminActivitySummary(1);
    const byActor = new Map(rows.map((r) => [`${r.platform}:${r.actorUserId}`, r]));

    const a = byActor.get(`discord:${actorA}`);
    assert.ok(a, 'actorA appears in the summary');
    assert.equal(a?.actionCount, 3, 'the 2-day-old row is excluded from the 1-day window');
    assert.equal(a?.successCount, 2);
    assert.equal(a?.failureCount, 1);
    assert.ok(a?.lastActionAt instanceof Date);

    const b = byActor.get(`whatsapp:${actorB}`);
    assert.ok(b, 'actorB appears in the summary');
    assert.equal(b?.actionCount, 1);
    assert.equal(b?.successCount, 1);
    assert.equal(b?.failureCount, 0);

    const indexOfA = rows.findIndex((r) => r.actorUserId === actorA);
    const indexOfB = rows.findIndex((r) => r.actorUserId === actorB);
    assert.ok(
      indexOfA < indexOfB,
      'actorA (3 actions) must sort ahead of actorB (1 action) — actionCount descending',
    );

    await pool.query(`DELETE FROM admin_audit WHERE actor_user_id = ANY($1)`, [[actorA, actorB]]);
  },
);

test(
  'repository: adminActivitySummary excludes the auto-enroll sentinel actor, so it never buries genuine human admin activity however many joins it logs (issue #606)',
  { skip },
  async () => {
    const human = `${RUN}-aas-human`;
    // The sentinel floods MORE rows than the human — if it weren't excluded it
    // would top the count-descending ranking and bury the human's one action.
    for (let i = 0; i < 5; i++) {
      await recordAdminAction({
        platform: 'discord',
        actorUserId: AUTO_ENROLL_ACTOR,
        actionKind: 'auto_enroll_member',
        targetUserId: `${RUN}-enrolled-${i}`,
        result: 'registered as member',
        success: true,
      });
    }
    await recordAdminAction({
      platform: 'discord',
      actorUserId: human,
      actionKind: 'warn_user',
      result: 'warned',
      success: true,
    });

    const rows = await adminActivitySummary(1);
    assert.ok(
      !rows.some((r) => r.actorUserId === AUTO_ENROLL_ACTOR),
      'the auto-enroll system actor must never appear in the human-activity rollup, however many rows it has',
    );
    assert.ok(
      rows.some((r) => r.actorUserId === human),
      'a genuine human admin action still appears in the rollup',
    );

    await pool.query(`DELETE FROM admin_audit WHERE actor_user_id = $1 AND target_user_id LIKE $2`, [
      AUTO_ENROLL_ACTOR,
      `${RUN}-%`,
    ]);
    await pool.query(`DELETE FROM admin_audit WHERE actor_user_id = $1`, [human]);
  },
);

test(
  'repository: autoEnrollMemberWithAudit commits the member grant and its audit row atomically, returns the role, and never downgrades a rejoining admin (issue #606)',
  { skip },
  async () => {
    const userId = `${RUN}-auto-enroll-user`;

    const role = await autoEnrollMemberWithAudit({
      platform: 'discord',
      userId,
      displayName: 'Fresh Joiner',
    });
    assert.equal(role, 'member', 'a first-ever joiner is enrolled as a member');

    const { rows: cu } = await pool.query(
      `SELECT role, added_by FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`,
      [userId],
    );
    assert.equal(cu.length, 1, 'the member grant was committed');
    assert.equal(cu[0].role, 'member');
    assert.equal(cu[0].added_by, AUTO_ENROLL_ACTOR, 'added_by carries the auto-enroll sentinel');

    const { rows: aa } = await pool.query(
      `SELECT actor_user_id, success FROM admin_audit
        WHERE target_user_id = $1 AND action_kind = 'auto_enroll_member'`,
      [userId],
    );
    assert.equal(aa.length, 1, 'the audit row was committed in the SAME transaction as the grant');
    assert.equal(aa[0].actor_user_id, AUTO_ENROLL_ACTOR);
    assert.equal(aa[0].success, true);

    // A rejoining admin must keep 'admin' — the no-downgrade ON CONFLICT CASE
    // holds inside the transaction too.
    await pool.query(
      `UPDATE community_users SET role = 'admin' WHERE platform = 'discord' AND platform_user_id = $1`,
      [userId],
    );
    const rejoinRole = await autoEnrollMemberWithAudit({
      platform: 'discord',
      userId,
      displayName: 'Fresh Joiner',
    });
    assert.equal(rejoinRole, 'admin', 'a rejoining admin is never downgraded to member by auto-enroll');

    await pool.query(`DELETE FROM admin_audit WHERE target_user_id = $1`, [userId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      userId,
    ]);
  },
);

test(
  'repository: adminActivitySummary clamps an out-of-range days window to [1, 365], default 30 (issue #488)',
  { skip },
  async () => {
    const actor = `${RUN}-aas-clamp-actor`;

    const beforeMin = await adminActivitySummary(-3);
    await recordAdminAction({
      platform: 'discord',
      actorUserId: actor,
      actionKind: 'warn_user',
      result: 'warned',
      success: true,
    });
    await pool.query(
      `INSERT INTO admin_audit (platform, actor_user_id, action_kind, result, success, created_at)
       VALUES ($1,$2,$3,$4,$5, now() - interval '2 days')`,
      ['discord', actor, 'warn_user', 'warned', true],
    );
    const afterMin = await adminActivitySummary(-3);
    const beforeCount = beforeMin.find((r) => r.actorUserId === actor)?.actionCount ?? 0;
    const afterCount = afterMin.find((r) => r.actorUserId === actor)?.actionCount ?? 0;
    assert.equal(
      afterCount - beforeCount,
      1,
      'days=-3 clamps to the 1-day floor: only the "now" row is counted, not the 2-day-old row',
    );

    await pool.query(`DELETE FROM admin_audit WHERE actor_user_id = $1`, [actor]);

    const actorMax = `${RUN}-aas-clamp-max-actor`;
    const beforeMax = await adminActivitySummary(10_000);
    await pool.query(
      `INSERT INTO admin_audit (platform, actor_user_id, action_kind, result, success, created_at)
       VALUES ($1,$2,$3,$4,$5, now() - interval '400 days')`,
      ['discord', actorMax, 'warn_user', 'warned', true],
    );
    const afterMax = await adminActivitySummary(10_000);
    const beforeMaxCount = beforeMax.find((r) => r.actorUserId === actorMax)?.actionCount ?? 0;
    const afterMaxCount = afterMax.find((r) => r.actorUserId === actorMax)?.actionCount ?? 0;
    assert.equal(
      afterMaxCount - beforeMaxCount,
      0,
      'days=10_000 clamps to the 365-day ceiling: a 400-day-old row must not become visible',
    );

    await pool.query(`DELETE FROM admin_audit WHERE actor_user_id = $1`, [actorMax]);
  },
);

test(
  'SECURITY: adminActivitySummary is global/unscoped across actors — never silently filtered to a single caller — and never selects admin_audit.params (issue #488)',
  { skip },
  async () => {
    const actor1 = `${RUN}-aas-sec-actor-1`;
    const actor2 = `${RUN}-aas-sec-actor-2`;
    const sentinel = 'SENTINEL-FREE-TEXT-REASON-NEVER-SHOWN-AAS';

    await recordAdminAction({
      platform: 'discord',
      actorUserId: actor1,
      actionKind: 'warn_user',
      params: { reason: sentinel },
      result: 'warned',
      success: true,
    });
    await recordAdminAction({
      platform: 'whatsapp',
      actorUserId: actor2,
      actionKind: 'timeout_user',
      result: 'timed out',
      success: true,
    });

    const rows = await adminActivitySummary(1);
    const ids = rows.map((r) => r.actorUserId);
    assert.ok(ids.includes(actor1), 'actor1 appears — the aggregation is not scoped to a single caller');
    assert.ok(ids.includes(actor2), 'actor2 appears — every distinct actor is present, unscoped');
    assert.ok(
      !rows.some((r) => Object.values(r).some((v) => typeof v === 'string' && v.includes(sentinel))),
      'admin_audit.params content must never surface through adminActivitySummary',
    );

    await pool.query(`DELETE FROM admin_audit WHERE actor_user_id = ANY($1)`, [[actor1, actor2]]);
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
  'repository: usageStats().byPlatform sums inbound/outbound/cost per platform, consistent with the top-level totals, ordered by volume desc then platform (issue #580)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-platform-split`;
    const discordUser = `${RUN}-platform-discord`;
    const whatsappUser = `${RUN}-platform-whatsapp`;

    const days = 1;
    // Exact-delta assertions over whole-table aggregates race with other test
    // FILES writing interactions concurrently (parallel file execution, one
    // shared DB) — retry the full read-seed-read sequence, cleaning seeds
    // between attempts (see retryOnSharedTableInterference above).
    await retryOnSharedTableInterference(4, async () => {
      try {
        const before = await usageStats(days);
        const beforeByPlatform = new Map(before.byPlatform.map((r) => [r.platform, r]));

        await recordInteraction({
          platform: 'discord',
          conversationId,
          userId: discordUser,
          role: 'member',
          direction: 'inbound',
          content: 'discord question',
        });
        await recordInteraction({
          platform: 'discord',
          conversationId,
          userId: discordUser,
          role: 'member',
          direction: 'outbound',
          content: 'discord reply',
          costUsd: 1.2,
        });
        await recordInteraction({
          platform: 'whatsapp',
          conversationId,
          userId: whatsappUser,
          role: 'member',
          direction: 'inbound',
          content: 'whatsapp question',
        });
        await recordInteraction({
          platform: 'whatsapp',
          conversationId,
          userId: whatsappUser,
          role: 'member',
          direction: 'outbound',
          content: 'whatsapp reply',
          costUsd: 0.3,
        });

        const after = await usageStats(days);
        const afterByPlatform = new Map(after.byPlatform.map((r) => [r.platform, r]));

        const discordBefore = beforeByPlatform.get('discord');
        const discordAfter = afterByPlatform.get('discord');
        assert.ok(discordAfter, 'discord appears in byPlatform after seeding a discord row');
        assert.equal(discordAfter.inbound - (discordBefore?.inbound ?? 0), 1);
        assert.equal(discordAfter.outbound - (discordBefore?.outbound ?? 0), 1);
        assert.equal(discordAfter.costUsd - (discordBefore?.costUsd ?? 0), 1.2);

        const whatsappBefore = beforeByPlatform.get('whatsapp');
        const whatsappAfter = afterByPlatform.get('whatsapp');
        assert.ok(whatsappAfter, 'whatsapp appears in byPlatform after seeding a whatsapp row');
        assert.equal(whatsappAfter.inbound - (whatsappBefore?.inbound ?? 0), 1);
        assert.equal(whatsappAfter.outbound - (whatsappBefore?.outbound ?? 0), 1);
        assert.equal(whatsappAfter.costUsd - (whatsappBefore?.costUsd ?? 0), 0.3);

        // Criterion 3: summing byPlatform must equal the top-level totals exactly (same
        // table/window/direction semantics as `totals`, differing only by GROUP BY platform).
        const sumInbound = after.byPlatform.reduce((a, r) => a + r.inbound, 0);
        const sumOutbound = after.byPlatform.reduce((a, r) => a + r.outbound, 0);
        const sumCost = after.byPlatform.reduce((a, r) => a + r.costUsd, 0);
        assert.equal(sumInbound, after.inbound);
        assert.equal(sumOutbound, after.outbound);
        assert.ok(Math.abs(sumCost - after.costUsd) < 1e-9);

        // Criterion 5: deterministic ordering by volume (inbound+outbound) desc, then platform name.
        for (let i = 1; i < after.byPlatform.length; i++) {
          const prev = after.byPlatform[i - 1];
          const curr = after.byPlatform[i];
          const prevVolume = prev.inbound + prev.outbound;
          const currVolume = curr.inbound + curr.outbound;
          assert.ok(
            prevVolume > currVolume || (prevVolume === currVolume && prev.platform < curr.platform),
            'byPlatform is ordered by volume desc, then platform asc as a deterministic tiebreaker',
          );
        }
      } finally {
        await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
      }
    });
  },
);

test(
  'repository: usageStats(days, platform) scopes topUsers/costByRole/totals to one platform, leaves byPlatform/backgroundCostByJob/cacheUsage/shortcutHits/autoAnswerUsage unaffected, and per-platform-scoped deltas reconcile to the unscoped delta (issue #647)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-platform-filter`;
    const discordUser = `${RUN}-filter-discord`;
    const whatsappUser = `${RUN}-filter-whatsapp`;

    const days = 1;
    // Exact-delta assertions over whole-table aggregates race with other test
    // FILES writing interactions concurrently (parallel file execution, one
    // shared DB) — retry the full read-seed-read sequence, cleaning seeds
    // between attempts (see retryOnSharedTableInterference above).
    await retryOnSharedTableInterference(4, async () => {
      try {
        const beforeAll = await usageStats(days);
        const beforeDiscord = await usageStats(days, 'discord');
        const beforeWhatsapp = await usageStats(days, 'whatsapp');

        await recordInteraction({
          platform: 'discord',
          conversationId,
          userId: discordUser,
          userName: 'DiscordFilterUser',
          role: 'member',
          direction: 'inbound',
          content: 'discord question',
        });
        await recordInteraction({
          platform: 'discord',
          conversationId,
          userId: discordUser,
          role: 'member',
          direction: 'outbound',
          content: 'discord reply',
          costUsd: 1.2,
        });
        await recordInteraction({
          platform: 'whatsapp',
          conversationId,
          userId: whatsappUser,
          userName: 'WhatsappFilterUser',
          role: 'admin',
          direction: 'inbound',
          content: 'whatsapp question',
        });
        await recordInteraction({
          platform: 'whatsapp',
          conversationId,
          userId: whatsappUser,
          role: 'admin',
          direction: 'outbound',
          content: 'whatsapp reply',
          costUsd: 0.3,
        });

        const afterAll = await usageStats(days);
        const afterDiscord = await usageStats(days, 'discord');
        const afterWhatsapp = await usageStats(days, 'whatsapp');

        // Criterion 2: a discord-scoped call reflects only discord rows.
        assert.equal(afterDiscord.inbound - beforeDiscord.inbound, 1);
        assert.equal(afterDiscord.outbound - beforeDiscord.outbound, 1);
        assert.ok(Math.abs(afterDiscord.costUsd - beforeDiscord.costUsd - 1.2) < 1e-9);
        assert.ok(
          afterDiscord.topUsers.some((u) => u.userId === discordUser),
          'discord-scoped topUsers includes the seeded discord user',
        );
        assert.ok(
          !afterDiscord.topUsers.some((u) => u.userId === whatsappUser),
          'discord-scoped topUsers must never include a whatsapp-only user',
        );
        const discordAfterByRole = new Map(afterDiscord.costByRole.map((r) => [r.role, r.costUsd]));
        const discordBeforeByRole = new Map(beforeDiscord.costByRole.map((r) => [r.role, r.costUsd]));
        assert.equal((discordAfterByRole.get('member') ?? 0) - (discordBeforeByRole.get('member') ?? 0), 1.2);
        assert.equal(
          (discordAfterByRole.get('admin') ?? 0) - (discordBeforeByRole.get('admin') ?? 0),
          0,
          'discord-scoped costByRole must not pick up the whatsapp admin reply cost',
        );

        // A whatsapp-scoped call reflects only whatsapp rows.
        assert.equal(afterWhatsapp.inbound - beforeWhatsapp.inbound, 1);
        assert.equal(afterWhatsapp.outbound - beforeWhatsapp.outbound, 1);
        assert.ok(Math.abs(afterWhatsapp.costUsd - beforeWhatsapp.costUsd - 0.3) < 1e-9);
        assert.ok(
          afterWhatsapp.topUsers.some((u) => u.userId === whatsappUser),
          'whatsapp-scoped topUsers includes the seeded whatsapp user',
        );
        assert.ok(
          !afterWhatsapp.topUsers.some((u) => u.userId === discordUser),
          'whatsapp-scoped topUsers must never include a discord-only user',
        );

        // Criterion 3: reconciliation — summing the per-platform-scoped
        // deltas for the same window must equal the unscoped delta exactly
        // (no double counting, no dropped rows).
        assert.equal(
          afterDiscord.inbound - beforeDiscord.inbound + (afterWhatsapp.inbound - beforeWhatsapp.inbound),
          afterAll.inbound - beforeAll.inbound,
        );
        assert.equal(
          afterDiscord.outbound - beforeDiscord.outbound + (afterWhatsapp.outbound - beforeWhatsapp.outbound),
          afterAll.outbound - beforeAll.outbound,
        );
        assert.ok(
          Math.abs(
            afterDiscord.costUsd -
              beforeDiscord.costUsd +
              (afterWhatsapp.costUsd - beforeWhatsapp.costUsd) -
              (afterAll.costUsd - beforeAll.costUsd),
          ) < 1e-9,
        );

        // Criterion 4: fields the filter deliberately never touches stay
        // identical to the unscoped call, regardless of the platform arg —
        // scoping can't silently mislabel a global aggregate as scoped.
        assert.deepEqual(afterDiscord.byPlatform, afterAll.byPlatform);
        assert.deepEqual(afterWhatsapp.byPlatform, afterAll.byPlatform);
        assert.deepEqual(afterDiscord.backgroundCostByJob, afterAll.backgroundCostByJob);
        assert.deepEqual(afterDiscord.cacheUsage, afterAll.cacheUsage);
        assert.deepEqual(afterDiscord.shortcutHits, afterAll.shortcutHits);
        assert.deepEqual(afterDiscord.autoAnswerUsage, afterAll.autoAnswerUsage);
      } finally {
        await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
      }
    });
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
  'repository: sumBackgroundJobCosts sums only rows within the rolling window, broken down byJob (issue #401)',
  { skip },
  async () => {
    const days = 1;
    const before = await sumBackgroundJobCosts(days);
    const beforeByJob = new Map(before.byJob.map((r) => [r.job, r.costUsd]));

    await recordBackgroundJobCost('moderation_llm', 0.5);
    await recordBackgroundJobCost('moderation_llm', 0.25);
    await recordBackgroundJobCost('context_builder', 1.5);
    await recordBackgroundJobCost('knowledge_refresh', 2);
    // Outside the 1-day window — must not contribute to either total or byJob.
    await pool.query(
      `INSERT INTO background_job_costs (job, cost_usd, created_at) VALUES ($1, $2, now() - interval '2 days')`,
      ['moderation_llm', 100],
    );

    const after = await sumBackgroundJobCosts(days);
    const afterByJob = new Map(after.byJob.map((r) => [r.job, r.costUsd]));

    assert.equal(
      after.total - before.total,
      4.25,
      'total sums only the in-window rows: 0.5 + 0.25 + 1.5 + 2',
    );
    assert.equal(
      (afterByJob.get('moderation_llm') ?? 0) - (beforeByJob.get('moderation_llm') ?? 0),
      0.75,
      'moderation_llm sums its two in-window rows, excluding the 2-day-old one',
    );
    assert.equal((afterByJob.get('context_builder') ?? 0) - (beforeByJob.get('context_builder') ?? 0), 1.5);
    assert.equal((afterByJob.get('knowledge_refresh') ?? 0) - (beforeByJob.get('knowledge_refresh') ?? 0), 2);

    await pool.query(`DELETE FROM background_job_costs WHERE cost_usd = ANY($1)`, [[0.5, 0.25, 1.5, 2, 100]]);
  },
);

test(
  'repository: usageStats().backgroundCostUsd equals sumBackgroundJobCosts(days).total for the same window, and every existing field is unchanged (issue #401)',
  { skip },
  async () => {
    const days = 1;
    const before = await usageStats(days);

    await recordBackgroundJobCost('knowledge_refresh', 3.75);

    const [after, background] = await Promise.all([usageStats(days), sumBackgroundJobCosts(days)]);

    assert.equal(
      after.backgroundCostUsd,
      background.total,
      'usageStats.backgroundCostUsd mirrors the same-window sum',
    );
    assert.equal(
      after.backgroundCostUsd - before.backgroundCostUsd,
      3.75,
      'the newly recorded background cost is reflected',
    );
    assert.equal(
      after.inbound,
      before.inbound,
      'existing inbound field is unchanged by a background-cost write',
    );
    assert.equal(
      after.outbound,
      before.outbound,
      'existing outbound field is unchanged by a background-cost write',
    );
    assert.equal(
      after.costUsd,
      before.costUsd,
      'existing costUsd field is unchanged by a background-cost write',
    );
    assert.deepEqual(after.costByRole, before.costByRole, 'existing costByRole field is unchanged');

    await pool.query(`DELETE FROM background_job_costs WHERE cost_usd = $1`, [3.75]);
  },
);

test(
  'repository: usageStats().backgroundCostByJob equals sumBackgroundJobCosts(days).byJob for the same window, across all three job labels and outside the window (issue #438)',
  { skip },
  async () => {
    const days = 1;
    const before = await usageStats(days);
    const beforeByJob = new Map(before.backgroundCostByJob.map((r) => [r.job, r.costUsd]));

    await recordBackgroundJobCost('moderation_llm', 0.35);
    await recordBackgroundJobCost('context_builder', 0.05);
    await recordBackgroundJobCost('knowledge_refresh', 3.8);
    // Outside the 1-day window — must not appear in either usageStats or sumBackgroundJobCosts.
    await pool.query(
      `INSERT INTO background_job_costs (job, cost_usd, created_at) VALUES ($1, $2, now() - interval '2 days')`,
      ['moderation_llm', 100],
    );

    const [after, background] = await Promise.all([usageStats(days), sumBackgroundJobCosts(days)]);
    const afterByJob = new Map(after.backgroundCostByJob.map((r) => [r.job, r.costUsd]));

    assert.deepEqual(
      after.backgroundCostByJob,
      background.byJob,
      'usageStats.backgroundCostByJob is sourced verbatim from sumBackgroundJobCosts(days).byJob',
    );
    assert.equal(
      (afterByJob.get('moderation_llm') ?? 0) - (beforeByJob.get('moderation_llm') ?? 0),
      0.35,
      'moderation_llm reflects only the in-window row, excluding the 2-day-old one',
    );
    assert.equal((afterByJob.get('context_builder') ?? 0) - (beforeByJob.get('context_builder') ?? 0), 0.05);
    assert.equal(
      (afterByJob.get('knowledge_refresh') ?? 0) - (beforeByJob.get('knowledge_refresh') ?? 0),
      3.8,
    );

    await pool.query(`DELETE FROM background_job_costs WHERE cost_usd = ANY($1)`, [[0.35, 0.05, 3.8, 100]]);
  },
);

test(
  'SECURITY: repository: background_job_costs stores only the fixed job enum and a numeric cost — no user id, conversation id, platform, or free text (issue #401)',
  { skip },
  async () => {
    const { rows: columns } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'background_job_costs' ORDER BY column_name`,
    );
    assert.deepEqual(
      columns.map((c) => c.column_name).sort(),
      ['cost_usd', 'created_at', 'id', 'job'],
      'background_job_costs columns are a fixed job enum + numeric cost only — adding an identity-bearing column is a posture change',
    );

    // A literal, non-enum job value must be rejected outright by the CHECK
    // constraint — job can never be free text.
    await assert.rejects(
      pool.query(`INSERT INTO background_job_costs (job, cost_usd) VALUES ($1, $2)`, ['not_a_real_job', 1]),
      /violates check constraint/,
      'the job CHECK constraint rejects anything outside the fixed enum',
    );
  },
);

test(
  'repository: sumShortcutHits sums only rows within the rolling window, broken down byKind (issue #440)',
  { skip },
  async () => {
    const days = 1;
    const before = await sumShortcutHits(days);
    const beforeByKind = new Map(before.byKind.map((r) => [r.kind, r.count]));

    await recordShortcutHit('ack');
    await recordShortcutHit('ack');
    await recordShortcutHit('knowledge');
    await recordShortcutHit('repeat_question');
    await recordShortcutHit('repeat_max_turns');
    // Outside the 1-day window — must not contribute to either total or byKind.
    await pool.query(`INSERT INTO shortcut_hits (kind, created_at) VALUES ($1, now() - interval '2 days')`, [
      'ack',
    ]);

    const after = await sumShortcutHits(days);
    const afterByKind = new Map(after.byKind.map((r) => [r.kind, r.count]));

    assert.equal(after.total - before.total, 5, 'total sums only the in-window rows: 2 + 1 + 1 + 1');
    assert.equal(
      (afterByKind.get('ack') ?? 0) - (beforeByKind.get('ack') ?? 0),
      2,
      'ack sums its two in-window rows, excluding the 2-day-old one',
    );
    assert.equal((afterByKind.get('knowledge') ?? 0) - (beforeByKind.get('knowledge') ?? 0), 1);
    assert.equal((afterByKind.get('repeat_question') ?? 0) - (beforeByKind.get('repeat_question') ?? 0), 1);
    assert.equal((afterByKind.get('repeat_max_turns') ?? 0) - (beforeByKind.get('repeat_max_turns') ?? 0), 1);

    await pool.query(
      `DELETE FROM shortcut_hits WHERE kind = ANY($1) AND created_at > now() - interval '3 days'`,
      [['ack', 'knowledge', 'repeat_question', 'repeat_max_turns']],
    );
  },
);

test(
  'repository: sumShortcutHits reflects zero new hits when none are recorded in between two reads (empty-window case, issue #440)',
  { skip },
  async () => {
    const before = await sumShortcutHits(1);
    const after = await sumShortcutHits(1);
    assert.equal(
      after.total - before.total,
      0,
      'no hits recorded in between — the window contributes nothing',
    );
    assert.equal(
      after.total,
      after.byKind.reduce((sum, r) => sum + r.count, 0),
      'total always equals the sum of byKind counts',
    );
  },
);

test(
  'repository: usageStats().shortcutHits equals sumShortcutHits(days) for the same window, and every existing field is unchanged (issue #440)',
  { skip },
  async () => {
    const days = 1;
    // The unchanged-field equalities compare two whole-table aggregate reads
    // taken moments apart — a concurrent test FILE inserting an interaction
    // in that window shifts them (the 2026-07-20 CI flake: inbound
    // "122 !== 121"). Retry the full read-write-read sequence, cleaning the
    // seeded hit between attempts (see retryOnSharedTableInterference above).
    await retryOnSharedTableInterference(4, async () => {
      // Watermark BEFORE seeding so cleanup can be scoped to rows this attempt
      // created (id > watermark), instead of the old blanket one-hour window —
      // which, run up to 4x under retry, could delete a concurrently-running
      // file's 'ack' rows mid-window and CAUSE the interference this wrapper
      // exists to absorb (PR #643 review).
      const { rows: wm } = await pool.query(`SELECT coalesce(max(id), 0) AS watermark FROM shortcut_hits`);
      const watermark = Number(wm[0].watermark);
      try {
        const before = await usageStats(days);

        await recordShortcutHit('ack');

        const [after, shortcuts] = await Promise.all([usageStats(days), sumShortcutHits(days)]);

        assert.deepEqual(
          after.shortcutHits,
          shortcuts,
          'usageStats.shortcutHits mirrors the same-window sum',
        );
        assert.equal(
          after.shortcutHits.total - before.shortcutHits.total,
          1,
          'the newly recorded shortcut hit is reflected',
        );
        assert.equal(
          after.inbound,
          before.inbound,
          'existing inbound field is unchanged by a shortcut-hit write',
        );
        assert.equal(
          after.outbound,
          before.outbound,
          'existing outbound field is unchanged by a shortcut-hit write',
        );
        assert.equal(
          after.costUsd,
          before.costUsd,
          'existing costUsd field is unchanged by a shortcut-hit write',
        );
        assert.deepEqual(after.costByRole, before.costByRole, 'existing costByRole field is unchanged');
        assert.equal(
          after.backgroundCostUsd,
          before.backgroundCostUsd,
          'existing backgroundCostUsd field is unchanged by a shortcut-hit write',
        );
      } finally {
        await pool.query(`DELETE FROM shortcut_hits WHERE kind = 'ack' AND id > $1`, [watermark]);
      }
    });
  },
);

test(
  'repository: usageStats().cacheUsage sums meta.cacheReadTokens/cacheCreationTokens over outbound rows in the window, across other meta shapes and outside the window (issue #522, acceptance criterion 4)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-cache-usage`;
    const days = 1;
    const before = await usageStats(days);

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'reply 1',
      meta: { cacheReadTokens: 1000, cacheCreationTokens: 40 },
    });
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'reply 2',
      meta: { cacheReadTokens: 234, cacheCreationTokens: 6, knowledgeEntryId: 99 },
    });
    // No cache-usage keys at all — must contribute 0, not throw or null-poison the SUM.
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'reply 3',
      meta: { replyToUserId: 'someone' },
    });
    // Inbound rows must never contribute — cacheUsage is direction = 'outbound' only.
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'someone',
      role: 'member',
      direction: 'inbound',
      content: 'a member question',
      meta: { cacheReadTokens: 999999, cacheCreationTokens: 999999 },
    });
    // Outside the 1-day window — must not appear in the sum.
    await pool.query(
      `INSERT INTO interactions
         (platform, conversation_id, user_id, role, direction, content, meta, created_at)
       VALUES ('discord', $1, 'bot', 'member', 'outbound', 'old reply',
               '{"cacheReadTokens": 5000, "cacheCreationTokens": 500}'::jsonb, now() - interval '2 days')`,
      [conversationId],
    );

    const after = await usageStats(days);

    assert.equal(
      after.cacheUsage.readTokens - before.cacheUsage.readTokens,
      1234,
      'readTokens sums only the two in-window outbound rows that carried the key (1000 + 234)',
    );
    assert.equal(
      after.cacheUsage.creationTokens - before.cacheUsage.creationTokens,
      46,
      'creationTokens sums only the two in-window outbound rows that carried the key (40 + 6)',
    );

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  'repository: usageStats().cacheUsage reflects zero delta when no interaction is recorded in between two reads (empty-window case, issue #522)',
  { skip },
  async () => {
    const before = await usageStats(1);
    const after = await usageStats(1);
    assert.deepEqual(
      after.cacheUsage,
      before.cacheUsage,
      'no interactions recorded in between — the window contributes nothing new',
    );
  },
);

test(
  "repository: usageStats().autoAnswerUsage counts/sums only outbound rows tagged meta.autoAnswer === 'true', across other meta shapes and outside the window (issue #552, acceptance criterion 3)",
  { skip },
  async () => {
    const conversationId = `${RUN}-c-autoanswer-usage`;
    const days = 1;
    const before = await usageStats(days);

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'reply 1',
      costUsd: 0.1,
      meta: { autoAnswer: true },
    });
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'reply 2',
      costUsd: 0.05,
      meta: { autoAnswer: true, knowledgeEntryId: 99 },
    });
    // No autoAnswer key at all — a normal reply — must contribute 0, not throw.
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'reply 3',
      costUsd: 1.5,
      meta: { replyToUserId: 'someone' },
    });
    // Inbound rows must never contribute — autoAnswerUsage is direction = 'outbound' only.
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'someone',
      role: 'member',
      direction: 'inbound',
      content: 'a member question',
      costUsd: 999,
      meta: { autoAnswer: true },
    });
    // Outside the 1-day window — must not appear in the sum.
    await pool.query(
      `INSERT INTO interactions
         (platform, conversation_id, user_id, role, direction, content, cost_usd, meta, created_at)
       VALUES ('discord', $1, 'bot', 'member', 'outbound', 'old reply', 500,
               '{"autoAnswer": true}'::jsonb, now() - interval '2 days')`,
      [conversationId],
    );

    const after = await usageStats(days);

    assert.equal(
      after.autoAnswerUsage.count - before.autoAnswerUsage.count,
      2,
      'count sums only the two in-window outbound rows tagged autoAnswer',
    );
    assert.ok(
      Math.abs(after.autoAnswerUsage.costUsd - before.autoAnswerUsage.costUsd - 0.15) < 1e-9,
      'costUsd sums only the two in-window outbound rows tagged autoAnswer (0.10 + 0.05)',
    );

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  'repository: usageStats().autoAnswerUsage reflects zero delta when no interaction is recorded in between two reads (empty-window case, issue #552)',
  { skip },
  async () => {
    const before = await usageStats(1);
    const after = await usageStats(1);
    assert.deepEqual(
      after.autoAnswerUsage,
      before.autoAnswerUsage,
      'no interactions recorded in between — the window contributes nothing new',
    );
  },
);

test(
  'SECURITY: repository: shortcut_hits stores only the fixed kind enum and a timestamp — no user id, conversation id, platform, or free text (issue #440)',
  { skip },
  async () => {
    const { rows: columns } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'shortcut_hits' ORDER BY column_name`,
    );
    assert.deepEqual(
      columns.map((c) => c.column_name).sort(),
      ['created_at', 'id', 'kind'],
      'shortcut_hits columns are a fixed kind enum + timestamp only — adding an identity-bearing column is a posture change',
    );

    // A literal, non-enum kind value must be rejected outright by the CHECK
    // constraint — kind can never be free text.
    await assert.rejects(
      pool.query(`INSERT INTO shortcut_hits (kind) VALUES ($1)`, ['not_a_real_kind']),
      /violates check constraint/,
      'the kind CHECK constraint rejects anything outside the fixed enum',
    );

    // sumShortcutHits's return shape carries only kind + count — no
    // user/conversation identifier or free-text field can leak through it.
    const result = await sumShortcutHits(1);
    assert.deepEqual(Object.keys(result).sort(), ['byKind', 'total']);
    for (const row of result.byKind) {
      assert.deepEqual(Object.keys(row).sort(), ['count', 'kind']);
    }
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

test('repository: listReports narrows by targetUserId (issue #463)', { skip }, async () => {
  const convo = `${RUN}-c-reports-target`;
  const reporter = `${RUN}-reports-target-reporter`;
  const targetA = `${RUN}-reports-target-a`;
  const targetB = `${RUN}-reports-target-b`;

  const reportA = await createContentReport({
    platform: 'discord',
    reporterUserId: reporter,
    conversationId: convo,
    targetUserId: targetA,
    reason: 'filed against target A',
  });
  const reportB = await createContentReport({
    platform: 'discord',
    reporterUserId: reporter,
    conversationId: convo,
    targetUserId: targetB,
    reason: 'filed against target B',
  });
  assert.ok(reportA && reportB);

  const unfiltered = await listReports([convo], undefined, 50, undefined);
  assert.ok(
    unfiltered.some((r) => r.id === reportA.id) && unfiltered.some((r) => r.id === reportB.id),
    'omitting targetUserId leaves both reports visible, unchanged from before #463',
  );

  const filteredToA = await listReports([convo], undefined, 50, undefined, targetA);
  assert.ok(
    filteredToA.some((r) => r.id === reportA.id),
    'targetUserId filter includes the matching report',
  );
  assert.ok(
    !filteredToA.some((r) => r.id === reportB.id),
    'targetUserId filter excludes a report against a different target',
  );

  await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [[reportA.id, reportB.id]]);
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
    const dmReportAgainstViewer = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId: dmConvo,
      targetUserId: viewer,
      reason: 'a DM report filed against the viewing admin themselves',
      isDirect: true,
    });
    assert.ok(dmReport && channelReport && dmReportAgainstViewer);

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

    // issue #463: the new targetUserId filter is appended AFTER the
    // accused-admin exclusion, so setting it to the caller's own id must not
    // resurface a DM report filed against themselves.
    const scopedWithSelfTarget = await listReports([inScopeConvo], undefined, 50, [viewer], viewer);
    assert.ok(
      !scopedWithSelfTarget.some((r) => r.id === dmReportAgainstViewer.id),
      'SECURITY: targetUserId set to the caller’s own id must not surface a DM report filed against themselves',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [
      [dmReport.id, channelReport.id, dmReportAgainstViewer.id],
    ]);
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
  'repository: oldestAccessRequestAgeDays returns the whole-day age of the oldest row (MIN(first_requested_at)), not the most recently inserted one (issue #515)',
  { skip },
  async () => {
    const recentUser = `${RUN}-oldestage-recent`;
    const oldUser = `${RUN}-oldestage-old`;
    await recordAccessRequest({ platform: 'discord', userId: recentUser, userName: 'tester' });
    await recordAccessRequest({ platform: 'discord', userId: oldUser, userName: 'tester' });
    // Backdate oldUser far enough into the past that no concurrently-running
    // test file's freshly-inserted row (first_requested_at always defaults to
    // now() — nothing else in the codebase ever sets it directly) could
    // plausibly be older, so MIN(first_requested_at) is deterministically
    // this row regardless of what else is in the table right now.
    await pool.query(
      `UPDATE access_requests SET first_requested_at = now() - interval '500 days'
        WHERE platform = 'discord' AND user_id = $1`,
      [oldUser],
    );

    assert.equal(
      await oldestAccessRequestAgeDays(),
      500,
      'the oldest row by first_requested_at determines the age, not the most recently inserted row',
    );

    await clearAccessRequest('discord', recentUser);
    await clearAccessRequest('discord', oldUser);
  },
);

test(
  'SECURITY: oldestAccessRequestAgeDays returns null (never 0 or NaN) for an empty access_requests table, and a real non-negative integer otherwise (issue #515)',
  { skip },
  async () => {
    const countBefore = await countAccessRequests();
    const age = await oldestAccessRequestAgeDays();
    if (countBefore === 0) {
      assert.equal(age, null, 'an empty table must return null, never 0 or a throw');
    } else {
      // A concurrently-running test file may have a pending row at this
      // instant — still must never come back as anything other than null or
      // a well-formed non-negative integer (never NaN/undefined/negative).
      assert.ok(
        age === null || (Number.isInteger(age) && age >= 0),
        'a non-empty table must yield null or a non-negative integer day count, never NaN',
      );
    }
  },
);

test(
  'SECURITY: repository: oldestOpenReportAgeDays inherits countOpenReports scoping — an out-of-scope report never influences the age, only open status counts, and MIN(created_at) picks the oldest (issue #450)',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-reportage-in`;
    const outOfScopeConvo = `${RUN}-c-reportage-out`;
    const reporter = `${RUN}-reportage-reporter`;

    const recent = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId: inScopeConvo,
      reason: 'in scope, open, recent',
    });
    const old = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId: inScopeConvo,
      reason: 'in scope, open, old',
    });
    const outOfScope = await createContentReport({
      platform: 'discord',
      reporterUserId: reporter,
      conversationId: outOfScopeConvo,
      reason: 'out of scope — must never influence the in-scope age',
    });
    assert.ok(recent && old && outOfScope);

    // Backdate the in-scope "old" report to 300d and the out-of-scope one to
    // 900d. If scoping leaked, MIN(created_at) over the scoped set would jump
    // to 900; a correctly-scoped query stays at 300.
    await pool.query(`UPDATE content_reports SET created_at = now() - interval '300 days' WHERE id = $1`, [
      old.id,
    ]);
    await pool.query(`UPDATE content_reports SET created_at = now() - interval '900 days' WHERE id = $1`, [
      outOfScope.id,
    ]);

    assert.equal(
      await oldestOpenReportAgeDays([inScopeConvo]),
      300,
      'the oldest IN-SCOPE open report determines the age; the older out-of-scope report must never leak in',
    );

    // Resolving the oldest in-scope report drops it out — the age falls back to
    // the remaining (recent) in-scope report, never to the out-of-scope one.
    await resolveContentReport(old.id, 'resolved', `${RUN}-reportage-resolver`);
    const afterResolve = await oldestOpenReportAgeDays([inScopeConvo]);
    assert.ok(
      afterResolve !== null && afterResolve < 300,
      'a resolved report no longer counts; the age reflects only the remaining open in-scope reports',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [[recent.id, old.id, outOfScope.id]]);
  },
);

test(
  'SECURITY: oldestOpenReportAgeDays / oldestPendingSuggestionAgeDays return null (never 0 or NaN) for an empty scoped/pending set, and a real non-negative integer otherwise (issue #450)',
  { skip },
  async () => {
    // A conversation scope with no reports at all — must be null, never 0.
    const emptyScope = `${RUN}-c-reportage-empty`;
    assert.equal(
      await oldestOpenReportAgeDays([emptyScope]),
      null,
      'an empty scoped report set must return null, never 0 or a throw',
    );

    const suggestionAge = await oldestPendingSuggestionAgeDays();
    const pendingCount = await countPendingSuggestions();
    if (pendingCount === 0) {
      assert.equal(
        suggestionAge,
        null,
        'an empty pending-suggestion set must return null, never 0 or a throw',
      );
    } else {
      // A concurrently-running test file may have a pending suggestion at this
      // instant — still must never be anything other than null or a
      // well-formed non-negative integer.
      assert.ok(
        suggestionAge === null || (Number.isInteger(suggestionAge) && suggestionAge >= 0),
        'a non-empty pending set must yield null or a non-negative integer day count, never NaN',
      );
    }
  },
);

test(
  'repository: oldestPendingSuggestionAgeDays returns the whole-day age of the oldest status=new row (MIN(created_at)), excludes reviewed rows, and is null when none are pending (issue #450)',
  { skip },
  async () => {
    const user = `${RUN}-suggestionage-user`;
    // Insert two pending suggestions directly (bypassing createSuggestion's
    // rolling-24h rate cap) so we control created_at deterministically.
    const { rows: recentRows } = await pool.query(
      `INSERT INTO suggestions (platform, user_id, content) VALUES ($1,$2,$3) RETURNING id`,
      ['discord', user, 'recent pending suggestion'],
    );
    const { rows: oldRows } = await pool.query(
      `INSERT INTO suggestions (platform, user_id, content) VALUES ($1,$2,$3) RETURNING id`,
      ['discord', user, 'old pending suggestion'],
    );
    const recentId = Number(recentRows[0].id);
    const oldId = Number(oldRows[0].id);
    // Backdate the old one far enough that no concurrent test file's fresh row
    // (created_at defaults to now()) could plausibly be older, so
    // MIN(created_at) over status='new' is deterministically this row.
    await pool.query(`UPDATE suggestions SET created_at = now() - interval '400 days' WHERE id = $1`, [
      oldId,
    ]);

    assert.equal(
      await oldestPendingSuggestionAgeDays(),
      400,
      'the oldest status=new suggestion by created_at determines the age',
    );

    // Marking the old one reviewed drops it from the pending set — the age
    // falls back to the recent one, proving status='new' scoping.
    await resolveSuggestion(oldId, 'done', `${RUN}-suggestionage-reviewer`);
    const afterReview = await oldestPendingSuggestionAgeDays();
    assert.ok(
      afterReview !== null && afterReview < 400,
      "a reviewed suggestion no longer counts as pending — only 'new' rows drive the age",
    );

    await pool.query(`DELETE FROM suggestions WHERE id = ANY($1)`, [[recentId, oldId]]);
  },
);

test(
  'repository: recordAccessRequest reports insert-vs-update via the RETURNING (xmax = 0) trick — true on a fresh ' +
    'row, false on a repeat upsert, true again after the row is cleared (issue #480)',
  { skip },
  async () => {
    const userId = `${RUN}-recordaccessreq-inserted`;
    await clearAccessRequest('discord', userId); // in case a previous failed run left a row behind

    const firstInsert = await recordAccessRequest({ platform: 'discord', userId, userName: 'tester' });
    assert.equal(
      firstInsert.inserted,
      true,
      'the first-ever request for this (platform, user_id) must report a fresh insert',
    );
    assert.ok(
      firstInsert.firstRequestedAt instanceof Date,
      "a fresh insert must return the row's first_requested_at",
    );

    const repeat = await recordAccessRequest({ platform: 'discord', userId, userName: 'tester' });
    assert.equal(
      repeat.inserted,
      false,
      'a second request from the same still-pending user must report NOT a fresh insert',
    );
    assert.equal(
      repeat.firstRequestedAt.getTime(),
      firstInsert.firstRequestedAt.getTime(),
      'a repeat upsert must return the ORIGINAL first_requested_at, unchanged by the update',
    );

    const repeatAgain = await recordAccessRequest({ platform: 'discord', userId, userName: 'tester' });
    assert.equal(
      repeatAgain.inserted,
      false,
      'every subsequent repeat must keep reporting false, not just the second one',
    );

    await clearAccessRequest('discord', userId);

    const afterClear = await recordAccessRequest({ platform: 'discord', userId, userName: 'tester' });
    assert.equal(
      afterClear.inserted,
      true,
      'after clearAccessRequest removes the row, the next request is a fresh insert again',
    );

    await clearAccessRequest('discord', userId);
  },
);

test(
  'SECURITY: repository: recordAccessRequest returning firstRequestedAt adds no new DB round-trip — issues ' +
    'exactly one query per call (issue #591)',
  { skip },
  async (t) => {
    const userId = `${RUN}-recordaccessreq-onequery`;
    await clearAccessRequest('discord', userId); // in case a previous failed run left a row behind

    const calls: unknown[] = [];
    const realQuery = pool.query.bind(pool);
    t.mock.method(pool, 'query', (...args: unknown[]) => {
      calls.push(args);
      return (realQuery as (...a: unknown[]) => unknown)(...args);
    });

    const result = await recordAccessRequest({ platform: 'discord', userId, userName: 'tester' });

    assert.equal(
      calls.length,
      1,
      'recordAccessRequest must issue exactly one query even though it now also returns firstRequestedAt',
    );
    assert.equal(result.inserted, true);
    assert.ok(result.firstRequestedAt instanceof Date);

    await clearAccessRequest('discord', userId);
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
  'repository: countUnreachableSourceKnowledge counts only source_unreachable = true rows, independent of staleness/rating/candidate status on those same rows (issue #624 acceptance criterion 1)',
  { skip },
  async () => {
    const before = await countUnreachableSourceKnowledge();

    const { id: unreachableId } = await saveKnowledge({
      content: `${RUN} entry with a dead source link`,
      title: 'unreachable-source-check-flagged',
      scope: 'global',
      sourceUrl: 'https://example.com/dead-link',
    });
    // Also stale (400 days untouched) — proves the count never cross-
    // contaminates with countStaleKnowledge's own definition.
    await pool.query(
      `UPDATE knowledge SET source_unreachable = true, source_checked_at = now(),
         updated_at = now() - interval '400 days'
       WHERE id = $1`,
      [unreachableId],
    );

    const { id: reachableId } = await saveKnowledge({
      content: `${RUN} entry with a healthy source link`,
      title: 'unreachable-source-check-healthy',
      scope: 'global',
      sourceUrl: 'https://example.com/healthy-link',
    });
    await pool.query(
      `UPDATE knowledge SET source_unreachable = false, source_checked_at = now() WHERE id = $1`,
      [reachableId],
    );

    const { id: uncheckedId } = await saveKnowledge({
      content: `${RUN} entry never checked (source_unreachable NULL)`,
      title: 'unreachable-source-check-unchecked',
      scope: 'global',
    });

    assert.equal(
      await countUnreachableSourceKnowledge(),
      before + 1,
      'only the one entry with source_unreachable = true counts — never the healthy (false) or never-checked (NULL) rows',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[unreachableId, reachableId, uncheckedId]]);
    assert.equal(await countUnreachableSourceKnowledge(), before, 'cleanup restores the prior count');
  },
);

test(
  'repository: countStaleKnowledge maxAgeDays ceiling counts a frequently-retrieved-but-ancient entry that staleDays alone exempts forever, and stays byte-identical to pre-#380 when omitted (issue #380)',
  { skip },
  async () => {
    const before0 = await countStaleKnowledge(30);
    const beforeCeiling = await countStaleKnowledge(30, 90);

    const { id: popularAncient } = await saveKnowledge({
      content: `${RUN} popular but ancient — retrieved moments ago, content is 200 days old`,
      title: 'stale-max-age-popular-ancient',
      scope: 'global',
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '200 days', last_retrieved_at = now()
        WHERE id = $1`,
      [popularAncient],
    );

    assert.equal(
      await countStaleKnowledge(30),
      before0,
      'omitting maxAgeDays must never count the popular-but-ancient entry — byte-identical to pre-#380',
    );
    assert.equal(
      await countStaleKnowledge(30, 0),
      before0,
      'maxAgeDays=0 (explicit) is identical to omitting it',
    );
    assert.equal(
      await countStaleKnowledge(30, 90),
      beforeCeiling + 1,
      'maxAgeDays=90 must count the popular-but-ancient entry even though staleDays alone never would',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [popularAncient]);
    assert.equal(
      await countStaleKnowledge(30, 90),
      beforeCeiling,
      'cleanup restores the prior ceiling count',
    );
  },
);

test(
  'SECURITY: countStaleKnowledge in ceiling-only mode (days=0, maxAgeDays>0) counts only entries past the ' +
    "ceiling, not the entire table — a regression where the unguarded GREATEST(...) < now() - '0 days' " +
    "disjunct matched virtually every pre-existing row, making the OR's other branch irrelevant (issue #380)",
  { skip },
  async () => {
    const beforeCeiling = await countStaleKnowledge(0, 90);

    const { id: freshEntry } = await saveKnowledge({
      content: `${RUN} freshly edited and freshly retrieved — must never count as stale in ceiling-only mode`,
      title: 'stale-ceiling-only-fresh',
      scope: 'global',
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '1 day', last_retrieved_at = now()
        WHERE id = $1`,
      [freshEntry],
    );

    const { id: popularAncient } = await saveKnowledge({
      content: `${RUN} popular but ancient — must count as stale in ceiling-only mode`,
      title: 'stale-ceiling-only-popular-ancient',
      scope: 'global',
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '200 days', last_retrieved_at = now()
        WHERE id = $1`,
      [popularAncient],
    );

    assert.equal(
      await countStaleKnowledge(0, 90),
      beforeCeiling + 1,
      'days=0 must exempt the freshly-edited entry from the first disjunct — only the entry past the ' +
        '90-day ceiling counts, not every pre-existing row',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[freshEntry, popularAncient]]);
    assert.equal(await countStaleKnowledge(0, 90), beforeCeiling, 'cleanup restores the prior ceiling count');
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
  'repository: listKnowledge staleOnly + staleMaxAgeDays includes a frequently-retrieved-but-ancient entry that staleDays alone excludes, and stays byte-identical to pre-#380 when omitted (issue #380)',
  { skip },
  async () => {
    const scope = `${RUN}-stale-max-age-scope`;

    const { id: popularAncient } = await saveKnowledge({
      content: `${RUN} popular but ancient`,
      title: 'stale-max-age-list-popular-ancient',
      scope,
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '200 days', last_retrieved_at = now()
        WHERE id = $1`,
      [popularAncient],
    );

    const omitted = await listKnowledge({ scope, staleOnly: true, staleDays: 30 });
    assert.deepEqual(
      omitted.map((e) => e.id),
      [],
      'omitting staleMaxAgeDays must never surface the popular-but-ancient entry — byte-identical to pre-#380',
    );

    const explicitZero = await listKnowledge({ scope, staleOnly: true, staleDays: 30, staleMaxAgeDays: 0 });
    assert.deepEqual(
      explicitZero.map((e) => e.id),
      [],
      'staleMaxAgeDays=0 (explicit) is identical to omitting it',
    );

    const withCeiling = await listKnowledge({ scope, staleOnly: true, staleDays: 30, staleMaxAgeDays: 90 });
    assert.deepEqual(
      withCeiling.map((e) => e.id),
      [popularAncient],
      'staleMaxAgeDays=90 must include the popular-but-ancient entry even though staleDays alone never would',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [popularAncient]);
  },
);

test(
  'repository: listKnowledge staleOnly ordering tracks the ACTIVE criterion — with the content-age ceiling on, ' +
    'oldest-content-first even for a frequently-retrieved entry (issue #380)',
  { skip },
  async () => {
    const scope = `${RUN}-stale-ceiling-order-scope`;

    // Oldest content, but very popular (recent last_retrieved_at). Under the old
    // ORDER BY GREATEST(updated_at, last_retrieved_at) this sorted LAST ("least
    // overdue") — the exact blind spot a content-age ceiling exists to close.
    const { id: oldestPopular } = await saveKnowledge({
      content: `${RUN} oldest content, frequently served`,
      title: 'stale-ceiling-order-oldest-popular',
      scope,
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '300 days', last_retrieved_at = now() WHERE id = $1`,
      [oldestPopular],
    );

    // Newer content (still past the 90d ceiling), never retrieved.
    const { id: newerUnread } = await saveKnowledge({
      content: `${RUN} newer content, never served`,
      title: 'stale-ceiling-order-newer-unread',
      scope,
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '120 days', last_retrieved_at = NULL WHERE id = $1`,
      [newerUnread],
    );

    const ordered = await listKnowledge({ scope, staleOnly: true, staleDays: 0, staleMaxAgeDays: 90 });
    assert.deepEqual(
      ordered.map((e) => e.id),
      [oldestPopular, newerUnread],
      'ceiling-only mode must order by content age (updated_at) so the oldest-content entry is first even ' +
        'though it was just retrieved — not sunk to the end by GREATEST(updated_at, last_retrieved_at)',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[oldestPopular, newerUnread]]);
  },
);

test(
  'SECURITY: listKnowledge staleOnly in ceiling-only mode (staleDays=0, staleMaxAgeDays>0) returns only entries ' +
    'past the ceiling, not the entire scope — a regression where the unguarded GREATEST(...) < now() - ' +
    "'0 days' disjunct matched virtually every pre-existing row, making staleOnly return everything " +
    '(issue #380)',
  { skip },
  async () => {
    const scope = `${RUN}-stale-ceiling-only-list-scope`;

    const { id: freshEntry } = await saveKnowledge({
      content: `${RUN} freshly edited and freshly retrieved — must never appear in ceiling-only staleOnly`,
      title: 'stale-ceiling-only-list-fresh',
      scope,
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '1 day', last_retrieved_at = now()
        WHERE id = $1`,
      [freshEntry],
    );

    const { id: popularAncient } = await saveKnowledge({
      content: `${RUN} popular but ancient — must appear in ceiling-only staleOnly`,
      title: 'stale-ceiling-only-list-popular-ancient',
      scope,
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '200 days', last_retrieved_at = now()
        WHERE id = $1`,
      [popularAncient],
    );

    const ceilingOnly = await listKnowledge({ scope, staleOnly: true, staleDays: 0, staleMaxAgeDays: 90 });
    assert.deepEqual(
      ceilingOnly.map((e) => e.id),
      [popularAncient],
      'staleDays=0 must exempt the freshly-edited entry from the first disjunct — only the entry past ' +
        'the 90-day ceiling is returned, not every entry in scope',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[freshEntry, popularAncient]]);
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
  'isKnowledgeStale maxAgeDays (issue #380): a popular entry retrieved just now still trips the absolute ' +
    'content-age ceiling, closing the gap where staleDays alone can never fire on it',
  () => {
    const ancientEdit = new Date(Date.now() - 200 * 86_400_000);
    const retrievedNow = new Date();
    assert.equal(
      isKnowledgeStale({ updatedAt: ancientEdit, lastRetrievedAt: retrievedNow }, 30),
      false,
      'staleDays alone: retrieved moments ago, so never stale — the exact self-defeating loop #380 closes',
    );
    assert.equal(
      isKnowledgeStale({ updatedAt: ancientEdit, lastRetrievedAt: retrievedNow }, 30, 90),
      true,
      'maxAgeDays=90 fires on content age alone, deliberately ignoring lastRetrievedAt',
    );
  },
);

test('isKnowledgeStale maxAgeDays fires even with staleDays=0 — a valid config combo (ceiling-only mode)', () => {
  const ancientEdit = new Date(Date.now() - 200 * 86_400_000);
  assert.equal(
    isKnowledgeStale({ updatedAt: ancientEdit, lastRetrievedAt: new Date() }, 0, 90),
    true,
    'maxAgeDays does not depend on staleDays being enabled',
  );
});

test('isKnowledgeStale maxAgeDays omitted/0 is byte-identical to pre-#380 behaviour for every existing case', () => {
  const oldDate = new Date(Date.now() - 400 * 86_400_000);
  const recentDate = new Date(Date.now() - 1 * 86_400_000);
  assert.equal(isKnowledgeStale({ updatedAt: oldDate, lastRetrievedAt: recentDate }, 30, 0), false);
  assert.equal(isKnowledgeStale({ updatedAt: recentDate, lastRetrievedAt: oldDate }, 30, 0), false);
  assert.equal(isKnowledgeStale({ updatedAt: oldDate, lastRetrievedAt: oldDate }, 30, 0), true);
  assert.equal(isKnowledgeStale({ updatedAt: oldDate, lastRetrievedAt: null }, 30, 0), true);
  assert.equal(isKnowledgeStale({ updatedAt: oldDate, lastRetrievedAt: null }, 0, 0), false);
});

test(
  'SECURITY: countStaleKnowledge/listKnowledge staleOnly stay byte-identical to pre-#380 behaviour when ' +
    'maxAgeDays is omitted — the new ceiling parameter is a strict opt-in, never a default behaviour change ' +
    '(issue #380)',
  { skip },
  async () => {
    const scope = `${RUN}-stale-max-age-security-scope`;
    const { id: popularAncient } = await saveKnowledge({
      content: `${RUN} popular but ancient (security regression check)`,
      title: 'stale-max-age-security-popular-ancient',
      scope,
    });
    await pool.query(
      `UPDATE knowledge SET updated_at = now() - interval '200 days', last_retrieved_at = now()
        WHERE id = $1`,
      [popularAncient],
    );

    const countOmitted = await countStaleKnowledge(30);
    const countExplicitZero = await countStaleKnowledge(30, 0);
    assert.equal(countOmitted, countExplicitZero, 'omitting maxAgeDays must equal passing 0 explicitly');

    const listOmitted = await listKnowledge({ scope, staleOnly: true, staleDays: 30 });
    assert.deepEqual(
      listOmitted.map((e) => e.id),
      [],
      'omitting staleMaxAgeDays must never surface the popular-but-ancient entry — matches pre-#380 output exactly',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [popularAncient]);
  },
);

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
    assert.ok(counts.notMembers >= 1, 'notMembers includes the still-present non-member lurker (issue #460)');

    await pool.query(`DELETE FROM server_roster WHERE user_id = ANY($1)`, [[lurker, member, leaver]]);
    await pool.query(`DELETE FROM community_users WHERE platform_user_id = $1`, [member]);
  },
);

test(
  'repository: rosterCounts.notMembers counts a present non-member, excludes a member and a departed non-member (issue #460)',
  { skip },
  async () => {
    const lurker = `${RUN}-roster-nm-lurker`;
    const member = `${RUN}-roster-nm-member`;
    const leaver = `${RUN}-roster-nm-leaver`;

    const before = await rosterCounts('discord');

    await upsertRosterMember({ platform: 'discord', userId: lurker, displayName: 'NM Lurker' });
    await upsertRosterMember({ platform: 'discord', userId: member, displayName: 'NM Member' });
    await upsertRosterMember({ platform: 'discord', userId: leaver, displayName: 'NM Leaver' });
    await upsertMember({ platform: 'discord', userId: member, role: 'member', addedBy: `${RUN}-admin` });
    await markRosterLeave('discord', leaver);

    const after = await rosterCounts('discord');
    assert.equal(
      after.notMembers,
      before.notMembers + 1,
      'exactly one net-new not_members row: the still-present, never-added lurker — ' +
        'the registered member and the departed non-member are both excluded',
    );

    await pool.query(`DELETE FROM server_roster WHERE user_id = ANY($1)`, [[lurker, member, leaver]]);
    await pool.query(`DELETE FROM community_users WHERE platform_user_id = $1`, [member]);
  },
);

test(
  'repository: listRoster and rosterCounts work identically for platform "whatsapp" with zero code change (issue #407)',
  { skip },
  async () => {
    const lurker = `${RUN}-wa-roster-lurker`;
    const member = `${RUN}-wa-roster-member`;
    const leaver = `${RUN}-wa-roster-leaver`;

    // WhatsApp roster rows carry no display name (Baileys' group-participants.update
    // carries no push name) — upsertRosterMember/markRosterLeave/listRoster/
    // rosterCounts are unchanged, platform-generic functions; this is purely a
    // regression check that the #407 WhatsApp integration needed no edits to them.
    await upsertRosterMember({ platform: 'whatsapp', userId: lurker });
    await upsertRosterMember({ platform: 'whatsapp', userId: member });
    await upsertRosterMember({ platform: 'whatsapp', userId: leaver });
    await upsertMember({ platform: 'whatsapp', userId: member, role: 'member', addedBy: `${RUN}-wa-admin` });
    await markRosterLeave('whatsapp', leaver);

    const notMembers = await listRoster('whatsapp', 'not_members', 7, 200);
    assert.ok(
      notMembers.some((r) => r.userId === lurker && !r.isMember),
      'a present WhatsApp non-member appears in the onboarding queue, same as Discord',
    );
    assert.ok(
      !notMembers.some((r) => r.userId === member),
      'a registered WhatsApp member is not in the queue',
    );
    assert.ok(
      !notMembers.some((r) => r.userId === leaver),
      'someone who left is not in the onboarding queue',
    );

    const left = await listRoster('whatsapp', 'left', 7, 200);
    assert.ok(
      left.some((r) => r.userId === leaver && r.leftAt !== null),
      'recent leavers appear under "left"',
    );

    const counts = await rosterCounts('whatsapp');
    assert.ok(
      counts.total >= 2,
      'rosterCounts("whatsapp") is no longer permanently zero (issue #344 gap closed)',
    );
    assert.ok(counts.joinedThisWeek >= 2, 'this-week join count includes the WhatsApp fixtures');
    assert.ok(counts.leftThisWeek >= 1, 'this-week leave count includes the WhatsApp leaver');
    assert.ok(
      counts.notMembers >= 1,
      'notMembers includes the still-present WhatsApp non-member lurker, same as Discord (issue #460)',
    );

    await pool.query(`DELETE FROM server_roster WHERE user_id = ANY($1)`, [[lurker, member, leaver]]);
    await pool.query(`DELETE FROM community_users WHERE platform_user_id = $1`, [member]);
  },
);

test(
  'repository: engagementStats counts only currently-present roster members with a distinct matching ' +
    'inbound interaction, excludes members who left, and never divides by zero (issue #419)',
  { skip },
  async () => {
    const engaged = `${RUN}-engagement-repo-engaged`;
    const lurker = `${RUN}-engagement-repo-lurker`;
    const departed = `${RUN}-engagement-repo-departed`;
    const conversationId = `${RUN}-engagement-repo-convo`;

    await upsertRosterMember({ platform: 'discord', userId: engaged, displayName: 'Engaged' });
    await upsertRosterMember({ platform: 'discord', userId: lurker, displayName: 'Lurker' });
    await upsertRosterMember({ platform: 'discord', userId: departed, displayName: 'Departed' });
    await markRosterLeave('discord', departed);

    // Two inbound rows for the engaged member — numerator must be a
    // DISTINCT user_id count, not a raw row count.
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: engaged,
      role: 'member',
      direction: 'inbound',
      content: 'first message',
    });
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: engaged,
      role: 'member',
      direction: 'inbound',
      content: 'second message',
    });
    // An outbound-only row for the departed member must never count them as
    // engaged even before their left_at exclusion is considered.
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: departed,
      role: 'member',
      direction: 'outbound',
      content: 'bot reply',
    });

    const stats = await engagementStats('discord');
    const before = stats.byPlatform.find((p) => p.platform === 'discord');
    assert.ok(before, 'discord breakdown is present since we just upserted discord roster rows');

    assert.ok(
      before.total >= 2,
      'total counts present members (engaged + lurker), excluding the departed one',
    );
    assert.ok(before.engaged >= 1, 'engaged count includes the distinct engaged member');

    // Re-run scoped strictly to our fixture rows via a direct query, since
    // a shared DB may carry other engagement fixtures/production data.
    const { rows } = await pool.query(
      `SELECT r.user_id, (e.user_id IS NOT NULL) AS is_engaged
         FROM server_roster r
         LEFT JOIN (SELECT DISTINCT platform, user_id FROM interactions WHERE direction = 'inbound') e
           ON e.platform = r.platform AND e.user_id = r.user_id
        WHERE r.platform = 'discord' AND r.left_at IS NULL AND r.user_id = ANY($1)`,
      [[engaged, lurker, departed]],
    );
    assert.deepEqual(
      rows
        .map((r) => ({ userId: r.user_id, isEngaged: r.is_engaged }))
        .sort((a, b) => (a.userId < b.userId ? -1 : 1)),
      [
        { userId: engaged, isEngaged: true },
        { userId: lurker, isEngaged: false },
      ].sort((a, b) => (a.userId < b.userId ? -1 : 1)),
      'exactly the engaged fixture is flagged engaged; the departed member is absent (left_at excluded)',
    );

    // The returned percentage must always equal the arithmetic derived from
    // total/engaged directly — no drift between the two, and (since total
    // is always >= 1 once any roster row exists) no division-by-zero path
    // taken here. The dedicated zero-roster/divide-by-zero case is covered
    // by tests/tools.test.ts's formatEngagementStats({ total: 0, ... }) test,
    // which exercises the exact zero-total input this function can produce.
    assert.equal(
      before.percentage,
      Math.round((before.engaged / before.total) * 1000) / 10,
      'percentage matches engaged/total arithmetic exactly',
    );

    await pool.query(`DELETE FROM server_roster WHERE user_id = ANY($1)`, [[engaged, lurker, departed]]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  'repository: wasEngagementAlertSentRecently is true within the freshness window, false past it and before any send (issue #568) — same restart-safe shape as wasAdminDigestSentRecently',
  { skip },
  async () => {
    await pool.query(`DELETE FROM engagement_alert_sends WHERE id = 1`);

    assert.equal(await wasEngagementAlertSentRecently(7), false, 'no send recorded yet — not fresh');

    await recordEngagementAlertSent(42);
    assert.equal(
      await wasEngagementAlertSentRecently(7),
      true,
      'a send just recorded is within the 7-day freshness window',
    );

    await pool.query(`UPDATE engagement_alert_sends SET sent_at = now() - interval '8 days' WHERE id = 1`);
    assert.equal(
      await wasEngagementAlertSentRecently(7),
      false,
      'a send older than the window no longer counts as fresh',
    );

    await pool.query(`DELETE FROM engagement_alert_sends WHERE id = 1`);
  },
);

test(
  'repository: recordEngagementAlertSent upserts the single guild-wide row (id = 1) — a second call updates sent_at/last_percentage rather than inserting a second row (issue #568)',
  { skip },
  async () => {
    await pool.query(`DELETE FROM engagement_alert_sends WHERE id = 1`);

    await recordEngagementAlertSent(10);
    await recordEngagementAlertSent(55);

    const { rows } = await pool.query(`SELECT id, last_percentage FROM engagement_alert_sends`);
    assert.equal(rows.length, 1, 'exactly one row ever exists — the singleton guard');
    assert.equal(rows[0].id, 1);
    assert.equal(Number(rows[0].last_percentage), 55, "the latest call's percentage wins");

    await pool.query(`DELETE FROM engagement_alert_sends WHERE id = 1`);
  },
);

test(
  'SECURITY: repository: engagement_alert_sends holds no user/admin identifier column — only sent_at and an aggregate percentage, so forget_me/purge_user_data have nothing user-scoped to purge here (issue #568)',
  { skip },
  async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'engagement_alert_sends'`,
    );
    const columns = new Set(rows.map((r) => r.column_name));
    assert.deepEqual(
      columns,
      new Set(['id', 'sent_at', 'last_percentage']),
      'no platform/platform_user_id/display_name column exists on this table',
    );
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
  'repository: getInteractionContentByMessageId returns the stored content, scoped to its conversation, ' +
    'null when unmatched (issue #312)',
  { skip },
  async () => {
    const author = `${RUN}-content-author`;
    const convo = `${RUN}-content-convo`;
    const messageId = `${RUN}-content-msg`;
    await recordInteraction({
      platform: 'whatsapp',
      conversationId: convo,
      userId: author,
      role: 'member',
      direction: 'inbound',
      content: 'the actual stored content',
      messageId,
    });
    assert.equal(
      await getInteractionContentByMessageId('whatsapp', convo, messageId),
      'the actual stored content',
    );
    assert.equal(
      await getInteractionContentByMessageId('whatsapp', `${convo}-other`, messageId),
      null,
      'a wrong-conversation lookup finds nothing — read-only and scope-safe like getInteractionAuthorByMessageId',
    );
    assert.equal(
      await getInteractionContentByMessageId('whatsapp', convo, `${messageId}-never-seen`),
      null,
      'an unstored message id returns null, never a fabricated preview',
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
  'listAdminDisplayNames: resolves community_users->server_roster names for admins only, excludes members, omits admins with no resolvable name, platform-scoped',
  { skip },
  async () => {
    const adminWithOwnName = `${RUN}-lad-admin-own`;
    const adminFromRoster = `${RUN}-lad-admin-roster`;
    const adminNoName = `${RUN}-lad-admin-noname`;
    const member = `${RUN}-lad-member`;
    const otherPlatformAdmin = `${RUN}-lad-admin-whatsapp`;

    await upsertMember({
      platform: 'discord',
      userId: adminWithOwnName,
      role: 'admin',
      addedBy: `${RUN}-actor`,
      displayName: 'Admin Own Name',
    });
    // Roster-only display name (issue #360 growth path: same fallback resolveDisplayName uses).
    await pool.query(
      `INSERT INTO server_roster (platform, user_id, display_name) VALUES ('discord', $1, 'Admin Roster Name')`,
      [adminFromRoster],
    );
    await upsertMember({
      platform: 'discord',
      userId: adminFromRoster,
      role: 'admin',
      addedBy: `${RUN}-actor`,
    });
    // No display name anywhere — must be OMITTED, never rendered as a blank/empty string.
    await upsertMember({ platform: 'discord', userId: adminNoName, role: 'admin', addedBy: `${RUN}-actor` });
    await upsertMember({
      platform: 'discord',
      userId: member,
      role: 'member',
      addedBy: `${RUN}-actor`,
      displayName: 'Just A Member',
    });
    await upsertMember({
      platform: 'whatsapp',
      userId: otherPlatformAdmin,
      role: 'admin',
      addedBy: `${RUN}-actor`,
      displayName: 'WhatsApp Admin',
    });

    const discordNames = await listAdminDisplayNames('discord');
    assert.ok(discordNames.includes('Admin Own Name'), 'membership display name is resolved');
    assert.ok(discordNames.includes('Admin Roster Name'), 'falls back to the roster name');
    assert.ok(!discordNames.includes('Just A Member'), 'a plain member is never listed');
    assert.ok(
      !discordNames.some((n) => n.length === 0),
      'an admin with no resolvable name anywhere is omitted, not rendered blank',
    );
    assert.equal(discordNames.length, discordNames.filter((n) => n.trim().length > 0).length);
    assert.ok(!discordNames.includes('WhatsApp Admin'), 'query is platform-scoped');

    const whatsappNames = await listAdminDisplayNames('whatsapp');
    assert.ok(whatsappNames.includes('WhatsApp Admin'));
    assert.ok(!whatsappNames.includes('Admin Own Name'));

    await pool.query(`DELETE FROM community_users WHERE platform_user_id = ANY($1)`, [
      [adminWithOwnName, adminFromRoster, adminNoName, member, otherPlatformAdmin],
    ]);
    await pool.query(`DELETE FROM server_roster WHERE platform = 'discord' AND user_id = $1`, [
      adminFromRoster,
    ]);
  },
);

test(
  'listAdminDisplayNames: deterministically ordered (stable across repeat calls), independent of insertion race',
  { skip },
  async () => {
    const first = `${RUN}-lad-order-1`;
    const second = `${RUN}-lad-order-2`;
    const third = `${RUN}-lad-order-3`;
    await upsertMember({
      platform: 'discord',
      userId: first,
      role: 'admin',
      addedBy: `${RUN}-actor`,
      displayName: `${RUN} Ordered One`,
    });
    await upsertMember({
      platform: 'discord',
      userId: second,
      role: 'admin',
      addedBy: `${RUN}-actor`,
      displayName: `${RUN} Ordered Two`,
    });
    await upsertMember({
      platform: 'discord',
      userId: third,
      role: 'admin',
      addedBy: `${RUN}-actor`,
      displayName: `${RUN} Ordered Three`,
    });

    const callA = (await listAdminDisplayNames('discord')).filter((n) => n.startsWith(RUN));
    const callB = (await listAdminDisplayNames('discord')).filter((n) => n.startsWith(RUN));
    assert.deepEqual(callA, callB, 'repeat calls return the same order — no nondeterministic shuffling');
    assert.deepEqual(
      callA,
      [`${RUN} Ordered One`, `${RUN} Ordered Two`, `${RUN} Ordered Three`],
      'ordered by insertion (community_users.id), matching creation order',
    );

    await pool.query(`DELETE FROM community_users WHERE platform_user_id = ANY($1)`, [
      [first, second, third],
    ]);
  },
);

test(
  'SECURITY: listAdminDisplayNames returns bare display-name strings only — never platform_user_id, added_by, or any other column, and is parameterised on platform alone',
  { skip },
  async () => {
    const adminId = `${RUN}-lad-sec-admin`;
    await upsertMember({
      platform: 'discord',
      userId: adminId,
      role: 'admin',
      addedBy: `${RUN}-sec-actor`,
      displayName: `${RUN} Security Admin`,
    });

    const names = await listAdminDisplayNames('discord');
    const mine = names.filter((n) => n.startsWith(RUN));
    assert.equal(mine.length, 1);
    assert.equal(typeof mine[0], 'string', 'each entry is a bare string, never an object with extra columns');
    assert.ok(!mine[0].includes(adminId), 'the raw platform_user_id never leaks into the resolved name');
    assert.ok(!mine[0].includes(`${RUN}-sec-actor`), 'added_by never leaks into the resolved name');

    // The function signature takes only `platform` — there is no parameter
    // through which caller-supplied (guest) message content could steer
    // which names are returned; two calls with the same platform always see
    // the same server-side-sourced rows.
    assert.deepEqual(await listAdminDisplayNames('discord'), names);

    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
  },
);

test(
  'listAdminRoster: resolves community_users->server_roster names across both platforms, excludes members, deterministically ordered by community_users.id (issue #428)',
  { skip },
  async () => {
    const adminOwnName = `${RUN}-lar-admin-own`;
    const adminRosterName = `${RUN}-lar-admin-roster`;
    const member = `${RUN}-lar-member`;
    const whatsappAdmin = `${RUN}-lar-admin-whatsapp`;

    await upsertMember({
      platform: 'discord',
      userId: adminOwnName,
      role: 'admin',
      addedBy: `${RUN}-actor`,
      displayName: `${RUN} Roster Own Name`,
    });
    await pool.query(
      `INSERT INTO server_roster (platform, user_id, display_name) VALUES ('discord', $1, $2)`,
      [adminRosterName, `${RUN} Roster Fallback Name`],
    );
    await upsertMember({
      platform: 'discord',
      userId: adminRosterName,
      role: 'admin',
      addedBy: `${RUN}-actor`,
    });
    await upsertMember({
      platform: 'discord',
      userId: member,
      role: 'member',
      addedBy: `${RUN}-actor`,
      displayName: `${RUN} Just A Member`,
    });
    await upsertMember({
      platform: 'whatsapp',
      userId: whatsappAdmin,
      role: 'admin',
      addedBy: `${RUN}-actor`,
      displayName: `${RUN} WhatsApp Admin`,
    });

    const roster = await listAdminRoster();
    const mine = roster.filter((a) => a.platformUserId.startsWith(RUN));

    assert.deepEqual(
      mine.map((a) => ({ platform: a.platform, name: a.displayName })),
      [
        { platform: 'discord', name: `${RUN} Roster Own Name` },
        { platform: 'discord', name: `${RUN} Roster Fallback Name` },
        { platform: 'whatsapp', name: `${RUN} WhatsApp Admin` },
      ],
      'community_users own name wins, falls back to server_roster, ordered by community_users.id, spans both platforms',
    );
    assert.ok(
      !mine.some((a) => a.platformUserId === member),
      'a plain member is never returned by listAdminRoster',
    );

    await pool.query(`DELETE FROM community_users WHERE platform_user_id = ANY($1)`, [
      [adminOwnName, adminRosterName, member, whatsappAdmin],
    ]);
    await pool.query(`DELETE FROM server_roster WHERE platform = 'discord' AND user_id = $1`, [
      adminRosterName,
    ]);
  },
);

test(
  'SECURITY: listAdminRoster flags leftServer true only when server_roster.left_at is set — a missing roster row or left_at IS NULL both read as false (issue #428, the departed-but-still-admin visibility gap)',
  { skip },
  async () => {
    const departedAdmin = `${RUN}-lar-sec-departed`;
    const presentAdmin = `${RUN}-lar-sec-present`;
    const noRosterAdmin = `${RUN}-lar-sec-noroster`;

    await pool.query(
      `INSERT INTO server_roster (platform, user_id, display_name) VALUES ('discord', $1, $2)`,
      [departedAdmin, `${RUN} Departed Admin`],
    );
    await upsertMember({
      platform: 'discord',
      userId: departedAdmin,
      role: 'admin',
      addedBy: `${RUN}-actor`,
    });
    // onGuildMemberRemove calls markRosterLeave but never touches
    // community_users.role — this is exactly the gap #428 surfaces.
    const left = await markRosterLeave('discord', departedAdmin);
    assert.ok(left, 'fixture setup: markRosterLeave must actually flip left_at');

    await pool.query(
      `INSERT INTO server_roster (platform, user_id, display_name) VALUES ('discord', $1, $2)`,
      [presentAdmin, `${RUN} Present Admin`],
    );
    await upsertMember({
      platform: 'discord',
      userId: presentAdmin,
      role: 'admin',
      addedBy: `${RUN}-actor`,
    });

    // No server_roster row at all — never observed leaving.
    await upsertMember({
      platform: 'discord',
      userId: noRosterAdmin,
      role: 'admin',
      addedBy: `${RUN}-actor`,
      displayName: `${RUN} No Roster Admin`,
    });

    const roster = await listAdminRoster();
    const byId = (id: string) => roster.find((a) => a.platformUserId === id);

    assert.equal(byId(departedAdmin)?.leftServer, true, 'left_at set must flag leftServer: true');
    assert.equal(byId(presentAdmin)?.leftServer, false, 'left_at IS NULL must flag leftServer: false');
    assert.equal(
      byId(noRosterAdmin)?.leftServer,
      false,
      'no matching roster row must flag leftServer: false',
    );

    await pool.query(`DELETE FROM community_users WHERE platform_user_id = ANY($1)`, [
      [departedAdmin, presentAdmin, noRosterAdmin],
    ]);
    await pool.query(`DELETE FROM server_roster WHERE platform = 'discord' AND user_id = ANY($1)`, [
      [departedAdmin, presentAdmin],
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
  'repository: createAnswerFeedback normalizes an optional comment (control-char-stripped, truncated to 200 ' +
    'chars) and stores NULL for an omitted or whitespace-only comment (issue #354)',
  { skip },
  async () => {
    const userId = `${RUN}-rate-answer-comment-user`;
    const conversationId = `${RUN}-c-rate-answer-comment`;

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'the answer to comment on',
      meta: { replyToUserId: userId },
    });

    const overlong = 'x'.repeat(250);
    const feedbackId = expectFeedbackId(
      await createAnswerFeedback({
        platform: 'discord',
        conversationId,
        userId,
        helpful: false,
        comment: `wrong pricing\r\n${overlong}`,
      }),
    );

    const listed = await listAnswerFeedback([conversationId]);
    const row = listed.find((r) => r.id === feedbackId);
    assert.ok(row, 'the rating is visible via listAnswerFeedback');
    assert.equal(row.comment?.length, 200, 'the stored comment is truncated to the 200-char cap');
    assert.doesNotMatch(row.comment ?? '', /[\r\n]/, 'control characters are stripped before storage');
    assert.match(row.comment ?? '', /^wrong pricing/, 'the leading, non-truncated text survives verbatim');

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);

    const noCommentUser = `${RUN}-rate-answer-no-comment-user`;
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'another answer',
      meta: { replyToUserId: noCommentUser },
    });
    const noCommentId = expectFeedbackId(
      await createAnswerFeedback({
        platform: 'discord',
        conversationId,
        userId: noCommentUser,
        helpful: true,
        comment: '   ',
      }),
    );
    const listedNoComment = await listAnswerFeedback([conversationId]);
    const noCommentRow = listedNoComment.find((r) => r.id === noCommentId);
    assert.ok(noCommentRow);
    assert.equal(noCommentRow.comment, null, 'a whitespace-only comment stores NULL, not an empty string');

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = $1`, [noCommentUser]);
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

// Per-(interaction, rater) dedup (issue #619): before this fix, a member
// calling rate_answer twice on the same bot reply inserted two rows,
// inflating every downstream count and bypassing the >= 2 low-rated-caveat
// floor tested separately below.
test(
  'repository: createAnswerFeedback dedups repeated ratings from the same rater on the same interaction via ON CONFLICT DO UPDATE, converges concurrent writes to one row, and still inserts independently for a NEW interaction (issue #619)',
  { skip },
  async () => {
    const userId = `${RUN}-rate-answer-dedup-user`;
    const conversationId = `${RUN}-c-rate-answer-dedup`;

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'first answer',
      meta: { replyToUserId: userId },
    });

    const firstId = expectFeedbackId(
      await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: true }),
    );
    const secondId = expectFeedbackId(
      await createAnswerFeedback({
        platform: 'discord',
        conversationId,
        userId,
        helpful: false,
        comment: 'changed my mind',
      }),
    );
    assert.equal(
      secondId,
      firstId,
      'a second rating on the same interaction updates the SAME row (same id), not a new one',
    );

    const rowsForFirst = await pool.query(`SELECT helpful, comment FROM answer_feedback WHERE user_id = $1`, [
      userId,
    ]);
    assert.equal(rowsForFirst.rows.length, 1, 'exactly one row exists for this (interaction, rater) pair');
    assert.equal(rowsForFirst.rows[0].helpful, false, "the row's helpful flag reflects the LATEST verdict");
    assert.equal(
      rowsForFirst.rows[0].comment,
      'changed my mind',
      "the row's comment reflects the LATEST verdict",
    );

    // Two near-simultaneous writes for the same (interaction, rater) pair
    // must still converge to exactly one row (a check-then-act race would
    // risk a duplicate; ON CONFLICT DO UPDATE is atomic at the row level).
    const [concurrentA, concurrentB] = await Promise.all([
      createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: true }),
      createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: false }),
    ]);
    expectFeedbackId(concurrentA, 'concurrent write A should still succeed');
    expectFeedbackId(concurrentB, 'concurrent write B should still succeed');
    const rowsAfterConcurrent = await pool.query(
      `SELECT count(*) AS n FROM answer_feedback WHERE user_id = $1`,
      [userId],
    );
    assert.equal(
      Number(rowsAfterConcurrent.rows[0].n),
      1,
      'two near-simultaneous writes on the same (interaction, rater) pair still converge to exactly one row',
    );

    // A NEW outbound reply means a NEW interaction_id — a rating against it
    // must insert independently (dedup is per-answer, not per-rater-globally).
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'second, different answer',
      meta: { replyToUserId: userId },
    });
    const thirdId = expectFeedbackId(
      await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: true }),
    );
    assert.notEqual(thirdId, firstId, 'a rating on a NEW interaction inserts a new, independent row');

    const totalRows = await pool.query(`SELECT count(*) AS n FROM answer_feedback WHERE user_id = $1`, [
      userId,
    ]);
    assert.equal(
      Number(totalRows.rows[0].n),
      2,
      'one row per distinct interaction, not per rate_answer call',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  'SECURITY: repository: one rater double-tapping rate_answer(helpful:false) on the same answer cannot alone cross isKnowledgeLowRated/areKnowledgeEntriesLowRated\'s >= 2 "more than one identifiable rater" floor (issue #619)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-low-rated-single-rater`;
    const { id: entryId } = await saveKnowledge({ content: `${RUN} single-rater low-rated entry content` });
    const soleRater = `${RUN}-low-rated-sole-rater`;

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'shortcut answer for sole rater',
      meta: { replyToUserId: soleRater, knowledgeShortcut: true, knowledgeEntryId: entryId },
    });

    expectFeedbackId(
      await createAnswerFeedback({ platform: 'discord', conversationId, userId: soleRater, helpful: false }),
    );
    // A second 👎 tap from the SAME rater on the SAME answer, before any new
    // bot reply — must dedup to the same row (see the dedup test above), not
    // add a second "identifiable person's opinion".
    expectFeedbackId(
      await createAnswerFeedback({ platform: 'discord', conversationId, userId: soleRater, helpful: false }),
    );

    const rowCount = await pool.query(`SELECT count(*) AS n FROM answer_feedback WHERE user_id = $1`, [
      soleRater,
    ]);
    assert.equal(Number(rowCount.rows[0].n), 1, 'one rater tapping twice yields exactly one row, not two');

    const single = await isKnowledgeLowRated(entryId, 2);
    assert.equal(
      single,
      false,
      'SECURITY: one rater tapping unhelpful twice must NOT cross the >= 2 floor alone — the floor exists ' +
        'specifically so no single identifiable rater can trigger it',
    );
    const batched = await areKnowledgeEntriesLowRated([entryId], 2);
    assert.deepEqual(
      batched,
      new Set(),
      'SECURITY: the batched sibling must agree — one rater alone must not cross the threshold',
    );

    // A genuinely SECOND, distinct rater tapping unhelpful now legitimately
    // crosses the floor — proving this isn't permanently stuck at zero.
    const secondRater = `${RUN}-low-rated-second-rater`;
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: 'shortcut answer for second rater',
      meta: { replyToUserId: secondRater, knowledgeShortcut: true, knowledgeEntryId: entryId },
    });
    expectFeedbackId(
      await createAnswerFeedback({
        platform: 'discord',
        conversationId,
        userId: secondRater,
        helpful: false,
      }),
    );
    const withSecondRater = await isKnowledgeLowRated(entryId, 2);
    assert.equal(
      withSecondRater,
      true,
      'a genuinely SECOND distinct rater legitimately crosses the >= 2 floor',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [[soleRater, secondRater]]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [entryId]);
  },
);

test(
  "repository: schema.sql's answer_feedback dedup DELETE removes pre-existing duplicate (interaction_id, " +
    'user_id) rows — keeping the most recent — before the partial unique index statement runs, so redeploying ' +
    "against a production DB that already has the pre-fix double-tap bug's duplicates (issue #619) succeeds " +
    'instead of failing on a duplicate-key error',
  { skip },
  async () => {
    // Exercised against a connection-private TEMP TABLE, not the real
    // shared `answer_feedback` table: dropping the live production unique
    // index to simulate a pre-migration DB would race with every OTHER
    // test file's concurrent createAnswerFeedback calls (Node's test
    // runner runs files in parallel), risking spurious "no unique or
    // exclusion constraint matching ON CONFLICT" failures elsewhere in the
    // suite. A temp table is invisible to every other session, so this
    // reproduces the exact statements from schema.sql with zero blast
    // radius on concurrently-running tests.
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TEMP TABLE answer_feedback_dedup_fixture (
          id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          interaction_id BIGINT,
          user_id        TEXT NOT NULL,
          helpful        BOOLEAN NOT NULL
        )
      `);

      // Simulate a production DB that predates this migration: two
      // duplicate rows for the same (interaction_id, user_id) pair, exactly
      // what the pre-fix double-tap bug could already have left behind.
      const { rows: dupRows } = await client.query(`
        INSERT INTO answer_feedback_dedup_fixture (interaction_id, user_id, helpful) VALUES
          (42, 'legacy-rater', true),
          (42, 'legacy-rater', false)
        RETURNING id, helpful
      `);
      assert.equal(
        dupRows.length,
        2,
        'both legacy duplicate rows insert cleanly with no unique index present',
      );
      const newerRowId = Number(dupRows.find((r) => r.helpful === false)?.id);

      // The exact dedup statement from schema.sql: keep the highest-id
      // (most recent) row per (interaction_id, user_id), drop the rest.
      await client.query(`
        DELETE FROM answer_feedback_dedup_fixture a USING answer_feedback_dedup_fixture b
         WHERE a.interaction_id IS NOT NULL
           AND a.interaction_id = b.interaction_id
           AND a.user_id = b.user_id
           AND a.id < b.id
      `);

      // The exact unique index statement from schema.sql must now succeed
      // against the de-duped data, not fail with a duplicate-key error.
      await assert.doesNotReject(
        client.query(
          `CREATE UNIQUE INDEX ON answer_feedback_dedup_fixture (interaction_id, user_id) WHERE interaction_id IS NOT NULL`,
        ),
        'the unique index must be creatable after the dedup DELETE runs, even though duplicates pre-existed',
      );

      const { rows: survivingRows } = await client.query(
        `SELECT id, helpful FROM answer_feedback_dedup_fixture`,
      );
      assert.equal(survivingRows.length, 1, 'exactly one row survives the de-dup');
      assert.equal(
        Number(survivingRows[0].id),
        newerRowId,
        'the surviving row is the most recent (highest id) one',
      );
      assert.equal(
        survivingRows[0].helpful,
        false,
        "the surviving row's data matches the most recent duplicate",
      );
    } finally {
      await client.query(`DROP TABLE IF EXISTS answer_feedback_dedup_fixture`);
      client.release();
    }
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

test(
  "SECURITY: repository: listAnswerFeedback's raw per-rating output is unchanged by an intervening update_knowledge call on the rated entry — the aggregate-only #540 reset never reaches the raw audit log (issue #540)",
  { skip },
  async () => {
    const conversationId = `${RUN}-c-feedback-list-unchanged-by-edit`;
    const { id: entryId } = await saveKnowledge({ content: `${RUN} raw-audit entry content` });
    const userId = `${RUN}-feedback-list-unchanged-user`;

    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      role: 'member',
      direction: 'outbound',
      content: `shortcut answer for ${userId}`,
      meta: { replyToUserId: userId, knowledgeShortcut: true, knowledgeEntryId: entryId },
    });
    const feedbackId = expectFeedbackId(
      await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: false }),
    );

    const beforeEdit = await listAnswerFeedback([conversationId]);
    const beforeRow = beforeEdit.find((r) => r.id === feedbackId);
    assert.ok(beforeRow, 'the raw rating is visible before the edit');

    const updated = await updateKnowledge({ id: entryId, content: `${RUN} raw-audit entry content, fixed` });
    assert.ok(updated.updated, 'update applied');

    const afterEdit = await listAnswerFeedback([conversationId]);
    const afterRow = afterEdit.find((r) => r.id === feedbackId);
    assert.ok(
      afterRow,
      'SECURITY: the raw audit row must still be present after an intervening update_knowledge call — only the aggregate views (listKnowledgeFeedbackSummary/isKnowledgeLowRated/areKnowledgeEntriesLowRated/countLowRatedKnowledge) apply the post-edit time filter, never the raw audit log',
    );
    assert.deepEqual(
      afterRow,
      beforeRow,
      'the raw row is byte-identical before and after the edit — listAnswerFeedback is unaffected by knowledge.updated_at entirely',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [entryId]);
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

// Issue #540: fixing a flagged entry (update_knowledge) must clear the
// low-rated signal it earned under its old content, and a new run of
// post-edit unhelpful ratings must be able to flag it again — a reset, not a
// permanent suppression.
test(
  'repository: listKnowledgeFeedbackSummary drops an edited entry once its only unhelpful ratings predate the edit, and re-includes it once new unhelpful ratings arrive afterward (issue #540)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-knowledge-feedback-summary-reset`;
    const { id: entryId } = await saveKnowledge({
      content: `${RUN} reset entry content`,
      title: `${RUN} reset entry`,
    });

    async function rateShortcut(userSuffix: string, helpful: boolean) {
      const userId = `${RUN}-summary-reset-${userSuffix}`;
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
    users.push(await rateShortcut('pre-1', false));
    users.push(await rateShortcut('pre-2', false));

    const beforeEdit = await listKnowledgeFeedbackSummary([conversationId]);
    assert.ok(
      beforeEdit.some((s) => s.knowledgeEntryId === entryId && s.unhelpfulCount === 2),
      'the entry is flagged before any edit, with both pre-edit ratings counted',
    );

    const updated = await updateKnowledge({ id: entryId, content: `${RUN} reset entry content, fixed` });
    assert.ok(updated.updated, 'update applied');

    const afterEdit = await listKnowledgeFeedbackSummary([conversationId]);
    assert.ok(
      !afterEdit.some((s) => s.knowledgeEntryId === entryId),
      'the fixed entry with no post-edit ratings no longer appears in the summary at all',
    );

    users.push(await rateShortcut('post-1', false));
    users.push(await rateShortcut('post-2', false));

    const afterNewRatings = await listKnowledgeFeedbackSummary([conversationId]);
    const reflagged = afterNewRatings.find((s) => s.knowledgeEntryId === entryId);
    assert.ok(reflagged, 'the entry is flagged again once it accumulates new unhelpful ratings post-edit');
    assert.equal(
      reflagged?.unhelpfulCount,
      2,
      'only the 2 post-edit ratings are counted, not the 2 pre-edit ones — proving a reset, not a permanent suppression',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [entryId]);
  },
);

// End-to-end aggregation for issue #411's normal (non-shortcut) knowledge_search
// path: before #411, only sendKnowledgeShortcut ever stamped meta.knowledgeEntryId,
// so an unhelpfully-rated answer served via the model-mediated knowledge_search
// tool was structurally invisible to this aggregation no matter how it was
// rated. The fix is entirely in what router.ts/core.ts/tools.ts WRITE to
// meta — this query and its JOIN/WHERE clause are unchanged (the proposal's
// whole point) — so this test proves that reach by recording an outbound
// interaction with knowledgeEntryId set but WITHOUT knowledgeShortcut: true
// (the shape the new normal-path recording now produces) and confirming it
// is aggregated exactly like a shortcut-served one.
test(
  'repository: listKnowledgeFeedbackSummary / list_low_rated_knowledge now aggregate an unhelpfully-rated answer served via the normal (non-shortcut) knowledge_search path (issue #411, acceptance criterion 4)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-knowledge-feedback-normal-path`;
    const { id: entryId } = await saveKnowledge({
      content: `${RUN} normal-path entry content`,
      title: `${RUN} normal-path entry`,
    });

    async function rateNormalPath(userSuffix: string, helpful: boolean) {
      const userId = `${RUN}-normal-path-${userSuffix}`;
      // The shape the router's normal outbound-recording path now produces
      // (router.ts): knowledgeEntryId present, but no knowledgeShortcut flag
      // at all — this is what distinguishes it from sendKnowledgeShortcut's
      // meta and from a pre-#411 plain reply that carried neither.
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `model-mediated answer for ${userId}`,
        meta: { replyToUserId: userId, knowledgeEntryId: entryId },
      });
      expectFeedbackId(await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful }));
      return userId;
    }

    const users = [
      await rateNormalPath('u1', false),
      await rateNormalPath('u2', false),
      await rateNormalPath('u3', true),
    ];

    const summary = await listKnowledgeFeedbackSummary([conversationId]);
    const row = summary.find((s) => s.knowledgeEntryId === entryId);
    assert.ok(
      row,
      'an entry whose only ratings came via the normal knowledge_search path must now be aggregated',
    );
    assert.equal(row?.unhelpfulCount, 2);
    assert.equal(row?.helpfulCount, 1);

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [entryId]);
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

// sampleComment (issue #409): the most recent comment from an *unhelpful*
// rating on the entry, surfaced by listKnowledgeFeedbackSummary so an admin
// sees WHY without switching to list_answer_feedback's raw per-rating list.
test(
  'repository: listKnowledgeFeedbackSummary.sampleComment picks the most recent non-null comment from an unhelpful rating, or null when none exists',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-knowledge-feedback-sample-comment`;
    const { id: commentedEntryId } = await saveKnowledge({
      content: `${RUN} commented entry content`,
      title: `${RUN} commented entry`,
    });
    const { id: uncommentedEntryId } = await saveKnowledge({
      content: `${RUN} uncommented entry content`,
      title: `${RUN} uncommented entry`,
    });

    async function rateShortcut(entryId: number, userSuffix: string, helpful: boolean, comment?: string) {
      const userId = `${RUN}-sample-comment-${userSuffix}`;
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
        await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful, comment }),
      );
      return userId;
    }

    const users: string[] = [];
    // Older unhelpful rating with a comment, then a newer unhelpful rating
    // with a different comment — the newer one must win.
    users.push(await rateShortcut(commentedEntryId, 'older', false, 'older complaint'));
    users.push(await rateShortcut(commentedEntryId, 'newer', false, 'newer complaint'));
    // No comment at all on this entry's ratings -> sampleComment stays null.
    users.push(await rateShortcut(uncommentedEntryId, 'u1', false));
    users.push(await rateShortcut(uncommentedEntryId, 'u2', false));

    const summary = await listKnowledgeFeedbackSummary([conversationId], 2);
    const commentedRow = summary.find((s) => s.knowledgeEntryId === commentedEntryId);
    assert.equal(commentedRow?.sampleComment, 'newer complaint', 'the most recent comment wins');

    const uncommentedRow = summary.find((s) => s.knowledgeEntryId === uncommentedEntryId);
    assert.equal(uncommentedRow?.sampleComment, null, 'null when no unhelpful rating carries a comment');

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[commentedEntryId, uncommentedEntryId]]);
  },
);

test(
  'repository: listKnowledgeFeedbackSummary.sampleComment never selects a comment left on a helpful rating',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-knowledge-feedback-sample-comment-helpful`;
    const { id: mixedEntryId } = await saveKnowledge({
      content: `${RUN} mixed entry content`,
      title: `${RUN} mixed entry`,
    });
    const { id: onlyHelpfulEntryId } = await saveKnowledge({
      content: `${RUN} only-helpful entry content`,
      title: `${RUN} only-helpful entry`,
    });

    async function rateShortcut(entryId: number, userSuffix: string, helpful: boolean, comment?: string) {
      const userId = `${RUN}-sample-comment-helpful-${userSuffix}`;
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
        await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful, comment }),
      );
      return userId;
    }

    const users: string[] = [];
    // mixedEntry: a helpful rating with a comment, then two unhelpful ratings
    // (one commented, one not) — the helpful comment must never be selected.
    users.push(await rateShortcut(mixedEntryId, 'helpful', true, 'this was great'));
    users.push(await rateShortcut(mixedEntryId, 'unhelpful-plain', false));
    users.push(await rateShortcut(mixedEntryId, 'unhelpful-commented', false, 'unhelpful reason'));
    // onlyHelpfulEntry: two unhelpful ratings (clearing the threshold) plus a
    // helpful rating that carries the ONLY comment on the entry -> null.
    users.push(await rateShortcut(onlyHelpfulEntryId, 'u1', false));
    users.push(await rateShortcut(onlyHelpfulEntryId, 'u2', false));
    users.push(await rateShortcut(onlyHelpfulEntryId, 'helpful-only-comment', true, 'glad it worked'));

    const summary = await listKnowledgeFeedbackSummary([conversationId], 2);
    const mixedRow = summary.find((s) => s.knowledgeEntryId === mixedEntryId);
    assert.equal(
      mixedRow?.sampleComment,
      'unhelpful reason',
      'the unhelpful comment is selected even though a helpful comment exists',
    );

    const onlyHelpfulRow = summary.find((s) => s.knowledgeEntryId === onlyHelpfulEntryId);
    assert.equal(
      onlyHelpfulRow?.sampleComment,
      null,
      'a comment on a helpful rating is never selected, even when it is the only comment on the entry',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[mixedEntryId, onlyHelpfulEntryId]]);
  },
);

test(
  'SECURITY: repository: listKnowledgeFeedbackSummary.sampleComment never surfaces a comment from a conversation outside the calling scope, even when the entry itself still lists via in-scope ratings',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-knowledge-feedback-sample-comment-scope-in`;
    const outOfScopeConvo = `${RUN}-c-knowledge-feedback-sample-comment-scope-out`;
    const { id: entryId } = await saveKnowledge({ content: `${RUN} scope-comment entry content` });

    async function rateShortcut(conversationId: string, userSuffix: string, comment?: string) {
      const userId = `${RUN}-sample-comment-scope-${userSuffix}`;
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
        await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: false, comment }),
      );
      return userId;
    }

    const inScopeUsers = [await rateShortcut(inScopeConvo, 'in-1', 'in-scope complaint')];
    const outOfScopeUsers = [
      // Recorded AFTER the in-scope rating, so a naive "most recent" pick
      // with no scope filter would wrongly select this one.
      await rateShortcut(outOfScopeConvo, 'out-1', 'out-of-scope complaint'),
    ];

    const scoped = await listKnowledgeFeedbackSummary([inScopeConvo], 1);
    const scopedRow = scoped.find((s) => s.knowledgeEntryId === entryId);
    assert.ok(scopedRow, 'the entry still lists from its in-scope unhelpful rating');
    assert.equal(
      scopedRow?.sampleComment,
      'in-scope complaint',
      'SECURITY: the out-of-scope comment never surfaces, even though it is the more recent rating',
    );

    const unscoped = await listKnowledgeFeedbackSummary(null, 1);
    const unscopedRow = unscoped.find((s) => s.knowledgeEntryId === entryId);
    assert.equal(
      unscopedRow?.sampleComment,
      'out-of-scope complaint',
      'a null (super admin) scope may see the more recent comment across all conversations',
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
  'SECURITY: repository: isKnowledgeLowRated resets after update_knowledge and re-flags once new unhelpful ratings arrive post-edit, still crossing the boundary as a boolean only (issue #540)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-low-rated-reset`;
    const { id: entryId } = await saveKnowledge({ content: `${RUN} low-rated reset entry content` });

    async function rateShortcut(userSuffix: string, helpful: boolean) {
      const userId = `${RUN}-low-rated-reset-${userSuffix}`;
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
    users.push(await rateShortcut('pre-1', false));
    users.push(await rateShortcut('pre-2', false));

    const beforeEdit = await isKnowledgeLowRated(entryId, 2);
    assert.equal(
      typeof beforeEdit,
      'boolean',
      'SECURITY: must cross the boundary as a boolean, never a number',
    );
    assert.equal(beforeEdit, true, 'the entry is low-rated before any edit');

    const updated = await updateKnowledge({
      id: entryId,
      content: `${RUN} low-rated reset entry content, fixed`,
    });
    assert.ok(updated.updated, 'update applied');

    const afterEdit = await isKnowledgeLowRated(entryId, 2);
    assert.equal(typeof afterEdit, 'boolean');
    assert.equal(
      afterEdit,
      false,
      'fixing the entry resets the low-rated flag when no ratings have arrived since',
    );

    users.push(await rateShortcut('post-1', false));
    users.push(await rateShortcut('post-2', false));

    const afterNewRatings = await isKnowledgeLowRated(entryId, 2);
    assert.equal(typeof afterNewRatings, 'boolean');
    assert.equal(
      afterNewRatings,
      true,
      'the entry is flagged again once it accumulates new unhelpful ratings post-edit — proving a reset, not a permanent suppression',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [entryId]);
  },
);

// areKnowledgeEntriesLowRated (issue #432): the batched sibling of
// isKnowledgeLowRated above, feeding the display-side caveat on the normal
// knowledge_search path (as opposed to isKnowledgeLowRated's shortcut-only
// caller). Same join/threshold semantics, extended to ≥3 entries straddling
// the threshold in one call.
test(
  'SECURITY: repository: areKnowledgeEntriesLowRated returns exactly the subset of ids whose unhelpful count clears the threshold, never a raw count, and short-circuits an empty input without a query',
  { skip },
  async () => {
    const convoA = `${RUN}-c-batch-low-rated-a`;
    const convoB = `${RUN}-c-batch-low-rated-b`;
    const { id: lowRatedEntryId } = await saveKnowledge({ content: `${RUN} batch low-rated entry` });
    const { id: belowThresholdEntryId } = await saveKnowledge({
      content: `${RUN} batch below-threshold entry`,
    });
    const { id: unratedEntryId } = await saveKnowledge({ content: `${RUN} batch unrated entry` });

    async function rate(conversationId: string, entryId: number, userSuffix: string, helpful: boolean) {
      const userId = `${RUN}-batch-low-rated-${userSuffix}`;
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `knowledge_search answer for ${userId}`,
        meta: { knowledgeEntryId: entryId },
      });
      expectFeedbackId(await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful }));
      return userId;
    }

    const users: string[] = [];
    // lowRatedEntryId: 2 unhelpful across two conversations — clears a
    // threshold of 2.
    users.push(await rate(convoA, lowRatedEntryId, 'a1', false));
    users.push(await rate(convoB, lowRatedEntryId, 'b1', false));
    // belowThresholdEntryId: only 1 unhelpful — never clears a threshold of 2.
    users.push(await rate(convoA, belowThresholdEntryId, 'a2', false));
    // unratedEntryId: no feedback at all.

    const neverServedEntryId = unratedEntryId + 1_000_000;

    const result = await areKnowledgeEntriesLowRated(
      [lowRatedEntryId, belowThresholdEntryId, unratedEntryId, neverServedEntryId],
      2,
    );
    assert.ok(
      result instanceof Set,
      'SECURITY: must cross the boundary as a Set of ids, never a count or map',
    );
    assert.deepEqual(
      [...result].sort((a, b) => a - b),
      [lowRatedEntryId].sort((a, b) => a - b),
      'only the id whose unhelpful count clears the threshold is present; below-threshold, unrated, and never-served ids are absent',
    );

    const emptyResult = await areKnowledgeEntriesLowRated([], 2);
    assert.deepEqual(emptyResult, new Set(), 'an empty ids array returns an empty set');

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [[convoA, convoB]]);
    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [
      [lowRatedEntryId, belowThresholdEntryId, unratedEntryId],
    ]);
  },
);

test(
  'SECURITY: repository: areKnowledgeEntriesLowRated drops an edited entry from the returned set once its only unhelpful ratings predate the edit, and re-includes it once new ratings arrive post-edit, still returning only an id Set (issue #540)',
  { skip },
  async () => {
    const convoA = `${RUN}-c-batch-low-rated-reset-a`;
    const convoB = `${RUN}-c-batch-low-rated-reset-b`;
    const { id: entryId } = await saveKnowledge({ content: `${RUN} batch reset entry content` });
    const { id: siblingEntryId } = await saveKnowledge({
      content: `${RUN} batch reset sibling entry content`,
    });

    async function rate(conversationId: string, targetEntryId: number, userSuffix: string, helpful: boolean) {
      const userId = `${RUN}-batch-low-rated-reset-${userSuffix}`;
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `knowledge_search answer for ${userId}`,
        meta: { knowledgeEntryId: targetEntryId },
      });
      expectFeedbackId(await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful }));
      return userId;
    }

    const users: string[] = [];
    users.push(await rate(convoA, entryId, 'pre-1', false));
    users.push(await rate(convoB, entryId, 'pre-2', false));
    // siblingEntryId is never edited and only ever gets 1 unhelpful rating —
    // stays below threshold throughout, proving the returned set doesn't
    // leak an unrelated id.
    users.push(await rate(convoA, siblingEntryId, 'sib-1', false));

    const beforeEdit = await areKnowledgeEntriesLowRated([entryId, siblingEntryId], 2);
    assert.ok(
      beforeEdit instanceof Set,
      'SECURITY: must cross the boundary as a Set of ids, never a count or map',
    );
    assert.deepEqual(
      [...beforeEdit].sort((a, b) => a - b),
      [entryId],
      'entryId clears the threshold before any edit; siblingEntryId (1 unhelpful) does not',
    );

    const updated = await updateKnowledge({
      id: entryId,
      content: `${RUN} batch reset entry content, fixed`,
    });
    assert.ok(updated.updated, 'update applied');

    const afterEdit = await areKnowledgeEntriesLowRated([entryId, siblingEntryId], 2);
    assert.deepEqual(
      [...afterEdit],
      [],
      'the fixed entry with no post-edit ratings drops out of the low-rated set entirely',
    );

    users.push(await rate(convoA, entryId, 'post-1', false));
    users.push(await rate(convoB, entryId, 'post-2', false));

    const afterNewRatings = await areKnowledgeEntriesLowRated([entryId, siblingEntryId], 2);
    assert.deepEqual(
      [...afterNewRatings].sort((a, b) => a - b),
      [entryId],
      'the entry re-enters the low-rated set once new unhelpful ratings arrive post-edit — proving a reset, not a permanent suppression',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [[convoA, convoB]]);
    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[entryId, siblingEntryId]]);
  },
);

// countLowRatedKnowledge (issue #324): a true COUNT(DISTINCT) complement to
// listKnowledgeFeedbackSummary, for the weekly admin digest.
test(
  "repository: countLowRatedKnowledge returns a true count of distinct low-rated entries beyond list_low_rated_knowledge's own default limit of 20, and never counts ratings on non-shortcut-served answers or below-threshold entries",
  { skip },
  async () => {
    const conversationId = `${RUN}-c-low-rated-count`;
    const entryIds: number[] = [];
    const users: string[] = [];

    async function rateShortcut(entryId: number, userSuffix: string, helpful: boolean) {
      const userId = `${RUN}-lowrated-${userSuffix}`;
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

    // 21 distinct entries, each with 2 unhelpful ratings — one past
    // list_low_rated_knowledge's own default limit of 20, proving the count
    // is a true SELECT count(DISTINCT ...), not `.length` of that
    // LIMIT-bounded list.
    for (let i = 0; i < 21; i++) {
      const { id } = await saveKnowledge({ content: `${RUN} low-rated entry ${i} content` });
      entryIds.push(id);
      users.push(await rateShortcut(id, `e${i}-u1`, false));
      users.push(await rateShortcut(id, `e${i}-u2`, false));
    }
    // One entry with only 1 unhelpful rating — below the default threshold
    // of 2, must not be counted.
    const { id: belowThresholdId } = await saveKnowledge({ content: `${RUN} below-threshold entry content` });
    entryIds.push(belowThresholdId);
    users.push(await rateShortcut(belowThresholdId, 'below-u1', false));

    // Non-shortcut-served rating: must never be counted toward any entry.
    const plainUser = `${RUN}-lowrated-plain`;
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

    const count = await countLowRatedKnowledge([conversationId]);
    assert.equal(
      count,
      21,
      "a true COUNT(DISTINCT) of the 21 low-rated entries — past list_low_rated_knowledge's own LIMIT-" +
        'bounded 20, excluding the below-threshold entry and the non-shortcut rating',
    );

    const lowerThreshold = await countLowRatedKnowledge([conversationId], 1);
    assert.equal(lowerThreshold, 22, 'lowering minUnhelpful to 1 includes the below-threshold entry too');

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [entryIds]);
  },
);

test(
  'repository: countLowRatedKnowledge excludes an edited entry with only pre-edit unhelpful ratings, and re-includes it once new post-edit ratings clear the threshold again (issue #540)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-low-rated-count-reset`;
    const { id: entryId } = await saveKnowledge({ content: `${RUN} count reset entry content` });

    async function rateShortcut(userSuffix: string, helpful: boolean) {
      const userId = `${RUN}-lowratedcount-reset-${userSuffix}`;
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
    users.push(await rateShortcut('pre-1', false));
    users.push(await rateShortcut('pre-2', false));

    assert.equal(
      await countLowRatedKnowledge([conversationId]),
      1,
      'the entry counts as low-rated before any edit',
    );

    const updated = await updateKnowledge({
      id: entryId,
      content: `${RUN} count reset entry content, fixed`,
    });
    assert.ok(updated.updated, 'update applied');

    assert.equal(
      await countLowRatedKnowledge([conversationId]),
      0,
      'the fixed entry with no post-edit ratings no longer counts as low-rated',
    );

    users.push(await rateShortcut('post-1', false));
    users.push(await rateShortcut('post-2', false));

    assert.equal(
      await countLowRatedKnowledge([conversationId]),
      1,
      'the entry counts again once it accumulates new unhelpful ratings post-edit — proving a reset, not a permanent suppression',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [entryId]);
  },
);

test(
  'SECURITY: repository: countLowRatedKnowledge scopes by conversation — a rating recorded outside the calling admin scope is excluded from the count entirely, while a null (super admin) scope sees it',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-low-rated-scope-in`;
    const outOfScopeConvo = `${RUN}-c-low-rated-scope-out`;
    const { id: inScopeEntryId } = await saveKnowledge({
      content: `${RUN} scope-test in-scope entry content`,
    });
    const { id: outOfScopeEntryId } = await saveKnowledge({
      content: `${RUN} scope-test out-of-scope entry content`,
    });

    async function rateShortcut(conversationId: string, entryId: number, userSuffix: string) {
      const userId = `${RUN}-lowratedscope-${userSuffix}`;
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

    // Snapshot the unscoped (super admin) count BEFORE inserting the fixture
    // so the assertion below is a delta, not an absolute — a concurrently
    // running test file may leave its own low-rated entries in the shared DB
    // (same caution as adminDigest.test.ts's guild-wide-count snapshots).
    const nullScopeBefore = await countLowRatedKnowledge(null);

    const inScopeUsers = [
      await rateShortcut(inScopeConvo, inScopeEntryId, 'in-1'),
      await rateShortcut(inScopeConvo, inScopeEntryId, 'in-2'),
    ];
    const outOfScopeUsers = [
      await rateShortcut(outOfScopeConvo, outOfScopeEntryId, 'out-1'),
      await rateShortcut(outOfScopeConvo, outOfScopeEntryId, 'out-2'),
    ];

    assert.equal(
      await countLowRatedKnowledge([inScopeConvo]),
      1,
      'SECURITY: only the in-scope entry is counted, never the out-of-scope one',
    );

    const nullScopeAfter = await countLowRatedKnowledge(null);
    assert.equal(
      nullScopeAfter - nullScopeBefore,
      2,
      'null scope (super admin) counts both fixture entries, in-scope and out-of-scope alike',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [
      [...inScopeUsers, ...outOfScopeUsers],
    ]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [
      [inScopeConvo, outOfScopeConvo],
    ]);
    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[inScopeEntryId, outOfScopeEntryId]]);
  },
);

// answerFeedbackOriginSummary (issue #592): the answer-quality counterpart
// to usageStats's autoAnswerUsage cost split (issue #552) — buckets
// answer_feedback by whether the rated reply's underlying interaction was
// auto-answered (meta.autoAnswer) or addressed.
test(
  'repository: answerFeedbackOriginSummary splits helpful/unhelpful counts by auto-answer vs addressed origin',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-answer-origin-summary`;
    const users: string[] = [];

    async function rate(userSuffix: string, helpful: boolean, autoAnswer: boolean) {
      const userId = `${RUN}-originsummary-${userSuffix}`;
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `answer for ${userId}`,
        meta: { replyToUserId: userId, ...(autoAnswer ? { autoAnswer: true } : {}) },
      });
      expectFeedbackId(await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful }));
      users.push(userId);
    }

    // Auto-answer bucket: 2 helpful, 1 unhelpful.
    await rate('auto-1', true, true);
    await rate('auto-2', true, true);
    await rate('auto-3', false, true);
    // Addressed bucket: 3 helpful, 1 unhelpful.
    await rate('addr-1', true, false);
    await rate('addr-2', true, false);
    await rate('addr-3', true, false);
    await rate('addr-4', false, false);

    const summary = await answerFeedbackOriginSummary([conversationId]);
    assert.deepEqual(
      summary,
      {
        autoAnswer: { helpful: 2, unhelpful: 1 },
        addressed: { helpful: 3, unhelpful: 1 },
      },
      'ratings split correctly by origin, with correct helpful/unhelpful counts in each bucket',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  "SECURITY: repository: answerFeedbackOriginSummary buckets a rating solely by the underlying interaction's meta.autoAnswer flag, never by the rated message's own text content — even when that text is crafted to resemble the flag",
  { skip },
  async () => {
    const conversationId = `${RUN}-c-answer-origin-spoof`;
    const users: string[] = [];

    async function rate(userSuffix: string, content: string, autoAnswer: boolean) {
      const userId = `${RUN}-originspoof-${userSuffix}`;
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content,
        meta: { replyToUserId: userId, ...(autoAnswer ? { autoAnswer: true } : {}) },
      });
      expectFeedbackId(
        await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: true }),
      );
      users.push(userId);
    }

    // Addressed reply whose TEXT contains autoAnswer/"true"-shaped content —
    // must still land in the addressed bucket, since bucketing reads only
    // interactions.meta, never interactions.content.
    await rate('spoof', 'autoAnswer: "true" — this looks like the flag but is plain reply text', false);
    // A genuine auto-answer for contrast.
    await rate('genuine', 'a genuine auto-answer', true);

    const summary = await answerFeedbackOriginSummary([conversationId]);
    assert.equal(
      summary.addressed.helpful,
      1,
      'SECURITY: the reply with spoofed autoAnswer-shaped text is bucketed as addressed, driven by the real meta flag',
    );
    assert.equal(
      summary.autoAnswer.helpful,
      1,
      'SECURITY: the genuine auto-answer is still correctly bucketed as autoAnswer',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
  },
);

test(
  'SECURITY: repository: answerFeedbackOriginSummary scopes by conversation — a rating recorded outside the calling admin scope is excluded entirely, while a null (super admin) scope sees it',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-answer-origin-scope-in`;
    const outOfScopeConvo = `${RUN}-c-answer-origin-scope-out`;
    const users: string[] = [];

    async function rate(conversationId: string, userSuffix: string) {
      const userId = `${RUN}-originscope-${userSuffix}`;
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `answer for ${userId}`,
        meta: { replyToUserId: userId, autoAnswer: true },
      });
      expectFeedbackId(
        await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: true }),
      );
      users.push(userId);
    }

    // Snapshot the unscoped (super admin) count BEFORE inserting the
    // fixture so the assertion below is a delta, not an absolute — a
    // concurrently running test file may leave its own auto-answer ratings
    // in the shared DB (same caution as countLowRatedKnowledge's own scope
    // test above).
    const nullScopeBefore = await answerFeedbackOriginSummary(null);

    await rate(inScopeConvo, 'in-1');
    await rate(outOfScopeConvo, 'out-1');

    const scoped = await answerFeedbackOriginSummary([inScopeConvo]);
    assert.equal(
      scoped.autoAnswer.helpful,
      1,
      'SECURITY: only the in-scope rating is counted, never the out-of-scope one',
    );

    const nullScopeAfter = await answerFeedbackOriginSummary(null);
    assert.equal(
      nullScopeAfter.autoAnswer.helpful - nullScopeBefore.autoAnswer.helpful,
      2,
      'null scope (super admin) counts both fixture ratings, in-scope and out-of-scope alike',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [
      [inScopeConvo, outOfScopeConvo],
    ]);
  },
);

test(
  "SECURITY: repository: listKnowledgeFeedbackSummary's and countLowRatedKnowledge's conversation-scope filter still excludes out-of-scope ratings once the post-edit #540 time filter is composed in (issue #540)",
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-c-scope-edit-in`;
    const outOfScopeConvo = `${RUN}-c-scope-edit-out`;
    const { id: entryId } = await saveKnowledge({ content: `${RUN} scope-edit entry content` });

    async function rateShortcut(conversationId: string, userSuffix: string) {
      const userId = `${RUN}-scope-edit-${userSuffix}`;
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

    // Pre-edit ratings in both conversations — excluded by the time filter
    // regardless of scope, but scope must not leak in the process.
    const preEditUsers = [
      await rateShortcut(inScopeConvo, 'pre-in'),
      await rateShortcut(outOfScopeConvo, 'pre-out'),
    ];

    const updated = await updateKnowledge({ id: entryId, content: `${RUN} scope-edit entry content, fixed` });
    assert.ok(updated.updated, 'update applied');

    // Post-edit ratings: 2 in-scope, 2 out-of-scope.
    const postEditUsers = [
      await rateShortcut(inScopeConvo, 'post-in-1'),
      await rateShortcut(inScopeConvo, 'post-in-2'),
      await rateShortcut(outOfScopeConvo, 'post-out-1'),
      await rateShortcut(outOfScopeConvo, 'post-out-2'),
    ];

    const scopedSummary = await listKnowledgeFeedbackSummary([inScopeConvo], 1);
    const scopedRow = scopedSummary.find((s) => s.knowledgeEntryId === entryId);
    assert.equal(
      scopedRow?.unhelpfulCount,
      2,
      'SECURITY: only the 2 in-scope, post-edit ratings are counted — never the pre-edit or out-of-scope ones',
    );

    assert.equal(
      await countLowRatedKnowledge([inScopeConvo], 1),
      1,
      'SECURITY: the in-scope count agrees with the summary above',
    );
    assert.equal(
      await countLowRatedKnowledge([inScopeConvo], 3),
      0,
      'a threshold above the 2 in-scope post-edit ratings excludes the entry, proving pre-edit/out-of-scope ratings are not silently folded in',
    );

    const unscopedSummary = await listKnowledgeFeedbackSummary(null, 1);
    const unscopedRow = unscopedSummary.find((s) => s.knowledgeEntryId === entryId);
    assert.equal(
      unscopedRow?.unhelpfulCount,
      4,
      'null scope (super admin) sees all 4 post-edit ratings, in-scope and out-of-scope alike, still excluding the 2 pre-edit ones',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [
      [...preEditUsers, ...postEditUsers],
    ]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [
      [inScopeConvo, outOfScopeConvo],
    ]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [entryId]);
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
      await createAnswerFeedback({
        platform: 'discord',
        conversationId,
        userId: rater,
        helpful: true,
        comment: 'this pinned the wrong price',
      }),
    );

    // Purging the RECIPIENT (the person the rated answer was sent to) deletes
    // their outbound interaction, which must SET NULL on the FK rather than
    // deleting or orphaning the rater's feedback row.
    await purgeUserData('discord', recipient);
    const afterRecipientPurge = await pool.query(
      `SELECT interaction_id, comment FROM answer_feedback WHERE id = $1`,
      [feedbackId],
    );
    assert.equal(afterRecipientPurge.rows.length, 1, "the rater's feedback row itself survives");
    assert.equal(
      afterRecipientPurge.rows[0].interaction_id,
      null,
      'SECURITY: interaction_id is nulled (ON DELETE SET NULL), not left dangling, once the rated reply is purged',
    );
    assert.equal(
      afterRecipientPurge.rows[0].comment,
      'this pinned the wrong price',
      "the rater's comment is untouched by the RECIPIENT's purge",
    );

    const purgedRater = await purgeUserData('discord', rater);
    assert.ok(purgedRater >= 1, "purge count includes the rater's own feedback rows");
    const afterRaterPurge = await pool.query(`SELECT 1 FROM answer_feedback WHERE user_id = $1`, [rater]);
    assert.equal(
      afterRaterPurge.rows.length,
      0,
      "the rater's own feedback rows — including the stored comment (issue #354) — are gone after their purge",
    );
  },
);

test(
  'SECURITY: repository: multiple NULL-interaction_id answer_feedback rows (as ON DELETE SET NULL leaves behind post-purge) coexist without a unique violation, for the same and for different raters (issue #619)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-feedback-null-interaction`;
    const raterA = `${RUN}-feedback-null-a`;
    const raterB = `${RUN}-feedback-null-b`;

    // The partial unique index on (interaction_id, user_id) is scoped to
    // `WHERE interaction_id IS NOT NULL` precisely so post-purge rows (whose
    // FK was nulled by ON DELETE SET NULL, exercised end-to-end just above)
    // never collide with each other — several NULL rows for the SAME rater,
    // and rows across DIFFERENT raters, must all coexist.
    await pool.query(
      `INSERT INTO answer_feedback (platform, conversation_id, user_id, interaction_id, helpful) VALUES
         ($1,$2,$3,NULL,true),
         ($1,$2,$3,NULL,false),
         ($1,$2,$4,NULL,true)`,
      ['discord', conversationId, raterA, raterB],
    );

    const rows = await pool.query(
      `SELECT user_id FROM answer_feedback WHERE conversation_id = $1 ORDER BY id`,
      [conversationId],
    );
    assert.equal(
      rows.rows.length,
      3,
      'all three NULL-interaction_id rows coexist without a unique violation',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE conversation_id = $1`, [conversationId]);
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

test(
  "SECURITY: repository: purgeUserData (forget_me/purge_user_data) removes the requester's own dev_team_watches rows (PR #421 review)",
  { skip },
  async () => {
    const targetUser = `${RUN}-dtw-purge-target`;
    const otherUser = `${RUN}-dtw-purge-other`;

    await pool.query(
      `INSERT INTO dev_team_watches (job_id, requester_platform, requester_user_id, mode, repo)
       VALUES ($1, 'discord', $2, 'assess', 'o/r'), ($3, 'discord', $4, 'assess', 'o/r')`,
      [`${RUN}-dtw-job-1`, targetUser, `${RUN}-dtw-job-2`, otherUser],
    );

    const purged = await purgeUserData('discord', targetUser);
    assert.ok(purged >= 1, 'purged count covers the watch row');

    const targetRows = await pool.query(`SELECT 1 FROM dev_team_watches WHERE requester_user_id = $1`, [
      targetUser,
    ]);
    assert.equal(targetRows.rows.length, 0, "the requester's dev_team_watches rows are gone");

    const otherRows = await pool.query(`SELECT 1 FROM dev_team_watches WHERE requester_user_id = $1`, [
      otherUser,
    ]);
    assert.equal(otherRows.rows.length, 1, "another requester's watch rows are untouched");

    await pool.query(`DELETE FROM dev_team_watches WHERE requester_user_id = $1`, [otherUser]);
  },
);

// moderation_appeals (issue #554): the durable record appeal_moderation
// inserts alongside its existing best-effort notifyAppealFiled DM, plus the
// admin-tier list_appeals/resolve_appeal read/write pair.

test(
  'repository: createModerationAppeal inserts a row with the snapshotted warning counts and reason',
  { skip },
  async () => {
    const userId = `${RUN}-appeal-create`;
    const { id } = await createModerationAppeal({
      platform: 'discord',
      userId,
      userName: 'Appealing Member',
      reason: 'I was not spamming',
      activeWarnings: 2,
      strikeLimit: 3,
    });
    assert.ok(id > 0);

    const { rows } = await pool.query(
      `SELECT platform, user_id, user_name, reason, active_warnings, strike_limit, status, resolved_by, resolved_at
       FROM moderation_appeals WHERE id = $1`,
      [id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].platform, 'discord');
    assert.equal(rows[0].user_id, userId);
    assert.equal(rows[0].user_name, 'Appealing Member');
    assert.equal(rows[0].reason, 'I was not spamming');
    assert.equal(Number(rows[0].active_warnings), 2);
    assert.equal(Number(rows[0].strike_limit), 3);
    assert.equal(rows[0].status, 'open');
    assert.equal(rows[0].resolved_by, null);
    assert.equal(rows[0].resolved_at, null);

    await pool.query(`DELETE FROM moderation_appeals WHERE id = $1`, [id]);
  },
);

test('repository: createModerationAppeal stores a null reason when none is given', { skip }, async () => {
  const userId = `${RUN}-appeal-create-no-reason`;
  const { id } = await createModerationAppeal({
    platform: 'discord',
    userId,
    userName: null,
    activeWarnings: 1,
    strikeLimit: 3,
  });

  const { rows } = await pool.query(`SELECT reason, user_name FROM moderation_appeals WHERE id = $1`, [id]);
  assert.equal(rows[0].reason, null);
  assert.equal(rows[0].user_name, null);

  await pool.query(`DELETE FROM moderation_appeals WHERE id = $1`, [id]);
});

test(
  'repository: listAppeals returns newest-first and the status filter narrows results',
  { skip },
  async () => {
    const userId = `${RUN}-appeal-list`;
    const open = await createModerationAppeal({
      platform: 'discord',
      userId,
      userName: 'A',
      activeWarnings: 1,
      strikeLimit: 3,
    });
    const toResolve = await createModerationAppeal({
      platform: 'discord',
      userId,
      userName: 'A',
      activeWarnings: 1,
      strikeLimit: 3,
    });
    await resolveModerationAppeal(toResolve.id, 'resolved', 'admin-1');

    const all = await listAppeals();
    const ids = all.map((r) => r.id);
    assert.ok(
      ids.includes(open.id) && ids.includes(toResolve.id),
      'both fixture rows are visible unfiltered',
    );
    assert.ok(
      ids.indexOf(toResolve.id) < ids.indexOf(open.id),
      'newest first: the later-inserted, later-resolved row sorts before the earlier open row',
    );

    const openOnly = await listAppeals('open');
    assert.ok(openOnly.some((r) => r.id === open.id));
    assert.ok(!openOnly.some((r) => r.id === toResolve.id), 'the status filter excludes the resolved row');

    const resolvedOnly = await listAppeals('resolved');
    assert.ok(resolvedOnly.some((r) => r.id === toResolve.id));
    assert.ok(!resolvedOnly.some((r) => r.id === open.id));

    await pool.query(`DELETE FROM moderation_appeals WHERE id = ANY($1)`, [[open.id, toResolve.id]]);
  },
);

test(
  'repository: resolveModerationAppeal flips only status/resolved_by/resolved_at, never active_warnings/strike_limit/reason, and returns null for an unknown id',
  { skip },
  async () => {
    const userId = `${RUN}-appeal-resolve`;
    const { id } = await createModerationAppeal({
      platform: 'discord',
      userId,
      userName: 'A',
      reason: 'original reason',
      activeWarnings: 2,
      strikeLimit: 3,
    });

    const resolved = await resolveModerationAppeal(id, 'dismissed', 'admin-9');
    assert.ok(resolved);
    assert.equal(resolved?.status, 'dismissed');
    assert.equal(resolved?.resolvedBy, 'admin-9');
    assert.ok(resolved?.resolvedAt);
    assert.equal(resolved?.reason, 'original reason', 'the original reason is untouched');
    assert.equal(resolved?.activeWarnings, 2, 'the snapshotted warning count is untouched');
    assert.equal(resolved?.strikeLimit, 3, 'the snapshotted strike limit is untouched');

    const unknown = await resolveModerationAppeal(id + 1_000_000, 'resolved', 'admin-9');
    assert.equal(unknown, null, 'an unknown id returns null rather than throwing');

    await pool.query(`DELETE FROM moderation_appeals WHERE id = $1`, [id]);
  },
);

test(
  'SECURITY: repository: resolveModerationAppeal never touches member_warnings — resolving an appeal does not clear the underlying warnings or lift a mute (issue #554 scope guardrail)',
  { skip },
  async () => {
    const userId = `${RUN}-appeal-resolve-no-side-effects`;
    await addWarning({
      platform: 'discord',
      userId,
      reason: 'test',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    const before = await countActiveWarnings('discord', userId);

    const { id } = await createModerationAppeal({
      platform: 'discord',
      userId,
      userName: 'A',
      activeWarnings: before,
      strikeLimit: 3,
    });
    await resolveModerationAppeal(id, 'resolved', 'admin-1');

    const after = await countActiveWarnings('discord', userId);
    assert.equal(after, before, 'resolving the appeal must not change the member_warnings active count');

    await pool.query(`DELETE FROM moderation_appeals WHERE id = $1`, [id]);
    await pool.query(`DELETE FROM member_warnings WHERE user_id = $1`, [userId]);
  },
);

test(
  "SECURITY: repository: purgeUserData (forget_me/purge_user_data) removes the caller's own moderation_appeals rows (issue #554)",
  { skip },
  async () => {
    const targetUser = `${RUN}-appeal-purge-target`;
    const otherUser = `${RUN}-appeal-purge-other`;

    const targetAppeal = await createModerationAppeal({
      platform: 'discord',
      userId: targetUser,
      userName: 'Target',
      activeWarnings: 1,
      strikeLimit: 3,
    });
    assert.ok(targetAppeal.id > 0, 'fixture appeal was recorded');
    const otherAppeal = await createModerationAppeal({
      platform: 'discord',
      userId: otherUser,
      userName: 'Other',
      activeWarnings: 1,
      strikeLimit: 3,
    });

    const purged = await purgeUserData('discord', targetUser);
    assert.ok(purged >= 1, 'purged count covers the target appeal row');

    const targetRows = await pool.query(`SELECT 1 FROM moderation_appeals WHERE user_id = $1`, [targetUser]);
    assert.equal(targetRows.rows.length, 0, "the target user's moderation_appeals rows are gone");

    const otherRows = await pool.query(`SELECT 1 FROM moderation_appeals WHERE id = $1`, [otherAppeal.id]);
    assert.equal(otherRows.rows.length, 1, "another user's moderation_appeals rows are untouched");

    await pool.query(`DELETE FROM moderation_appeals WHERE id = $1`, [otherAppeal.id]);
  },
);

test(
  'repository: countOpenAppeals counts only same-platform open rows, excluding resolved/dismissed and other platforms (issue #631)',
  { skip },
  async () => {
    const userId = `${RUN}-appeal-count`;
    // Baselines rather than absolute counts — moderation_appeals has no
    // per-run scoping column, and other concurrently-running test files
    // (tools.test.ts's appeal_moderation suite) may hold their own
    // in-flight 'discord' rows, so only the DELTA our own fixtures cause is
    // a safe assertion.
    const baselineDiscord = await countOpenAppeals('discord');
    const baselineWhatsapp = await countOpenAppeals('whatsapp');

    const open = await createModerationAppeal({
      platform: 'discord',
      userId,
      userName: 'A',
      activeWarnings: 1,
      strikeLimit: 3,
    });
    const resolved = await createModerationAppeal({
      platform: 'discord',
      userId,
      userName: 'B',
      activeWarnings: 1,
      strikeLimit: 3,
    });
    await resolveModerationAppeal(resolved.id, 'resolved', 'admin-1');
    const dismissed = await createModerationAppeal({
      platform: 'discord',
      userId,
      userName: 'C',
      activeWarnings: 1,
      strikeLimit: 3,
    });
    await resolveModerationAppeal(dismissed.id, 'dismissed', 'admin-1');
    const otherPlatformOpen = await createModerationAppeal({
      platform: 'whatsapp',
      userId,
      userName: 'D',
      activeWarnings: 1,
      strikeLimit: 3,
    });

    const afterDiscord = await countOpenAppeals('discord');
    assert.equal(
      afterDiscord,
      baselineDiscord + 1,
      'only the genuinely open discord row is counted — the resolved and dismissed rows are excluded',
    );

    const afterWhatsapp = await countOpenAppeals('whatsapp');
    assert.equal(
      afterWhatsapp,
      baselineWhatsapp + 1,
      'the whatsapp open row is counted only under its own platform, not leaked into/from discord',
    );

    await pool.query(`DELETE FROM moderation_appeals WHERE id = ANY($1)`, [
      [open.id, resolved.id, dismissed.id, otherPlatformOpen.id],
    ]);
  },
);

// searchMemory's relevanceThreshold floor (issue #474) — same technique as
// tests/tools.test.ts's atCosineSimilarity: derive a fixture embedding at an
// EXACT known cosine similarity to the query's own real embed() output via
// Gram-Schmidt, rather than relying on the model's actual semantic judgement
// of hand-picked text (unreliable for landing precisely on either side of a
// threshold).
function memoryAtCosineSimilarity(anchor: number[], rho: number): number[] {
  const dim = anchor.length;
  const seed = new Array(dim).fill(0);
  seed[Math.abs(anchor[0]) > 0.9 ? 1 : 0] = 1;
  const dot = seed.reduce((s, v, i) => s + v * anchor[i], 0);
  const orth = seed.map((v, i) => v - dot * anchor[i]);
  const norm = Math.sqrt(orth.reduce((s, v) => s + v * v, 0));
  const unitOrth = orth.map((v) => v / norm);
  const scale = Math.sqrt(1 - rho * rho);
  return anchor.map((v, i) => rho * v + scale * unitOrth[i]);
}

const insertMemoryAt = (conversationId: string, userId: string, content: string, vec: number[]) =>
  pool
    .query(
      `INSERT INTO interactions (platform, conversation_id, user_id, role, direction, content, embedding)
       VALUES ('discord',$1,$2,'member','inbound',$3,$4) RETURNING id`,
      [conversationId, userId, content, pgvector.toSql(vec)],
    )
    .then((r) => Number(r.rows[0].id));

test(
  'repository: searchMemory relevanceThreshold excludes rows below the floor, keeps rows at/above it in similarity-descending order, and topK still applies among the survivors (issue #474, AC1)',
  { skip },
  async () => {
    const conversationId = `${RUN}-mem-floor`;
    const userId = `${RUN}-mem-floor-user`;
    const query = 'when is the next community meetup scheduled';
    const anchor = await embed(query);

    const highId = await insertMemoryAt(
      conversationId,
      userId,
      'high match row',
      memoryAtCosineSimilarity(anchor, 0.9),
    );
    const midId = await insertMemoryAt(
      conversationId,
      userId,
      'mid match row',
      memoryAtCosineSimilarity(anchor, 0.6),
    );
    const lowId = await insertMemoryAt(
      conversationId,
      userId,
      'low match row',
      memoryAtCosineSimilarity(anchor, 0.3),
    );
    const belowFloorId = await insertMemoryAt(
      conversationId,
      userId,
      'below floor row',
      memoryAtCosineSimilarity(anchor, 0.1),
    );

    const hits = await searchMemory(query, { conversationId, relevanceThreshold: 0.5, topK: 10 });
    assert.deepEqual(
      hits.map((h) => h.content),
      ['high match row', 'mid match row'],
      'only rows at/above the 0.5 floor survive, in similarity-descending order',
    );
    assert.ok(
      hits.every((h) => h.similarity >= 0.5),
      'every surviving hit clears the configured floor',
    );

    const limited = await searchMemory(query, { conversationId, relevanceThreshold: 0.5, topK: 1 });
    assert.deepEqual(
      limited.map((h) => h.content),
      ['high match row'],
      'topK still applies among the rows that clear the floor',
    );

    await pool.query(`DELETE FROM interactions WHERE id = ANY($1)`, [[highId, midId, lowId, belowFloorId]]);
  },
);

test(
  'repository: searchMemory relevanceThreshold of 0 is a true no-op, returning rows at exactly-zero and negative similarity unchanged (issue #474, AC2)',
  { skip },
  async () => {
    const conversationId = `${RUN}-mem-noop`;
    const userId = `${RUN}-mem-noop-user`;
    const query = 'what time does the meetup start this week';
    const anchor = await embed(query);

    const zeroId = await insertMemoryAt(
      conversationId,
      userId,
      'zero similarity row',
      memoryAtCosineSimilarity(anchor, 0),
    );
    const negativeId = await insertMemoryAt(
      conversationId,
      userId,
      'negative similarity row',
      memoryAtCosineSimilarity(anchor, -0.4),
    );

    const withExplicitZero = await searchMemory(query, {
      conversationId,
      relevanceThreshold: 0,
      topK: 10,
    });
    const withOmittedThreshold = await searchMemory(query, { conversationId, topK: 10 });

    assert.deepEqual(
      new Set(withExplicitZero.map((h) => h.content)),
      new Set(['zero similarity row', 'negative similarity row']),
      'an explicit 0 threshold must not exclude exactly-zero or negative-similarity rows',
    );
    assert.deepEqual(
      new Set(withOmittedThreshold.map((h) => h.content)),
      new Set(['zero similarity row', 'negative similarity row']),
      'omitting relevanceThreshold falls back to config default (0 in this test env) — identical result set',
    );

    await pool.query(`DELETE FROM interactions WHERE id = ANY($1)`, [[zeroId, negativeId]]);
  },
);

test(
  'SECURITY: repository: searchMemory relevanceThreshold composes as an additional AND with existing scope filters — never widens scope. An out-of-scope row that clears the floor is still never returned, for both conversationId and conversationIds scoping (issue #474, AC5)',
  { skip },
  async () => {
    const inScopeConvo = `${RUN}-mem-scope-in`;
    const outOfScopeConvo = `${RUN}-mem-scope-out`;
    const userId = `${RUN}-mem-scope-user`;
    const query = 'how do I reset my community forum password';
    const anchor = await embed(query);

    const inScopeId = await insertMemoryAt(
      inScopeConvo,
      userId,
      'in scope row',
      memoryAtCosineSimilarity(anchor, 0.9),
    );
    // Deliberately a HIGHER similarity than the in-scope row, so a $N
    // parameter-index regression that dropped or reordered the scope
    // predicate would surface this row ahead of (or instead of) the
    // in-scope one.
    const outOfScopeId = await insertMemoryAt(
      outOfScopeConvo,
      userId,
      'out of scope row',
      memoryAtCosineSimilarity(anchor, 0.95),
    );

    const scopedById = await searchMemory(query, {
      conversationId: inScopeConvo,
      relevanceThreshold: 0.5,
      topK: 10,
    });
    assert.deepEqual(
      scopedById.map((h) => h.content),
      ['in scope row'],
      'conversationId scope returns only the in-scope row even though the out-of-scope row has higher similarity',
    );

    const scopedByIds = await searchMemory(query, {
      conversationIds: [inScopeConvo],
      relevanceThreshold: 0.5,
      topK: 10,
    });
    assert.deepEqual(
      scopedByIds.map((h) => h.content),
      ['in scope row'],
      'SECURITY: the admin conversationIds scope must never leak a higher-similarity out-of-scope row',
    );

    await pool.query(`DELETE FROM interactions WHERE id = ANY($1)`, [[inScopeId, outOfScopeId]]);
  },
);

test(
  'repository: recentConversationTail returns the most recent in-window rows for ONE conversation, oldest-first; limit 0 disables it',
  { skip },
  async () => {
    const conv = `${RUN}-c-tail`;
    const otherConv = `${RUN}-c-tail-other`;
    const userId = `${RUN}-tail-user`;

    const insert = (conversationId: string, content: string, interval: string) =>
      pool.query(
        `INSERT INTO interactions (platform, conversation_id, user_id, user_name, role, direction, content, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() - interval '${interval}')`,
        ['discord', conversationId, userId, 'Tail Tester', 'member', 'inbound', content],
      );
    await insert(conv, 'oldest in-window', '3 minutes');
    await insert(conv, 'middle in-window', '2 minutes');
    await insert(conv, 'newest in-window', '1 minute');
    // Outside the SESSION_MAX_AGE_HOURS window (default 24h in this test env):
    // a fresh session inherits at most what a live session could have held.
    await insert(conv, 'out of window — must be excluded', '25 hours');
    await insert(otherConv, 'other conversation — must never leak in', '1 minute');

    const tail = await recentConversationTail('discord', conv, 2);
    assert.deepEqual(
      tail.map((r) => r.content),
      ['middle in-window', 'newest in-window'],
      'limit takes the MOST RECENT rows and returns them oldest-first',
    );
    assert.equal(tail[0]?.userName, 'Tail Tester');
    assert.equal(tail[0]?.direction, 'inbound');

    const all = await recentConversationTail('discord', conv, 10);
    assert.deepEqual(
      all.map((r) => r.content),
      ['oldest in-window', 'middle in-window', 'newest in-window'],
      'the age window excludes stale rows, and other conversations are scoped out',
    );

    assert.deepEqual(await recentConversationTail('discord', conv, 0), [], 'limit 0 disables the backfill');

    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [[conv, otherConv]]);
  },
);
