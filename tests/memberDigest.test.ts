import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';
import type { ContextDigest } from '../src/storage/repository.js';

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

const { formatMemberDigestMessage, makeDefaultMemberDigestRun, startMemberDigest } =
  await import('../src/memberDigest.js');
const { pool, closeDb } = await import('../src/storage/db.js');
const {
  wasMemberDigestSentRecently,
  recordMemberDigestSent,
  listCuratedKnowledgeCreatedSince,
  saveKnowledge,
} = await import('../src/storage/repository.js');
const { config } = await import('../src/config.js');

after(async () => {
  await closeDb();
});

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

function makeDigest(overrides: Partial<ContextDigest> = {}): ContextDigest {
  return {
    id: 1,
    periodStart: new Date(0),
    periodEnd: new Date(0),
    platform: null,
    topic: 'MCP server auth',
    summary: 'Aggregate summary.',
    exampleRefs: [],
    distinctUsers: 2,
    questionCount: 1,
    createdAt: new Date(0),
    ...overrides,
  };
}

// --- formatMemberDigestMessage (pure, byte-tested) --------------------------

test('formatMemberDigestMessage: no topics and no new knowledge titles renders null — silence over noise', () => {
  assert.equal(formatMemberDigestMessage([], []), null);
});

test('formatMemberDigestMessage: topics only renders the topic section, no knowledge-base line', () => {
  const message = formatMemberDigestMessage(
    [
      { topic: 'MCP server auth', questionCount: 4 },
      { topic: 'Bedrock region gotchas', questionCount: 1 },
    ],
    [],
  );
  assert.equal(
    message,
    "📅 This week's topics:\n• MCP server auth (4 questions)\n• Bedrock region gotchas (1 question)",
  );
  assert.doesNotMatch(message ?? '', /knowledge base/i);
});

test('formatMemberDigestMessage: new knowledge titles only renders the knowledge-base line, no topics section', () => {
  const message = formatMemberDigestMessage([], ['Setting up MCP auth', 'Bedrock region checklist']);
  assert.equal(message, '📚 New in the knowledge base (2): Setting up MCP auth, Bedrock region checklist');
  assert.doesNotMatch(message ?? '', /This week's topics/);
});

test('formatMemberDigestMessage: both sections present render topics then the knowledge-base line, separated by a blank line', () => {
  const message = formatMemberDigestMessage(
    [{ topic: 'MCP server auth', questionCount: 1 }],
    ['Setting up MCP auth'],
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
  );
  assert.match(message ?? '', /One-question topic \(1 question\)/);
  assert.match(message ?? '', /Multi-question topic \(2 questions\)/);
});

// --- makeDefaultMemberDigestRun (injected deps, no real DB) ----------------

test('makeDefaultMemberDigestRun: MEMBER_DIGEST_CHANNEL_ID unset, runOnce is a no-op — no send, no freshness read', async () => {
  const original = config.memberDigest.channelId;
  config.memberDigest.channelId = undefined;
  try {
    const { adapter, sent } = makeAdapter();
    let wasSentRecentlyCalled = false;
    const runOnce = makeDefaultMemberDigestRun([adapter], {
      wasSentRecently: async () => {
        wasSentRecentlyCalled = true;
        return false;
      },
      getDigests: async () => [],
      getNewKnowledgeTitles: async () => [],
      recordSent: async () => {},
    });
    await runOnce();
    assert.equal(sent.length, 0, 'no send when the channel id is unconfigured');
    assert.equal(
      wasSentRecentlyCalled,
      false,
      'the freshness guard is never even checked when config is incomplete',
    );
  } finally {
    config.memberDigest.channelId = original;
  }
});

test('makeDefaultMemberDigestRun: inside the freshness window, runOnce is a no-op — no digest read, no knowledge read, no send', async () => {
  const { adapter, sent } = makeAdapter();
  let digestsCalled = false;
  let knowledgeCalled = false;
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    wasSentRecently: async () => true,
    getDigests: async () => {
      digestsCalled = true;
      return [];
    },
    getNewKnowledgeTitles: async () => {
      knowledgeCalled = true;
      return [];
    },
    recordSent: async () => {},
  });
  await runOnce();
  assert.equal(sent.length, 0, 'no send inside the freshness window');
  assert.equal(digestsCalled, false, 'digests are never read inside the freshness window');
  assert.equal(knowledgeCalled, false, 'new knowledge is never read inside the freshness window');
});

test('makeDefaultMemberDigestRun: no connected Discord adapter — no-op, no throw, no send', async () => {
  const { adapter: whatsappAdapter, sent } = makeAdapter('whatsapp');
  const runOnce = makeDefaultMemberDigestRun([whatsappAdapter], {
    wasSentRecently: async () => false,
    getDigests: async () => [makeDigest({ topic: 'x', questionCount: 1 })],
    getNewKnowledgeTitles: async () => [],
    recordSent: async () => {},
  });
  await runOnce();
  assert.equal(sent.length, 0, 'never sends over a non-Discord adapter, even when content exists');
});

test('makeDefaultMemberDigestRun: a quiet week (no digests, no new knowledge) sends nothing and does not record — silence over noise', async () => {
  const { adapter, sent } = makeAdapter();
  let recordCalled = false;
  const runOnce = makeDefaultMemberDigestRun([adapter], {
    wasSentRecently: async () => false,
    getDigests: async () => [],
    getNewKnowledgeTitles: async () => [],
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
    wasSentRecently: async () => false,
    getDigests: async () => [makeDigest({ topic: 'MCP server auth', questionCount: 4 })],
    getNewKnowledgeTitles: async () => ['Setting up MCP auth'],
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

test('SECURITY: makeDefaultMemberDigestRun posts to exactly MEMBER_DIGEST_CHANNEL_ID from config — never a model- or message-derived id, even with multiple adapters registered', async () => {
  const { adapter: discordAdapter, sent } = makeAdapter('discord');
  const { adapter: whatsappAdapter } = makeAdapter('whatsapp');
  const runOnce = makeDefaultMemberDigestRun([whatsappAdapter, discordAdapter], {
    wasSentRecently: async () => false,
    getDigests: async () => [makeDigest({ topic: 'MCP server auth', questionCount: 1 })],
    getNewKnowledgeTitles: async () => [],
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
    wasSentRecently: async () => false,
    getDigests: async () => [adversarialDigest],
    getNewKnowledgeTitles: async () => [],
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
