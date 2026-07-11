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
  countKnowledgeGaps,
  countLowRatedKnowledge,
  countMaxTurnsFailures,
  countPendingSuggestions,
  countStaleKnowledge,
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
      { total: 0, joinedThisWeek: 0, leftThisWeek: 0 },
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
