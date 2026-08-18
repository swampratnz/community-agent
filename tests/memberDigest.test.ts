import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';
import type { ContextDigest } from '@swampratnz/agent-base/storage/repository.js';
import type { MemberDigestContentDeps, MemberDigestRunDeps } from '../src/module/memberDigest.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/usageCostDigest.test.ts. MEMBER_DIGEST_CHANNEL_ID is
// fixed for this whole process so the "sends to exactly the configured
// channel" tests below have a concrete value to assert against; the
// disabled-by-default path (MEMBER_DIGEST_ENABLED unset) is covered by the
// shared loop in tests/backgroundJobsDisabled.test.ts, not here — config is
// parsed once per process at import time, so "enabled" and "disabled"
// behaviour can't share a file.
const hasDb = Boolean(process.env.DATABASE_URL);
const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';
process.env.MEMBER_DIGEST_CHANNEL_ID = 'configured-channel-1';

const { formatMemberDigestMessage, makeDefaultMemberDigestRun, startMemberDigest, buildMemberDigestContent } =
  await import('../src/module/memberDigest.js');
const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');
const {
  wasMemberDigestSentRecently,
  recordMemberDigestSent,
  listCuratedKnowledgeCreatedSince,
  listReleaseWatchUpdatesSince,
  saveKnowledge,
  updateKnowledge,
  countProjectsSharedSince,
  shareProject,
  countInterestsPublishedSince,
  setMemberInterests,
  setHelperAvailability,
  countHelperMatchesSince,
  countProjectConnectionsSince,
  recordHelperNotificationIfUnderCap,
  recordProjectConnectionIfUnderCap,
} = await import('@swampratnz/agent-base/storage/repository.js');
const { config } = await import('@swampratnz/agent-base/config.js');

after(async () => {
  await closeDb();
});

const unexpected = (name: string) => () => {
  throw new Error(`unexpected ${name} call: stub it explicitly if this test means to exercise it`);
};

/**
 * Deps whose every read THROWS. Spread `throwingRunDeps()` (or, for
 * `buildMemberDigestContent`, `throwingContentDeps()`) as the base of a deps
 * object and override only the reads the test actually exercises.
 *
 * Why throwing rather than `async () => 0`: every field here defaults to a real
 * repository read (issue #868), so an omitted stub used to mean a live Postgres
 * query from this file. Because `node:test` runs test FILES in parallel, those
 * stray reads landed on tables other files were counting, which is one source
 * of the suite's cross-file flakiness. A throwing stub keeps the DB out of it
 * AND refuses to pass vacuously — a test that unexpectedly reaches one of these
 * reads names the read in its failure instead of quietly succeeding on a zero.
 *
 * The deps types have no optional fields, so adding a new digest signal breaks
 * these two helpers (one compile error, one place) and then every call site that
 * needs to stub it — which is the whole point.
 */
function throwingContentDeps(): MemberDigestContentDeps {
  return {
    getDigests: unexpected('getDigests'),
    getNewKnowledgeTitles: unexpected('getNewKnowledgeTitles'),
    getNewProjectCount: unexpected('getNewProjectCount'),
    getReleaseWatchUpdates: unexpected('getReleaseWatchUpdates'),
    getMemberTipCount: unexpected('getMemberTipCount'),
    getNewInterestCount: unexpected('getNewInterestCount'),
    getHelperMatchesCount: unexpected('getHelperMatchesCount'),
    getProjectConnectionsCount: unexpected('getProjectConnectionsCount'),
  };
}

function throwingRunDeps(): MemberDigestRunDeps {
  return {
    ...throwingContentDeps(),
    wasSentRecently: unexpected('wasSentRecently'),
    recordSent: unexpected('recordSent'),
  };
}

/**
 * `config` is deeply readonly by design (it's parsed once at import time and
 * must never be mutated in production). These tests still need to flip
 * feature flags around a try/finally, so this narrow cast is the sanctioned
 * test-only escape hatch — kept as one named helper so the intent is visible
 * rather than scattered as bare assignments the type system silently allowed
 * only because `tests/` went untypechecked.
 */
function mutable<T>(o: T): { -readonly [K in keyof T]: T[K] } {
  return o;
}

function makeAdapter(platform: 'discord' | 'whatsapp' = 'discord'): {
  adapter: PlatformAdapter;
  sent: OutgoingMessage[];
} {
  const sent: OutgoingMessage[] = [];
  const adapter: PlatformAdapter = {
    platform,
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage() {},
    async sendMessage(out: OutgoingMessage) {
      sent.push(out);
      return undefined;
    },
    async sendDirectMessage() {},
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return { adapter, sent };
}

// distinctUsers defaults to config.memberDigest.minDistinctUsers's own
// default (3) so callers that don't care about the k-floor clear it
// automatically; tests exercising the floor itself override explicitly.
function makeDigest(overrides: Partial<ContextDigest> = {}): ContextDigest {
  return {
    id: 1,
    periodStart: new Date(0),
    periodEnd: new Date(0),
    platform: null,
    topic: 'MCP server auth',
    summary: 'Aggregate summary.',
    exampleRefs: [],
    distinctUsers: 3,
    questionCount: 1,
    createdAt: new Date(0),
    ...overrides,
  };
}

// --- formatMemberDigestMessage (pure, byte-tested) --------------------------

test('formatMemberDigestMessage: no topics, no new knowledge titles, no new projects renders null — silence over noise', () => {
  assert.equal(formatMemberDigestMessage([], [], 0), null);
});

test('formatMemberDigestMessage: topics only renders the topic section, no knowledge-base line, no project line', () => {
  const message = formatMemberDigestMessage(
    [
      { topic: 'MCP server auth', questionCount: 4 },
      { topic: 'Bedrock region gotchas', questionCount: 1 },
    ],
    [],
    0,
  );
  assert.equal(
    message,
    "📅 This week's topics:\n• MCP server auth (4 questions)\n• Bedrock region gotchas (1 question)",
  );
  assert.doesNotMatch(message ?? '', /knowledge base/i);
  assert.doesNotMatch(message ?? '', /showcase/i);
});

test('formatMemberDigestMessage: new knowledge titles only renders the knowledge-base line, no topics section, no project line', () => {
  const message = formatMemberDigestMessage([], ['Setting up MCP auth', 'Bedrock region checklist'], 0);
  assert.equal(message, '📚 New in the knowledge base (2): Setting up MCP auth, Bedrock region checklist');
  assert.doesNotMatch(message ?? '', /This week's topics/);
  assert.doesNotMatch(message ?? '', /showcase/i);
});

test('formatMemberDigestMessage: both sections present render topics then the knowledge-base line, separated by a blank line', () => {
  const message = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    ['Setting up MCP auth'],
    0,
  );
  assert.equal(
    message,
    "📅 This week's topics:\n• MCP server auth (1 question)\n\n📚 New in the knowledge base (1): Setting up MCP auth",
  );
});

test('formatMemberDigestMessage: singular/plural "question(s)" agrees with the exact count', () => {
  const message = formatMemberDigestMessage(
    [
      { topic: 'One-question topic', questionCount: 1 },
      { topic: 'Multi-question topic', questionCount: 2 },
    ],
    [],
    0,
  );
  assert.match(message ?? '', /One-question topic \(1 question\)/);
  assert.match(message ?? '', /Multi-question topic \(2 questions\)/);
});

test('SECURITY: formatMemberDigestMessage scrubs PII out of a topic label before rendering — the builder\'s "no names/handles" prompt contract is not trusted alone', () => {
  const message = formatMemberDigestMessage(
    [{ topic: 'Contact alice@example.com or @alice_h about MCP auth', questionCount: 2 }],
    [],
    0,
  );
  assert.doesNotMatch(message ?? '', /alice@example\.com|@alice_h/);
  assert.match(message ?? '', /\[email\]/);
  assert.match(message ?? '', /\[handle\]/);
});

// --- formatMemberDigestMessage: project-showcase count (issue #714) --------

test('formatMemberDigestMessage: newProjectCount > 0 renders the showcase section with singular/plural agreement', () => {
  const singular = formatMemberDigestMessage([], [], 1);
  assert.equal(
    singular,
    '🚀 1 new project added to the showcase this week — ask me to show the project showcase to browse.',
  );
  const plural = formatMemberDigestMessage([], [], 3);
  assert.equal(
    plural,
    '🚀 3 new projects added to the showcase this week — ask me to show the project showcase to browse.',
  );
});

test("formatMemberDigestMessage: newProjectCount === 0 renders byte-identical to today's two-section output — no third section, no trailing separator", () => {
  const withoutProjectArg = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    ['Setting up MCP auth'],
    0,
  );
  assert.equal(
    withoutProjectArg,
    "📅 This week's topics:\n• MCP server auth (1 question)\n\n📚 New in the knowledge base (1): Setting up MCP auth",
  );
});

test('formatMemberDigestMessage: an only-projects week (zero topics, zero new knowledge, newProjectCount > 0) still returns a non-null message containing only the project section', () => {
  const message = formatMemberDigestMessage([], [], 2);
  assert.equal(
    message,
    '🚀 2 new projects added to the showcase this week — ask me to show the project showcase to browse.',
  );
  assert.doesNotMatch(message ?? '', /This week's topics|knowledge base/);
});

test('formatMemberDigestMessage: project section renders last, after topics and knowledge-base sections', () => {
  const message = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    ['Setting up MCP auth'],
    1,
  );
  assert.equal(
    message,
    "📅 This week's topics:\n• MCP server auth (1 question)\n\n📚 New in the knowledge base (1): Setting up MCP auth\n\n🚀 1 new project added to the showcase this week — ask me to show the project showcase to browse.",
  );
});

// --- formatMemberDigestMessage: release-watch section (issue #733) ---------

test('formatMemberDigestMessage: omitting the 4th argument renders byte-identical to explicitly passing an empty array — existing call sites are unaffected', () => {
  const withoutArg = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    ['Setting up MCP auth'],
    1,
  );
  const withEmptyArray = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    ['Setting up MCP auth'],
    1,
    [],
  );
  assert.equal(withoutArg, withEmptyArray);
});

test('formatMemberDigestMessage: a quiet week across all four inputs (topics, knowledge, projects, release-watch) still renders null', () => {
  assert.equal(formatMemberDigestMessage([], [], 0, []), null);
});

test('formatMemberDigestMessage: releaseWatchPages only renders the release-watch section, no other sections', () => {
  const message = formatMemberDigestMessage([], [], 0, [
    {
      title: 'docs: release-notes/overview',
      url: 'https://platform.claude.com/docs/en/release-notes/overview',
    },
  ]);
  assert.equal(
    message,
    '🆕 Anthropic platform updates this week: [docs: release-notes/overview](https://platform.claude.com/docs/en/release-notes/overview)',
  );
  assert.doesNotMatch(message ?? '', /This week's topics|knowledge base|showcase/i);
});

test('formatMemberDigestMessage: a release-watch page with a null url renders its bare title, not a markdown link', () => {
  const message = formatMemberDigestMessage([], [], 0, [
    { title: 'docs: about-claude/model-deprecations', url: null },
  ]);
  assert.equal(message, '🆕 Anthropic platform updates this week: docs: about-claude/model-deprecations');
  assert.doesNotMatch(message ?? '', /\[.*\]\(.*\)/, 'no markdown link syntax when url is null');
});

test('formatMemberDigestMessage: multiple release-watch pages are comma-joined', () => {
  const message = formatMemberDigestMessage([], [], 0, [
    { title: 'docs: release-notes/overview', url: 'https://platform.claude.com/a' },
    { title: 'docs: about-claude/model-deprecations', url: null },
  ]);
  assert.equal(
    message,
    '🆕 Anthropic platform updates this week: [docs: release-notes/overview](https://platform.claude.com/a), docs: about-claude/model-deprecations',
  );
});

test('formatMemberDigestMessage: release-watch section renders last, after topics, knowledge-base, and project sections', () => {
  const message = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    ['Setting up MCP auth'],
    1,
    [{ title: 'docs: release-notes/overview', url: 'https://platform.claude.com/a' }],
  );
  assert.equal(
    message,
    "📅 This week's topics:\n• MCP server auth (1 question)\n\n📚 New in the knowledge base (1): Setting up MCP auth\n\n🚀 1 new project added to the showcase this week — ask me to show the project showcase to browse.\n\n🆕 Anthropic platform updates this week: [docs: release-notes/overview](https://platform.claude.com/a)",
  );
});

test('formatMemberDigestMessage: an only-release-watch week (all other inputs empty) still returns a non-null message containing only that section', () => {
  const message = formatMemberDigestMessage([], [], 0, [
    { title: 'docs: release-notes/overview', url: null },
  ]);
  assert.equal(message, '🆕 Anthropic platform updates this week: docs: release-notes/overview');
});

// --- formatMemberDigestMessage: member-tip note (issue #837) ---------------

test('formatMemberDigestMessage: memberTipCount > 0 appends a trailing clause to the knowledge-base line with singular/plural agreement', () => {
  const singular = formatMemberDigestMessage([], ['Setting up MCP auth'], 0, [], 1);
  assert.equal(
    singular,
    '📚 New in the knowledge base (1): Setting up MCP auth — 1 suggested by a member like you 💡',
  );
  const plural = formatMemberDigestMessage([], ['Setting up MCP auth', 'Bedrock region checklist'], 0, [], 2);
  assert.equal(
    plural,
    '📚 New in the knowledge base (2): Setting up MCP auth, Bedrock region checklist — 2 suggested by members like you 💡',
  );
});

test("formatMemberDigestMessage: memberTipCount === 0 (default, omitted argument) renders byte-identical to today's knowledge-base line", () => {
  const withDefault = formatMemberDigestMessage([], ['Setting up MCP auth'], 0);
  const withExplicitZero = formatMemberDigestMessage([], ['Setting up MCP auth'], 0, [], 0);
  assert.equal(withDefault, '📚 New in the knowledge base (1): Setting up MCP auth');
  assert.equal(withDefault, withExplicitZero);
});

test('formatMemberDigestMessage: memberTipCount is clamped to newKnowledgeTitles.length — the clause never reads as a subset larger than the titles shown', () => {
  const message = formatMemberDigestMessage([], ['Setting up MCP auth'], 0, [], 12);
  assert.equal(
    message,
    '📚 New in the knowledge base (1): Setting up MCP auth — 1 suggested by a member like you 💡',
    'a memberTipCount (12, an uncapped aggregate) far exceeding the one displayed title clamps down to 1, never rendering "(1): ... — 12 suggested"',
  );
});

test('formatMemberDigestMessage: memberTipCount > 0 with an empty newKnowledgeTitles renders no knowledge-base line and no orphan clause', () => {
  const message = formatMemberDigestMessage([], [], 0, [], 5);
  assert.equal(message, null, 'the clause has nothing to attach to when no knowledge-base line renders');
});

test('formatMemberDigestMessage: memberTipCount never affects any other section', () => {
  const message = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    [],
    1,
    [{ title: 'docs: release-notes/overview', url: null }],
    5,
  );
  assert.equal(
    message,
    "📅 This week's topics:\n• MCP server auth (1 question)\n\n🚀 1 new project added to the showcase this week — ask me to show the project showcase to browse.\n\n🆕 Anthropic platform updates this week: docs: release-notes/overview",
  );
});

test('SECURITY: formatMemberDigestMessage never emits a platform name or user-id-shaped string for any memberTipCount input — the parameter is a bare number, not a candidate row/list', () => {
  const inputs = [0, 1, 2, 10, 999_999, -5];
  for (const memberTipCount of inputs) {
    const message = formatMemberDigestMessage([], ['Setting up MCP auth'], 0, [], memberTipCount);
    assert.ok(message);
    assert.doesNotMatch(
      message,
      /discord|whatsapp/i,
      `memberTipCount=${memberTipCount} must never leak a platform name`,
    );
    assert.doesNotMatch(
      message,
      /\b\d{15,20}\b/,
      `memberTipCount=${memberTipCount} must never leak a Discord-snowflake-shaped id`,
    );
  }
});

// --- formatMemberDigestMessage: member-interests count (issue #815) --------

test('formatMemberDigestMessage: newInterestCount > 0 renders the interests section with singular/plural agreement', () => {
  const singular = formatMemberDigestMessage([], [], 0, [], 0, 1);
  assert.equal(
    singular,
    '🔍 1 member published or updated their interests this week — ask me "who\'s into X?" to find them.',
  );
  const plural = formatMemberDigestMessage([], [], 0, [], 0, 3);
  assert.equal(
    plural,
    '🔍 3 members published or updated their interests this week — ask me "who\'s into X?" to find them.',
  );
});

test('formatMemberDigestMessage: newInterestCount === 0 renders byte-identical to the shorter-argument output — no interests section', () => {
  const withoutInterestArg = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    ['Setting up MCP auth'],
    1,
    [{ title: 'docs: release-notes/overview', url: null }],
  );
  const withZeroInterestCount = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    ['Setting up MCP auth'],
    1,
    [{ title: 'docs: release-notes/overview', url: null }],
    0,
    0,
  );
  assert.equal(withoutInterestArg, withZeroInterestCount);
});

test('formatMemberDigestMessage: an only-interests week (all other inputs empty) still returns a non-null message containing only the interests section', () => {
  const message = formatMemberDigestMessage([], [], 0, [], 0, 2);
  assert.equal(
    message,
    '🔍 2 members published or updated their interests this week — ask me "who\'s into X?" to find them.',
  );
  assert.doesNotMatch(message ?? '', /This week's topics|knowledge base|showcase|platform updates/i);
});

test('formatMemberDigestMessage: interests section renders last, after topics, knowledge-base, project and release-watch sections', () => {
  const message = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    ['Setting up MCP auth'],
    1,
    [{ title: 'docs: release-notes/overview', url: 'https://platform.claude.com/a' }],
    0,
    1,
  );
  assert.equal(
    message,
    '📅 This week\'s topics:\n• MCP server auth (1 question)\n\n📚 New in the knowledge base (1): Setting up MCP auth\n\n🚀 1 new project added to the showcase this week — ask me to show the project showcase to browse.\n\n🆕 Anthropic platform updates this week: [docs: release-notes/overview](https://platform.claude.com/a)\n\n🔍 1 member published or updated their interests this week — ask me "who\'s into X?" to find them.',
  );
});

test('formatMemberDigestMessage: a quiet week across all five inputs (topics, knowledge, projects, release-watch, interests) still renders null', () => {
  assert.equal(formatMemberDigestMessage([], [], 0, [], 0), null);
});

// --- formatMemberDigestMessage: member→member connection count (issue #1012) --

test('formatMemberDigestMessage: connectionCount > 0 renders the connections section with singular/plural agreement', () => {
  const singular = formatMemberDigestMessage([], [], 0, [], 0, 0, 1);
  assert.equal(singular, '🤝 1 member connected with help or a collaborator this week.');
  const plural = formatMemberDigestMessage([], [], 0, [], 0, 0, 3);
  assert.equal(plural, '🤝 3 members connected with help or a collaborator this week.');
});

test('formatMemberDigestMessage: connectionCount === 0 (default, omitted argument) renders byte-identical to the shorter-argument output — no connections section', () => {
  const withoutConnectionArg = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    ['Setting up MCP auth'],
    1,
    [{ title: 'docs: release-notes/overview', url: null }],
    0,
    1,
  );
  const withZeroConnectionCount = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    ['Setting up MCP auth'],
    1,
    [{ title: 'docs: release-notes/overview', url: null }],
    0,
    1,
    0,
  );
  assert.equal(withoutConnectionArg, withZeroConnectionCount);
});

test('formatMemberDigestMessage: an only-connections week (all other inputs empty) still returns a non-null message containing only the connections section', () => {
  const message = formatMemberDigestMessage([], [], 0, [], 0, 0, 2);
  assert.equal(message, '🤝 2 members connected with help or a collaborator this week.');
  assert.doesNotMatch(
    message ?? '',
    /This week's topics|knowledge base|showcase|platform updates|interests/i,
  );
});

test('formatMemberDigestMessage: connections section renders last, after topics, knowledge-base, project, release-watch and interests sections', () => {
  const message = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    ['Setting up MCP auth'],
    1,
    [{ title: 'docs: release-notes/overview', url: 'https://platform.claude.com/a' }],
    0,
    1,
    1,
  );
  assert.equal(
    message,
    '📅 This week\'s topics:\n• MCP server auth (1 question)\n\n📚 New in the knowledge base (1): Setting up MCP auth\n\n🚀 1 new project added to the showcase this week — ask me to show the project showcase to browse.\n\n🆕 Anthropic platform updates this week: [docs: release-notes/overview](https://platform.claude.com/a)\n\n🔍 1 member published or updated their interests this week — ask me "who\'s into X?" to find them.\n\n🤝 1 member connected with help or a collaborator this week.',
  );
});

test('formatMemberDigestMessage: a quiet week across all six inputs (topics, knowledge, projects, release-watch, interests, connections) still renders null — connectionCount is a 6th input to the null-guard OR condition', () => {
  assert.equal(formatMemberDigestMessage([], [], 0, [], 0, 0, 0), null);
});

test('SECURITY: formatMemberDigestMessage: the connections section is exactly the fixed template with only the count digit(s) interpolated — no identifier, handle, topic, project name, or platform is reachable through this code path (issue #1012 acceptance criterion 5)', () => {
  const inputs = [1, 2, 10, 999_999];
  for (const connectionCount of inputs) {
    const message = formatMemberDigestMessage([], [], 0, [], 0, 0, connectionCount);
    assert.equal(
      message,
      `🤝 ${connectionCount} member${connectionCount === 1 ? '' : 's'} connected with help or a collaborator this week.`,
      `connectionCount=${connectionCount} must render exactly the fixed template with only the digit(s) interpolated`,
    );
    assert.doesNotMatch(
      message ?? '',
      /discord|whatsapp/i,
      `connectionCount=${connectionCount} must never leak a platform name`,
    );
    assert.doesNotMatch(
      message ?? '',
      /\b\d{15,20}\b/,
      `connectionCount=${connectionCount} must never leak a Discord-snowflake-shaped id`,
    );
  }
});

// --- makeDefaultMemberDigestRun (injected deps, no real DB) ----------------

test('makeDefaultMemberDigestRun: MEMBER_DIGEST_CHANNEL_ID unset, runOnce is a no-op — no send, no freshness read', async () => {
  const original = config.memberDigest.channelId;
  mutable(config.memberDigest).channelId = undefined;
  try {
    const { adapter, sent } = makeAdapter();
    let wasSentRecentlyCalled = false;
    let memberTipCountCalled = false;
    const runOnce = makeDefaultMemberDigestRun([adapter], {
      ...throwingRunDeps(),
      wasSentRecently: async () => {
        wasSentRecentlyCalled = true;
        return false;
      },
      getDigests: async () => [],
      getNewKnowledgeTitles: async () => [],
      getMemberTipCount: async () => {
        memberTipCountCalled = true;
        return 0;
      },
      recordSent: async () => {},
    });
    await runOnce();
    assert.equal(sent.length, 0, 'no send when the channel id is unconfigured');
    assert.equal(
      wasSentRecentlyCalled,
      false,
      'the freshness guard is never even checked when config is incomplete',
    );
    assert.equal(
      memberTipCountCalled,
      false,
      'the new count read is never invoked when the digest is inert (channel unconfigured)',
    );
  } finally {
    mutable(config.memberDigest).channelId = original;
  }
});

test('makeDefaultMemberDigestRun: inside the freshness window, runOnce is a no-op — no digest read, no knowledge read, no member-tip read, no send', async () => {
  const { adapter, sent } = makeAdapter();
  let digestsCalled = false;
  let knowledgeCalled = false;
  let memberTipCountCalled = false;
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => true,
    getDigests: async () => {
      digestsCalled = true;
      return [];
    },
    getNewKnowledgeTitles: async () => {
      knowledgeCalled = true;
      return [];
    },
    getMemberTipCount: async () => {
      memberTipCountCalled = true;
      return 0;
    },
    recordSent: async () => {},
  });
  await runOnce();
  assert.equal(sent.length, 0, 'no send inside the freshness window');
  assert.equal(digestsCalled, false, 'digests are never read inside the freshness window');
  assert.equal(knowledgeCalled, false, 'new knowledge is never read inside the freshness window');
  assert.equal(memberTipCountCalled, false, 'the member-tip count is never read inside the freshness window');
});

test('makeDefaultMemberDigestRun: no connected Discord adapter — no-op, no throw, no send', async () => {
  const { adapter: whatsappAdapter, sent } = makeAdapter('whatsapp');
  const runOnce = makeDefaultMemberDigestRun([whatsappAdapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => false,
    getDigests: async () => [makeDigest({ topic: 'x', questionCount: 1 })],
    getNewKnowledgeTitles: async () => [],
    recordSent: async () => {},
  });
  await runOnce();
  assert.equal(sent.length, 0, 'never sends over a non-Discord adapter, even when content exists');
});

test('makeDefaultMemberDigestRun: a quiet week (no digests, no new knowledge, no new projects) sends nothing and does not record — silence over noise', async () => {
  const { adapter, sent } = makeAdapter();
  let recordCalled = false;
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => false,
    getDigests: async () => [],
    getNewKnowledgeTitles: async () => [],
    getNewInterestCount: async () => 0,
    getNewProjectCount: async () => 0,
    getMemberTipCount: async () => 0,
    getHelperMatchesCount: async () => 0,
    getProjectConnectionsCount: async () => 0,
    recordSent: async () => {
      recordCalled = true;
    },
  });
  await runOnce();
  assert.equal(sent.length, 0, 'a quiet week posts nothing');
  assert.equal(recordCalled, false, 'a quiet week does not stamp the freshness guard');
});

test('makeDefaultMemberDigestRun: past the freshness window with content, posts to the channel and records the send', async () => {
  const { adapter, sent } = makeAdapter();
  let recordCalled = false;
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => false,
    getDigests: async () => [makeDigest({ topic: 'MCP server auth', questionCount: 4 })],
    getNewKnowledgeTitles: async () => ['Setting up MCP auth'],
    getNewInterestCount: async () => 0,
    getNewProjectCount: async () => 0,
    getMemberTipCount: async () => 0,
    getHelperMatchesCount: async () => 0,
    getProjectConnectionsCount: async () => 0,
    recordSent: async () => {
      recordCalled = true;
    },
  });
  await runOnce();
  assert.equal(sent.length, 1, 'exactly one post');
  assert.equal(
    sent[0].text,
    "📅 This week's topics:\n• MCP server auth (4 questions)\n\n📚 New in the knowledge base (1): Setting up MCP auth",
  );
  assert.equal(recordCalled, true, 'a real send stamps the freshness guard');
});

test('makeDefaultMemberDigestRun: getMemberTipCount is called with the exact same `since` instant as getNewKnowledgeTitles/getNewProjectCount, and a nonzero result reaches the sent message (issue #837)', async () => {
  const { adapter, sent } = makeAdapter();
  let knowledgeSince: Date | undefined;
  let tipSince: Date | undefined;
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => false,
    getDigests: async () => [],
    getNewKnowledgeTitles: async (since) => {
      knowledgeSince = since;
      return ['Setting up MCP auth'];
    },
    getNewInterestCount: async () => 0,
    getNewProjectCount: async () => 0,
    getMemberTipCount: async (since) => {
      tipSince = since;
      return 1;
    },
    getHelperMatchesCount: async () => 0,
    getProjectConnectionsCount: async () => 0,
    recordSent: async () => {},
  });
  await runOnce();
  assert.ok(knowledgeSince instanceof Date && tipSince instanceof Date);
  assert.equal(
    tipSince?.getTime(),
    knowledgeSince?.getTime(),
    'getMemberTipCount receives the exact same since instant as getNewKnowledgeTitles',
  );
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].text,
    '📚 New in the knowledge base (1): Setting up MCP auth — 1 suggested by a member like you 💡',
  );
});

test("makeDefaultMemberDigestRun: an only-projects week (zero topics, zero new knowledge, newProjectCount > 0) still posts — the null-guard's OR condition covers all three inputs", async () => {
  const { adapter, sent } = makeAdapter();
  let recordCalled = false;
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => false,
    getDigests: async () => [],
    getNewKnowledgeTitles: async () => [],
    getNewInterestCount: async () => 0,
    getNewProjectCount: async () => 2,
    getMemberTipCount: async () => 0,
    getHelperMatchesCount: async () => 0,
    getProjectConnectionsCount: async () => 0,
    recordSent: async () => {
      recordCalled = true;
    },
  });
  await runOnce();
  assert.equal(sent.length, 1, 'a week with only new projects still posts');
  assert.equal(
    sent[0].text,
    '🚀 2 new projects added to the showcase this week — ask me to show the project showcase to browse.',
  );
  assert.equal(recordCalled, true);
});

test('makeDefaultMemberDigestRun: getNewProjectCount is called with the exact same `since` instant already computed for getNewKnowledgeTitles — one window, no second Date.now() call', async () => {
  const { adapter, sent } = makeAdapter();
  let knowledgeSince: Date | undefined;
  let projectSince: Date | undefined;
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => false,
    getDigests: async () => [],
    getNewKnowledgeTitles: async (since) => {
      knowledgeSince = since;
      return [];
    },
    getNewInterestCount: async () => 0,
    getNewProjectCount: async (since) => {
      projectSince = since;
      return 0;
    },
    getMemberTipCount: async () => 0,
    getHelperMatchesCount: async () => 0,
    getProjectConnectionsCount: async () => 0,
    recordSent: async () => {},
  });
  await runOnce();
  assert.ok(knowledgeSince instanceof Date && projectSince instanceof Date);
  assert.equal(
    projectSince?.getTime(),
    knowledgeSince?.getTime(),
    'getNewProjectCount receives the exact same since instant as getNewKnowledgeTitles',
  );
  assert.equal(sent.length, 0, 'both inputs still empty this run — nothing to post');
});

// --- makeDefaultMemberDigestRun: release-watch wiring (issue #733) ---------

test('SECURITY: makeDefaultMemberDigestRun never calls getReleaseWatchUpdates when RELEASE_WATCH_ENABLED is unset/false, and the digest is byte-identical to today for a fixture with other content', async () => {
  const original = config.releaseWatch.enabled;
  mutable(config.releaseWatch).enabled = false;
  try {
    const { adapter, sent } = makeAdapter();
    let releaseWatchCalled = false;
    const runOnce = makeDefaultMemberDigestRun([adapter], {
      ...throwingRunDeps(),
      wasSentRecently: async () => false,
      getDigests: async () => [makeDigest({ topic: 'MCP server auth', questionCount: 4 })],
      getNewKnowledgeTitles: async () => ['Setting up MCP auth'],
      getNewInterestCount: async () => 0,
      getNewProjectCount: async () => 0,
      getMemberTipCount: async () => 0,
      getHelperMatchesCount: async () => 0,
      getProjectConnectionsCount: async () => 0,
      getReleaseWatchUpdates: async () => {
        releaseWatchCalled = true;
        return [{ pageTitle: 'docs: release-notes/overview', sourceUrl: null }];
      },
      recordSent: async () => {},
    });
    await runOnce();
    assert.equal(releaseWatchCalled, false, 'the new read is never issued while the flag is off');
    assert.equal(sent.length, 1);
    assert.equal(
      sent[0].text,
      "📅 This week's topics:\n• MCP server auth (4 questions)\n\n📚 New in the knowledge base (1): Setting up MCP auth",
      'byte-identical to the pre-#733 output — no release-watch section, even though the injected dep would have returned content',
    );
  } finally {
    mutable(config.releaseWatch).enabled = original;
  }
});

test('makeDefaultMemberDigestRun: with RELEASE_WATCH_ENABLED true, getReleaseWatchUpdates is called with the shared `since` window and configured doc paths, and its result reaches the sent message', async () => {
  const originalEnabled = config.releaseWatch.enabled;
  const originalPaths = config.releaseWatch.docPaths;
  mutable(config.releaseWatch).enabled = true;
  mutable(config.releaseWatch).docPaths = ['release-notes', 'about-claude/model-deprecations'];
  try {
    const { adapter, sent } = makeAdapter();
    let receivedSince: Date | undefined;
    let receivedPaths: readonly string[] | undefined;
    const runOnce = makeDefaultMemberDigestRun([adapter], {
      ...throwingRunDeps(),
      wasSentRecently: async () => false,
      getDigests: async () => [],
      getNewKnowledgeTitles: async (since) => {
        receivedSince = since;
        return [];
      },
      getNewInterestCount: async () => 0,
      getNewProjectCount: async () => 0,
      getMemberTipCount: async () => 0,
      getHelperMatchesCount: async () => 0,
      getProjectConnectionsCount: async () => 0,
      getReleaseWatchUpdates: async (since, pathPrefixes) => {
        receivedPaths = pathPrefixes;
        assert.equal(since.getTime(), receivedSince?.getTime(), 'shares the exact same since instant');
        return [
          {
            pageTitle: 'docs: release-notes/overview',
            sourceUrl: 'https://platform.claude.com/docs/en/release-notes/overview',
          },
        ];
      },
      recordSent: async () => {},
    });
    await runOnce();
    assert.deepEqual(receivedPaths, ['release-notes', 'about-claude/model-deprecations']);
    assert.equal(sent.length, 1);
    assert.equal(
      sent[0].text,
      '🆕 Anthropic platform updates this week: [docs: release-notes/overview](https://platform.claude.com/docs/en/release-notes/overview)',
    );
  } finally {
    mutable(config.releaseWatch).enabled = originalEnabled;
    mutable(config.releaseWatch).docPaths = originalPaths;
  }
});

test('makeDefaultMemberDigestRun: an only-release-watch week (zero topics, zero new knowledge, zero new projects) still posts — release-watch is a 4th input to the same null-guard OR condition', async () => {
  const original = config.releaseWatch.enabled;
  mutable(config.releaseWatch).enabled = true;
  try {
    const { adapter, sent } = makeAdapter();
    let recordCalled = false;
    const runOnce = makeDefaultMemberDigestRun([adapter], {
      ...throwingRunDeps(),
      wasSentRecently: async () => false,
      getDigests: async () => [],
      getNewKnowledgeTitles: async () => [],
      getNewInterestCount: async () => 0,
      getNewProjectCount: async () => 0,
      getMemberTipCount: async () => 0,
      getHelperMatchesCount: async () => 0,
      getProjectConnectionsCount: async () => 0,
      getReleaseWatchUpdates: async () => [{ pageTitle: 'docs: release-notes/overview', sourceUrl: null }],
      recordSent: async () => {
        recordCalled = true;
      },
    });
    await runOnce();
    assert.equal(sent.length, 1, 'a week with only a release-watch update still posts');
    assert.equal(sent[0].text, '🆕 Anthropic platform updates this week: docs: release-notes/overview');
    assert.equal(recordCalled, true);
  } finally {
    mutable(config.releaseWatch).enabled = original;
  }
});

// --- makeDefaultMemberDigestRun: member-interests wiring (issue #815) ------

test('makeDefaultMemberDigestRun: an only-interests week (zero topics, zero new knowledge, zero new projects, no release-watch) still posts — newInterestCount is a 5th input to the same null-guard OR condition', async () => {
  const { adapter, sent } = makeAdapter();
  let recordCalled = false;
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => false,
    getDigests: async () => [],
    getNewKnowledgeTitles: async () => [],
    getNewProjectCount: async () => 0,
    // Un-injected deps fall through to the REAL repository (see
    // buildMemberDigestContent's `deps.x ?? <repo fn>` defaults), so a missing
    // stub here is a silent live-Postgres dependency, not a no-op.
    getMemberTipCount: async () => 0,
    getNewInterestCount: async () => 4,
    getHelperMatchesCount: async () => 0,
    getProjectConnectionsCount: async () => 0,
    recordSent: async () => {
      recordCalled = true;
    },
  });
  await runOnce();
  assert.equal(sent.length, 1, 'a week with only new interests activity still posts');
  assert.equal(
    sent[0].text,
    '🔍 4 members published or updated their interests this week — ask me "who\'s into X?" to find them.',
  );
  assert.equal(recordCalled, true);
});

test('makeDefaultMemberDigestRun: getNewInterestCount is called with the exact same `since` instant already computed for getNewProjectCount — one window, no second Date.now() call', async () => {
  const { adapter, sent } = makeAdapter();
  let projectSince: Date | undefined;
  let interestSince: Date | undefined;
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => false,
    getDigests: async () => [],
    getNewKnowledgeTitles: async () => [],
    getNewProjectCount: async (since) => {
      projectSince = since;
      return 0;
    },
    getNewInterestCount: async (since) => {
      interestSince = since;
      return 0;
    },
    // Un-injected deps fall through to the REAL repository (see
    // buildMemberDigestContent's `deps.x ?? <repo fn>` defaults), so a missing
    // stub here is a silent live-Postgres dependency, not a no-op.
    getMemberTipCount: async () => 0,
    getHelperMatchesCount: async () => 0,
    getProjectConnectionsCount: async () => 0,
    recordSent: async () => {},
  });
  await runOnce();
  assert.ok(projectSince instanceof Date && interestSince instanceof Date);
  assert.equal(
    interestSince?.getTime(),
    projectSince?.getTime(),
    'getNewInterestCount receives the exact same since instant as getNewProjectCount',
  );
  assert.equal(sent.length, 0, 'both inputs still zero this run — nothing to post');
});

// --- makeDefaultMemberDigestRun: member→member connection wiring (issue #1012) --

test('makeDefaultMemberDigestRun: an only-connections week (zero topics, zero new knowledge, zero new projects, no release-watch, no new interests) still posts — connectionCount is a 6th input to the same null-guard OR condition', async () => {
  const { adapter, sent } = makeAdapter();
  let recordCalled = false;
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => false,
    getDigests: async () => [],
    getNewKnowledgeTitles: async () => [],
    getNewProjectCount: async () => 0,
    getMemberTipCount: async () => 0,
    getNewInterestCount: async () => 0,
    getHelperMatchesCount: async () => 3,
    getProjectConnectionsCount: async () => 1,
    recordSent: async () => {
      recordCalled = true;
    },
  });
  await runOnce();
  assert.equal(sent.length, 1, 'a week with only connection activity still posts');
  assert.equal(
    sent[0].text,
    '🤝 4 members connected with help or a collaborator this week.',
    'the rendered count is the sum of getHelperMatchesCount and getProjectConnectionsCount',
  );
  assert.equal(recordCalled, true);
});

test('makeDefaultMemberDigestRun: getHelperMatchesCount and getProjectConnectionsCount are both called with the exact same `since` instant already computed for getNewInterestCount — one window, no second Date.now() call', async () => {
  const { adapter, sent } = makeAdapter();
  let interestSince: Date | undefined;
  let helperSince: Date | undefined;
  let connectionSince: Date | undefined;
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => false,
    getDigests: async () => [],
    getNewKnowledgeTitles: async () => [],
    getNewProjectCount: async () => 0,
    getMemberTipCount: async () => 0,
    getNewInterestCount: async (since) => {
      interestSince = since;
      return 0;
    },
    getHelperMatchesCount: async (since) => {
      helperSince = since;
      return 0;
    },
    getProjectConnectionsCount: async (since) => {
      connectionSince = since;
      return 0;
    },
    recordSent: async () => {},
  });
  await runOnce();
  assert.ok(interestSince instanceof Date && helperSince instanceof Date && connectionSince instanceof Date);
  assert.equal(
    helperSince?.getTime(),
    interestSince?.getTime(),
    'getHelperMatchesCount receives the exact same since instant as getNewInterestCount',
  );
  assert.equal(
    connectionSince?.getTime(),
    interestSince?.getTime(),
    'getProjectConnectionsCount receives the exact same since instant as getNewInterestCount',
  );
  assert.equal(sent.length, 0, 'all inputs still zero this run — nothing to post');
});

test('SECURITY: makeDefaultMemberDigestRun drops a digest topic below MEMBER_DIGEST_MIN_DISTINCT_USERS — its own k-anonymity floor, independent of the builder/export floors', async () => {
  const original = config.memberDigest.minDistinctUsers;
  mutable(config.memberDigest).minDistinctUsers = 3;
  try {
    const { adapter, sent } = makeAdapter();
    const runOnce = makeDefaultMemberDigestRun([adapter], {
      ...throwingRunDeps(),
      wasSentRecently: async () => false,
      getDigests: async () => [
        makeDigest({ topic: 'below floor', distinctUsers: 2, questionCount: 5 }),
        makeDigest({ topic: 'at floor', distinctUsers: 3, questionCount: 1 }),
      ],
      getNewKnowledgeTitles: async () => [],
      getNewProjectCount: async () => 0,
      getMemberTipCount: async () => 0,
      getNewInterestCount: async () => 0,
      getHelperMatchesCount: async () => 0,
      getProjectConnectionsCount: async () => 0,
      recordSent: async () => {},
    });
    await runOnce();
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].text, /below floor/, 'a topic under the floor never reaches the post');
    assert.match(sent[0].text, /at floor/, 'a topic exactly at the floor is included');
  } finally {
    mutable(config.memberDigest).minDistinctUsers = original;
  }
});

test('makeDefaultMemberDigestRun: a week where every digest is below the k-floor and there is no new knowledge sends nothing', async () => {
  const original = config.memberDigest.minDistinctUsers;
  mutable(config.memberDigest).minDistinctUsers = 3;
  try {
    const { adapter, sent } = makeAdapter();
    let recordCalled = false;
    const runOnce = makeDefaultMemberDigestRun([adapter], {
      ...throwingRunDeps(),
      wasSentRecently: async () => false,
      getDigests: async () => [makeDigest({ topic: 'below floor', distinctUsers: 2 })],
      getNewKnowledgeTitles: async () => [],
      getNewInterestCount: async () => 0,
      getNewProjectCount: async () => 0,
      getMemberTipCount: async () => 0,
      getHelperMatchesCount: async () => 0,
      getProjectConnectionsCount: async () => 0,
      recordSent: async () => {
        recordCalled = true;
      },
    });
    await runOnce();
    assert.equal(sent.length, 0, 'the only digest this week was below the floor — nothing to post');
    assert.equal(recordCalled, false);
  } finally {
    mutable(config.memberDigest).minDistinctUsers = original;
  }
});

test("SECURITY: makeDefaultMemberDigestRun never surfaces a WhatsApp-sourced digest topic to the Discord audience — only platform 'discord'/null topics are eligible", async () => {
  const { adapter, sent } = makeAdapter();
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => false,
    getDigests: async () => [
      makeDigest({ topic: 'whatsapp-only topic', platform: 'whatsapp', questionCount: 5 }),
      makeDigest({ topic: 'discord topic', platform: 'discord', questionCount: 1 }),
      makeDigest({ topic: 'cross-platform topic', platform: null, questionCount: 1 }),
    ],
    getNewKnowledgeTitles: async () => [],
    getNewInterestCount: async () => 0,
    getNewProjectCount: async () => 0,
    getMemberTipCount: async () => 0,
    getHelperMatchesCount: async () => 0,
    getProjectConnectionsCount: async () => 0,
    recordSent: async () => {},
  });
  await runOnce();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(
    sent[0].text,
    /whatsapp-only topic/,
    'a WhatsApp-clustered topic never reaches the Discord-only digest',
  );
  assert.match(sent[0].text, /discord topic/);
  assert.match(
    sent[0].text,
    /cross-platform topic/,
    'a platform-null (mixed/unattributed) topic is still eligible',
  );
});

test('SECURITY: makeDefaultMemberDigestRun posts to exactly MEMBER_DIGEST_CHANNEL_ID from config — never a model- or message-derived id, even with multiple adapters registered', async () => {
  const { adapter: discordAdapter, sent } = makeAdapter('discord');
  const { adapter: whatsappAdapter } = makeAdapter('whatsapp');
  const runOnce = makeDefaultMemberDigestRun([whatsappAdapter, discordAdapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => false,
    getDigests: async () => [makeDigest({ topic: 'MCP server auth', questionCount: 1 })],
    getNewKnowledgeTitles: async () => [],
    getNewInterestCount: async () => 0,
    getNewProjectCount: async () => 0,
    getMemberTipCount: async () => 0,
    getHelperMatchesCount: async () => 0,
    getProjectConnectionsCount: async () => 0,
    recordSent: async () => {},
  });
  await runOnce();
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].conversationId,
    'configured-channel-1',
    'the post target is exactly config.memberDigest.channelId (MEMBER_DIGEST_CHANNEL_ID)',
  );
});

test("SECURITY: makeDefaultMemberDigestRun never leaks a ContextDigest's distinctUsers/exampleRefs/summary — even adversarial identity-bearing values — only topic text and questionCount reach the sent message", async () => {
  const { adapter, sent } = makeAdapter();
  const adversarialDigest = makeDigest({
    topic: 'MCP server auth',
    // A real digest's summary is model-written and could, in principle,
    // slip past the builder's own "no names/handles" prompt contract — this
    // renderer must never read it regardless.
    summary: 'adversarial-user alice#1234 (discord id 999888777) asked about this repeatedly',
    exampleRefs: [101, 102, 103],
    distinctUsers: 3,
    questionCount: 4,
  });
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    ...throwingRunDeps(),
    wasSentRecently: async () => false,
    getDigests: async () => [adversarialDigest],
    getNewKnowledgeTitles: async () => [],
    getNewInterestCount: async () => 0,
    getNewProjectCount: async () => 0,
    getMemberTipCount: async () => 0,
    getHelperMatchesCount: async () => 0,
    getProjectConnectionsCount: async () => 0,
    recordSent: async () => {},
  });
  await runOnce();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "📅 This week's topics:\n• MCP server auth (4 questions)");
  assert.doesNotMatch(
    sent[0].text,
    /alice|999888777|101|102|103|discord id/i,
    'only topic text and the question count ever reach the sent message',
  );
});

test('startMemberDigest: MEMBER_DIGEST_ENABLED unset (default) creates no timer', () => {
  const timer = startMemberDigest([]);
  assert.equal(timer, null, 'disabled by default — no timer, no extra queries');
});

// --- Repository: freshness guard (DB-integration) ---------------------------

test(
  'repository: wasMemberDigestSentRecently is false with no row, true within the freshness window, false past it',
  { skip },
  async () => {
    await pool.query('DELETE FROM member_digest_sends');

    assert.equal(await wasMemberDigestSentRecently(7), false, 'no send recorded yet — not fresh');

    await recordMemberDigestSent();
    assert.equal(
      await wasMemberDigestSentRecently(7),
      true,
      'a send just recorded is within the 7-day freshness window',
    );

    await pool.query(`UPDATE member_digest_sends SET sent_at = now() - interval '8 days'`);
    assert.equal(
      await wasMemberDigestSentRecently(7),
      false,
      'a send older than the window no longer counts as fresh — a restart past the window may send again',
    );

    await pool.query('DELETE FROM member_digest_sends');
  },
);

test(
  'repository: recordMemberDigestSent upserts the single global row rather than inserting a new one',
  { skip },
  async () => {
    await pool.query('DELETE FROM member_digest_sends');

    await recordMemberDigestSent();
    await recordMemberDigestSent();
    await recordMemberDigestSent();

    const { rows } = await pool.query('SELECT * FROM member_digest_sends');
    assert.equal(
      rows.length,
      1,
      'exactly one global row ever exists, regardless of how many times it is sent',
    );

    await pool.query('DELETE FROM member_digest_sends');
  },
);

test('SECURITY: member_digest_sends carries no user/admin identity column', { skip }, async () => {
  await pool.query('DELETE FROM member_digest_sends');
  await recordMemberDigestSent();
  const { rows } = await pool.query('SELECT * FROM member_digest_sends');
  assert.equal(rows.length, 1);
  assert.deepEqual(
    Object.keys(rows[0]).sort(),
    ['id', 'sent_at'],
    'the table has exactly its two documented columns — no platform/user-id column ever added',
  );
  await pool.query('DELETE FROM member_digest_sends');
});

// --- Repository: curated-only "new in the KB" line (DB-integration) --------

test(
  "SECURITY: repository: listCuratedKnowledgeCreatedSince excludes auto-provenance (unreviewed) entries — only created_by_role != 'auto' titles are returned",
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const since = new Date(Date.now() - 3_600_000);

    const { id: autoId } = await saveKnowledge({
      title: `${marker}-auto-title`,
      content: `${marker} auto-researched content`,
      createdByRole: 'auto',
    });
    const { id: curatedId } = await saveKnowledge({
      title: `${marker}-curated-title`,
      content: `${marker} admin-curated content`,
      createdByRole: 'admin',
    });

    const titles = await listCuratedKnowledgeCreatedSince(since, 50);
    assert.ok(titles.includes(`${marker}-curated-title`), 'the curated entry title is present');
    assert.ok(!titles.includes(`${marker}-auto-title`), 'the auto-provenance entry title is never present');

    await pool.query('DELETE FROM knowledge WHERE id = ANY($1)', [[autoId, curatedId]]);
  },
);

test(
  "SECURITY: repository: listCuratedKnowledgeCreatedSince excludes conversation/platform-scoped entries — only scope='global' titles ever reach the public digest",
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-scoped`;
    const since = new Date(Date.now() - 3_600_000);

    const { id: globalId } = await saveKnowledge({
      title: `${marker}-global-title`,
      content: `${marker} global content`,
      createdByRole: 'admin',
      scope: 'global',
    });
    const { id: conversationId } = await saveKnowledge({
      title: `${marker}-conversation-title`,
      content: `${marker} conversation-scoped content, e.g. a private support channel`,
      createdByRole: 'admin',
      scope: 'whatsapp:some-private-conversation',
    });
    const { id: platformId } = await saveKnowledge({
      title: `${marker}-platform-title`,
      content: `${marker} platform-scoped content`,
      createdByRole: 'admin',
      scope: 'whatsapp',
    });

    const titles = await listCuratedKnowledgeCreatedSince(since, 50);
    assert.ok(titles.includes(`${marker}-global-title`), 'the global-scope entry title is present');
    assert.ok(
      !titles.includes(`${marker}-conversation-title`),
      'a conversation-scoped entry (e.g. a private support channel) never reaches the public digest',
    );
    assert.ok(
      !titles.includes(`${marker}-platform-title`),
      'a platform-scoped entry never reaches the public digest either',
    );

    await pool.query('DELETE FROM knowledge WHERE id = ANY($1)', [[globalId, conversationId, platformId]]);
  },
);

test(
  'repository: listCuratedKnowledgeCreatedSince excludes entries created before the since cutoff',
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-old`;
    const { id } = await saveKnowledge({
      title: `${marker}-title`,
      content: `${marker} content`,
      createdByRole: 'admin',
    });
    await pool.query(`UPDATE knowledge SET created_at = now() - interval '30 days' WHERE id = $1`, [id]);

    const since = new Date(Date.now() - 7 * 24 * 3_600_000);
    const titles = await listCuratedKnowledgeCreatedSince(since, 50);
    assert.ok(!titles.includes(`${marker}-title`), 'an entry older than the window is excluded');

    await pool.query('DELETE FROM knowledge WHERE id = $1', [id]);
  },
);

// --- Repository: release-watch "what changed" line (issue #733, DB-integration) --

test(
  'repository: listReleaseWatchUpdatesSince groups multiple changed chunks of the same page into a single result, keeping its source_url',
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const since = new Date(Date.now() - 3_600_000);
    const pageTitle = `docs: release-notes/${marker}`;
    const sourceUrl = `https://platform.claude.com/docs/en/release-notes/${marker}`;

    const { id: chunk1 } = await saveKnowledge({
      title: `${pageTitle} › intro`,
      content: `${marker} intro content`,
      createdByRole: 'docs',
      sourceUrl,
    });
    const { id: chunk2 } = await saveKnowledge({
      title: `${pageTitle} › details`,
      content: `${marker} details content`,
      createdByRole: 'docs',
      sourceUrl,
    });

    const results = await listReleaseWatchUpdatesSince(since, ['release-notes'], 50);
    const matches = results.filter((r) => r.pageTitle === pageTitle);
    assert.equal(matches.length, 1, 'two changed chunks of the same page report once, not twice');
    assert.equal(matches[0].sourceUrl, sourceUrl);

    await pool.query('DELETE FROM knowledge WHERE id = ANY($1)', [[chunk1, chunk2]]);
  },
);

test(
  "SECURITY: repository: listReleaseWatchUpdatesSince never returns a created_by_role = 'auto' row, even one whose title collides with a configured prefix",
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-auto`;
    const since = new Date(Date.now() - 3_600_000);
    const pageTitle = `docs: release-notes/${marker}`;

    const { id } = await saveKnowledge({
      title: pageTitle,
      content: `${marker} adversarial auto-provenance content`,
      createdByRole: 'auto',
    });

    const results = await listReleaseWatchUpdatesSince(since, ['release-notes'], 50);
    assert.ok(
      !results.some((r) => r.pageTitle === pageTitle),
      "an 'auto'-provenance (unreviewed/quarantined) row is never surfaced even when its title collides with a configured release-watch prefix",
    );

    await pool.query('DELETE FROM knowledge WHERE id = $1', [id]);
  },
);

test(
  "SECURITY: repository: listReleaseWatchUpdatesSince excludes a 'docs'-provenance page outside the configured prefixes — the feature cannot broadcast the whole docs corpus's weekly edits",
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-outside`;
    const since = new Date(Date.now() - 3_600_000);
    const pageTitle = `docs: api/messages/${marker}`;

    const { id } = await saveKnowledge({
      title: pageTitle,
      content: `${marker} ordinary API-reference content, not a release note`,
      createdByRole: 'docs',
    });

    const results = await listReleaseWatchUpdatesSince(since, ['release-notes'], 50);
    assert.ok(
      !results.some((r) => r.pageTitle === pageTitle),
      'a docs page outside the configured RELEASE_WATCH_DOC_PATHS prefixes is never surfaced',
    );

    await pool.query('DELETE FROM knowledge WHERE id = $1', [id]);
  },
);

test(
  "SECURITY: repository: listReleaseWatchUpdatesSince surfaces an existing page merely updated in place (updated_at bumped, created_at unchanged and older than the window) — pinning updated_at-based detection over listCuratedKnowledgeCreatedSince's created_at-only behaviour",
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-updated`;
    const pageTitle = `docs: release-notes/${marker}`;

    const { id } = await saveKnowledge({
      title: pageTitle,
      content: `${marker} original content`,
      createdByRole: 'docs',
    });
    // Simulate a pre-existing, not-yet-edited page: both created_at and
    // updated_at predate the digest window (saveKnowledge stamps both to
    // "now" at insert, so updated_at must be backdated too, or the "before"
    // check below would trivially pass on a page that was just inserted).
    // Neither column is in the knowledge_set_updated_at trigger's own UPDATE
    // OF list, so this direct assignment isn't overwritten by the trigger.
    await pool.query(
      `UPDATE knowledge SET created_at = now() - interval '30 days', updated_at = now() - interval '30 days' WHERE id = $1`,
      [id],
    );

    const since = new Date(Date.now() - 7 * 24 * 3_600_000);
    const before = await listReleaseWatchUpdatesSince(since, ['release-notes'], 50);
    assert.ok(
      !before.some((r) => r.pageTitle === pageTitle),
      'an old, unedited page is not yet surfaced (created_at is outside the window and it has not been updated since)',
    );

    // Edit in place — content change bumps updated_at via the
    // knowledge_set_updated_at trigger; created_at stays untouched.
    await updateKnowledge({ id, content: `${marker} edited content describing a new release` });

    const after = await listReleaseWatchUpdatesSince(since, ['release-notes'], 50);
    assert.ok(
      after.some((r) => r.pageTitle === pageTitle),
      'an existing page edited in place is surfaced via updated_at — not only newly-created pages',
    );

    await pool.query('DELETE FROM knowledge WHERE id = $1', [id]);
  },
);

test(
  'repository: listReleaseWatchUpdatesSince excludes entries updated before the since cutoff',
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-old`;
    const pageTitle = `docs: release-notes/${marker}`;
    const { id } = await saveKnowledge({
      title: pageTitle,
      content: `${marker} content`,
      createdByRole: 'docs',
    });
    await pool.query(`UPDATE knowledge SET updated_at = now() - interval '30 days' WHERE id = $1`, [id]);

    const since = new Date(Date.now() - 7 * 24 * 3_600_000);
    const results = await listReleaseWatchUpdatesSince(since, ['release-notes'], 50);
    assert.ok(
      !results.some((r) => r.pageTitle === pageTitle),
      'an entry updated before the window is excluded',
    );

    await pool.query('DELETE FROM knowledge WHERE id = $1', [id]);
  },
);

test('repository: listReleaseWatchUpdatesSince returns [] immediately when pathPrefixes is empty', async () => {
  const results = await listReleaseWatchUpdatesSince(new Date(0), [], 50);
  assert.deepEqual(results, []);
});

// --- Repository: project-showcase count (issue #714, DB-integration) -------

test(
  "SECURITY: repository: countProjectsSharedSince + formatMemberDigestMessage never leak a project's name/description/link/owner — only the integer count and fixed nudge text ever reach the rendered digest",
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-leak`;
    const owner = `${marker}-owner`;
    const adversarialName = `${marker}-name <script>alert(1)</script> impersonating-admin`;
    const adversarialDescription = `${marker}-description visit http://evil.example/${marker}`;
    const adversarialLink = `http://evil.example/${marker}`;
    const since = new Date(Date.now() - 3_600_000);

    const shared = await shareProject({
      platform: 'discord',
      userId: owner,
      name: adversarialName,
      description: adversarialDescription,
      link: adversarialLink,
    });
    assert.ok(shared.ok, 'seed project shared successfully');

    const count = await countProjectsSharedSince(since);
    assert.ok(count >= 1, 'the seeded project is counted');

    const message = formatMemberDigestMessage([], [], count);
    assert.ok(message);
    assert.doesNotMatch(
      message,
      new RegExp(marker),
      "no project field value (name/description/link/owner user_id) ever appears in the rendered message — formatMemberDigestMessage's signature takes only a bare count",
    );
    assert.match(
      message,
      /new projects? added to the showcase this week — ask me to show the project showcase to browse\.$/,
    );

    await pool.query('DELETE FROM member_projects WHERE user_id = $1', [owner]);
  },
);

test(
  'SECURITY: repository: countProjectsSharedSince excludes soft-removed rows — the digest count never implies content list_projects can no longer show',
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-removed`;
    const activeUser = `${marker}-active`;
    const removedUser = `${marker}-removed`;
    const since = new Date(Date.now() - 3_600_000);

    const before = await countProjectsSharedSince(since);

    const active = await shareProject({
      platform: 'discord',
      userId: activeUser,
      name: 'active project',
      description: 'still visible via list_projects',
    });
    const removed = await shareProject({
      platform: 'discord',
      userId: removedUser,
      name: 'removed project',
      description: 'soft-removed, must not be counted',
    });
    assert.ok(active.ok && removed.ok);
    await pool.query('UPDATE member_projects SET removed_at = now() WHERE id = $1', [
      removed.ok ? removed.id : -1,
    ]);

    const after = await countProjectsSharedSince(since);
    assert.equal(
      after - before,
      1,
      'only the active project increments the count; the soft-removed one is excluded',
    );

    await pool.query('DELETE FROM member_projects WHERE user_id = ANY($1)', [[activeUser, removedUser]]);
  },
);

// --- buildMemberDigestContent (issue #841) — the shared on-demand-pull builder --

test("buildMemberDigestContent: with injected deps, gathers, applies the two-floor eligible filter, and renders exactly like makeDefaultMemberDigestRun's own inlined logic used to", async () => {
  const message = await buildMemberDigestContent({
    ...throwingContentDeps(),
    getDigests: async () => [
      makeDigest({ topic: 'below floor', distinctUsers: 2, questionCount: 5 }),
      makeDigest({ topic: 'at floor', distinctUsers: 3, questionCount: 1 }),
    ],
    getNewKnowledgeTitles: async () => ['Setting up MCP auth'],
    getNewProjectCount: async () => 1,
    getMemberTipCount: async () => 0,
    getNewInterestCount: async () => 0,
    getHelperMatchesCount: async () => 0,
    getProjectConnectionsCount: async () => 0,
  });
  assert.equal(
    message,
    "📅 This week's topics:\n• at floor (1 question)\n\n📚 New in the knowledge base (1): Setting up MCP auth\n\n🚀 1 new project added to the showcase this week — ask me to show the project showcase to browse.",
  );
});

test('buildMemberDigestContent: every input empty renders null, same as formatMemberDigestMessage directly', async () => {
  const message = await buildMemberDigestContent({
    ...throwingContentDeps(),
    getDigests: async () => [],
    getNewKnowledgeTitles: async () => [],
    getNewProjectCount: async () => 0,
    getMemberTipCount: async () => 0,
    getNewInterestCount: async () => 0,
    getHelperMatchesCount: async () => 0,
    getProjectConnectionsCount: async () => 0,
  });
  assert.equal(message, null);
});

// --- buildMemberDigestContent: member→member connection wiring (issue #1012, DB-integration) --

test(
  "SECURITY: buildMemberDigestContent only issues the countHelperMatchesSince query when config.findHelper.enabled is true; with the flag off, its contribution to connectionCount is always 0 and no extra query is issued — mirrors adminDigest.ts's own #820 gating test (issue #1012 acceptance criterion 4)",
  { skip },
  async (t) => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-findhelperoff`;
    const owner = `${marker}-owner`;
    const requester = `${marker}-requester`;

    // A seeded project connection guarantees a non-null message so "no
    // helper contribution" is a meaningful assertion, not just "no message".
    const claimed = await recordProjectConnectionIfUnderCap('discord', owner, 'discord', requester, 333);
    assert.ok(claimed, 'seed connection request claims a slot');

    const wasEnabled = config.findHelper.enabled;
    mutable(config.findHelper).enabled = false;
    const querySpy = t.mock.method(pool, 'query');

    let message: string | null;
    try {
      message = await buildMemberDigestContent();
    } finally {
      mutable(config.findHelper).enabled = wasEnabled;
    }

    assert.match(
      message ?? '',
      /🤝 \d+ members? connected with help or a collaborator this week\./,
      'the seeded project connection alone still renders the connections section',
    );

    const issuedHelperNotificationsQuery = querySpy.mock.calls.some((call) =>
      String(call.arguments[0]).includes('helper_notifications'),
    );
    assert.ok(
      !issuedHelperNotificationsQuery,
      'SECURITY: the helper_notifications COUNT(*) is never issued while the flag is off — fail-safe by construction (config.findHelper.enabled resolves straight to Promise.resolve(0)), not merely a zero result',
    );

    await pool.query(`DELETE FROM project_connection_requests WHERE owner_user_id = $1`, [owner]);
  },
);

test(
  'buildMemberDigestContent: with config.findHelper.enabled true, connectionCount reflects countHelperMatchesSince(since) + countProjectConnectionsSince(since) and renders on the connections section (issue #1012 acceptance criteria 2, 3)',
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-findhelperon`;
    const helperOwner = `${marker}-helper`;
    const helperRequester = `${marker}-requester`;
    const projectOwner = `${marker}-projowner`;
    const projectRequester = `${marker}-projrequester`;
    const since = new Date(Date.now() - 7 * 86_400_000);

    const helperBefore = await countHelperMatchesSince(since);
    const projectBefore = await countProjectConnectionsSince(since);

    const claimedHelper = await recordHelperNotificationIfUnderCap(
      'discord',
      helperOwner,
      'discord',
      helperRequester,
      `${marker}-topic`,
    );
    assert.ok(claimedHelper, 'seed helper notification claims a slot');
    const claimedProject = await recordProjectConnectionIfUnderCap(
      'discord',
      projectOwner,
      'discord',
      projectRequester,
      444,
    );
    assert.ok(claimedProject, 'seed project connection claims a slot');

    const wasEnabled = config.findHelper.enabled;
    mutable(config.findHelper).enabled = true;

    let message: string | null;
    try {
      message = await buildMemberDigestContent();
    } finally {
      mutable(config.findHelper).enabled = wasEnabled;
    }

    const expectedCount = helperBefore + 1 + (projectBefore + 1);
    assert.match(
      message ?? '',
      new RegExp(`🤝 ${expectedCount} members connected with help or a collaborator this week\\.`),
      'connectionCount is the sum of both seeded signals',
    );

    await pool.query(`DELETE FROM helper_notifications WHERE helper_user_id = $1`, [helperOwner]);
    await pool.query(`DELETE FROM project_connection_requests WHERE owner_user_id = $1`, [projectOwner]);
  },
);

test(
  "SECURITY: buildMemberDigestContent (the shared gather both community_digest and /digest call) never touches member_digest_sends — repeated on-demand pulls leave wasMemberDigestSentRecently's answer unchanged, and a subsequent makeDefaultMemberDigestRun tick still posts on its normal freshness-guarded cadence (issue #841 acceptance criterion 6)",
  { skip },
  async () => {
    await pool.query('DELETE FROM member_digest_sends');
    try {
      assert.equal(await wasMemberDigestSentRecently(7), false, 'no send recorded yet — not fresh');

      // Repeated on-demand pulls (standing in for several community_digest/
      // /digest calls) — the pull path takes no arguments in production, so
      // this exercises the exact same real-repository call the tools make.
      await buildMemberDigestContent();
      await buildMemberDigestContent();
      await buildMemberDigestContent();

      assert.equal(
        await wasMemberDigestSentRecently(7),
        false,
        'repeated on-demand pulls must never advance or suppress the freshness guard',
      );

      const { adapter, sent } = makeAdapter();
      let recordCalled = false;
      const runOnce = makeDefaultMemberDigestRun([adapter], {
        ...throwingRunDeps(),
        wasSentRecently: async () => false,
        getDigests: async () => [makeDigest({ topic: 'post-pull topic', questionCount: 2 })],
        getNewKnowledgeTitles: async () => [],
        getNewProjectCount: async () => 0,
        getMemberTipCount: async () => 0,
        // Stubbed even though this test's assertions (a send happened, a send
        // was recorded) don't depend on them: the unstubbed versions read
        // member_interests / release-watch pages live, and getReleaseWatchUpdates
        // was additionally reached only when a sibling test happened to leave
        // config.releaseWatch.enabled true — an order dependency, not a contract.
        getNewInterestCount: async () => 0,
        getReleaseWatchUpdates: async () => [],
        getHelperMatchesCount: async () => 0,
        getProjectConnectionsCount: async () => 0,
        recordSent: async () => {
          recordCalled = true;
        },
      });
      await runOnce();
      assert.equal(sent.length, 1, 'the scheduled push still posts on its normal cadence after prior pulls');
      assert.equal(recordCalled, true, 'the scheduled push still records its own send after prior pulls');
    } finally {
      await pool.query('DELETE FROM member_digest_sends');
    }
  },
);

// --- Repository: member-interests count (issue #815, DB-integration) -------

test(
  'repository: countInterestsPublishedSince counts a row updated after `since` and excludes rows updated at or before it',
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-boundary`;
    const afterUser = `${marker}-after`;
    const atUser = `${marker}-at`;
    const beforeUser = `${marker}-before`;
    const since = new Date(Date.now() - 3_600_000);

    const baseline = await countInterestsPublishedSince(since);

    await setMemberInterests('discord', afterUser, 'published after since');
    assert.equal(
      await countInterestsPublishedSince(since),
      baseline + 1,
      'a row updated strictly after `since` (just now) is counted',
    );

    await setMemberInterests('discord', atUser, 'published exactly at since');
    await pool.query(
      `UPDATE member_interests SET updated_at = $1 WHERE platform = 'discord' AND user_id = $2`,
      [since, atUser],
    );
    assert.equal(
      await countInterestsPublishedSince(since),
      baseline + 1,
      'a row whose updated_at equals `since` is excluded (strict >)',
    );

    await setMemberInterests('discord', beforeUser, 'published before since');
    await pool.query(
      `UPDATE member_interests SET updated_at = $1 WHERE platform = 'discord' AND user_id = $2`,
      [new Date(since.getTime() - 1000), beforeUser],
    );
    assert.equal(
      await countInterestsPublishedSince(since),
      baseline + 1,
      'a row whose updated_at precedes `since` is excluded',
    );

    await pool.query('DELETE FROM member_interests WHERE user_id = ANY($1)', [
      [afterUser, atUser, beforeUser],
    ]);
  },
);

test(
  'SECURITY: repository: countInterestsPublishedSince + formatMemberDigestMessage never leak interest text or a member identifier — only the integer count and fixed nudge text ever reach the rendered digest',
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-leak`;
    const owner = `${marker}-owner`;
    const adversarialInterests = `${marker}-interests <script>alert(1)</script> impersonating-admin`;
    const since = new Date(Date.now() - 3_600_000);

    await setMemberInterests('discord', owner, adversarialInterests);

    const count = await countInterestsPublishedSince(since);
    assert.ok(count >= 1, 'the seeded interests row is counted');

    const message = formatMemberDigestMessage([], [], 0, [], 0, count);
    assert.ok(message);
    assert.doesNotMatch(
      message,
      new RegExp(marker),
      "no interest text or member identifier ever appears in the rendered message — formatMemberDigestMessage's signature takes only a bare count",
    );
    assert.match(
      message,
      /members? published or updated their interests this week — ask me "who's into X\?" to find them\.$/,
    );

    await pool.query('DELETE FROM member_interests WHERE user_id = $1', [owner]);
  },
);

test(
  'SECURITY: repository: setHelperAvailability never bumps updated_at, so a helper-availability toggle does not contribute to countInterestsPublishedSince',
  { skip },
  async () => {
    const marker = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-toggle`;
    const userId = `${marker}-helper`;
    const since = new Date(Date.now() - 3_600_000);

    await setMemberInterests('discord', userId, 'building RAG systems with Claude');
    await pool.query(
      `UPDATE member_interests SET updated_at = $1 WHERE platform = 'discord' AND user_id = $2`,
      [new Date(since.getTime() - 1000), userId],
    );

    const before = await countInterestsPublishedSince(since);

    const toggled = await setHelperAvailability('discord', userId, true);
    assert.deepEqual(toggled, { ok: true });

    const after = await countInterestsPublishedSince(since);
    assert.equal(
      after,
      before,
      'toggling willing_to_help does not bump updated_at, so it never contributes to this public-surface count',
    );

    await pool.query('DELETE FROM member_interests WHERE user_id = $1', [userId]);
  },
);
