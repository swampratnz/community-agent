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
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
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
  answerFeedbackWeeklySummary,
  countAccessRequests,
  countGeneralUnhelpfulAnswers,
  countKnowledgeGaps,
  countLowRatedKnowledge,
  countMaxTurnsFailures,
  countPendingSuggestions,
  countStaleKnowledge,
  countUnreachableSourceKnowledge,
  countPendingKnowledgeCandidates,
  createContentReport,
  createSuggestion,
  createAnswerFeedback,
  recordInteraction,
  saveKnowledge,
  recordKnowledgeRetrieval,
  deleteKnowledge,
  insertContextDigest,
  insertKnowledgeCandidate,
  upsertRosterMember,
  markRosterLeave,
  rosterCounts,
  addWarning,
  countMutedMembers,
  countStaleMutedMembers,
  getLastDigestCounts,
  recordAdminDigestSnapshot,
  createModerationAppeal,
} = await import('../src/storage/repository.js');
const { buildAdminDigestMessage, buildAdminDigestForAdmin, runAdminDigestOnce, startAdminDigest } =
  await import('../src/adminDigest.js');
const { readFileSync } = await import('node:fs');
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

test('buildAdminDigestMessage: oldestAccessRequestAgeDays appends an "oldest waiting Nd" fragment to the pending-access-request line only when pendingAccessRequests > 0 AND the age is non-null (issue #515)', () => {
  const withAge = buildAdminDigestMessage(
    [],
    3,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    12,
  );
  assert.equal(
    withAge,
    '⏳ 3 pending access request(s), oldest waiting 12d — run `list_access_requests`.',
    'the age fragment is appended right after the count, before the trend suffix position',
  );

  const nullAge = buildAdminDigestMessage(
    [],
    3,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
  );
  assert.equal(
    nullAge,
    '⏳ 3 pending access request(s) — run `list_access_requests`.',
    'a null age (e.g. an empty access_requests table at the moment of the aggregate query) renders no fragment',
  );

  const omittedAge = buildAdminDigestMessage([], 3, 0, 0, 0, 0);
  assert.equal(
    omittedAge,
    nullAge,
    'omitting the trailing param entirely defaults to null, same output as passing null explicitly',
  );
});

test('SECURITY: buildAdminDigestMessage: pendingAccessRequests === 0 renders no access-request line and is byte-identical whether or not oldestAccessRequestAgeDays is supplied — no regression to the quiet case (issue #515)', () => {
  const withoutAgeParam = buildAdminDigestMessage([], 0, 0, 0, 0, 0);
  const withAgeParam = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    40,
  );
  assert.equal(withoutAgeParam, null, 'the quiet case (all signals zero) is unaffected');
  assert.equal(
    withAgeParam,
    null,
    'a non-null age must never surface a line on its own — it only ever decorates an already-nonzero pendingAccessRequests count',
  );
});

test('buildAdminDigestMessage: oldestOpenReportAgeDays / oldestPendingSuggestionAgeDays append an "oldest Nd old" fragment to their respective lines only when the paired count > 0 AND the age is non-null (issue #450)', () => {
  // positional layout (1-indexed): 3 = openReports, 4 = pendingSuggestions,
  // 22 = previousCounts, 23 = oldestAccessRequestAgeDays,
  // 24 = oldestOpenReportAgeDays, 25 = oldestPendingSuggestionAgeDays.
  const reportWithAge = buildAdminDigestMessage(
    [],
    0,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    12,
  );
  assert.equal(
    reportWithAge,
    '🚩 2 open report(s) in your conversations, oldest 12d old — run `list_reports`.',
    'the report age fragment is appended right after the count',
  );

  const suggestionWithAge = buildAdminDigestMessage(
    [],
    0,
    0,
    4,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    5,
  );
  assert.equal(
    suggestionWithAge,
    '💡 4 pending suggestion(s), oldest 5d old — run `list_suggestions`.',
    'the suggestion age fragment is appended right after the count',
  );

  // A null age (empty scoped set at the moment of the aggregate query) renders
  // the line exactly as before #450, for both signals.
  const reportNullAge = buildAdminDigestMessage(
    [],
    0,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
  );
  assert.equal(
    reportNullAge,
    '🚩 2 open report(s) in your conversations — run `list_reports`.',
    'a null report age renders no fragment',
  );
  const suggestionNullAge = buildAdminDigestMessage(
    [],
    0,
    0,
    4,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
  );
  assert.equal(
    suggestionNullAge,
    '💡 4 pending suggestion(s) — run `list_suggestions`.',
    'a null suggestion age renders no fragment',
  );

  // Omitting the trailing params entirely defaults them to null — same output.
  assert.equal(buildAdminDigestMessage([], 0, 2, 0, 0, 0), reportNullAge);
  assert.equal(buildAdminDigestMessage([], 0, 0, 4, 0, 0), suggestionNullAge);
});

test('SECURITY: buildAdminDigestMessage: openReports === 0 / pendingSuggestions === 0 render no line and are byte-identical whether or not the #450 age params are supplied — a non-null age never surfaces a line on its own (issue #450)', () => {
  const quiet = buildAdminDigestMessage([], 0, 0, 0, 0, 0);
  // Both ages non-null but both paired counts zero — must stay null (all
  // signals zero), never leak a report/suggestion line off the age alone.
  const withAgesButZeroCounts = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    99,
    77,
  );
  assert.equal(quiet, null, 'the quiet case (all signals zero) is unaffected');
  assert.equal(
    withAgesButZeroCounts,
    null,
    'a non-null report/suggestion age must never surface a line on its own — it only ever decorates an already-nonzero paired count',
  );
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

test('buildAdminDigestMessage: stale-knowledge line names the ACTIVE threshold — ceiling-only mode reads "content older than Nd", never "0d+" (issue #380)', () => {
  // Ceiling-only (KNOWLEDGE_STALE_DAYS=0, KNOWLEDGE_STALE_MAX_AGE_DAYS=90): the
  // count comes from the content-age ceiling, so the line must describe THAT,
  // not render the raw 0-day window. (15 leading positional args, then the
  // ceiling as the last one.)
  const ceilingOnly = buildAdminDigestMessage([], 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 90);
  assert.ok(ceilingOnly);
  assert.match(
    ceilingOnly,
    /^📚 4 knowledge entries with content older than 90d — run `list_knowledge` to review\.$/,
  );
  assert.ok(!ceilingOnly.includes('0d+'), 'ceiling-only mode must never render the nonsensical "0d+" window');

  // Both knobs on: name both criteria (the count is their union).
  const both = buildAdminDigestMessage([], 0, 0, 0, 4, 30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 90);
  assert.ok(both);
  assert.match(
    both,
    /^📚 4 knowledge entries untouched for 30d\+ or with content older than 90d — run `list_knowledge` to review\.$/,
  );
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

test('buildAdminDigestMessage: knowledge-gaps line appears only when count > 0, and all SIX signals zero -> null (issue #246)', () => {
  assert.equal(
    buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0),
    null,
    'all six signals zero — including knowledge gaps — is a quiet week',
  );

  const message = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 2);
  assert.ok(message, 'a non-zero knowledge-gaps count alone still produces a DM');
  const gapLines = message.split('\n').filter((l) => l.includes('🕳️'));
  assert.equal(gapLines.length, 1, 'exactly one knowledge-gaps line');
  assert.match(gapLines[0], /🕳️ 2 unanswered question\(s\).*`list_knowledge_gaps`/);
  assert.ok(!message.includes('🔔'), 'no cluster line when there are no clusters');
  assert.ok(!message.includes('📚'), 'no stale-knowledge line when that count is zero');

  assert.ok(
    !buildAdminDigestMessage([], 1, 0, 0, 0, 0, 0)!.includes('🕳️'),
    'no knowledge-gaps line when the gap count is zero',
  );
});

test('buildAdminDigestMessage: knowledge-candidates line appears only when count > 0, and all SEVEN signals zero -> null (issue #284)', () => {
  assert.equal(
    buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0),
    null,
    'all seven signals zero — including pending knowledge candidates — is a quiet week',
  );

  const message = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 3);
  assert.ok(message, 'a non-zero pending-knowledge-candidate count alone still produces a DM');
  const candidateLines = message.split('\n').filter((l) => l.includes('🧩'));
  assert.equal(candidateLines.length, 1, 'exactly one knowledge-candidates line');
  assert.match(candidateLines[0], /🧩 3 pending knowledge candidate\(s\).*`list_knowledge_candidates`/);
  assert.ok(!message.includes('🔔'), 'no cluster line when there are no clusters');
  assert.ok(!message.includes('🕳️'), 'no knowledge-gaps line when that count is zero');

  assert.ok(
    !buildAdminDigestMessage([], 1, 0, 0, 0, 0, 0, 0)!.includes('🧩'),
    'no knowledge-candidates line when the candidate count is zero',
  );
});

test('buildAdminDigestMessage: the knowledge-candidates line never contains candidate title, content, or topic — only the bare count (issue #284 privacy pin)', () => {
  const message = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 5);
  assert.ok(message);
  assert.ok(
    !/title|content|topic/i.test(message),
    'no candidate field name or content ever leaks into the digest text',
  );
});

test('buildAdminDigestMessage: KNOWLEDGE_CANDIDATE_STALE_DAYS unset (default) -> pending-candidates line is byte-identical to the pre-#398 (#284) wording (issue #398)', () => {
  // Trailing args explicitly passed as 0 (knob unset, stale sub-count 0) —
  // matches how runAdminDigestOnce calls this when the knob is unconfigured.
  const message = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  assert.ok(message);
  assert.equal(
    message,
    '🧩 3 pending knowledge candidate(s) — run `list_knowledge_candidates`.',
    'with the knob unset, the line must render exactly as it did before issue #398',
  );
});

test('buildAdminDigestMessage: KNOWLEDGE_CANDIDATE_STALE_DAYS set with a nonzero stale sub-count extends the pending-candidates line; a zero sub-count leaves it bare (issue #398)', () => {
  const withStale = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 2, 14);
  assert.ok(withStale);
  assert.equal(
    withStale,
    '🧩 5 pending knowledge candidate(s), 2 unreviewed for 14d+ — run `list_knowledge_candidates`.',
    'knob set + nonzero stale sub-count -> the line names both the total and the stale sub-count',
  );

  const withoutStale = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14);
  assert.ok(withoutStale);
  assert.equal(
    withoutStale,
    '🧩 5 pending knowledge candidate(s) — run `list_knowledge_candidates`.',
    'knob set but stale sub-count is 0 -> no "0 unreviewed" noise, bare total only',
  );
});

test('SECURITY: buildAdminDigestMessage: the extended knowledge-candidates line (stale sub-count present or absent) never contains candidate title, content, or topic — only integers (issue #398 privacy pin)', () => {
  const withStale = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 2, 14);
  assert.ok(withStale);
  assert.ok(
    !/title|content|topic/i.test(withStale),
    'SECURITY: stale-present branch must never leak a candidate field name or its content',
  );

  const withoutStale = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14);
  assert.ok(withoutStale);
  assert.ok(
    !/title|content|topic/i.test(withoutStale),
    'SECURITY: stale-absent branch must never leak a candidate field name or its content either',
  );
});

test('buildAdminDigestMessage: low-rated-knowledge line appears only when count > 0, and all EIGHT signals zero -> null (issue #324)', () => {
  assert.equal(
    buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0),
    null,
    'all eight signals zero — including low-rated knowledge — is a quiet week',
  );

  const message = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 2);
  assert.ok(message, 'a non-zero low-rated-knowledge count alone still produces a DM');
  const lowRatedLines = message.split('\n').filter((l) => l.includes('👎'));
  assert.equal(lowRatedLines.length, 1, 'exactly one low-rated-knowledge line');
  assert.match(
    lowRatedLines[0],
    /👎 2 knowledge entries with repeated unhelpful ratings.*`list_low_rated_knowledge`/,
  );
  assert.ok(!message.includes('🔔'), 'no cluster line when there are no clusters');
  assert.ok(!message.includes('🧩'), 'no knowledge-candidates line when that count is zero');

  assert.ok(
    !buildAdminDigestMessage([], 1, 0, 0, 0, 0, 0, 0, 0)!.includes('👎'),
    'no low-rated-knowledge line when the count is zero',
  );
});

test('buildAdminDigestMessage: low-rated-knowledge singular/plural wording (issue #324)', () => {
  const singular = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 1);
  assert.ok(singular);
  assert.match(
    singular,
    /^👎 1 knowledge entry with repeated unhelpful ratings — run `list_low_rated_knowledge` to review\.$/,
  );
});

test('buildAdminDigestMessage: the low-rated-knowledge line never contains entry title or rater identity — only the bare count (issue #324 privacy pin)', () => {
  const message = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 3);
  assert.ok(message);
  assert.ok(
    !/title|rater|user_id/i.test(message),
    'no knowledge-feedback field name or content ever leaks into the digest text',
  );
});

test('buildAdminDigestMessage: roster-growth line appears only when joined/left are non-zero, and all TEN signals zero -> null (issue #344)', () => {
  assert.equal(
    buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    null,
    'all ten signals zero — including roster joined/left — is a quiet week',
  );

  const message = buildAdminDigestMessage([], 1, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  assert.ok(message, 'a non-zero other-signal count alone still produces a DM');
  assert.ok(
    !message.includes('📈'),
    'no roster-growth line when joined/left are both zero, even though the DM is non-empty',
  );
});

test('buildAdminDigestMessage: roster-growth line reflects joined-only, left-only, and both (issue #344)', () => {
  const joinedOnly = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 3, 0);
  assert.ok(joinedOnly);
  const joinedLines = joinedOnly.split('\n').filter((l) => l.includes('📈'));
  assert.equal(joinedLines.length, 1, 'exactly one roster-growth line');
  assert.match(joinedLines[0], /^📈 3 joined this week — run `list_roster` for detail\.$/);

  const leftOnly = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 2);
  assert.ok(leftOnly);
  assert.match(leftOnly, /^📈 2 left this week — run `list_roster` for detail\.$/);

  const both = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 4, 1);
  assert.ok(both);
  assert.match(both, /^📈 4 joined, 1 left this week — run `list_roster` for detail\.$/);

  assert.ok(
    !buildAdminDigestMessage([], 1, 0, 0, 0, 0, 0, 0, 0, 0, 0)!.includes('📈'),
    'no roster-growth line when both joined and left are zero',
  );
});

test('SECURITY: the roster-growth line is a deterministic function of (joinedThisWeek, leftThisWeek) only, and never carries a display name, user id, or platform id (issue #344)', () => {
  const secretName = 'Very Identifiable Display Name';
  const secretUserId = 'discord-user-1234567890';
  const secretPlatformId = 'whatsapp:+64211234567';

  // The digest DM is built from bare integers only — buildAdminDigestMessage
  // never receives roster row content, so there is nothing to smuggle in via
  // an unrelated argument either. Assert the two calls (identical counts,
  // different unrelated arguments) produce byte-identical output.
  const a = buildAdminDigestMessage([{ representative: secretName, count: 1 }], 0, 0, 0, 0, 0, 0, 0, 0, 5, 3);
  const b = buildAdminDigestMessage(
    [{ representative: secretUserId, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    5,
    3,
  );
  assert.ok(a && b);
  const rosterLine = (m: string) => m.split('\n').find((l) => l.includes('📈'));
  assert.equal(
    rosterLine(a),
    rosterLine(b),
    'the roster-growth line is unaffected by unrelated content passed through other parameters',
  );
  assert.match(rosterLine(a)!, /^📈 5 joined, 3 left this week — run `list_roster` for detail\.$/);
  assert.ok(
    !rosterLine(a)!.includes(secretName) &&
      !rosterLine(a)!.includes(secretUserId) &&
      !rosterLine(a)!.includes(secretPlatformId),
    'SECURITY: no display name, user id, or platform id ever appears in the roster-growth line — bare counts only',
  );
});

test('buildAdminDigestMessage: muted-member line appears only when count > 0, and all ELEVEN signals zero -> null (issue #357)', () => {
  assert.equal(
    buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    null,
    'all eleven signals zero — including muted members — is a quiet week',
  );

  const message = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4);
  assert.ok(message, 'a non-zero muted-member count alone still produces a DM');
  const mutedLines = message.split('\n').filter((l) => l.includes('🔇'));
  assert.equal(mutedLines.length, 1, 'exactly one muted-member line');
  assert.match(
    mutedLines[0],
    /^🔇 4 member\(s\) currently muted — run `moderation_history` or `clear_warnings` to review\.$/,
  );
  assert.ok(!message.includes('📈'), 'no roster-growth line when joined/left are both zero');

  assert.ok(
    !buildAdminDigestMessage([], 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)!.includes('🔇'),
    'no muted-member line when the count is zero',
  );
});

test('buildAdminDigestMessage: max-turns-failures line appears only when count > 0, and all TWELVE signals zero -> null (issue #371)', () => {
  assert.equal(
    buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    null,
    'all twelve signals zero — including max-turns failures — is a quiet week',
  );

  const message = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5);
  assert.ok(message, 'a non-zero max-turns-failures count alone still produces a DM');
  const wallHitLines = message.split('\n').filter((l) => l.includes('⏱️'));
  assert.equal(wallHitLines.length, 1, 'exactly one max-turns-failures line');
  assert.match(
    wallHitLines[0],
    /^⏱️ 5 replies in your conversations this week hit the step limit before finishing\.$/,
  );
  assert.ok(!message.includes('🔇'), 'no muted-member line when that count is zero');

  assert.ok(
    !buildAdminDigestMessage([], 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)!.includes('⏱️'),
    'no max-turns-failures line when the count is zero',
  );

  const singular = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
  assert.match(
    singular!,
    /^⏱️ 1 reply in your conversations this week hit the step limit before finishing\.$/,
  );
});

test('SECURITY: the max-turns-failures line is a deterministic function of maxTurnsFailuresCount only, and never carries message content, question text, user id, or conversation id (issue #371)', () => {
  const secretContent = 'a very identifiable message that must never leak';
  const secretUserId = 'discord-user-1234567890';
  const secretConversationId = 'discord-channel-9999999999';

  // buildAdminDigestMessage never receives interaction content/ids — only the
  // bare count — so there is nothing to smuggle in via an unrelated
  // parameter either (same shape as the muted-member privacy pin above).
  const a = buildAdminDigestMessage(
    [{ representative: secretContent, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    7,
  );
  const b = buildAdminDigestMessage(
    [{ representative: secretUserId, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    7,
  );
  assert.ok(a && b);
  const wallHitLine = (m: string) => m.split('\n').find((l) => l.includes('⏱️'));
  assert.equal(
    wallHitLine(a),
    wallHitLine(b),
    'the max-turns-failures line is unaffected by unrelated content passed through other parameters',
  );
  assert.match(
    wallHitLine(a)!,
    /^⏱️ 7 replies in your conversations this week hit the step limit before finishing\.$/,
  );
  assert.ok(
    !wallHitLine(a)!.includes(secretContent) &&
      !wallHitLine(a)!.includes(secretUserId) &&
      !wallHitLine(a)!.includes(secretConversationId),
    'SECURITY: no message content, question text, user id, or conversation id ever appears in the max-turns-failures line — bare count only',
  );
});

test('SECURITY: the muted-member line is a deterministic function of mutedMembersCount only, and never carries a warning reason, excerpt, user id, or member name (issue #357)', () => {
  const secretReason = 'bad language ("very identifiable slur")';
  const secretExcerpt = 'the exact offending message text';
  const secretUserId = 'discord-user-9876543210';
  const secretName = 'Very Identifiable Member Name';

  // buildAdminDigestMessage never receives warning row content — only the
  // bare count — so there is nothing to smuggle in via an unrelated
  // parameter either (same shape as the roster-growth privacy pin above).
  const a = buildAdminDigestMessage(
    [{ representative: secretReason, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    6,
  );
  const b = buildAdminDigestMessage(
    [{ representative: secretExcerpt, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    6,
  );
  assert.ok(a && b);
  const mutedLine = (m: string) => m.split('\n').find((l) => l.includes('🔇'));
  assert.equal(
    mutedLine(a),
    mutedLine(b),
    'the muted-member line is unaffected by unrelated content passed through other parameters',
  );
  assert.match(
    mutedLine(a)!,
    /^🔇 6 member\(s\) currently muted — run `moderation_history` or `clear_warnings` to review\.$/,
  );
  assert.ok(
    !mutedLine(a)!.includes(secretReason) &&
      !mutedLine(a)!.includes(secretExcerpt) &&
      !mutedLine(a)!.includes(secretUserId) &&
      !mutedLine(a)!.includes(secretName),
    'SECURITY: no warning reason, excerpt, user id, or member name ever appears in the muted-member line — bare count only',
  );
});

test('buildAdminDigestMessage: the stale-muted-member hedge clause appears only when staleMutedMembersCount > 0 — including when mutedMembersCount is itself zero — and all FIFTEEN signals zero -> null (issue #403)', () => {
  assert.equal(
    buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    null,
    'all fifteen signals zero — including the new stale-muted-member upper bound — is a quiet week',
  );

  // mutedMembersCount > 0, staleMutedMembersCount = 0 (default/unset-window
  // case) — byte-identical to the pre-#403 bare form.
  const bare = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0);
  assert.ok(bare);
  const bareLine = bare.split('\n').find((l) => l.includes('🔇'));
  assert.match(
    bareLine!,
    /^🔇 4 member\(s\) currently muted — run `moderation_history` or `clear_warnings` to review\.$/,
    'with nothing stale, the muted-members line is byte-identical to its pre-#403 form',
  );

  // Both > 0 — the extended, hedged wording.
  const extended = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 2);
  assert.ok(extended);
  const extendedLine = extended.split('\n').find((l) => l.includes('🔇'));
  assert.match(
    extendedLine!,
    /^🔇 4 member\(s\) currently muted \(2 more may still be muted from an earlier strike that's since aged out — check moderation_history\) — run `moderation_history` or `clear_warnings` to review\.$/,
  );

  // The central case this issue exists to fix: mutedMembersCount is ZERO
  // (nobody is currently over the windowed limit) but staleMutedMembersCount
  // is not — this cohort must still surface, not stay invisible.
  const invisibleCohort = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3);
  assert.ok(
    invisibleCohort,
    'a non-zero stale-muted count alone, even with zero currently-muted members, must still produce a DM',
  );
  const invisibleLine = invisibleCohort.split('\n').find((l) => l.includes('🔇'));
  assert.match(
    invisibleLine!,
    /^🔇 0 member\(s\) currently muted \(3 more may still be muted from an earlier strike that's since aged out — check moderation_history\) — run `moderation_history` or `clear_warnings` to review\.$/,
  );

  assert.ok(
    !buildAdminDigestMessage([], 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)!.includes('🔇'),
    'no muted-member line at all when both counts are zero',
  );
});

test('SECURITY: the stale-muted-member hedge clause is a deterministic function of staleMutedMembersCount only, and never carries a warning reason, excerpt, user id, or member name (issue #403)', () => {
  const secretReason = 'bad language ("very identifiable slur")';
  const secretExcerpt = 'the exact offending message text';
  const secretUserId = 'discord-user-1122334455';
  const secretName = 'Very Identifiable Stale Member Name';

  // buildAdminDigestMessage never receives warning row content — only the
  // bare counts — so there is nothing to smuggle in via an unrelated
  // parameter either (same shape as the #357 muted-member privacy pin).
  const a = buildAdminDigestMessage(
    [{ representative: secretReason, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    5,
    0,
    0,
    0,
    0,
    0,
    0,
    2,
  );
  const b = buildAdminDigestMessage(
    [{ representative: secretExcerpt, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    5,
    0,
    0,
    0,
    0,
    0,
    0,
    2,
  );
  assert.ok(a && b);
  const mutedLine = (m: string) => m.split('\n').find((l) => l.includes('🔇'));
  assert.equal(
    mutedLine(a),
    mutedLine(b),
    'the stale-muted hedge clause is unaffected by unrelated content passed through other parameters',
  );
  assert.match(
    mutedLine(a)!,
    /^🔇 5 member\(s\) currently muted \(2 more may still be muted from an earlier strike that's since aged out — check moderation_history\) — run `moderation_history` or `clear_warnings` to review\.$/,
  );
  assert.ok(
    !mutedLine(a)!.includes(secretReason) &&
      !mutedLine(a)!.includes(secretExcerpt) &&
      !mutedLine(a)!.includes(secretUserId) &&
      !mutedLine(a)!.includes(secretName),
    'SECURITY: no warning reason, excerpt, user id, or member name ever appears in the stale-muted hedge clause — bare counts only',
  );
});

test('buildAdminDigestMessage: near-duplicate/conflict-candidate knowledge lines each appear only when their own count > 0, and all FOURTEEN signals zero -> null (issue #378)', () => {
  assert.equal(
    buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    null,
    'all fourteen signals zero — including the two new knowledge-pair counts — is a quiet week',
  );

  const dupOnly = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0);
  assert.ok(dupOnly, 'a non-zero near-duplicate-knowledge count alone still produces a DM');
  const dupLines = dupOnly.split('\n').filter((l) => l.includes('🔀'));
  assert.equal(dupLines.length, 1, 'exactly one near-duplicate-knowledge line');
  assert.match(
    dupLines[0],
    /^🔀 6 near-duplicate knowledge pair\(s\) — run `list_duplicate_knowledge` to review\.$/,
  );
  assert.ok(!dupOnly.includes('⚖️'), 'no conflict-candidate line when that count is zero');

  const conflictOnly = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4);
  assert.ok(conflictOnly, 'a non-zero conflict-candidate-knowledge count alone still produces a DM');
  const conflictLines = conflictOnly.split('\n').filter((l) => l.includes('⚖️'));
  assert.equal(conflictLines.length, 1, 'exactly one conflict-candidate-knowledge line');
  assert.match(
    conflictLines[0],
    /^⚖️ 4 conflict-candidate knowledge pair\(s\) that may disagree — run `list_knowledge_conflicts` to review\.$/,
  );
  assert.ok(!conflictOnly.includes('🔀'), 'no near-duplicate line when that count is zero');

  assert.ok(
    !buildAdminDigestMessage([], 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)!.includes('🔀') &&
      !buildAdminDigestMessage([], 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)!.includes('⚖️'),
    'neither new line appears when both counts are zero',
  );
});

test('buildAdminDigestMessage: the near-duplicate-knowledge and conflict-candidate-knowledge lines never contain a knowledge entry id, title, or content — only the bare count (issue #378 privacy pin)', () => {
  const message = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3);
  assert.ok(message);
  assert.ok(!/title|content/i.test(message), 'no pair field name or content ever leaks into the digest text');
});

test('SECURITY: the near-duplicate and conflict-candidate knowledge lines are a deterministic function of their count integers only, and never carry a knowledge entry id, title, or content (issue #378)', () => {
  const secretTitle = 'A Very Identifiable Knowledge Entry Title';
  const secretContent = 'a very identifiable knowledge entry body that must never leak';

  // buildAdminDigestMessage never receives pair row content — only the bare
  // counts — so there is nothing to smuggle in via an unrelated parameter
  // either (same shape as the muted-member/max-turns privacy pins above).
  const a = buildAdminDigestMessage(
    [{ representative: secretTitle, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    9,
    5,
  );
  const b = buildAdminDigestMessage(
    [{ representative: secretContent, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    9,
    5,
  );
  assert.ok(a && b);
  const dupLine = (m: string) => m.split('\n').find((l) => l.includes('🔀'));
  const conflictLine = (m: string) => m.split('\n').find((l) => l.includes('⚖️'));
  assert.equal(
    dupLine(a),
    dupLine(b),
    'the near-duplicate-knowledge line is unaffected by unrelated content passed through other parameters',
  );
  assert.equal(
    conflictLine(a),
    conflictLine(b),
    'the conflict-candidate-knowledge line is unaffected by unrelated content passed through other parameters',
  );
  assert.match(
    dupLine(a)!,
    /^🔀 9 near-duplicate knowledge pair\(s\) — run `list_duplicate_knowledge` to review\.$/,
  );
  assert.match(
    conflictLine(a)!,
    /^⚖️ 5 conflict-candidate knowledge pair\(s\) that may disagree — run `list_knowledge_conflicts` to review\.$/,
  );
  assert.ok(
    !dupLine(a)!.includes(secretTitle) &&
      !dupLine(a)!.includes(secretContent) &&
      !conflictLine(a)!.includes(secretTitle) &&
      !conflictLine(a)!.includes(secretContent),
    'SECURITY: no knowledge entry id, title, or content ever appears in either line — bare count only',
  );
});

test('buildAdminDigestMessage: onboarding-queue line appears only when notMembersCount > 0, and all SIXTEEN signals zero -> null (issue #460)', () => {
  assert.equal(
    buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    null,
    'all sixteen signals zero — including the new onboarding-queue count — is a quiet week',
  );

  const message = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3);
  assert.ok(message);
  const line = message.split('\n').find((l) => l.includes('🆕'));
  assert.match(
    line!,
    /^🆕 3 guest\(s\) joined but haven't been added as a member yet — run `list_roster` \(filter: not_members\) to review\.$/,
  );

  assert.ok(
    !buildAdminDigestMessage([], 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)!.includes('🆕'),
    'no onboarding-queue line when notMembersCount is zero, even though the DM is non-empty',
  );
});

test('buildAdminDigestMessage: notMembersCount omitted (default 0) -> output is byte-identical to the pre-#460 form (issue #460)', () => {
  const before = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0);
  const after = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0);
  assert.equal(
    after,
    before,
    'notMembersCount defaulting to 0 must not change any existing call site output',
  );
});

test('SECURITY: the onboarding-queue line is a deterministic function of notMembersCount only, and never carries a display name, user id, or joined_at (issue #460)', () => {
  const secretName = 'Very Identifiable Guest Display Name';
  const secretUserId = 'discord-user-9988776655';

  // buildAdminDigestMessage never receives roster row content — only the bare
  // count — so there is nothing to smuggle in via an unrelated parameter
  // either (same shape as the roster-growth/muted-member privacy pins above).
  const a = buildAdminDigestMessage(
    [{ representative: secretName, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    7,
  );
  const b = buildAdminDigestMessage(
    [{ representative: secretUserId, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    7,
  );
  assert.ok(a && b);
  const queueLine = (m: string) => m.split('\n').find((l) => l.includes('🆕'));
  assert.equal(
    queueLine(a),
    queueLine(b),
    'the onboarding-queue line is unaffected by unrelated content passed through other parameters',
  );
  assert.match(
    queueLine(a)!,
    /^🆕 7 guest\(s\) joined but haven't been added as a member yet — run `list_roster` \(filter: not_members\) to review\.$/,
  );
  assert.ok(
    !queueLine(a)!.includes(secretName) && !queueLine(a)!.includes(secretUserId),
    'SECURITY: no display name, user id, or joined_at ever appears in the onboarding-queue line — bare count only',
  );
});

test('buildAdminDigestMessage: escalated-knowledge-gap line appears only when escalatedKnowledgeGapsCount > 0, nested under the existing knowledge-gaps line, and is absent even when the base gap count is > 0 (issue #514)', () => {
  // Base knowledge-gaps line present, escalated sub-count 0 (default,
  // omitted) — output must be byte-identical to the pre-#514 form.
  const withoutEscalated = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 5);
  assert.ok(withoutEscalated);
  assert.ok(withoutEscalated.includes('🕳️'), 'sanity: base knowledge-gaps line present');
  assert.ok(
    !withoutEscalated.includes('🆘'),
    'no escalated line when escalatedKnowledgeGapsCount is 0/omitted',
  );

  // Base gap count 5, escalated sub-count 2 -> both lines present, escalated
  // phrased as a subset ("N of those").
  const withEscalated = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    5,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    2,
  );
  assert.ok(withEscalated);
  const escalatedLine = withEscalated.split('\n').find((l) => l.includes('🆘'));
  assert.match(
    escalatedLine!,
    /^🆘 2 of those were member-flagged \(asked a human directly\) — start here\.$/,
  );

  // Escalated count alone (base gap count 0) must never surface the
  // escalated line on its own — it only ever renders nested under the base
  // gap line, since it is always a strict subset of it in real usage.
  const escalatedWithoutBase = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    2,
  );
  assert.ok(
    !escalatedWithoutBase || !escalatedWithoutBase.includes('🆘'),
    'the escalated line never appears without the base knowledge-gaps line being present',
  );
});

test('buildAdminDigestMessage: escalatedKnowledgeGapsCount omitted (default 0) -> output is byte-identical to the pre-#514 form (issue #514)', () => {
  const before = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  const after = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  assert.equal(
    after,
    before,
    'escalatedKnowledgeGapsCount defaulting to 0 must not change any existing call site output',
  );
});

test('SECURITY: the escalated-knowledge-gap line is a deterministic function of escalatedKnowledgeGapsCount only, and never carries query_text or user id (issue #514)', () => {
  const secretQuery = 'a very identifiable escalated query mentioning a secret';
  const secretUserId = 'discord-user-1234567890';

  const a = buildAdminDigestMessage(
    [{ representative: secretQuery, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    5,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    3,
  );
  const b = buildAdminDigestMessage(
    [{ representative: secretUserId, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    5,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    3,
  );
  assert.ok(a && b);
  const escalatedLine = (m: string) => m.split('\n').find((l) => l.includes('🆘'));
  assert.equal(
    escalatedLine(a),
    escalatedLine(b),
    'the escalated line is unaffected by unrelated content passed through other parameters',
  );
  assert.match(
    escalatedLine(a)!,
    /^🆘 3 of those were member-flagged \(asked a human directly\) — start here\.$/,
  );
  assert.ok(
    !escalatedLine(a)!.includes(secretQuery) && !escalatedLine(a)!.includes(secretUserId),
    'SECURITY: no query_text or user id ever appears in the escalated-gap line — bare count only',
  );
});

test('buildAdminDigestMessage: general-unhelpful-answers line appears only when count > 0, and all SEVENTEEN signals zero -> null (issue #563)', () => {
  assert.equal(
    buildAdminDigestMessage(
      [],
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      undefined,
      null,
      null,
      null,
      0,
    ),
    null,
    'all seventeen signals zero — including general-unhelpful-answers — is a quiet week',
  );

  const message = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    3,
  );
  assert.ok(message, 'a non-zero general-unhelpful-answers count alone still produces a DM');
  const lines = message.split('\n').filter((l) => l.includes('⚠️'));
  assert.equal(lines.length, 1, 'exactly one general-unhelpful-answers line');
  assert.match(
    lines[0],
    /^⚠️ 3 general-knowledge answers rated unhelpful this week \(no knowledge-base grounding\) — run `list_answer_feedback` \(unhelpfulOnly\) to review\.$/,
  );
  assert.ok(!message.includes('👎'), 'no low-rated-knowledge line when that count is zero');

  assert.ok(
    !buildAdminDigestMessage(
      [],
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      undefined,
      null,
      null,
      null,
      0,
    )!.includes('⚠️'),
    'no general-unhelpful-answers line when the count is zero',
  );

  const singular = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    1,
  );
  assert.match(
    singular!,
    /^⚠️ 1 general-knowledge answer rated unhelpful this week \(no knowledge-base grounding\) — run `list_answer_feedback` \(unhelpfulOnly\) to review\.$/,
  );
});

test('SECURITY: the general-unhelpful-answers line is a deterministic function of generalUnhelpfulCount only, and never carries question text, answer content, comment text, or user id (issue #563)', () => {
  const secretQuestion = 'a very identifiable question about a secret internal system';
  const secretAnswer = 'a very identifiable answer text that must never leak';
  const secretComment = 'a very identifiable rater comment explaining why it was unhelpful';
  const secretUserId = 'discord-user-1234567890';

  const a = buildAdminDigestMessage(
    [{ representative: secretQuestion, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    4,
  );
  const b = buildAdminDigestMessage(
    [{ representative: `${secretAnswer} ${secretComment} ${secretUserId}`, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    4,
  );
  assert.ok(a && b);
  const line = (m: string) => m.split('\n').find((l) => l.includes('⚠️'));
  assert.equal(
    line(a),
    line(b),
    'the general-unhelpful-answers line is unaffected by unrelated content passed through other parameters',
  );
  assert.match(
    line(a)!,
    /^⚠️ 4 general-knowledge answers rated unhelpful this week \(no knowledge-base grounding\) — run `list_answer_feedback` \(unhelpfulOnly\) to review\.$/,
  );
  assert.ok(
    !line(a)!.includes(secretQuestion) &&
      !line(a)!.includes(secretAnswer) &&
      !line(a)!.includes(secretComment) &&
      !line(a)!.includes(secretUserId),
    'SECURITY: no question text, answer content, comment text, or user id ever appears in the general-unhelpful-answers line — bare count only',
  );
});

test('buildAdminDigestMessage: generalUnhelpfulCount omitted (default 0) -> output is byte-identical to the pre-#563 form (issue #563)', () => {
  const before = buildAdminDigestMessage([], 3, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  const after = buildAdminDigestMessage(
    [],
    3,
    5,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
  );
  assert.equal(
    before,
    after,
    'an explicit 0 for the new trailing param matches the pre-#563 omitted-param output',
  );
  assert.ok(!before!.includes('⚠️'), 'no general-unhelpful-answers line at the pre-#563 call shape');
});

test('buildAdminDigestMessage: the general-unhelpful-answers line trends via the existing trendSuffix mechanism, and renders no suffix when previousCounts is omitted (issue #563 acceptance criterion 5)', () => {
  const withTrend = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    { generalUnhelpfulCount: 1 },
    null,
    null,
    null,
    4,
  );
  assert.ok(withTrend);
  const trendLine = withTrend.split('\n').find((l) => l.includes('⚠️'));
  assert.equal(
    trendLine,
    '⚠️ 4 general-knowledge answers rated unhelpful this week (no knowledge-base grounding) — run `list_answer_feedback` (unhelpfulOnly) to review. (▲+3 since last week)',
    'the trend suffix appends exactly as every other signal line does',
  );

  const withoutTrend = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    4,
  );
  assert.ok(withoutTrend);
  const noTrendLine = withoutTrend.split('\n').find((l) => l.includes('⚠️'));
  assert.equal(
    noTrendLine,
    '⚠️ 4 general-knowledge answers rated unhelpful this week (no knowledge-base grounding) — run `list_answer_feedback` (unhelpfulOnly) to review.',
    'no previousCounts -> no suffix, same as every other signal',
  );
});

// answerFeedbackWeeklySummary overall helpful-rate line (issue #653) —
// VISION's own named answer-quality north star, unfiltered by
// knowledge-grounding or origin (the distinct denominator neither
// generalUnhelpfulCount above nor the auto-answer/addressed split below
// covers).
test('buildAdminDigestMessage: the overall-answer-helpful-rate line appears only when overallAnswerTotal > 0, and all TWENTY-THREE signals zero -> null (issue #653 acceptance criteria 2, 3)', () => {
  assert.equal(
    buildAdminDigestMessage(
      [],
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      undefined,
      null,
      null,
      null,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ),
    null,
    'all twenty-three signals zero — including the overall answer helpful-rate — is a quiet week',
  );

  const message = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    8,
    10,
  );
  assert.ok(message, 'a non-zero overall answer total alone still produces a DM');
  const lines = message.split('\n').filter((l) => l.includes('✅'));
  assert.equal(lines.length, 1, 'exactly one overall-answer-helpful-rate line');
  assert.equal(
    lines[0],
    '✅ Overall answer helpful-rate this week: 80% (8/10 ratings)',
    'exact bare-percentage-plus-counts wording',
  );

  const zeroMessage = buildAdminDigestMessage(
    [],
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  assert.ok(
    !zeroMessage!.includes('✅'),
    'no overall-answer-helpful-rate line when overallAnswerTotal is zero',
  );
});

test('SECURITY: buildAdminDigestMessage: a week with zero overall answer ratings renders no line and does not crash — byte-identical to the quiet-week convention every other signal follows, and a nonzero total with zero helpful ratings renders 0% rather than NaN (issue #653 acceptance criterion 8)', () => {
  const quiet = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  assert.equal(
    quiet,
    null,
    'zero overall answer ratings alongside every other signal at zero remains a quiet week',
  );

  const allUnhelpful = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    5,
  );
  assert.ok(allUnhelpful);
  const line = allUnhelpful.split('\n').find((l) => l.includes('✅'));
  assert.equal(
    line,
    '✅ Overall answer helpful-rate this week: 0% (0/5 ratings)',
    'SECURITY: a week with ratings but zero helpful ones renders 0%, never NaN/crash from the 0-over-total division',
  );
});

test('SECURITY: the overall-answer-helpful-rate line is a deterministic function of overallAnswerHelpful/overallAnswerTotal only, and never carries question text, answer content, comment text, or user id (issue #653 acceptance criterion 6)', () => {
  const secretQuestion = 'a very identifiable question about a secret internal system';
  const secretAnswer = 'a very identifiable answer text that must never leak';
  const secretComment = 'a very identifiable rater comment explaining why it was unhelpful';
  const secretUserId = 'discord-user-1234567890';

  const a = buildAdminDigestMessage(
    [{ representative: secretQuestion, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    3,
    4,
  );
  const b = buildAdminDigestMessage(
    [{ representative: `${secretAnswer} ${secretComment} ${secretUserId}`, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    3,
    4,
  );
  assert.ok(a && b);
  const line = (m: string) => m.split('\n').find((l) => l.includes('✅'));
  assert.equal(
    line(a),
    line(b),
    'the overall-answer-helpful-rate line is unaffected by unrelated content passed through other parameters',
  );
  assert.match(line(a)!, /^✅ Overall answer helpful-rate this week: 75% \(3\/4 ratings\)$/);
  assert.ok(
    !line(a)!.includes(secretQuestion) &&
      !line(a)!.includes(secretAnswer) &&
      !line(a)!.includes(secretComment) &&
      !line(a)!.includes(secretUserId),
    'SECURITY: no question text, answer content, comment text, or user id ever appears in the overall-answer-helpful-rate line — bare percentage and counts only',
  );
});

test('buildAdminDigestMessage: overallAnswerHelpful/overallAnswerTotal omitted (default 0) -> output is byte-identical to the pre-#653 form (issue #653 acceptance criterion 5)', () => {
  const before = buildAdminDigestMessage(
    [],
    3,
    5,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    2,
    9,
    2,
    40,
    4,
    1,
    4,
  );
  const after = buildAdminDigestMessage(
    [],
    3,
    5,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    2,
    9,
    2,
    40,
    4,
    1,
    4,
    0,
    0,
  );
  assert.equal(
    before,
    after,
    'an explicit 0 for both new trailing params matches the pre-#653 omitted-param output',
  );
  assert.ok(!before!.includes('✅'), 'no overall-answer-helpful-rate line at the pre-#653 call shape');
});

test('buildAdminDigestMessage: the overall-answer-helpful-rate line trends via the existing trendSuffix mechanism on overallAnswerTotal, and renders no suffix when previousCounts is omitted (issue #653 acceptance criterion 4)', () => {
  const withTrend = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    { overallAnswerTotal: 6 },
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    3,
    9,
  );
  assert.ok(withTrend);
  const trendLine = withTrend.split('\n').find((l) => l.includes('✅'));
  assert.equal(
    trendLine,
    '✅ Overall answer helpful-rate this week: 33% (3/9 ratings) (▲+3 since last week)',
    'the trend suffix appends exactly as every other signal line does',
  );

  const withoutTrend = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    3,
    9,
  );
  assert.ok(withoutTrend);
  const noTrendLine = withoutTrend.split('\n').find((l) => l.includes('✅'));
  assert.equal(
    noTrendLine,
    '✅ Overall answer helpful-rate this week: 33% (3/9 ratings)',
    'no previousCounts -> no suffix, same as every other signal',
  );
});

// answerFeedbackOriginSummary origin-split line (issue #592) — #477's own
// named helpful-ratio-vs-mention-mode success metric, finally surfaced.
test('buildAdminDigestMessage: the auto-answer-ratings line renders only when the auto-answer bucket has at least one rating, with the exact bare-ratio wording (issue #592 acceptance criterion 3)', () => {
  const quiet = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
  );
  assert.equal(quiet, null, 'zero auto-answer ratings AND every other signal zero -> no digest at all');

  const withRatings = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    9,
    2,
    40,
    4,
  );
  assert.ok(withRatings);
  const line = withRatings.split('\n').find((l) => l.includes('📊'));
  assert.equal(
    line,
    '📊 Auto-answer ratings: 82% helpful (9/11) vs 91% helpful (40/44) addressed.',
    'exact bare-ratio wording matching the proposal example',
  );
});

test('buildAdminDigestMessage: the auto-answer-ratings line still renders when there are zero addressed-mode ratings to compare against, degrading gracefully without a division by zero', () => {
  const message = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    3,
    1,
    0,
    0,
  );
  assert.ok(message);
  const line = message.split('\n').find((l) => l.includes('📊'));
  assert.equal(
    line,
    '📊 Auto-answer ratings: 75% helpful (3/4).',
    'no "vs ... addressed" comparison clause when the addressed bucket is empty',
  );
});

test('buildAdminDigestMessage: autoAnswerHelpful/autoAnswerUnhelpful/addressedHelpful/addressedUnhelpful omitted (default 0) -> output is byte-identical to the pre-#592 form (issue #592 acceptance criterion 4)', () => {
  const before = buildAdminDigestMessage([], 3, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  const after = buildAdminDigestMessage(
    [],
    3,
    5,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
  );
  assert.equal(
    before,
    after,
    'explicit zeros for the four new trailing params match the pre-#592 omitted-param output',
  );
  assert.ok(!before!.includes('📊'), 'no auto-answer-ratings line at the pre-#592 call shape');
});

// Week-over-week trend on the auto-answer helpful ratio (issue #629) — the
// one digest line #497's trendSuffix mechanism never reached, and the one
// metric #477 itself named as auto-answer's own success criterion.
test('buildAdminDigestMessage: the auto-answer-ratings line trends via pctTrendSuffix, both directions (issue #629 acceptance criterion 1)', () => {
  const increase = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    { autoAnswerHelpfulPct: 70 },
    null,
    null,
    null,
    0,
    9,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  assert.ok(increase);
  assert.equal(
    increase.split('\n').find((l) => l.includes('📊')),
    '📊 Auto-answer ratings: 82% helpful (9/11). ▲ 12.0pp since last week.',
    "a rise from 70% to 82% renders the exact ▲ N.Npp suffix, #597's pp wording verbatim",
  );

  const decrease = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    { autoAnswerHelpfulPct: 90 },
    null,
    null,
    null,
    0,
    9,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  assert.ok(decrease);
  assert.equal(
    decrease.split('\n').find((l) => l.includes('📊')),
    '📊 Auto-answer ratings: 82% helpful (9/11). ▼ 8.0pp since last week.',
    'a fall from 90% to 82% renders the exact ▼ N.Npp suffix',
  );
});

test('buildAdminDigestMessage: the auto-answer-ratings line renders no suffix on an unchanged percentage, and none at all with no prior snapshot / missing key (issue #629 acceptance criteria 2, 3)', () => {
  const unchanged = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    { autoAnswerHelpfulPct: 82 },
    null,
    null,
    null,
    0,
    9,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  const noSnapshot = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    9,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  const missingKey = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    { openReports: 3 },
    null,
    null,
    null,
    0,
    9,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
  );

  assert.ok(unchanged && noSnapshot && missingKey);
  const line = (m: string) => m.split('\n').find((l) => l.includes('📊'));
  assert.equal(
    line(unchanged),
    '📊 Auto-answer ratings: 82% helpful (9/11).',
    'previous 82% -> current 82% is unchanged — silent, not "No change" (matching trendSuffix, not #597\'s alert form)',
  );
  assert.equal(
    line(noSnapshot),
    '📊 Auto-answer ratings: 82% helpful (9/11).',
    'no previousCounts at all -> byte-identical to the pre-#629 line',
  );
  assert.equal(
    line(missingKey),
    '📊 Auto-answer ratings: 82% helpful (9/11).',
    'a previousCounts snapshot that simply never had this key -> no suffix, no crash',
  );
  assert.equal(line(unchanged), line(noSnapshot), 'unchanged and no-prior-data render byte-identically');
});

test('SECURITY: the auto-answer trend suffix is a deterministic function of the two helpful/unhelpful count pairs and the prior snapshot only, and never carries message content, question text, or rater identity (issue #629 acceptance criterion 5)', () => {
  const secretRaterId = 'discord-user-9988776655';
  const message = buildAdminDigestMessage(
    [{ representative: `a secret question by ${secretRaterId}`, count: 1 }],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    { autoAnswerHelpfulPct: 70 },
    null,
    null,
    null,
    0,
    9,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  assert.ok(message);
  const line = message.split('\n').find((l) => l.includes('📊'));
  assert.ok(line, 'the auto-answer line renders');
  assert.match(
    line,
    /^📊 Auto-answer ratings: \d+% helpful \(\d+\/\d+\)( vs \d+% helpful \(\d+\/\d+\) addressed)?\.( [▲▼] \d+\.\d+pp since last week\.)?$/,
    'the whole line, trend suffix included, is numeric/symbol text only',
  );
  assert.ok(
    !line.includes(secretRaterId),
    'SECURITY: no rater/asker identity ever appears in the auto-answer trend line',
  );
});

test('buildAdminDigestMessage: open-appeals line appears only when openAppealsCount > 0, and all TWENTY signals zero -> null (issue #631 acceptance criteria 2, 3)', () => {
  assert.equal(
    buildAdminDigestMessage(
      [],
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      undefined,
      null,
      null,
      null,
      0,
      0,
      0,
      0,
      0,
      0,
    ),
    null,
    'all twenty signals zero — including open appeals — is a quiet week',
  );

  const message = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    3,
  );
  assert.ok(message, 'a non-zero open-appeals count alone still produces a DM');
  const appealLines = message.split('\n').filter((l) => l.includes('📋'));
  assert.equal(appealLines.length, 1, 'exactly one open-appeals line');
  assert.match(
    appealLines[0],
    /^📋 3 open moderation appeal\(s\) awaiting review — run `list_appeals` to review\.$/,
  );

  const zeroMessage = buildAdminDigestMessage(
    [],
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  assert.ok(!zeroMessage!.includes('📋'), 'no open-appeals line when the count is zero');
});

test('buildAdminDigestMessage: open-appeals line carries the standard trendSuffix delta (issue #631 acceptance criterion 4)', () => {
  const message = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    { openAppealsCount: 1 },
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    3,
  );
  assert.ok(message);
  const appealLine = message.split('\n').find((l) => l.includes('📋'));
  assert.equal(
    appealLine,
    '📋 3 open moderation appeal(s) awaiting review — run `list_appeals` to review. (▲+2 since last week)',
    'previous 1 -> current 3 renders exactly ▲+2, the same trendSuffix convention every other signal gets',
  );
});

test('buildAdminDigestMessage: unreachable-source-knowledge line appears only when unreachableSourceKnowledgeCount > 0, and all TWENTY-ONE signals zero -> null (issue #624 acceptance criteria 2, 3)', () => {
  assert.equal(
    buildAdminDigestMessage(
      [],
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      undefined,
      null,
      null,
      null,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ),
    null,
    'all twenty-one signals zero — including unreachable-source-knowledge — is a quiet week',
  );

  const message = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    4,
  );
  assert.ok(message, 'a non-zero unreachable-source-knowledge count alone still produces a DM');
  const linkLines = message.split('\n').filter((l) => l.includes('🔗'));
  assert.equal(linkLines.length, 1, 'exactly one unreachable-source-knowledge line');
  assert.match(
    linkLines[0],
    /^🔗 4 knowledge entries with an unreachable source link — run `list_knowledge` \(filter: sourceUnreachable\) to review\.$/,
  );

  const zeroMessage = buildAdminDigestMessage(
    [],
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  assert.ok(!zeroMessage!.includes('🔗'), 'no unreachable-source-knowledge line when the count is zero');
});

test('buildAdminDigestMessage: unreachable-source-knowledge line singular/plural and trendSuffix delta (issue #624)', () => {
  const singular = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    undefined,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
  );
  assert.ok(singular);
  const singularLine = singular.split('\n').find((l) => l.includes('🔗'));
  assert.match(
    singularLine!,
    /^🔗 1 knowledge entry with an unreachable source link — run `list_knowledge` \(filter: sourceUnreachable\) to review\.$/,
    'singular "entry" wording at count 1',
  );

  const withTrend = buildAdminDigestMessage(
    [],
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    { unreachableSourceKnowledgeCount: 1 },
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    3,
  );
  assert.ok(withTrend);
  const trendLine = withTrend.split('\n').find((l) => l.includes('🔗'));
  assert.equal(
    trendLine,
    '🔗 3 knowledge entries with an unreachable source link — run `list_knowledge` (filter: sourceUnreachable) to review. (▲+2 since last week)',
    'previous 1 -> current 3 renders exactly ▲+2, the same trendSuffix convention every other signal gets',
  );
});

test('SECURITY: buildAdminDigestMessage: previousCounts omitted -> byte-identical to the pre-#497 form, no trend suffix anywhere even with several non-zero signals (issue #497 acceptance criteria 1, 7)', () => {
  const before = buildAdminDigestMessage([], 3, 5, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 2, 0);
  const after = buildAdminDigestMessage(
    [],
    3,
    5,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    4,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    2,
    0,
    // escalatedKnowledgeGapsCount (issue #514), inserted ahead of
    // previousCounts by the #514/#497 merge — 0 keeps this call's shape
    // (and thus its output) identical to the pre-#514 positional layout.
    0,
    undefined,
  );
  assert.ok(before && after);
  assert.equal(
    after,
    before,
    'an explicit `undefined` previousCounts must render identically to omitting it',
  );
  assert.ok(
    !/▲|▼|since last week/.test(after),
    'SECURITY: with no previousCounts, no line ever gains a trend suffix',
  );
});

test('buildAdminDigestMessage: a signal whose count increased since previousCounts renders exactly the ▲+N suffix (issue #497 acceptance criterion 2)', () => {
  const message = buildAdminDigestMessage([], 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, {
    openReports: 2,
  });
  assert.ok(message);
  const line = message.split('\n').find((l) => l.includes('🚩'));
  assert.equal(
    line,
    '🚩 5 open report(s) in your conversations — run `list_reports`. (▲+3 since last week)',
    'the line ends with exactly the arithmetic difference, ▲-prefixed',
  );
});

test('buildAdminDigestMessage: a signal whose count decreased since previousCounts renders exactly the ▼-N suffix (issue #497 acceptance criterion 3)', () => {
  const message = buildAdminDigestMessage([], 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, {
    openReports: 8,
  });
  assert.ok(message);
  const line = message.split('\n').find((l) => l.includes('🚩'));
  assert.equal(
    line,
    '🚩 5 open report(s) in your conversations — run `list_reports`. (▼-3 since last week)',
    'the line ends with exactly the arithmetic difference, ▼-prefixed',
  );
});

test('buildAdminDigestMessage: a signal whose count is unchanged since previousCounts renders no suffix, independent of another signal that DID change (issue #497 acceptance criterion 4)', () => {
  const message = buildAdminDigestMessage([], 4, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, {
    openReports: 5,
    pendingAccessRequests: 1,
  });
  assert.ok(message);
  const reportLine = message.split('\n').find((l) => l.includes('🚩'));
  const requestLine = message.split('\n').find((l) => l.includes('⏳'));
  assert.equal(
    reportLine,
    '🚩 5 open report(s) in your conversations — run `list_reports`.',
    'openReports is unchanged (5 -> 5) — no suffix, no clutter',
  );
  assert.equal(
    requestLine,
    '⏳ 4 pending access request(s) — run `list_access_requests`. (▲+3 since last week)',
    'pendingAccessRequests changed independently — its own suffix still renders',
  );
});

test('buildAdminDigestMessage: a signal absent from a partial previousCounts snapshot renders no suffix for that signal only (issue #497 acceptance criterion 5)', () => {
  // previousCounts has an entry for openReports but none for
  // pendingAccessRequests — e.g. a snapshot taken before a newer signal
  // existed. The missing key must render as "no trend", not throw or
  // fall back to some other value.
  const message = buildAdminDigestMessage([], 4, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, {
    openReports: 2,
  });
  assert.ok(message);
  const reportLine = message.split('\n').find((l) => l.includes('🚩'));
  const requestLine = message.split('\n').find((l) => l.includes('⏳'));
  assert.equal(
    reportLine,
    '🚩 5 open report(s) in your conversations — run `list_reports`. (▲+3 since last week)',
    'openReports has a snapshot entry — its suffix renders',
  );
  assert.equal(
    requestLine,
    '⏳ 4 pending access request(s) — run `list_access_requests`.',
    'pendingAccessRequests has no snapshot entry — no suffix, not an error',
  );
});

test('buildAdminDigestMessage: the roster-growth line trends joinedThisWeek and leftThisWeek independently (issue #497)', () => {
  const message = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, {
    joinedThisWeek: 1,
    leftThisWeek: 5,
  });
  assert.ok(message);
  const line = message.split('\n').find((l) => l.includes('📈'));
  assert.equal(
    line,
    '📈 4 joined (▲+3 since last week), 2 left (▼-3 since last week) this week — run `list_roster` for detail.',
    'each of the two independent signals gets its own trend suffix, placed right after its own number',
  );
});

test('buildAdminDigestMessage: the muted-member line trends mutedMembersCount and staleMutedMembersCount independently (issue #497)', () => {
  const message = buildAdminDigestMessage([], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 2, 0, 0, {
    mutedMembersCount: 1,
    staleMutedMembersCount: 0,
  });
  assert.ok(message);
  const line = message.split('\n').find((l) => l.includes('🔇'));
  assert.equal(
    line,
    '🔇 3 member(s) currently muted (▲+2 since last week) (2 more may still be muted from an earlier ' +
      "strike that's since aged out — check moderation_history (▲+2 since last week)) — run " +
      '`moderation_history` or `clear_warnings` to review.',
    'both the base muted count and the stale hedge clause get their own independent trend suffix',
  );
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
      // runAdminDigestOnce iterates EVERY admin in the global community_users
      // table (listAdmins is not test-scoped), so a concurrently-running test
      // file's admin would otherwise be handed to this same fake adapter and
      // inflate `sent`, making the `sent.length` assertions flaky (issue
      // #224). Record only sends addressed to THIS run's admins.
      if (!userId.startsWith(RUN)) return;
      opts.sent.push({ userId, text });
    },
    async conversationsForUser(userId) {
      // Same isolation: only this run's admins "participate" in the fake's
      // conversations. A foreign admin then computes zero in-scope
      // clusters/reports and never triggers a send — which would otherwise
      // also write that admin's freshness row as a cross-file side effect.
      return userId.startsWith(RUN) ? opts.conversationIds : [];
    },
    async performAdminAction() {
      return '';
    },
  };
}

// --- issue #385: runAdminDigestOnce now signals total failure to
// startTrackedJob (previously listAdmins() failures were caught-and-returned,
// and the per-admin loop swallowed every error and continued — so the
// consecutive-failure tracker wired up below could never trip, the exact
// #335 trap). These four tests pin the throw-signal shape directly.

test('runAdminDigestOnce: throws when listAdmins() itself rejects, instead of silently swallowing the failure into a return (issue #385)', async (t) => {
  t.mock.method(pool, 'query', async () => {
    throw new Error('sentinel-listadmins-rejected');
  });

  await assert.rejects(() => runAdminDigestOnce([]), /sentinel-listadmins-rejected/);
});

test(
  "runAdminDigestOnce: throws when at least one admin is attempted and every attempted admin fails — a rejecting sendDirectMessage propagates as a per-admin failure (issue #385, applying #335's total-failure fix)",
  { skip },
  async () => {
    const adminId = `${RUN}-run-totalfail-admin`;
    const requesterId = `${RUN}-run-totalfail-requester`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });
    // A pending access request guarantees a non-null digest message, so
    // sendDirectMessage is actually reached (a quiet week would `continue`
    // before ever calling it, which would prove nothing about the throw path).
    await recordAccessRequest({ platform: 'discord', userId: requesterId, userName: 'guest' });

    const baseAdapter = fakeAdapter({
      platform: 'discord',
      conversationIds: [`${RUN}-c-totalfail-empty`],
      sent: [],
    });
    const adapter: PlatformAdapter = {
      ...baseAdapter,
      async sendDirectMessage() {
        throw new Error('sentinel-totalfail-send');
      },
    };

    await assert.rejects(() => runAdminDigestOnce([adapter]), /Admin digest: all 1 admin runs failed/);

    await clearAccessRequest('discord', requesterId);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
  },
);

test(
  'SECURITY: runAdminDigestOnce does NOT throw when only some admins fail — a single bad admin must never abort the others nor be mistaken for total job failure (issue #385, #335 partial-failure convention)',
  { skip },
  async () => {
    const okAdminId = `${RUN}-partial-ok-admin`;
    const failAdminId = `${RUN}-partial-fail-admin`;
    await upsertMember({ platform: 'discord', userId: okAdminId, role: 'admin', addedBy: `${RUN}-actor` });
    await upsertMember({ platform: 'discord', userId: failAdminId, role: 'admin', addedBy: `${RUN}-actor` });

    const sent: Array<{ userId: string; text: string }> = [];
    const baseAdapter = fakeAdapter({
      platform: 'discord',
      conversationIds: [`${RUN}-c-partial-empty`],
      sent,
    });
    const adapter: PlatformAdapter = {
      ...baseAdapter,
      async conversationsForUser(userId) {
        if (userId === failAdminId) throw new Error('sentinel-partial-admin-failure');
        return baseAdapter.conversationsForUser(userId);
      },
    };

    await assert.doesNotReject(() => runAdminDigestOnce([adapter]));

    await pool.query(
      `DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = ANY($1)`,
      [[okAdminId, failAdminId]],
    );
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = ANY($1)`, [
      [okAdminId, failAdminId],
    ]);
  },
);

test(
  'runAdminDigestOnce: resolves without throwing when no adapter is connected for any admin — a legitimate zero-attempt run, same as zero enrolled admins (issue #385)',
  { skip },
  async () => {
    await assert.doesNotReject(() => runAdminDigestOnce([]));
  },
);

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
  'repository: getLastDigestCounts returns null when the admin has no prior admin_digest_sends row (issue #497)',
  { skip },
  async () => {
    const adminId = `${RUN}-trend-nosnapshot-admin`;
    assert.equal(
      await getLastDigestCounts('discord', adminId),
      null,
      'a first-ever digest has no prior row at all — null, not an empty object',
    );
  },
);

test(
  'repository: recordAdminDigestSent(..., counts) persists a sanitized last_counts snapshot alongside the freshness timestamp (issue #497)',
  { skip },
  async () => {
    const adminId = `${RUN}-trend-recordsent-admin`;

    await recordAdminDigestSent('discord', adminId, { openReports: 3, pendingAccessRequests: 1 });

    assert.deepEqual(
      await getLastDigestCounts('discord', adminId),
      { openReports: 3, pendingAccessRequests: 1 },
      'the exact counts passed in are persisted',
    );
    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'passing counts must not change the existing freshness-timestamp behaviour',
    );

    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'repository: recordAdminDigestSent without counts leaves an existing last_counts snapshot untouched, while still renewing the freshness timestamp (issue #497)',
  { skip },
  async () => {
    const adminId = `${RUN}-trend-omitcounts-admin`;

    await recordAdminDigestSent('discord', adminId, { openReports: 5 });
    await pool.query(
      `UPDATE admin_digest_sends SET sent_at = now() - interval '8 days'
        WHERE platform = $1 AND platform_user_id = $2`,
      ['discord', adminId],
    );

    await recordAdminDigestSent('discord', adminId); // legacy call site — no counts argument

    assert.deepEqual(
      await getLastDigestCounts('discord', adminId),
      { openReports: 5 },
      'omitting counts must leave a prior snapshot exactly as it was',
    );
    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'the freshness timestamp is still renewed even when no counts are passed',
    );

    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'repository: recordAdminDigestSnapshot on a brand-new admin writes last_counts but never advances the freshness guard (issue #497 acceptance criterion 6)',
  { skip },
  async () => {
    const adminId = `${RUN}-trend-snapshot-fresh-admin`;

    await recordAdminDigestSnapshot('discord', adminId, { openReports: 2 });

    assert.deepEqual(await getLastDigestCounts('discord', adminId), { openReports: 2 });
    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      false,
      'a snapshot-only write for a brand-new admin must never register as "sent recently"',
    );

    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'repository: recordAdminDigestSnapshot on an admin with a real prior send updates last_counts WITHOUT disturbing sent_at (issue #497 acceptance criterion 6)',
  { skip },
  async () => {
    const adminId = `${RUN}-trend-snapshot-existing-admin`;

    await recordAdminDigestSent('discord', adminId, { openReports: 1 });
    const { rows: before } = await pool.query<{ sent_at: string }>(
      `SELECT sent_at FROM admin_digest_sends WHERE platform = 'discord' AND platform_user_id = $1`,
      [adminId],
    );

    await recordAdminDigestSnapshot('discord', adminId, { openReports: 9 });

    const { rows: after } = await pool.query<{ sent_at: string }>(
      `SELECT sent_at FROM admin_digest_sends WHERE platform = 'discord' AND platform_user_id = $1`,
      [adminId],
    );
    assert.deepEqual(await getLastDigestCounts('discord', adminId), { openReports: 9 });
    assert.equal(
      new Date(before[0].sent_at).getTime(),
      new Date(after[0].sent_at).getTime(),
      'a snapshot-only write must not change sent_at on an existing row either',
    );

    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'SECURITY: repository: recordAdminDigestSent/recordAdminDigestSnapshot never persist a key outside the known digest signal set or a non-integer value into last_counts (issue #497 acceptance criterion 8)',
  { skip },
  async () => {
    const adminId1 = `${RUN}-trend-sanitize-sent-admin`;
    const adminId2 = `${RUN}-trend-sanitize-snapshot-admin`;
    // Cast past the compile-time Record<string, number> shape to simulate a
    // future call site that accidentally passes an unexpected field (a user
    // id) or a non-integer value — exactly what the whitelist must catch at
    // runtime, since TypeScript can't enforce this against a bad caller.
    const badCounts = {
      openReports: 2,
      secretUserId: 'discord-user-1234567890',
      fractionalNoise: 3.5,
    } as unknown as Record<string, number>;

    await recordAdminDigestSent('discord', adminId1, badCounts);
    assert.deepEqual(
      await getLastDigestCounts('discord', adminId1),
      { openReports: 2 },
      'SECURITY: only the known, integer-valued openReports key survives — no secretUserId, no fractionalNoise',
    );

    await recordAdminDigestSnapshot('discord', adminId2, badCounts);
    assert.deepEqual(
      await getLastDigestCounts('discord', adminId2),
      { openReports: 2 },
      'SECURITY: the snapshot-only write path enforces the identical whitelist',
    );

    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = ANY($1)`, [
      [adminId1, adminId2],
    ]);
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
    // open reports in scope. countAccessRequests/countPendingSuggestions/
    // countPendingKnowledgeCandidates are guild-wide by design (issue #133,
    // #193, #284) and so are NOT test-isolated by a unique id — snapshot them
    // immediately beforehand so this assertion holds even if another test
    // file concurrently has a pending access request, suggestion, or
    // knowledge candidate in flight.
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [`${RUN}-c-empty`], sent });
    const pendingAccessRequestsBefore = await countAccessRequests();
    const pendingSuggestionsBefore = await countPendingSuggestions();
    const pendingCandidatesBefore = await countPendingKnowledgeCandidates();

    await runAdminDigestOnce([adapter]);

    if (
      pendingAccessRequestsBefore === 0 &&
      pendingSuggestionsBefore === 0 &&
      pendingCandidatesBefore === 0
    ) {
      assert.equal(
        sent.length,
        0,
        'zero clusters, zero pending requests, zero open reports, zero pending suggestions, zero pending candidates — no DM sent',
      );
      assert.equal(
        await wasAdminDigestSentRecently('discord', adminId, 7),
        false,
        'a quiet run must not touch the freshness row (so a later clustered week is not skipped)',
      );
    } else {
      // Extremely rare in practice, but countAccessRequests/countPendingSuggestions/
      // countPendingKnowledgeCandidates are intentionally unscoped — a
      // concurrently-running test file's pending access request, suggestion,
      // or knowledge candidate legitimately makes this a non-quiet week, so
      // the digest correctly sends.
      assert.equal(
        sent.length,
        1,
        'a pre-existing pending access request, suggestion, or knowledge candidate still legitimately triggers a digest',
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
      /⏳ \d+ pending access request\(s\), oldest waiting \d+d — run `list_access_requests`\./,
      'the pending-access-request line is present, now with the oldest-request age (issue #515)',
    );
    assert.match(
      sent[0].text,
      /🚩 1 open report\(s\) in your conversations, oldest \d+d old — run `list_reports`\./,
      'the open-report line is present with the exact scoped count, now with the oldest-report age (issue #450)',
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
      /💡 \d+ pending suggestion\(s\), oldest \d+d old — run `list_suggestions`\./,
      'the pending-suggestion line is present, now with the oldest-suggestion age (issue #450)',
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

test(
  'SECURITY: countKnowledgeGaps is conversation-scoped, a true COUNT(*) (not LIMIT-bounded), and windowed (issue #246)',
  { skip },
  async () => {
    const inScope = `${RUN}-c-gaps-in`;
    const outOfScope = `${RUN}-c-gaps-out`;
    const userId = `${RUN}-gaps-user`;
    const insertGap = (conversationId: string, query: string, ageDays = 0) =>
      pool.query(
        `INSERT INTO knowledge_gaps (platform, conversation_id, user_id, query_text, created_at)
         VALUES ('discord', $1, $2, $3, now() - ($4 || ' days')::interval)`,
        [conversationId, userId, query, String(ageDays)],
      );
    // 12 recent in-scope (more than any list_knowledge_gaps limit), 3 recent
    // out-of-scope, and 1 in-scope but older than the 7-day window.
    for (let i = 0; i < 12; i++) await insertGap(inScope, `in-scope gap ${i}`);
    for (let i = 0; i < 3; i++) await insertGap(outOfScope, `out-of-scope gap ${i}`);
    await insertGap(inScope, 'stale in-scope gap', 30);

    assert.equal(
      await countKnowledgeGaps([inScope], 7),
      12,
      'SECURITY: a true COUNT(*) of the 12 recent in-scope rows — excludes the 3 out-of-scope rows and the 30-day-old one, and is not a LIMIT-bounded length',
    );
    assert.equal(
      await countKnowledgeGaps([inScope, outOfScope], 7),
      15,
      'counting across both scopes returns the full 15 recent rows (the count is not capped)',
    );
    assert.equal(await countKnowledgeGaps([], 7), 0, 'an empty scope counts nothing');

    await pool.query(`DELETE FROM knowledge_gaps WHERE conversation_id = ANY($1)`, [[inScope, outOfScope]]);
  },
);

test(
  'SECURITY: the digest knowledge-gaps line carries only the count — never a gap query_text or user id (issue #246)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-gaps-admin`;
    const conversationId = `${RUN}-c-run-gaps`;
    const gapUserId = `${RUN}-run-gaps-asker`;
    const secretQuery = 'a very identifiable unanswered question that must never leak';
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });
    await pool.query(
      `INSERT INTO knowledge_gaps (platform, conversation_id, user_id, query_text)
       VALUES ('discord', $1, $2, $3)`,
      [conversationId, gapUserId, secretQuery],
    );

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    await runAdminDigestOnce([adapter]);

    assert.equal(sent.length, 1, 'the in-scope knowledge gap triggers a digest');
    assert.match(
      sent[0].text,
      /🕳️ \d+ unanswered question\(s\).*`list_knowledge_gaps`/,
      'the knowledge-gaps line is present',
    );
    assert.ok(
      !sent[0].text.includes(secretQuery),
      'SECURITY: the raw query_text must never appear in the digest DM',
    );
    assert.ok(
      !sent[0].text.includes(gapUserId),
      'SECURITY: the asker user id must never appear in the digest DM',
    );

    await pool.query(`DELETE FROM knowledge_gaps WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'SECURITY: runAdminDigestOnce: an admin with zero clusters/requests/reports/suggestions/stale-knowledge/knowledge-gaps but ≥1 pending knowledge candidate still receives a digest containing only the bare count — never candidate title, content, or topic (issue #284 acceptance criteria)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-candidates-admin`;
    const secretTopic = `${RUN} a very identifiable topic that must never leak`;
    const secretTitle = 'a very identifiable drafted title that must never leak';
    const secretContent = 'a very identifiable drafted answer that must never leak';
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const digestId = await insertContextDigest({
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(),
      topic: secretTopic,
      summary: 'aggregate summary',
      exampleRefs: [],
      distinctUsers: 3,
      questionCount: 4,
    });
    const candidateId = await insertKnowledgeCandidate({
      digestId,
      topic: secretTopic,
      title: secretTitle,
      content: secretContent,
    });

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({
      platform: 'discord',
      conversationIds: [`${RUN}-c-candidates-empty`],
      sent,
    });

    await runAdminDigestOnce([adapter]);

    assert.equal(
      sent.length,
      1,
      'zero clusters/requests/reports/suggestions/stale-knowledge/knowledge-gaps today would previously mean ' +
        'no DM — a pending knowledge candidate now still triggers one',
    );
    assert.ok(!sent[0].text.includes('🔔'), 'no cluster line — this admin has zero clusters in scope');
    assert.match(
      sent[0].text,
      /🧩 \d+ pending knowledge candidate\(s\) — run `list_knowledge_candidates`\./,
      'the pending-knowledge-candidate line is present',
    );
    assert.ok(
      !sent[0].text.includes(secretTopic),
      'SECURITY: the raw candidate topic must never appear in the digest DM',
    );
    assert.ok(
      !sent[0].text.includes(secretTitle),
      'SECURITY: the raw candidate title must never appear in the digest DM',
    );
    assert.ok(
      !sent[0].text.includes(secretContent),
      'SECURITY: the raw candidate content must never appear in the digest DM',
    );

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'the freshness row is updated after a successful send',
    );

    await pool.query(`DELETE FROM knowledge_candidates WHERE id = $1`, [candidateId]);
    await pool.query(`DELETE FROM context_digests WHERE id = $1`, [digestId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

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
  'SECURITY: runAdminDigestOnce: an admin with all seven other signals at zero but ≥1 low-rated knowledge entry in scope still receives a digest containing only the bare count — never entry title or rater identity (issue #324 acceptance criteria)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-lowrated-admin`;
    const conversationId = `${RUN}-c-run-lowrated`;
    const secretTitle = `${RUN} a very identifiable knowledge entry title that must never leak`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const { id: entryId } = await saveKnowledge({
      content: `${RUN} low-rated entry content`,
      title: secretTitle,
    });
    const raters = [`${RUN}-run-lowrated-rater1`, `${RUN}-run-lowrated-rater2`];
    for (const raterId of raters) {
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `shortcut answer for ${raterId}`,
        meta: { replyToUserId: raterId, knowledgeShortcut: true, knowledgeEntryId: entryId },
      });
      expectFeedbackId(
        await createAnswerFeedback({ platform: 'discord', conversationId, userId: raterId, helpful: false }),
      );
    }

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    await runAdminDigestOnce([adapter]);

    assert.equal(
      sent.length,
      1,
      'zero clusters/requests/reports/suggestions/stale-knowledge/knowledge-gaps/candidates today would ' +
        'previously mean no DM — a low-rated knowledge entry now still triggers one',
    );
    assert.ok(!sent[0].text.includes('🔔'), 'no cluster line — this admin has zero clusters in scope');
    assert.match(
      sent[0].text,
      /👎 \d+ knowledge entr(?:y|ies) with repeated unhelpful ratings — run `list_low_rated_knowledge`/,
      'the low-rated-knowledge line is present',
    );
    assert.ok(
      !sent[0].text.includes(secretTitle),
      'SECURITY: the raw knowledge entry title must never appear in the digest DM',
    );
    assert.ok(
      !raters.some((r) => sent[0].text.includes(r)),
      'SECURITY: a rater user id must never appear in the digest DM',
    );

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'the freshness row is updated after a successful send',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [raters]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [entryId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'SECURITY: runAdminDigestOnce: the low-rated-knowledge count is scoped to the conversations the admin participates in, excluding a rating recorded outside that scope (issue #324)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-lowratedscope-admin`;
    const inScopeConvo = `${RUN}-c-run-lowratedscope-in`;
    const outOfScopeConvo = `${RUN}-c-run-lowratedscope-out`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const { id: outOfScopeEntryId } = await saveKnowledge({
      content: `${RUN} out-of-scope low-rated entry content`,
    });
    const outOfScopeRaters = [`${RUN}-run-lowratedscope-rater1`, `${RUN}-run-lowratedscope-rater2`];
    for (const raterId of outOfScopeRaters) {
      await recordInteraction({
        platform: 'discord',
        conversationId: outOfScopeConvo,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `shortcut answer for ${raterId}`,
        meta: { replyToUserId: raterId, knowledgeShortcut: true, knowledgeEntryId: outOfScopeEntryId },
      });
      expectFeedbackId(
        await createAnswerFeedback({
          platform: 'discord',
          conversationId: outOfScopeConvo,
          userId: raterId,
          helpful: false,
        }),
      );
    }

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [inScopeConvo], sent });

    // countAccessRequests/countPendingSuggestions/countPendingKnowledgeCandidates
    // are guild-wide by design (issues #133, #193, #284) and so are NOT
    // test-isolated by a unique id — snapshot them immediately beforehand,
    // same pattern as the "all four signals at zero" test above, so this
    // assertion holds even if another test file concurrently has one in flight.
    const pendingAccessRequestsBefore = await countAccessRequests();
    const pendingSuggestionsBefore = await countPendingSuggestions();
    const pendingCandidatesBefore = await countPendingKnowledgeCandidates();

    await runAdminDigestOnce([adapter]);

    if (
      pendingAccessRequestsBefore === 0 &&
      pendingSuggestionsBefore === 0 &&
      pendingCandidatesBefore === 0
    ) {
      assert.equal(
        sent.length,
        0,
        'SECURITY: a low-rated entry rated only in a conversation outside the admin scope must not trigger a digest',
      );
      assert.equal(
        await wasAdminDigestSentRecently('discord', adminId, 7),
        false,
        'a quiet run (out-of-scope-only signal) must not touch the freshness row',
      );
    } else {
      // Extremely rare in practice, but a concurrently-running test file's
      // pending access request, suggestion, or knowledge candidate legitimately
      // makes this a non-quiet week — the digest correctly sends, but must
      // still never carry the low-rated-knowledge line (its only source is the
      // out-of-scope conversation).
      assert.ok(
        !sent[0]?.text.includes('👎'),
        'SECURITY: still no low-rated-knowledge line — it is out of scope',
      );
    }

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [outOfScopeRaters]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [outOfScopeConvo]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [outOfScopeEntryId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'SECURITY: runAdminDigestOnce: the pending-knowledge-candidate count is guild-wide, not conversation/admin-scoped — two admins with disjoint conversation scopes and no other in-scope signals see the identical count (issue #284 acceptance criteria)',
  { skip },
  async () => {
    const admin1Id = `${RUN}-run-candscope-admin1`;
    const admin2Id = `${RUN}-run-candscope-admin2`;
    const convo1 = `${RUN}-c-candscope-1`;
    const convo2 = `${RUN}-c-candscope-2`;
    await upsertMember({ platform: 'discord', userId: admin1Id, role: 'admin', addedBy: `${RUN}-actor` });
    await upsertMember({ platform: 'discord', userId: admin2Id, role: 'admin', addedBy: `${RUN}-actor` });

    const digestId = await insertContextDigest({
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(),
      topic: `${RUN}-candscope-topic`,
      summary: 'aggregate summary',
      exampleRefs: [],
      distinctUsers: 3,
      questionCount: 4,
    });
    const candidateId = await insertKnowledgeCandidate({
      digestId,
      topic: `${RUN}-candscope-topic`,
      title: 'candscope drafted title',
      content: 'candscope drafted content',
    });

    const sent: Array<{ userId: string; text: string }> = [];
    // A scope map so each admin resolves to their OWN disjoint conversation —
    // proving the candidate count doesn't vary with either admin's scope,
    // unlike countOpenReports/recentQuestionClusters which deliberately do.
    const scopeByAdmin: Record<string, string[]> = { [admin1Id]: [convo1], [admin2Id]: [convo2] };
    const adapter: PlatformAdapter = {
      platform: 'discord',
      adminCapabilities: new Set(),
      async start() {},
      async stop() {},
      isConnected: () => true,
      onMessage() {},
      async sendMessage() {},
      async sendDirectMessage(userId, text) {
        if (!userId.startsWith(RUN)) return;
        sent.push({ userId, text });
      },
      async conversationsForUser(userId) {
        return scopeByAdmin[userId] ?? [];
      },
      async performAdminAction() {
        return '';
      },
    };

    await runAdminDigestOnce([adapter]);

    const admin1Msg = sent.find((s) => s.userId === admin1Id);
    const admin2Msg = sent.find((s) => s.userId === admin2Id);
    assert.ok(admin1Msg, 'admin 1 receives a digest despite zero clusters/reports in their own scope');
    assert.ok(admin2Msg, 'admin 2 receives a digest despite zero clusters/reports in their own scope');

    const candidateLine = (text: string) => text.split('\n').find((l) => l.includes('🧩'));
    const line1 = candidateLine(admin1Msg.text);
    const line2 = candidateLine(admin2Msg.text);
    assert.ok(line1, 'admin 1 sees the pending-knowledge-candidate line');
    assert.ok(line2, 'admin 2 sees the pending-knowledge-candidate line');
    assert.equal(
      line1,
      line2,
      'SECURITY: the pending-knowledge-candidate count must be identical across admins with disjoint ' +
        'conversation scopes — it is a guild-wide COUNT(*), never conversation-scoped',
    );

    await pool.query(`DELETE FROM knowledge_candidates WHERE id = $1`, [candidateId]);
    await pool.query(`DELETE FROM context_digests WHERE id = $1`, [digestId]);
    await pool.query(
      `DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = ANY($1)`,
      [[admin1Id, admin2Id]],
    );
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = ANY($1)`, [
      [admin1Id, admin2Id],
    ]);
  },
);

test(
  'runAdminDigestOnce: rosterCounts(admin.platform) joined/left counts pass through to the digest DM (issue #344)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-roster-admin`;
    const joinedUser1 = `${RUN}-roster-wire-joined1`;
    const joinedUser2 = `${RUN}-roster-wire-joined2`;
    const leftUser1 = `${RUN}-roster-wire-left1`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    // Two fresh joins and one fresh leave, isolated by unique RUN-prefixed
    // ids. rosterCounts is guild-wide by platform (not admin-scoped, per
    // list_roster's own unscoped behaviour), so a concurrently-running test
    // file could add more — assert lower bounds (>=), not exact equality,
    // the same tolerance repository.test.ts's own rosterCounts test uses.
    await upsertRosterMember({ platform: 'discord', userId: joinedUser1 });
    await upsertRosterMember({ platform: 'discord', userId: joinedUser2 });
    await upsertRosterMember({ platform: 'discord', userId: leftUser1 });
    await markRosterLeave('discord', leftUser1);

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({
      platform: 'discord',
      conversationIds: [`${RUN}-c-roster-wire-empty`],
      sent,
    });

    await runAdminDigestOnce([adapter]);

    assert.equal(
      sent.length,
      1,
      'the roster joins/leave alone trigger a digest — previously this would have been a quiet week',
    );
    const rosterLine = sent[0].text.split('\n').find((l) => l.includes('📈'));
    assert.ok(rosterLine, 'the roster-growth line is present');
    const match = rosterLine.match(
      /^📈 (\d+) joined(?:, (\d+) left)? this week — run `list_roster` for detail\.$/,
    );
    assert.ok(match, `roster line matches the expected format: ${rosterLine}`);
    assert.ok(
      Number(match[1]) >= 2,
      'joinedThisWeek reflects at least the two fixtures just inserted via rosterCounts(admin.platform)',
    );
    assert.ok(
      match[2] !== undefined && Number(match[2]) >= 1,
      'leftThisWeek reflects at least the one fixture just marked left via rosterCounts(admin.platform)',
    );

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'the freshness row is updated after a successful send',
    );

    await pool.query(`DELETE FROM server_roster WHERE user_id = ANY($1)`, [
      [joinedUser1, joinedUser2, leftUser1],
    ]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  "runAdminDigestOnce: a WhatsApp-platform admin's digest is unaffected by roster growth — server_roster is Discord-only (issue #344)",
  { skip },
  async () => {
    const adminId = `${RUN}-run-roster-wa-admin`;
    const suggesterId = `${RUN}-run-roster-wa-suggester`;
    await upsertMember({ platform: 'whatsapp', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    // Only src/platforms/discord/adapter.ts ever calls upsertRosterMember/
    // markRosterLeave — no code path writes a 'whatsapp' row to
    // server_roster — so rosterCounts('whatsapp') is always zero. Verify
    // that invariant holds for this run before relying on it, so a future
    // regression fails loudly here instead of silently in production.
    assert.deepEqual(
      await rosterCounts('whatsapp'),
      { total: 0, joinedThisWeek: 0, leftThisWeek: 0, notMembers: 0 },
      "no code path ever writes a whatsapp row to server_roster — rosterCounts('whatsapp') is always zero",
    );

    // An unrelated pending suggestion (guild-wide signal) so the digest
    // still sends, proving the rest of this WhatsApp admin's digest is
    // byte-for-byte unaffected by the new Discord-only roster signal.
    const created = await createSuggestion({
      platform: 'whatsapp',
      userId: suggesterId,
      displayName: 'wa roster suggester',
      content: 'unrelated suggestion content',
    });
    assert.ok(created);

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({
      platform: 'whatsapp',
      conversationIds: [`${RUN}-c-roster-wa-empty`],
      sent,
    });

    await runAdminDigestOnce([adapter]);

    assert.equal(sent.length, 1, 'the pending suggestion alone triggers a digest');
    assert.ok(!sent[0].text.includes('📈'), "no roster-growth line — rosterCounts('whatsapp') is all zeros");
    assert.match(
      sent[0].text,
      /💡 \d+ pending suggestion\(s\)/,
      'the rest of the digest is unaffected by the roster change',
    );

    await pool.query(`DELETE FROM suggestions WHERE id = $1`, [created.id]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'whatsapp' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  "runAdminDigestOnce: roster.notMembers passes through to the onboarding-queue digest line when the admin's platform access mode is 'gated' (issue #460)",
  { skip },
  async () => {
    const adminId = `${RUN}-run-notmembers-gated-admin`;
    const guestId = `${RUN}-run-notmembers-gated-guest`;
    const wasAccessMode = config.rbac.accessMode.discord;
    config.rbac.accessMode.discord = 'gated';

    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });
    await upsertRosterMember({ platform: 'discord', userId: guestId });

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({
      platform: 'discord',
      conversationIds: [`${RUN}-c-notmembers-gated-empty`],
      sent,
    });

    try {
      await runAdminDigestOnce([adapter]);

      assert.equal(sent.length, 1, 'the never-added guest alone triggers a digest');
      const line = sent[0].text.split('\n').find((l) => l.includes('🆕'));
      assert.ok(line, "the onboarding-queue line is present in 'gated' mode");
      const match = line.match(
        /^🆕 (\d+) guest\(s\) joined but haven't been added as a member yet — run `list_roster` \(filter: not_members\) to review\.$/,
      );
      assert.ok(match, `onboarding-queue line matches the expected format: ${line}`);
      assert.ok(
        Number(match[1]) >= 1,
        'notMembersCount reflects at least the one fixture just inserted via rosterCounts(admin.platform)',
      );
    } finally {
      config.rbac.accessMode.discord = wasAccessMode;
      await pool.query(`DELETE FROM server_roster WHERE user_id = $1`, [guestId]);
      await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
        adminId,
      ]);
      await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
    }
  },
);

test(
  "SECURITY: runAdminDigestOnce: the onboarding-queue line is never rendered for an 'open'-access-mode platform even when not_members rows exist (issue #460)",
  { skip },
  async () => {
    const adminId = `${RUN}-run-notmembers-open-admin`;
    const guestId = `${RUN}-run-notmembers-open-guest`;
    const suggesterId = `${RUN}-run-notmembers-open-suggester`;
    const wasAccessMode = config.rbac.accessMode.discord;
    config.rbac.accessMode.discord = 'open';

    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });
    await upsertRosterMember({ platform: 'discord', userId: guestId });
    // An unrelated pending suggestion so the digest still sends despite the
    // onboarding-queue count being suppressed to 0 — proving the line is
    // gated, not merely that the whole digest went quiet.
    const created = await createSuggestion({
      platform: 'discord',
      userId: suggesterId,
      displayName: 'open-mode notmembers suggester',
      content: 'unrelated suggestion content',
    });
    assert.ok(created);

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({
      platform: 'discord',
      conversationIds: [`${RUN}-c-notmembers-open-empty`],
      sent,
    });

    try {
      await runAdminDigestOnce([adapter]);

      assert.equal(sent.length, 1, 'the pending suggestion alone triggers a digest');
      assert.ok(
        !sent[0].text.includes('🆕'),
        "SECURITY: no onboarding-queue line for an 'open'-access-mode platform, even with a nonzero not_members row",
      );
      assert.match(
        sent[0].text,
        /💡 \d+ pending suggestion\(s\)/,
        'the rest of the digest is unaffected by the suppressed onboarding-queue signal',
      );
    } finally {
      config.rbac.accessMode.discord = wasAccessMode;
      await pool.query(`DELETE FROM suggestions WHERE id = $1`, [created.id]);
      await pool.query(`DELETE FROM server_roster WHERE user_id = $1`, [guestId]);
      await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
        adminId,
      ]);
      await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
    }
  },
);

test(
  "runAdminDigestOnce: countMutedMembers(admin.platform, config.moderation.strikeLimit, config.moderation.strikeWindowDays) passes through to the digest DM — the digest's 'muted' count is exactly what moderator.ts's own mute trigger would block (issue #357 acceptance criteria)",
  { skip },
  async () => {
    const adminId = `${RUN}-run-muted-admin`;
    const mutedUser = `${RUN}-run-muted-user`;
    const belowLimitUser = `${RUN}-run-muted-below`;
    const originalLimit = config.moderation.strikeLimit;
    const originalWindow = config.moderation.strikeWindowDays;
    config.moderation.strikeLimit = 3;
    config.moderation.strikeWindowDays = undefined;

    try {
      await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

      // Straddle the configured limit: mutedUser reaches exactly strikeLimit
      // (the same threshold moderator.ts's `active >= this.deps.strikeLimit`
      // check would mute on); belowLimitUser stays one strike short.
      for (let i = 0; i < config.moderation.strikeLimit; i++) {
        await addWarning({
          platform: 'discord',
          userId: mutedUser,
          reason: `strike-${i}`,
          excerpt: null,
          source: 'auto',
          issuedBy: null,
        });
      }
      await addWarning({
        platform: 'discord',
        userId: belowLimitUser,
        reason: 'strike-0',
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });

      const expected = await countMutedMembers(
        'discord',
        config.moderation.strikeLimit,
        config.moderation.strikeWindowDays,
      );
      assert.ok(expected >= 1, 'at least the just-inserted at-limit user is counted as muted');

      const sent: Array<{ userId: string; text: string }> = [];
      const adapter = fakeAdapter({
        platform: 'discord',
        conversationIds: [`${RUN}-c-muted-wire-empty`],
        sent,
      });

      await runAdminDigestOnce([adapter]);

      assert.equal(sent.length, 1, 'the muted member alone triggers a digest');
      const mutedLine = sent[0].text.split('\n').find((l) => l.includes('🔇'));
      assert.ok(mutedLine, 'the muted-member line is present');
      const match = mutedLine.match(/^🔇 (\d+) member\(s\) currently muted/);
      assert.ok(match, `muted line matches the expected format: ${mutedLine}`);
      assert.equal(
        Number(match[1]),
        expected,
        "the digest's wired count is exactly countMutedMembers(admin.platform, config.moderation.strikeLimit, " +
          'config.moderation.strikeWindowDays) — the same definition moderator.ts uses to mute',
      );

      assert.equal(
        await wasAdminDigestSentRecently('discord', adminId, 7),
        true,
        'the freshness row is updated after a successful send',
      );
    } finally {
      config.moderation.strikeLimit = originalLimit;
      config.moderation.strikeWindowDays = originalWindow;
      await pool.query(`DELETE FROM member_warnings WHERE user_id = ANY($1)`, [[mutedUser, belowLimitUser]]);
      await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
        adminId,
      ]);
      await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
    }
  },
);

test(
  'SECURITY: runAdminDigestOnce: the muted-member count is guild-wide, not conversation/admin-scoped — two admins on the same platform with disjoint conversation scopes see the identical count (issue #357 acceptance criteria)',
  { skip },
  async () => {
    const admin1Id = `${RUN}-run-mutedscope-admin1`;
    const admin2Id = `${RUN}-run-mutedscope-admin2`;
    const convo1 = `${RUN}-c-mutedscope-1`;
    const convo2 = `${RUN}-c-mutedscope-2`;
    const mutedUser = `${RUN}-run-mutedscope-user`;
    await upsertMember({ platform: 'discord', userId: admin1Id, role: 'admin', addedBy: `${RUN}-actor` });
    await upsertMember({ platform: 'discord', userId: admin2Id, role: 'admin', addedBy: `${RUN}-actor` });

    for (let i = 0; i < config.moderation.strikeLimit; i++) {
      await addWarning({
        platform: 'discord',
        userId: mutedUser,
        reason: `strike-${i}`,
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });
    }

    const sent: Array<{ userId: string; text: string }> = [];
    const scopeByAdmin: Record<string, string[]> = { [admin1Id]: [convo1], [admin2Id]: [convo2] };
    const adapter: PlatformAdapter = {
      platform: 'discord',
      adminCapabilities: new Set(),
      async start() {},
      async stop() {},
      isConnected: () => true,
      onMessage() {},
      async sendMessage() {},
      async sendDirectMessage(userId, text) {
        if (!userId.startsWith(RUN)) return;
        sent.push({ userId, text });
      },
      async conversationsForUser(userId) {
        return scopeByAdmin[userId] ?? [];
      },
      async performAdminAction() {
        return '';
      },
    };

    await runAdminDigestOnce([adapter]);

    const admin1Msg = sent.find((s) => s.userId === admin1Id);
    const admin2Msg = sent.find((s) => s.userId === admin2Id);
    assert.ok(admin1Msg, 'admin 1 receives a digest despite zero clusters/reports in their own scope');
    assert.ok(admin2Msg, 'admin 2 receives a digest despite zero clusters/reports in their own scope');

    const mutedLine = (text: string) => text.split('\n').find((l) => l.includes('🔇'));
    const line1 = mutedLine(admin1Msg.text);
    const line2 = mutedLine(admin2Msg.text);
    assert.ok(line1, 'admin 1 sees the muted-member line');
    assert.ok(line2, 'admin 2 sees the muted-member line');
    assert.equal(
      line1,
      line2,
      'SECURITY: the muted-member count must be identical across admins with disjoint conversation scopes — ' +
        "derived from admin.platform, never from the admin's conversation scope",
    );

    await pool.query(`DELETE FROM member_warnings WHERE user_id = $1`, [mutedUser]);
    await pool.query(
      `DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = ANY($1)`,
      [[admin1Id, admin2Id]],
    );
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = ANY($1)`, [
      [admin1Id, admin2Id],
    ]);
  },
);

test(
  'SECURITY: runAdminDigestOnce: the muted-member line carries only the bare count — never a member_warnings.reason, excerpt, user id, or display name (issue #357 acceptance criteria)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-mutedpriv-admin`;
    const mutedUser = `${RUN}-run-mutedpriv-user`;
    const secretReason = 'bad language ("a very identifiable reason string")';
    const secretExcerpt = 'the exact identifiable offending message excerpt';
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    for (let i = 0; i < config.moderation.strikeLimit; i++) {
      await addWarning({
        platform: 'discord',
        userId: mutedUser,
        reason: secretReason,
        excerpt: secretExcerpt,
        source: 'auto',
        issuedBy: null,
      });
    }

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({
      platform: 'discord',
      conversationIds: [`${RUN}-c-mutedpriv-empty`],
      sent,
    });

    await runAdminDigestOnce([adapter]);

    assert.equal(sent.length, 1, 'the muted member alone triggers a digest');
    assert.ok(sent[0].text.includes('🔇'), 'the muted-member line is present');
    assert.ok(
      !sent[0].text.includes(secretReason),
      'SECURITY: the raw warning reason must never appear in the digest DM',
    );
    assert.ok(
      !sent[0].text.includes(secretExcerpt),
      'SECURITY: the raw warning excerpt must never appear in the digest DM',
    );
    assert.ok(
      !sent[0].text.includes(mutedUser),
      "SECURITY: the muted member's user id must never appear in the digest DM",
    );

    await pool.query(`DELETE FROM member_warnings WHERE user_id = $1`, [mutedUser]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'runAdminDigestOnce: countStaleMutedMembers(admin.platform, config.moderation.strikeLimit, config.moderation.strikeWindowDays) is wired in — a member whose strikes fully age out of the window drops out of countMutedMembers but still surfaces via the hedged stale sub-clause, even when the base muted count is zero (issue #403 acceptance criteria)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-stalemuted-admin`;
    const agedOutUser = `${RUN}-run-stalemuted-user`;
    const originalLimit = config.moderation.strikeLimit;
    const originalWindow = config.moderation.strikeWindowDays;
    config.moderation.strikeLimit = 3;
    config.moderation.strikeWindowDays = 30;

    try {
      await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

      for (let i = 0; i < config.moderation.strikeLimit; i++) {
        await addWarning({
          platform: 'discord',
          userId: agedOutUser,
          reason: `strike-${i}`,
          excerpt: null,
          source: 'auto',
          issuedBy: null,
        });
      }
      await pool.query(
        `UPDATE member_warnings SET created_at = now() - interval '31 days'
          WHERE platform = 'discord' AND user_id = $1`,
        [agedOutUser],
      );

      const expectedMuted = await countMutedMembers(
        'discord',
        config.moderation.strikeLimit,
        config.moderation.strikeWindowDays,
      );
      const expectedStale = await countStaleMutedMembers(
        'discord',
        config.moderation.strikeLimit,
        config.moderation.strikeWindowDays,
      );
      assert.ok(expectedStale >= 1, 'at least the just-backdated aged-out user is counted as stale-muted');

      const sent: Array<{ userId: string; text: string }> = [];
      const adapter = fakeAdapter({
        platform: 'discord',
        conversationIds: [`${RUN}-c-stalemuted-empty`],
        sent,
      });

      await runAdminDigestOnce([adapter]);

      assert.equal(
        sent.length,
        1,
        'the stale-muted member alone triggers a digest, even though nobody is currently over the windowed limit',
      );
      const mutedLine = sent[0].text.split('\n').find((l) => l.includes('🔇'));
      assert.ok(mutedLine, 'the muted-member line is present');
      const match = mutedLine.match(
        /^🔇 (\d+) member\(s\) currently muted \((\d+) more may still be muted from an earlier strike that's since aged out — check moderation_history\) — run `moderation_history` or `clear_warnings` to review\.$/,
      );
      assert.ok(match, `muted line matches the expected hedged format: ${mutedLine}`);
      assert.equal(Number(match[1]), expectedMuted, 'the base count is exactly countMutedMembers');
      assert.equal(Number(match[2]), expectedStale, 'the hedge sub-count is exactly countStaleMutedMembers');
      assert.ok(
        !sent[0].text.includes(agedOutUser),
        "SECURITY: the stale-muted member's user id must never appear in the digest DM",
      );
    } finally {
      config.moderation.strikeLimit = originalLimit;
      config.moderation.strikeWindowDays = originalWindow;
      await pool.query(`DELETE FROM member_warnings WHERE user_id = $1`, [agedOutUser]);
      await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
        adminId,
      ]);
      await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
    }
  },
);

test(
  'SECURITY: countMaxTurnsFailures is conversation-scoped, a true COUNT(*), and windowed — counts both a primary maxTurnsExceeded stamp and a repeatMaxTurnsShortcut stamp, excludes a success row and an out-of-scope conversation (issue #371)',
  { skip },
  async () => {
    const inScope = `${RUN}-c-maxturns-in`;
    const outOfScope = `${RUN}-c-maxturns-out`;
    const recordOutbound = (conversationId: string, meta: Record<string, unknown>) =>
      recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        userName: 'CommunityAgent',
        role: 'member',
        direction: 'outbound',
        content: 'reply text',
        meta,
      });

    // In-scope: one primary failure, one repeat-shortcut replay, one success,
    // and one non-max-turns outbound reply — only the first two must count.
    await recordOutbound(inScope, { replyToUserId: 'u1', maxTurnsExceeded: true });
    await recordOutbound(inScope, { replyToUserId: 'u1', repeatMaxTurnsShortcut: true });
    await recordOutbound(inScope, { replyToUserId: 'u1' });
    await recordOutbound(inScope, { replyToUserId: 'u1', someOtherFlag: true });
    // Out-of-scope: a max-turns failure that must never be counted for a
    // different admin's scope.
    await recordOutbound(outOfScope, { replyToUserId: 'u2', maxTurnsExceeded: true });

    assert.equal(
      await countMaxTurnsFailures([inScope], 7),
      2,
      'SECURITY: a true COUNT(*) of exactly the primary failure + the repeat-shortcut replay — excludes the success row and the unrelated-meta row, and is not a LIMIT-bounded length',
    );
    assert.equal(
      await countMaxTurnsFailures([outOfScope], 7),
      1,
      'the out-of-scope conversation has its own single failure, counted only under its own scope',
    );
    assert.equal(
      await countMaxTurnsFailures([inScope, outOfScope], 7),
      3,
      'counting across both scopes returns the full 3 rows (the count is not capped)',
    );
    assert.equal(await countMaxTurnsFailures([], 7), 0, 'an empty scope counts nothing');

    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [[inScope, outOfScope]]);
  },
);

// countGeneralUnhelpfulAnswers (issue #563): the `knowledgeEntryId IS NULL`
// complement of countLowRatedKnowledge, modelled on countMaxTurnsFailures's
// rolling-window/conversation-scoped/true-COUNT(*) shape.
test(
  'repository: countGeneralUnhelpfulAnswers counts only in-window, in-scope, unhelpful ratings on answers with NO knowledgeEntryId — excludes KB-attributed ratings, helpful ratings, out-of-window ratings, and rows with a purged (NULL) interaction_id (issue #563)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-general-unhelpful`;
    const users: string[] = [];

    async function rateGeneral(userSuffix: string, helpful: boolean, knowledgeEntryId?: number) {
      const userId = `${RUN}-generalunhelpful-${userSuffix}`;
      users.push(userId);
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `answer for ${userId}`,
        meta:
          knowledgeEntryId !== undefined
            ? { replyToUserId: userId, knowledgeEntryId }
            : { replyToUserId: userId },
      });
      return expectFeedbackId(
        await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful }),
        `feedback recorded for ${userId}`,
      );
    }

    // (a) KB-attributed unhelpful rating — excluded (that's
    // countLowRatedKnowledge's half of the signal, not this one).
    const { id: entryId } = await saveKnowledge({ content: `${RUN} general-unhelpful KB entry content` });
    await rateGeneral('kb-attributed', false, entryId);
    // (b) helpful=true general-knowledge rating — excluded.
    await rateGeneral('helpful', true);
    // (c) genuine ungrounded unhelpful rating, but backdated outside the
    // window — excluded.
    const outOfWindowId = await rateGeneral('out-of-window', false);
    await pool.query(`UPDATE answer_feedback SET created_at = now() - interval '10 days' WHERE id = $1`, [
      outOfWindowId,
    ]);
    // (d) a row whose interaction_id is NULL (as if the rated reply had
    // since been purged via forget_me/purge_user_data, which sets
    // interaction_id to NULL on delete per schema.sql) — excluded, since
    // there's no interaction left to classify as grounded/ungrounded.
    const purgedUserId = `${RUN}-generalunhelpful-purged`;
    users.push(purgedUserId);
    await pool.query(
      `INSERT INTO answer_feedback (platform, conversation_id, user_id, interaction_id, helpful)
       VALUES ('discord', $1, $2, NULL, false)`,
      [conversationId, purgedUserId],
    );
    // (e) the true positive: in-window, in-scope, unhelpful, no
    // knowledgeEntryId — included.
    await rateGeneral('true-positive', false);

    assert.equal(
      await countGeneralUnhelpfulAnswers([conversationId], 7),
      1,
      'only the true-positive row is counted — KB-attributed, helpful, out-of-window, and NULL-interaction rows are all excluded',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [entryId]);
  },
);

test(
  'SECURITY: repository: countGeneralUnhelpfulAnswers scopes by conversation — an unhelpful general-knowledge rating recorded outside the calling admin scope is never counted (issue #563)',
  { skip },
  async () => {
    const inScope = `${RUN}-c-general-unhelpful-in`;
    const outOfScope = `${RUN}-c-general-unhelpful-out`;
    const users: string[] = [];

    async function rateGeneral(conversationId: string, userSuffix: string) {
      const userId = `${RUN}-generalunhelpfulscope-${userSuffix}`;
      users.push(userId);
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `answer for ${userId}`,
        meta: { replyToUserId: userId },
      });
      expectFeedbackId(
        await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful: false }),
      );
    }

    await rateGeneral(inScope, 'in');
    await rateGeneral(outOfScope, 'out');

    assert.equal(
      await countGeneralUnhelpfulAnswers([inScope], 7),
      1,
      'SECURITY: only the in-scope conversation is counted, never the out-of-scope one',
    );
    assert.equal(
      await countGeneralUnhelpfulAnswers([outOfScope], 7),
      1,
      'the out-of-scope conversation has its own single rating, counted only under its own scope',
    );
    assert.equal(
      await countGeneralUnhelpfulAnswers([inScope, outOfScope], 7),
      2,
      'counting across both scopes returns the full 2 rows (the count is not capped)',
    );
    assert.equal(await countGeneralUnhelpfulAnswers([], 7), 0, 'an empty scope counts nothing');

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [[inScope, outOfScope]]);
  },
);

// answerFeedbackWeeklySummary (issue #653): the overall, unfiltered-by-
// knowledge-grounding-or-origin denominator neither countGeneralUnhelpfulAnswers
// (#563) nor answerFeedbackOriginSummary (#592) covers — VISION's own named
// answer-quality north star.
test(
  'repository: answerFeedbackWeeklySummary counts every in-window, in-scope rating regardless of knowledge-grounding or origin — helpful and total, excluding out-of-window ratings and rows with a purged (NULL) interaction_id (issue #653)',
  { skip },
  async () => {
    const conversationId = `${RUN}-c-overallrate`;
    const users: string[] = [];

    async function rate(userSuffix: string, helpful: boolean, knowledgeEntryId?: number) {
      const userId = `${RUN}-overallrate-${userSuffix}`;
      users.push(userId);
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `answer for ${userId}`,
        meta:
          knowledgeEntryId !== undefined
            ? { replyToUserId: userId, knowledgeEntryId }
            : { replyToUserId: userId },
      });
      return expectFeedbackId(
        await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful }),
        `feedback recorded for ${userId}`,
      );
    }

    // (a) KB-attributed, helpful — counted (countGeneralUnhelpfulAnswers would
    // exclude this row entirely, since it only ever counts unhelpful+ungrounded).
    const { id: entryId } = await saveKnowledge({ content: `${RUN} overallrate KB entry content` });
    await rate('kb-helpful', true, entryId);
    // (b) KB-attributed, unhelpful — counted.
    await rate('kb-unhelpful', false, entryId);
    // (c) general-knowledge (ungrounded), helpful — counted.
    await rate('general-helpful', true);
    // (d) general-knowledge (ungrounded), unhelpful — counted.
    await rate('general-unhelpful', false);
    // (e) a genuine rating, but backdated outside the window — excluded.
    const outOfWindowId = await rate('out-of-window', true);
    await pool.query(`UPDATE answer_feedback SET created_at = now() - interval '10 days' WHERE id = $1`, [
      outOfWindowId,
    ]);
    // (f) a row whose interaction_id is NULL (as if the rated reply had since
    // been purged via forget_me/purge_user_data, which sets interaction_id to
    // NULL on delete per schema.sql) — excluded, there's no interaction left
    // to join.
    const purgedUserId = `${RUN}-overallrate-purged`;
    users.push(purgedUserId);
    await pool.query(
      `INSERT INTO answer_feedback (platform, conversation_id, user_id, interaction_id, helpful)
       VALUES ('discord', $1, $2, NULL, true)`,
      [conversationId, purgedUserId],
    );

    assert.deepEqual(
      await answerFeedbackWeeklySummary([conversationId], 7),
      { helpful: 2, total: 4 },
      'counts all 4 in-window rows (2 KB-attributed + 2 general) regardless of grounding — excludes the out-of-window and purged-interaction rows',
    );
    assert.deepEqual(
      await answerFeedbackWeeklySummary([], 7),
      { helpful: 0, total: 0 },
      'an empty scope counts nothing, matching countGeneralUnhelpfulAnswers/countMaxTurnsFailures',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [entryId]);
  },
);

test(
  'SECURITY: repository: answerFeedbackWeeklySummary scopes by conversation — a rating recorded outside the calling admin scope is never counted (issue #653 acceptance criterion 7)',
  { skip },
  async () => {
    const inScope = `${RUN}-c-overallrate-scope-in`;
    const outOfScope = `${RUN}-c-overallrate-scope-out`;
    const users: string[] = [];

    async function rate(conversationId: string, userSuffix: string, helpful: boolean) {
      const userId = `${RUN}-overallratescope-${userSuffix}`;
      users.push(userId);
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `answer for ${userId}`,
        meta: { replyToUserId: userId },
      });
      expectFeedbackId(await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful }));
    }

    await rate(inScope, 'in', true);
    await rate(outOfScope, 'out', false);

    assert.deepEqual(
      await answerFeedbackWeeklySummary([inScope], 7),
      { helpful: 1, total: 1 },
      'SECURITY: only the in-scope conversation is counted, never the out-of-scope one',
    );
    assert.deepEqual(
      await answerFeedbackWeeklySummary([outOfScope], 7),
      { helpful: 0, total: 1 },
      'the out-of-scope conversation has its own single rating, counted only under its own scope',
    );
    assert.deepEqual(
      await answerFeedbackWeeklySummary([inScope, outOfScope], 7),
      { helpful: 1, total: 2 },
      'counting across both scopes returns the full 2 rows (the count is not capped)',
    );
    assert.deepEqual(
      await answerFeedbackWeeklySummary([], 7),
      { helpful: 0, total: 0 },
      'an empty scope counts nothing',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = ANY($1)`, [[inScope, outOfScope]]);
  },
);

test(
  'SECURITY: runAdminDigestOnce: an admin with every other signal at zero but ≥1 max-turns failure in scope still receives a digest containing only the bare count — never message content, replyToUserId, or conversation id (issue #371 acceptance criteria)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-maxturns-admin`;
    const conversationId = `${RUN}-c-run-maxturns`;
    const secretUserId = `${RUN}-run-maxturns-asker`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      userName: 'CommunityAgent',
      role: 'member',
      direction: 'outbound',
      content: 'a canned max-turns apology',
      meta: { replyToUserId: secretUserId, maxTurnsExceeded: true },
    });

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    await runAdminDigestOnce([adapter]);

    assert.equal(sent.length, 1, 'the in-scope max-turns failure alone triggers a digest');
    assert.ok(!sent[0].text.includes('🕳️'), 'no knowledge-gaps line — this admin has zero gaps in scope');
    assert.match(
      sent[0].text,
      /⏱️ 1 reply in your conversations this week hit the step limit before finishing\./,
      'the max-turns-failures line is present',
    );
    assert.ok(
      !sent[0].text.includes(secretUserId),
      'SECURITY: the asker user id (replyToUserId) must never appear in the digest DM',
    );
    assert.ok(
      !sent[0].text.includes(conversationId),
      'SECURITY: the conversation id must never appear in the digest DM',
    );

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'the freshness row is updated after a successful send',
    );

    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'SECURITY: runAdminDigestOnce: an admin with every other signal at zero but ≥1 general-knowledge unhelpful rating in scope still receives a digest containing only the bare count — never question text, answer content, comment, or user id (issue #563 acceptance criteria)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-generalunhelpful-admin`;
    const conversationId = `${RUN}-c-run-generalunhelpful`;
    const secretUserId = `${RUN}-run-generalunhelpful-asker`;
    const secretAnswer = 'a very identifiable general-knowledge answer that must never leak';
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      userName: 'CommunityAgent',
      role: 'member',
      direction: 'outbound',
      content: secretAnswer,
      meta: { replyToUserId: secretUserId },
    });
    expectFeedbackId(
      await createAnswerFeedback({
        platform: 'discord',
        conversationId,
        userId: secretUserId,
        helpful: false,
      }),
    );

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    await runAdminDigestOnce([adapter]);

    assert.equal(sent.length, 1, 'the in-scope general-unhelpful rating alone triggers a digest');
    assert.ok(
      !sent[0].text.includes('👎'),
      'no low-rated-knowledge line — this rating has no knowledgeEntryId',
    );
    assert.match(
      sent[0].text,
      /⚠️ 1 general-knowledge answer rated unhelpful this week \(no knowledge-base grounding\) — run `list_answer_feedback` \(unhelpfulOnly\) to review\./,
      'the general-unhelpful-answers line is present',
    );
    assert.ok(
      !sent[0].text.includes(secretUserId),
      'SECURITY: the rater/asker user id must never appear in the digest DM',
    );
    assert.ok(
      !sent[0].text.includes(secretAnswer),
      'SECURITY: the rated answer content must never appear in the digest DM',
    );
    assert.ok(
      !sent[0].text.includes(conversationId),
      'SECURITY: the conversation id must never appear in the digest DM',
    );

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'the freshness row is updated after a successful send',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = $1`, [secretUserId]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'SECURITY: runAdminDigestOnce: an admin with every other signal at zero but ratings on BOTH a knowledge-grounded and a general-knowledge answer still receives a digest with a single overall helpful-rate line covering both — never question text, answer content, comment, or user id (issue #653 acceptance criteria)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-overallrate-admin`;
    const conversationId = `${RUN}-c-run-overallrate`;
    const secretUserId1 = `${RUN}-run-overallrate-asker1`;
    const secretUserId2 = `${RUN}-run-overallrate-asker2`;
    const secretAnswer = 'a very identifiable answer that must never leak in the overall-rate line';
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    // (a) a KB-attributed answer, rated helpful — generalUnhelpfulCount and
    // lowRatedKnowledgeCount both stay at 0, so this admin's only nonzero
    // signal is the new overall line.
    const { id: entryId } = await saveKnowledge({ content: `${RUN} overallrate KB entry content` });
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      userName: 'CommunityAgent',
      role: 'member',
      direction: 'outbound',
      content: secretAnswer,
      meta: { replyToUserId: secretUserId1, knowledgeEntryId: entryId },
    });
    expectFeedbackId(
      await createAnswerFeedback({
        platform: 'discord',
        conversationId,
        userId: secretUserId1,
        helpful: true,
      }),
    );

    // (b) a general-knowledge (ungrounded) answer, rated unhelpful — this
    // alone also triggers the narrower generalUnhelpfulCount line (#563),
    // proving the two lines coexist and the overall one counts BOTH rows.
    await recordInteraction({
      platform: 'discord',
      conversationId,
      userId: 'bot',
      userName: 'CommunityAgent',
      role: 'member',
      direction: 'outbound',
      content: `${secretAnswer} (general)`,
      meta: { replyToUserId: secretUserId2 },
    });
    expectFeedbackId(
      await createAnswerFeedback({
        platform: 'discord',
        conversationId,
        userId: secretUserId2,
        helpful: false,
      }),
    );

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    await runAdminDigestOnce([adapter]);

    assert.equal(sent.length, 1, 'the two in-scope ratings alone trigger a digest');
    assert.match(
      sent[0].text,
      /✅ Overall answer helpful-rate this week: 50% \(1\/2 ratings\)/,
      'the overall line counts BOTH the grounded and ungrounded rating in one denominator',
    );
    assert.match(
      sent[0].text,
      /⚠️ 1 general-knowledge answer rated unhelpful this week/,
      'the narrower general-unhelpful line still renders independently for its own slice',
    );
    assert.ok(
      !sent[0].text.includes(secretUserId1) && !sent[0].text.includes(secretUserId2),
      'SECURITY: no rater/asker user id ever appears in the digest DM',
    );
    assert.ok(
      !sent[0].text.includes(secretAnswer),
      'SECURITY: the rated answer content must never appear in the digest DM',
    );
    assert.ok(
      !sent[0].text.includes(conversationId),
      'SECURITY: the conversation id must never appear in the digest DM',
    );

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'the freshness row is updated after a successful send',
    );

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [[secretUserId1, secretUserId2]]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [entryId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  "SECURITY: runAdminDigestOnce: an admin with every other signal at zero but >=1 near-duplicate and >=1 conflict-candidate knowledge pair still receives a digest containing only the bare counts — never a pair's knowledge entry id, title, or content (issue #378 acceptance criteria)",
  { skip },
  async () => {
    const adminId = `${RUN}-run-knowledgepairs-admin`;
    const scope = `${RUN}-run-knowledgepairs-scope`;
    const secretDupTitleA = 'a very identifiable near-duplicate title A that must never leak';
    const secretDupTitleB = 'a very identifiable near-duplicate title B that must never leak';
    const secretDupContent = 'a very identifiable body shared by both near-duplicate entries';
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    // Near-duplicate pair (>= 0.92) — same content, near-identical title.
    const { id: dupAId } = await saveKnowledge({
      title: secretDupTitleA,
      content: secretDupContent,
      scope,
    });
    const { id: dupBId } = await saveKnowledge({
      title: secretDupTitleB,
      content: secretDupContent,
      scope,
    });

    // Conflict-candidate pair (mid-band, [0.55, 0.92)) — hand-crafted
    // orthonormal-basis embeddings so cosine similarity is exact, same
    // technique as tests/repository.test.ts's listKnowledgeConflictCandidates
    // fixtures.
    const secretConflictTitleA = 'a very identifiable conflict-candidate title A that must never leak';
    const secretConflictTitleB = 'a very identifiable conflict-candidate title B that must never leak';
    const dim = config.db.embeddingDim;
    const vecA = new Array(dim).fill(0);
    vecA[0] = 1;
    const vecB = new Array(dim).fill(0);
    vecB[0] = 0.7;
    vecB[1] = Math.sqrt(1 - 0.7 ** 2);
    const { rows: conflictRows } = await pool.query(
      `INSERT INTO knowledge (scope, title, content, embedding) VALUES
         ($1,$2,'conflict body a',$4), ($1,$3,'conflict body b',$5)
       RETURNING id`,
      [scope, secretConflictTitleA, secretConflictTitleB, pgvector.toSql(vecA), pgvector.toSql(vecB)],
    );
    const conflictAId = Number(conflictRows[0].id);
    const conflictBId = Number(conflictRows[1].id);

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({
      platform: 'discord',
      conversationIds: [`${RUN}-c-knowledgepairs-empty`],
      sent,
    });

    await runAdminDigestOnce([adapter]);

    assert.equal(sent.length, 1, 'the in-scope knowledge-pair backlog alone triggers a digest');
    assert.ok(!sent[0].text.includes('🔔'), 'no cluster line — this admin has zero clusters in scope');
    assert.match(
      sent[0].text,
      /🔀 \d+ near-duplicate knowledge pair\(s\) — run `list_duplicate_knowledge` to review\./,
      'the near-duplicate-knowledge line is present',
    );
    assert.match(
      sent[0].text,
      /⚖️ \d+ conflict-candidate knowledge pair\(s\) that may disagree — run `list_knowledge_conflicts` to review\./,
      'the conflict-candidate-knowledge line is present',
    );
    for (const secret of [
      secretDupTitleA,
      secretDupTitleB,
      secretDupContent,
      secretConflictTitleA,
      secretConflictTitleB,
      String(dupAId),
      String(dupBId),
      String(conflictAId),
      String(conflictBId),
    ]) {
      assert.ok(
        !sent[0].text.includes(secret),
        `SECURITY: "${secret}" (a knowledge entry id, title, or content) must never appear in the digest DM`,
      );
    }

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'the freshness row is updated after a successful send',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [
      [dupAId, dupBId, conflictAId, conflictBId],
    ]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'SECURITY: runAdminDigestOnce: the near-duplicate and conflict-candidate knowledge-pair counts are guild-wide, not conversation/admin-scoped — two admins with disjoint conversation scopes and no other in-scope signals see identical lines (issue #378 acceptance criteria)',
  { skip },
  async () => {
    const admin1Id = `${RUN}-run-pairscope-admin1`;
    const admin2Id = `${RUN}-run-pairscope-admin2`;
    const convo1 = `${RUN}-c-pairscope-1`;
    const convo2 = `${RUN}-c-pairscope-2`;
    const scope = `${RUN}-run-pairscope-scope`;
    await upsertMember({ platform: 'discord', userId: admin1Id, role: 'admin', addedBy: `${RUN}-actor` });
    await upsertMember({ platform: 'discord', userId: admin2Id, role: 'admin', addedBy: `${RUN}-actor` });

    const { id: dupAId } = await saveKnowledge({
      title: 'pairscope near-duplicate A',
      content: 'pairscope shared duplicate body',
      scope,
    });
    const { id: dupBId } = await saveKnowledge({
      title: 'pairscope near-duplicate B',
      content: 'pairscope shared duplicate body',
      scope,
    });

    const sent: Array<{ userId: string; text: string }> = [];
    // A scope map so each admin resolves to their OWN disjoint conversation —
    // proving the knowledge-pair counts don't vary with either admin's scope,
    // matching the pending-knowledge-candidate precedent (#284).
    const scopeByAdmin: Record<string, string[]> = { [admin1Id]: [convo1], [admin2Id]: [convo2] };
    const adapter: PlatformAdapter = {
      platform: 'discord',
      adminCapabilities: new Set(),
      async start() {},
      async stop() {},
      isConnected: () => true,
      onMessage() {},
      async sendMessage() {},
      async sendDirectMessage(userId, text) {
        if (!userId.startsWith(RUN)) return;
        sent.push({ userId, text });
      },
      async conversationsForUser(userId) {
        return scopeByAdmin[userId] ?? [];
      },
      async performAdminAction() {
        return '';
      },
    };

    await runAdminDigestOnce([adapter]);

    const admin1Msg = sent.find((s) => s.userId === admin1Id);
    const admin2Msg = sent.find((s) => s.userId === admin2Id);
    assert.ok(admin1Msg, 'admin 1 receives a digest despite zero clusters/reports in their own scope');
    assert.ok(admin2Msg, 'admin 2 receives a digest despite zero clusters/reports in their own scope');

    const dupLine = (text: string) => text.split('\n').find((l) => l.includes('🔀'));
    const line1 = dupLine(admin1Msg.text);
    const line2 = dupLine(admin2Msg.text);
    assert.ok(line1, 'admin 1 sees the near-duplicate-knowledge line');
    assert.ok(line2, 'admin 2 sees the near-duplicate-knowledge line');
    assert.equal(
      line1,
      line2,
      'SECURITY: the near-duplicate-knowledge count must be identical across admins with disjoint ' +
        'conversation scopes — it is a guild-wide COUNT(*), never conversation-scoped',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[dupAId, dupBId]]);
    await pool.query(
      `DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = ANY($1)`,
      [[admin1Id, admin2Id]],
    );
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = ANY($1)`, [
      [admin1Id, admin2Id],
    ]);
  },
);

// countOpenAppeals (issue #631): the digest backlog line #554 and #622 both
// named and deferred — a guild-wide-by-platform COUNT(*), same shape as
// countMutedMembers.

test(
  'SECURITY: runAdminDigestOnce: the open-appeals line carries only the bare count — never an appellant user_name, reason, or user_id (issue #631 acceptance criterion 5)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-appealpriv-admin`;
    const appellantUserId = `${RUN}-run-appealpriv-user`;
    const secretUserName = 'Very Identifiable Appellant Name';
    const secretReason = 'a very identifiable, specific appeal reason string';
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const { id: appealId } = await createModerationAppeal({
      platform: 'discord',
      userId: appellantUserId,
      userName: secretUserName,
      reason: secretReason,
      activeWarnings: 2,
      strikeLimit: 3,
    });

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({
      platform: 'discord',
      conversationIds: [`${RUN}-c-appealpriv-empty`],
      sent,
    });

    await runAdminDigestOnce([adapter]);

    assert.equal(sent.length, 1, 'the open appeal alone triggers a digest');
    const appealLine = sent[0].text.split('\n').find((l) => l.includes('📋'));
    assert.ok(appealLine, 'the open-appeals line is present');
    assert.match(
      appealLine,
      /^📋 \d+ open moderation appeal\(s\) awaiting review — run `list_appeals` to review\./,
    );
    assert.ok(
      !sent[0].text.includes(secretUserName),
      "SECURITY: the appellant's user_name must never appear in the digest DM",
    );
    assert.ok(
      !sent[0].text.includes(secretReason),
      'SECURITY: the raw appeal reason must never appear in the digest DM',
    );
    assert.ok(
      !sent[0].text.includes(appellantUserId),
      "SECURITY: the appellant's user_id must never appear in the digest DM",
    );

    await pool.query(`DELETE FROM moderation_appeals WHERE id = $1`, [appealId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'runAdminDigestOnce: the open-appeals count is guild-wide, not conversation/admin-scoped — two admins on the same platform with disjoint conversation scopes see the identical count (issue #631)',
  { skip },
  async () => {
    const admin1Id = `${RUN}-run-appealscope-admin1`;
    const admin2Id = `${RUN}-run-appealscope-admin2`;
    const convo1 = `${RUN}-c-appealscope-1`;
    const convo2 = `${RUN}-c-appealscope-2`;
    const appellantUserId = `${RUN}-run-appealscope-user`;
    await upsertMember({ platform: 'discord', userId: admin1Id, role: 'admin', addedBy: `${RUN}-actor` });
    await upsertMember({ platform: 'discord', userId: admin2Id, role: 'admin', addedBy: `${RUN}-actor` });

    const { id: appealId } = await createModerationAppeal({
      platform: 'discord',
      userId: appellantUserId,
      userName: 'Scope Test Appellant',
      activeWarnings: 1,
      strikeLimit: 3,
    });

    const sent: Array<{ userId: string; text: string }> = [];
    const scopeByAdmin: Record<string, string[]> = { [admin1Id]: [convo1], [admin2Id]: [convo2] };
    const adapter: PlatformAdapter = {
      platform: 'discord',
      adminCapabilities: new Set(),
      async start() {},
      async stop() {},
      isConnected: () => true,
      onMessage() {},
      async sendMessage() {},
      async sendDirectMessage(userId, text) {
        if (!userId.startsWith(RUN)) return;
        sent.push({ userId, text });
      },
      async conversationsForUser(userId) {
        return scopeByAdmin[userId] ?? [];
      },
      async performAdminAction() {
        return '';
      },
    };

    await runAdminDigestOnce([adapter]);

    const admin1Msg = sent.find((s) => s.userId === admin1Id);
    const admin2Msg = sent.find((s) => s.userId === admin2Id);
    assert.ok(admin1Msg, 'admin 1 receives a digest despite zero clusters/reports in their own scope');
    assert.ok(admin2Msg, 'admin 2 receives a digest despite zero clusters/reports in their own scope');

    const appealLine = (text: string) => text.split('\n').find((l) => l.includes('📋'));
    const line1 = appealLine(admin1Msg.text);
    const line2 = appealLine(admin2Msg.text);
    assert.ok(line1, 'admin 1 sees the open-appeals line');
    assert.ok(line2, 'admin 2 sees the open-appeals line');
    assert.equal(
      line1,
      line2,
      'SECURITY: the open-appeals count must be identical across admins with disjoint conversation scopes — ' +
        "derived from admin.platform, never from the admin's conversation scope",
    );

    await pool.query(`DELETE FROM moderation_appeals WHERE id = $1`, [appealId]);
    await pool.query(
      `DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = ANY($1)`,
      [[admin1Id, admin2Id]],
    );
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = ANY($1)`, [
      [admin1Id, admin2Id],
    ]);
  },
);

// --- issue #499: buildAdminDigestForAdmin, extracted so the weekly push and
// the on-demand `admin_digest` tool share one gathering implementation.

test(
  'buildAdminDigestForAdmin: the gathering Promise.all has exactly one call site in adminDigest.ts — ' +
    'runAdminDigestOnce delegates to the shared helper rather than keeping its own copy (issue #499, no drift)',
  () => {
    const source = readFileSync(new URL('../src/adminDigest.ts', import.meta.url), 'utf8');
    const promiseAllCount = (source.match(/await Promise\.all\(\[/g) ?? []).length;
    const gatheringCallCount = (source.match(/recentQuestionClusters\(scope/g) ?? []).length;
    assert.equal(
      promiseAllCount,
      1,
      'exactly one signal-gathering Promise.all in the whole file — a second copy would be the exact drift hazard this extraction exists to prevent',
    );
    assert.equal(
      gatheringCallCount,
      1,
      'recentQuestionClusters(scope, ...) — the first gathering call — appears exactly once, confirming runAdminDigestOnce has no inlined duplicate',
    );
  },
);

test(
  'SECURITY: buildAdminDigestForAdmin (the on-demand pull) never touches recordAdminDigestSent/wasAdminDigestSentRecently — calling it any number of times does not suppress or reset the next scheduled weekly push (issue #499 acceptance criteria)',
  { skip },
  async () => {
    const adminId = `${RUN}-pull-push-admin`;
    const requesterId = `${RUN}-pull-push-requester`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });
    // A pending access request (guild-wide) guarantees a non-null message so
    // the pull path is actually exercised, not short-circuited by a quiet week.
    await recordAccessRequest({ platform: 'discord', userId: requesterId, userName: 'guest' });

    const adapter = fakeAdapter({
      platform: 'discord',
      conversationIds: [`${RUN}-c-pull-push-empty`],
      sent: [],
    });

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      false,
      'no send recorded before any pull',
    );

    // Pull three times — an admin re-checking their own snapshot repeatedly.
    // ADMIN_DIGEST_ENABLED is unset for this whole test file (see the top-of-
    // file comment), so this also pins that the pull works independent of
    // that flag (issue #499 acceptance criteria).
    for (let i = 0; i < 3; i++) {
      const { message } = await buildAdminDigestForAdmin('discord', adminId, adapter);
      assert.ok(message, 'the pull returns a non-null message (pending access request in scope)');
      assert.match(message, /⏳ \d+ pending access request\(s\)/);
    }

    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      false,
      'repeated pulls must never mark the admin as recently sent — the freshness row stays untouched',
    );

    // The weekly push must still fire normally afterwards, unaffected by the pulls above.
    const sent: Array<{ userId: string; text: string }> = [];
    const pushAdapter = fakeAdapter({
      platform: 'discord',
      conversationIds: [`${RUN}-c-pull-push-empty`],
      sent,
    });
    await runAdminDigestOnce([pushAdapter]);
    assert.equal(sent.length, 1, 'the weekly push still sends on its normal cadence after prior pulls');
    assert.equal(
      await wasAdminDigestSentRecently('discord', adminId, 7),
      true,
      'ONLY the push (not the pulls before it) updates the freshness row',
    );

    await clearAccessRequest('discord', requesterId);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  "buildAdminDigestForAdmin: autoAnswerHelpfulPct round-trips through currentCounts/recordAdminDigestSnapshot, and the second week's pull renders the exact pp trend against the first (issue #629 acceptance criterion 4)",
  { skip },
  async () => {
    const adminId = `${RUN}-autoanswertrend-admin`;
    const conversationId = `${RUN}-c-autoanswertrend`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const ratedUsers: string[] = [];
    async function rateAutoAnswer(userSuffix: string, helpful: boolean) {
      const userId = `${RUN}-autoanswertrend-${userSuffix}`;
      await recordInteraction({
        platform: 'discord',
        conversationId,
        userId: 'bot',
        role: 'member',
        direction: 'outbound',
        content: `auto-answer for ${userId}`,
        meta: { replyToUserId: userId, autoAnswer: true },
      });
      expectFeedbackId(await createAnswerFeedback({ platform: 'discord', conversationId, userId, helpful }));
      ratedUsers.push(userId);
    }

    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent: [] });

    const wasTrendsEnabled = config.adminDigest.trendsEnabled;
    config.adminDigest.trendsEnabled = true;
    try {
      // Week 1: 3 helpful, 1 unhelpful -> 75% helpful.
      await rateAutoAnswer('w1-h1', true);
      await rateAutoAnswer('w1-h2', true);
      await rateAutoAnswer('w1-h3', true);
      await rateAutoAnswer('w1-u1', false);

      const week1 = await buildAdminDigestForAdmin('discord', adminId, adapter);
      assert.equal(
        week1.currentCounts.autoAnswerHelpfulPct,
        75,
        'currentCounts carries the derived percentage, not the raw helpful/unhelpful counts',
      );
      assert.ok(week1.message);
      assert.equal(
        week1.message.split('\n').find((l) => l.includes('📊')),
        '📊 Auto-answer ratings: 75% helpful (3/4).',
        'no prior snapshot yet -> no trend suffix, week 1 renders bare',
      );

      // Persist week 1's snapshot exactly as runAdminDigestOnce would on a
      // real send, so week 2's read sees it as "last week".
      await recordAdminDigestSnapshot('discord', adminId, week1.currentCounts);
      assert.equal(
        (await getLastDigestCounts('discord', adminId))?.autoAnswerHelpfulPct,
        75,
        'the percentage round-trips through the sanitize whitelist, unlike an unlisted key would',
      );

      // Week 2: one more helpful rating -> 4 helpful, 1 unhelpful -> 80%.
      await rateAutoAnswer('w2-h1', true);

      const week2 = await buildAdminDigestForAdmin('discord', adminId, adapter);
      assert.equal(week2.currentCounts.autoAnswerHelpfulPct, 80, "week 2's own currentCounts reflects 80%");
      assert.ok(week2.message);
      assert.equal(
        week2.message.split('\n').find((l) => l.includes('📊')),
        '📊 Auto-answer ratings: 80% helpful (4/5). ▲ 5.0pp since last week.',
        "week 2 sees last week's persisted 75% and renders the exact ▲ 5.0pp delta",
      );
    } finally {
      config.adminDigest.trendsEnabled = wasTrendsEnabled;
    }

    await pool.query(`DELETE FROM answer_feedback WHERE user_id = ANY($1)`, [ratedUsers]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

// --- issue #497: week-over-week trend suffix, wired end-to-end through
// runAdminDigestOnce. openReports is used as the representative signal
// throughout because it's cheaply and precisely controllable per admin
// (createContentReport, scoped to the admin's own conversation), unlike the
// guild-wide counts.

test(
  'SECURITY: runAdminDigestOnce: ADMIN_DIGEST_TRENDS_ENABLED unset (default) never reads last_counts and renders no trend suffix, even when a prior snapshot with a different count exists (issue #497 acceptance criteria 1, 7)',
  { skip },
  async (t) => {
    const adminId = `${RUN}-run-trendsoff-admin`;
    const conversationId = `${RUN}-c-run-trendsoff`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    // Seed a prior snapshot with a DIFFERENT openReports count so a trend
    // suffix would be non-empty if the read path were ever exercised.
    await recordAdminDigestSent('discord', adminId, { openReports: 0 });
    await pool.query(
      `UPDATE admin_digest_sends SET sent_at = now() - interval '8 days'
        WHERE platform = 'discord' AND platform_user_id = $1`,
      [adminId],
    );

    const report = await createContentReport({
      platform: 'discord',
      reporterUserId: `${RUN}-run-trendsoff-reporter`,
      conversationId,
      reason: 'trends-off open report',
    });
    assert.ok(report);

    const wasTrendsEnabled = config.adminDigest.trendsEnabled;
    config.adminDigest.trendsEnabled = false;
    const querySpy = t.mock.method(pool, 'query');

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    try {
      await runAdminDigestOnce([adapter]);
    } finally {
      config.adminDigest.trendsEnabled = wasTrendsEnabled;
    }

    assert.equal(sent.length, 1);
    assert.ok(
      !/▲|▼|since last week/.test(sent[0].text),
      'flag off -> no trend suffix anywhere, even though a differing prior snapshot exists',
    );
    assert.ok(
      !querySpy.mock.calls.some((c) => String(c.arguments[0]).includes('SELECT last_counts')),
      'SECURITY: getLastDigestCounts must never be invoked while ADMIN_DIGEST_TRENDS_ENABLED is unset',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = $1`, [report.id]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  "SECURITY: buildAdminDigestForAdmin's scoping matches runAdminDigestOnce exactly — conversation-scoped open-report count, with the admin's own linked identity excluded from DM-originated reports (issue #197 parity, issue #499)",
  { skip },
  async () => {
    const adminId = `${RUN}-pull-scope-admin`;
    const inScopeConvo = `${RUN}-c-pull-scope-in`;
    const outOfScopeConvo = `${RUN}-c-pull-scope-out`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const inScope = await createContentReport({
      platform: 'discord',
      reporterUserId: `${RUN}-pull-scope-reporter`,
      conversationId: inScopeConvo,
      reason: 'in-scope open report — must be counted',
    });
    const outOfScope = await createContentReport({
      platform: 'discord',
      reporterUserId: `${RUN}-pull-scope-reporter`,
      conversationId: outOfScopeConvo,
      reason: 'out-of-scope open report — must NOT be counted',
    });
    // DM-originated, filed against the admin's own identity — must be
    // excluded from their own count (issue #197), exactly like the pushed digest.
    const dmAgainstSelf = await createContentReport({
      platform: 'discord',
      reporterUserId: `${RUN}-pull-scope-reporter`,
      conversationId: `${RUN}-c-pull-scope-dm-self`,
      targetUserId: adminId,
      reason: 'DM report filed against the admin themselves — must be excluded from their own count',
      isDirect: true,
    });
    // DM-originated, filed against someone else — DM broadening still applies (counted).
    const dmAgainstOther = await createContentReport({
      platform: 'discord',
      reporterUserId: `${RUN}-pull-scope-reporter`,
      conversationId: `${RUN}-c-pull-scope-dm-other`,
      targetUserId: `${RUN}-pull-scope-someone-else`,
      reason: 'DM report filed against another user — must still be counted',
      isDirect: true,
    });
    assert.ok(inScope && outOfScope && dmAgainstSelf && dmAgainstOther);

    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [inScopeConvo], sent: [] });
    const { message } = await buildAdminDigestForAdmin('discord', adminId, adapter);
    assert.ok(message);
    assert.match(
      message,
      /🚩 2 open report\(s\)/,
      'in-scope report + DM-against-other = 2; out-of-scope and DM-against-self must both be excluded',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [
      [inScope.id, outOfScope.id, dmAgainstSelf.id, dmAgainstOther.id],
    ]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
  },
);

test(
  'runAdminDigestOnce: flag ON with a prior last_counts snapshot -> an increased signal renders exactly the ▲+N suffix, and the new counts are re-snapshotted (issue #497 acceptance criterion 2)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-trendup-admin`;
    const conversationId = `${RUN}-c-run-trendup`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    await recordAdminDigestSent('discord', adminId, { openReports: 2 });
    await pool.query(
      `UPDATE admin_digest_sends SET sent_at = now() - interval '8 days'
        WHERE platform = 'discord' AND platform_user_id = $1`,
      [adminId],
    );

    const reports = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        createContentReport({
          platform: 'discord',
          reporterUserId: `${RUN}-run-trendup-reporter-${n}`,
          conversationId,
          reason: `trend-up open report ${n}`,
        }),
      ),
    );

    const wasTrendsEnabled = config.adminDigest.trendsEnabled;
    config.adminDigest.trendsEnabled = true;
    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    try {
      await runAdminDigestOnce([adapter]);
    } finally {
      config.adminDigest.trendsEnabled = wasTrendsEnabled;
    }

    assert.equal(sent.length, 1);
    const line = sent[0].text.split('\n').find((l) => l.includes('🚩'));
    assert.equal(
      line,
      '🚩 5 open report(s) in your conversations, oldest 0d old — run `list_reports`. (▲+3 since last week)',
      'previous 2 -> current 5 renders exactly ▲+3',
    );

    const snapshot = await getLastDigestCounts('discord', adminId);
    assert.ok(snapshot);
    assert.equal(
      snapshot.openReports,
      5,
      "this week's send re-snapshots the new count for next week's delta",
    );

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [reports.map((r) => r!.id)]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'runAdminDigestOnce: flag ON with a prior last_counts snapshot -> a decreased signal renders exactly the ▼-N suffix (issue #497 acceptance criterion 3)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-trenddown-admin`;
    const conversationId = `${RUN}-c-run-trenddown`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    await recordAdminDigestSent('discord', adminId, { openReports: 8 });
    await pool.query(
      `UPDATE admin_digest_sends SET sent_at = now() - interval '8 days'
        WHERE platform = 'discord' AND platform_user_id = $1`,
      [adminId],
    );

    const reports = await Promise.all(
      [1, 2].map((n) =>
        createContentReport({
          platform: 'discord',
          reporterUserId: `${RUN}-run-trenddown-reporter-${n}`,
          conversationId,
          reason: `trend-down open report ${n}`,
        }),
      ),
    );

    const wasTrendsEnabled = config.adminDigest.trendsEnabled;
    config.adminDigest.trendsEnabled = true;
    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    try {
      await runAdminDigestOnce([adapter]);
    } finally {
      config.adminDigest.trendsEnabled = wasTrendsEnabled;
    }

    assert.equal(sent.length, 1);
    const line = sent[0].text.split('\n').find((l) => l.includes('🚩'));
    assert.equal(
      line,
      '🚩 2 open report(s) in your conversations, oldest 0d old — run `list_reports`. (▼-6 since last week)',
      'previous 8 -> current 2 renders exactly ▼-6',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [reports.map((r) => r!.id)]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'runAdminDigestOnce: flag ON with a signal unchanged since the prior snapshot renders no suffix on that line (issue #497 acceptance criterion 4)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-trendsame-admin`;
    const conversationId = `${RUN}-c-run-trendsame`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    await recordAdminDigestSent('discord', adminId, { openReports: 2 });
    await pool.query(
      `UPDATE admin_digest_sends SET sent_at = now() - interval '8 days'
        WHERE platform = 'discord' AND platform_user_id = $1`,
      [adminId],
    );

    const reports = await Promise.all(
      [1, 2].map((n) =>
        createContentReport({
          platform: 'discord',
          reporterUserId: `${RUN}-run-trendsame-reporter-${n}`,
          conversationId,
          reason: `trend-same open report ${n}`,
        }),
      ),
    );

    const wasTrendsEnabled = config.adminDigest.trendsEnabled;
    config.adminDigest.trendsEnabled = true;
    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    try {
      await runAdminDigestOnce([adapter]);
    } finally {
      config.adminDigest.trendsEnabled = wasTrendsEnabled;
    }

    assert.equal(sent.length, 1);
    const line = sent[0].text.split('\n').find((l) => l.includes('🚩'));
    assert.equal(
      line,
      '🚩 2 open report(s) in your conversations, oldest 0d old — run `list_reports`.',
      'previous 2 -> current 2 is unchanged — no suffix, no clutter',
    );

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [reports.map((r) => r!.id)]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  "runAdminDigestOnce: flag ON on an admin's first-ever digest -> no trend suffix anywhere, and a snapshot is written for next week (issue #497 acceptance criterion 5)",
  { skip },
  async () => {
    const adminId = `${RUN}-run-trendfirst-admin`;
    const conversationId = `${RUN}-c-run-trendfirst`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const reports = await Promise.all(
      [1, 2, 3].map((n) =>
        createContentReport({
          platform: 'discord',
          reporterUserId: `${RUN}-run-trendfirst-reporter-${n}`,
          conversationId,
          reason: `trend-first open report ${n}`,
        }),
      ),
    );

    assert.equal(
      await getLastDigestCounts('discord', adminId),
      null,
      'sanity check: this admin genuinely has no prior admin_digest_sends row',
    );

    const wasTrendsEnabled = config.adminDigest.trendsEnabled;
    config.adminDigest.trendsEnabled = true;
    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    try {
      await runAdminDigestOnce([adapter]);
    } finally {
      config.adminDigest.trendsEnabled = wasTrendsEnabled;
    }

    assert.equal(sent.length, 1);
    assert.ok(
      !/▲|▼|since last week/.test(sent[0].text),
      'a first-ever digest has no snapshot to diff against — no suffix anywhere',
    );

    const snapshot = await getLastDigestCounts('discord', adminId);
    assert.ok(snapshot, "a snapshot is written after the very first digest, for next week's delta");
    assert.equal(snapshot.openReports, 3);

    await pool.query(`DELETE FROM content_reports WHERE id = ANY($1)`, [reports.map((r) => r!.id)]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'runAdminDigestOnce: a quiet week (no message sent) still snapshots last_counts, but does NOT advance the freshness guard (issue #497 acceptance criterion 6)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-quiettrend-admin`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({
      platform: 'discord',
      conversationIds: [`${RUN}-c-quiettrend-empty`],
      sent,
    });
    // Guild-wide signals (see the analogous #133/#193 quiet-week test above)
    // aren't test-isolated — snapshot them first so the assertion holds even
    // if another concurrently-running test file has one in flight.
    const pendingAccessRequestsBefore = await countAccessRequests();
    const pendingSuggestionsBefore = await countPendingSuggestions();
    const pendingCandidatesBefore = await countPendingKnowledgeCandidates();

    await runAdminDigestOnce([adapter]);

    if (
      pendingAccessRequestsBefore === 0 &&
      pendingSuggestionsBefore === 0 &&
      pendingCandidatesBefore === 0
    ) {
      assert.equal(sent.length, 0, 'a genuinely quiet week sends nothing');
      assert.equal(
        await wasAdminDigestSentRecently('discord', adminId, 7),
        false,
        'a quiet-week snapshot write must never advance the freshness guard',
      );
      const snapshot = await getLastDigestCounts('discord', adminId);
      assert.ok(snapshot, "a quiet week still records a last_counts snapshot for next week's delta");
      assert.equal(snapshot.openReports, 0, 'this admin has zero in-scope open reports in the snapshot');
    } else {
      assert.equal(
        sent.length,
        1,
        'a pre-existing guild-wide pending signal legitimately makes this a non-quiet week',
      );
    }

    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

// --- issue #624: fold the weekly link-check's broken-source count into the
// admin digest — #448's own named, deferred follow-up. Mirrors
// countStaleKnowledge's exact opt-in gating shape: the extra COUNT(*) is only
// ever issued when config.knowledgeLinkCheck.enabled is true.

test(
  'runAdminDigestOnce: the unreachable-source-knowledge line renders with the exact count when config.knowledgeLinkCheck.enabled is true and >=1 entry is flagged (issue #624 acceptance criteria 2, 5)',
  { skip },
  async () => {
    const adminId = `${RUN}-run-linkcheckon-admin`;
    const conversationId = `${RUN}-c-run-linkcheckon`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const before = await countUnreachableSourceKnowledge();

    const { id: unreachableId } = await saveKnowledge({
      content: `${RUN} entry with a dead source link (link-check-on case)`,
      title: 'linkcheckon-flagged-entry',
      scope: 'global',
      sourceUrl: 'https://example.com/dead-link-on',
    });
    await pool.query(
      `UPDATE knowledge SET source_unreachable = true, source_checked_at = now() WHERE id = $1`,
      [unreachableId],
    );

    const wasEnabled = config.knowledgeLinkCheck.enabled;
    config.knowledgeLinkCheck.enabled = true;

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    try {
      await runAdminDigestOnce([adapter]);
    } finally {
      config.knowledgeLinkCheck.enabled = wasEnabled;
    }

    assert.equal(sent.length, 1, 'the flagged entry alone triggers a digest');
    const linkLines = sent[0].text.split('\n').filter((l) => l.includes('🔗'));
    assert.equal(linkLines.length, 1, 'exactly one unreachable-source-knowledge line');
    assert.match(
      linkLines[0],
      new RegExp(`^🔗 ${before + 1} knowledge entr`),
      'the line reports the current exact count, including this newly-flagged entry',
    );
    assert.match(
      linkLines[0],
      /run `list_knowledge` \(filter: sourceUnreachable\) to review\.$/,
      'the pointer directs to the existing list_knowledge tool — no new tool surface',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [unreachableId]);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);

test(
  'SECURITY: runAdminDigestOnce: the unreachable-source-knowledge line never renders when config.knowledgeLinkCheck.enabled is false, even when source_unreachable = true rows exist in the table — and the underlying COUNT(*) is never issued (issue #624 acceptance criteria 4, 6)',
  { skip },
  async (t) => {
    const adminId = `${RUN}-run-linkcheckoff-admin`;
    const conversationId = `${RUN}-c-run-linkcheckoff`;
    const requesterId = `${RUN}-run-linkcheckoff-requester`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${RUN}-actor` });

    const { id: unreachableId } = await saveKnowledge({
      content: `${RUN} entry with a dead source link (link-check-off case)`,
      title: 'linkcheckoff-flagged-entry',
      scope: 'global',
      sourceUrl: 'https://example.com/dead-link-off',
    });
    await pool.query(
      `UPDATE knowledge SET source_unreachable = true, source_checked_at = now() WHERE id = $1`,
      [unreachableId],
    );

    // A pending access request (guild-wide) guarantees a non-null message so
    // "no line renders" is a meaningful assertion, not just "no message sent".
    await recordAccessRequest({ platform: 'discord', userId: requesterId, userName: 'tester' });

    const wasEnabled = config.knowledgeLinkCheck.enabled;
    config.knowledgeLinkCheck.enabled = false;
    const querySpy = t.mock.method(pool, 'query');

    const sent: Array<{ userId: string; text: string }> = [];
    const adapter = fakeAdapter({ platform: 'discord', conversationIds: [conversationId], sent });

    try {
      await runAdminDigestOnce([adapter]);
    } finally {
      config.knowledgeLinkCheck.enabled = wasEnabled;
    }

    assert.equal(sent.length, 1, 'the pending access request alone still triggers a digest');
    assert.ok(
      !sent[0].text.includes('🔗'),
      'SECURITY: no unreachable-source-knowledge line renders when the flag is off, even with a flagged row present',
    );

    const issuedSourceUnreachableQuery = querySpy.mock.calls.some((call) =>
      String(call.arguments[0]).includes('source_unreachable'),
    );
    assert.ok(
      !issuedSourceUnreachableQuery,
      'SECURITY: the source_unreachable COUNT(*) is never issued while the flag is off — fail-safe by ' +
        'construction (config.knowledgeLinkCheck.enabled resolves straight to Promise.resolve(0)), not merely a zero result',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [unreachableId]);
    await clearAccessRequest('discord', requesterId);
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
    await pool.query(`DELETE FROM admin_digest_sends WHERE platform_user_id = $1`, [adminId]);
  },
);
