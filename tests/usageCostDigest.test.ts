import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. USAGE_COST_DIGEST_ENABLED is
// deliberately left unset so any use of startUsageCostDigest() here
// exercises the disabled-by-default path (the enabled path's consecutive-
// failure/rearm behaviour is covered by tests/backgroundJobs.test.ts and
// tests/backgroundJobsDisabled.test.ts, which pin the flag per-process like
// every other opt-in job) — this file focuses on the pure message builder,
// the injectable weekly runOnce, and the DB-backed freshness/trend
// persistence, skipped cleanly when DATABASE_URL is unset (per CLAUDE.md).
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

const {
  formatUsageCostDigestMessage,
  formatCacheHitRateTrendLine,
  makeDefaultUsageCostDigestRun,
  startUsageCostDigest,
} = await import('../src/usageCostDigest.js');
const { pool, closeDb } = await import('../src/storage/db.js');
const {
  wasUsageCostDigestSentRecently,
  getLastUsageCostDigestTotal,
  getLastUsageCostDigestCacheHitRate,
  recordUsageCostDigestSent,
  upsertMember,
} = await import('../src/storage/repository.js');

const NO_CACHE_ACTIVITY = { readTokens: 0, creationTokens: 0 };

after(async () => {
  await closeDb();
});

function makeAdapter(): { adapter: PlatformAdapter; dms: Array<{ userId: string; text: string }> } {
  const dms: Array<{ userId: string; text: string }> = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage() {},
    async sendMessage(_out: OutgoingMessage) {},
    async sendDirectMessage(userId: string, text: string) {
      dms.push({ userId, text });
    },
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return { adapter, dms };
}

// alertSuperAdmins is fire-and-forget (`void alertSuperAdmins(...)`, no
// await), so give the microtask queue a turn before asserting — same
// technique as tests/departedAdminAlert.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// --- formatUsageCostDigestMessage (pure, byte-tested) -----------------------

test('formatUsageCostDigestMessage: no prior total (first-ever run) renders a defined no-comparison form, never NaN/undefined', () => {
  assert.equal(
    formatUsageCostDigestMessage(12.5, null, NO_CACHE_ACTIVITY, null),
    '💰 Weekly cost trend: ~$12.50 this week (conversational + background). ' +
      'No prior week recorded yet to compare against.',
  );
  assert.equal(
    formatUsageCostDigestMessage(0, null, NO_CACHE_ACTIVITY, null),
    '💰 Weekly cost trend: ~$0.00 this week (conversational + background). ' +
      'No prior week recorded yet to compare against.',
  );
});

test('formatUsageCostDigestMessage: a higher total than last week renders the exact ▲ delta', () => {
  assert.equal(
    formatUsageCostDigestMessage(15.5, 10, NO_CACHE_ACTIVITY, null),
    '💰 Weekly cost trend: ~$15.50 this week (conversational + background). ▲ $5.50 vs last week.',
  );
});

test('formatUsageCostDigestMessage: a lower total than last week renders the exact ▼ delta (absolute value)', () => {
  assert.equal(
    formatUsageCostDigestMessage(8.25, 10.75, NO_CACHE_ACTIVITY, null),
    '💰 Weekly cost trend: ~$8.25 this week (conversational + background). ▼ $2.50 vs last week.',
  );
});

test('formatUsageCostDigestMessage: an unchanged total renders "No change", not ▲$0.00/▼$0.00', () => {
  assert.equal(
    formatUsageCostDigestMessage(10, 10, NO_CACHE_ACTIVITY, null),
    '💰 Weekly cost trend: ~$10.00 this week (conversational + background). No change vs last week.',
  );
});

// --- Cache-hit-rate trend line (issue #608) ---------------------------------

test('formatCacheHitRateTrendLine: no prior hit rate (first-ever run) renders a defined no-comparison form, never NaN/undefined', () => {
  const line = formatCacheHitRateTrendLine(75, null);
  assert.equal(line, 'Prompt cache: 75% hit rate this week. No prior week recorded yet to compare against.');
  assert.doesNotMatch(line, /NaN|undefined/);
});

test('formatCacheHitRateTrendLine: a higher hit rate than last week renders the exact ▲ Npp delta', () => {
  assert.equal(
    formatCacheHitRateTrendLine(80, 65),
    'Prompt cache: 80% hit rate this week. ▲ 15pp vs last week.',
  );
});

test('formatCacheHitRateTrendLine: a lower hit rate than last week renders the exact ▼ Npp delta (absolute value)', () => {
  assert.equal(
    formatCacheHitRateTrendLine(50, 70),
    'Prompt cache: 50% hit rate this week. ▼ 20pp vs last week.',
  );
});

test('formatCacheHitRateTrendLine: an unchanged hit rate renders "No change", not ▲0pp/▼0pp', () => {
  assert.equal(
    formatCacheHitRateTrendLine(60, 60),
    'Prompt cache: 60% hit rate this week. No change vs last week.',
  );
});

test('formatUsageCostDigestMessage: appends the cache-trend line when the window has cache activity', () => {
  const message = formatUsageCostDigestMessage(10, 10, { readTokens: 80, creationTokens: 20 }, 50);
  assert.equal(
    message,
    '💰 Weekly cost trend: ~$10.00 this week (conversational + background). No change vs last week.\n' +
      'Prompt cache: 80% hit rate this week. ▲ 30pp vs last week.',
  );
});

test('formatUsageCostDigestMessage: zero cache activity in the window omits the cache-trend line entirely', () => {
  const message = formatUsageCostDigestMessage(10, 10, NO_CACHE_ACTIVITY, 50);
  assert.equal(
    message,
    '💰 Weekly cost trend: ~$10.00 this week (conversational + background). No change vs last week.',
  );
  assert.doesNotMatch(message, /Prompt cache/);
});

test('SECURITY: formatUsageCostDigestMessage (and its appended cache-trend line) is a fixed template carrying only dollar/percentage figures — never a user id, conversation id, display name, or message excerpt', () => {
  const cases: Array<[number, number | null, { readTokens: number; creationTokens: number }, number | null]> =
    [
      [0, null, NO_CACHE_ACTIVITY, null],
      [12.345, null, NO_CACHE_ACTIVITY, null],
      [15.5, 10, NO_CACHE_ACTIVITY, null],
      [8.25, 10.75, NO_CACHE_ACTIVITY, null],
      [10, 10, NO_CACHE_ACTIVITY, null],
      [10, 10, { readTokens: 80, creationTokens: 20 }, null],
      [10, 10, { readTokens: 80, creationTokens: 20 }, 50],
      [10, 10, { readTokens: 20, creationTokens: 80 }, 90],
      [10, 10, { readTokens: 50, creationTokens: 50 }, 50],
    ];
  const costLinePattern =
    /^💰 Weekly cost trend: ~\$\d+\.\d{2} this week \(conversational \+ background\)\. (No prior week recorded yet to compare against\.|▲ \$\d+\.\d{2} vs last week\.|▼ \$\d+\.\d{2} vs last week\.|No change vs last week\.)/;
  const cacheLinePattern =
    /Prompt cache: \d+% hit rate this week\. (No prior week recorded yet to compare against\.|▲ \d+pp vs last week\.|▼ \d+pp vs last week\.|No change vs last week\.)$/;
  for (const [current, previous, cacheUsage, previousCacheHitRate] of cases) {
    const message = formatUsageCostDigestMessage(current, previous, cacheUsage, previousCacheHitRate);
    const totalCacheTokens = cacheUsage.readTokens + cacheUsage.creationTokens;
    assert.match(
      message,
      totalCacheTokens === 0 ? new RegExp(costLinePattern.source + '$') : costLinePattern,
    );
    if (totalCacheTokens > 0) assert.match(message, cacheLinePattern);
    // No identifier-shaped substring can ever appear — only figures and the fixed template text.
    assert.doesNotMatch(message, /\buser[-_]?id\b|\bconversation[-_]?id\b|discord|whatsapp|@\w+/i);
  }
});

// --- makeDefaultUsageCostDigestRun (injected deps, no real DB) -------------

test('makeDefaultUsageCostDigestRun: inside the freshness window, runOnce is a no-op — no stats read, no total read, no DM, no record', async () => {
  const { adapter, dms } = makeAdapter();
  let statsCalled = false;
  let getLastCalled = false;
  let getLastCacheHitRateCalled = false;
  let recordCalled = false;
  const runOnce = makeDefaultUsageCostDigestRun([adapter], {
    wasSentRecently: async () => true,
    getStats: async () => {
      statsCalled = true;
      return { costUsd: 1, backgroundCostUsd: 1, cacheUsage: NO_CACHE_ACTIVITY };
    },
    getLastTotal: async () => {
      getLastCalled = true;
      return null;
    },
    getLastCacheHitRate: async () => {
      getLastCacheHitRateCalled = true;
      return null;
    },
    recordSent: async () => {
      recordCalled = true;
    },
  });

  await runOnce();
  await flush();

  assert.equal(dms.length, 0, 'no DM inside the freshness window');
  assert.equal(statsCalled, false, 'usageStats is never read inside the freshness window');
  assert.equal(
    getLastCalled,
    false,
    'the persisted previous total is never read inside the freshness window',
  );
  assert.equal(
    getLastCacheHitRateCalled,
    false,
    'the persisted previous cache hit rate is never read inside the freshness window',
  );
  assert.equal(recordCalled, false, 'nothing is recorded inside the freshness window');
});

test('makeDefaultUsageCostDigestRun: past the freshness window with no prior total, sends the no-comparison message and records the current total', async () => {
  const { adapter, dms } = makeAdapter();
  let recordedTotal: number | null = null;
  const runOnce = makeDefaultUsageCostDigestRun([adapter], {
    wasSentRecently: async () => false,
    getStats: async () => ({ costUsd: 7, backgroundCostUsd: 3, cacheUsage: NO_CACHE_ACTIVITY }),
    getLastTotal: async () => null,
    getLastCacheHitRate: async () => null,
    recordSent: async (total) => {
      recordedTotal = total;
    },
  });

  await runOnce();
  await flush();

  assert.equal(dms.length, 1, 'exactly one DM is sent past the freshness window');
  assert.equal(
    dms[0].text,
    '💰 Weekly cost trend: ~$10.00 this week (conversational + background). ' +
      'No prior week recorded yet to compare against.',
  );
  assert.equal(
    recordedTotal,
    10,
    "this week's total (costUsd + backgroundCostUsd) is persisted for next week",
  );
});

test('makeDefaultUsageCostDigestRun: past the freshness window with a prior total, sends the delta message against it', async () => {
  const { adapter, dms } = makeAdapter();
  const runOnce = makeDefaultUsageCostDigestRun([adapter], {
    wasSentRecently: async () => false,
    getStats: async () => ({ costUsd: 4, backgroundCostUsd: 1, cacheUsage: NO_CACHE_ACTIVITY }),
    getLastTotal: async () => 3,
    getLastCacheHitRate: async () => null,
    recordSent: async () => {},
  });

  await runOnce();
  await flush();

  assert.equal(dms.length, 1);
  assert.equal(
    dms[0].text,
    '💰 Weekly cost trend: ~$5.00 this week (conversational + background). ▲ $2.00 vs last week.',
  );
});

test('makeDefaultUsageCostDigestRun: cache activity in the window appends the cache-trend line and persists the computed hit rate', async () => {
  const { adapter, dms } = makeAdapter();
  let recordedCacheHitRate: number | null | undefined;
  const runOnce = makeDefaultUsageCostDigestRun([adapter], {
    wasSentRecently: async () => false,
    getStats: async () => ({
      costUsd: 4,
      backgroundCostUsd: 1,
      cacheUsage: { readTokens: 90, creationTokens: 10 },
    }),
    getLastTotal: async () => 3,
    getLastCacheHitRate: async () => 70,
    recordSent: async (_total, cacheHitRate) => {
      recordedCacheHitRate = cacheHitRate;
    },
  });

  await runOnce();
  await flush();

  assert.equal(dms.length, 1);
  assert.equal(
    dms[0].text,
    '💰 Weekly cost trend: ~$5.00 this week (conversational + background). ▲ $2.00 vs last week.\n' +
      'Prompt cache: 90% hit rate this week. ▲ 20pp vs last week.',
  );
  assert.equal(recordedCacheHitRate, 90, "this week's computed hit rate is persisted for next week's delta");
});

test('makeDefaultUsageCostDigestRun: zero cache activity in the window omits the cache-trend line and persists null (does not overwrite)', async () => {
  const { adapter, dms } = makeAdapter();
  let recordedCacheHitRate: number | null | undefined;
  const runOnce = makeDefaultUsageCostDigestRun([adapter], {
    wasSentRecently: async () => false,
    getStats: async () => ({ costUsd: 4, backgroundCostUsd: 1, cacheUsage: NO_CACHE_ACTIVITY }),
    getLastTotal: async () => 3,
    getLastCacheHitRate: async () => 70,
    recordSent: async (_total, cacheHitRate) => {
      recordedCacheHitRate = cacheHitRate;
    },
  });

  await runOnce();
  await flush();

  assert.equal(dms.length, 1);
  assert.equal(
    dms[0].text,
    '💰 Weekly cost trend: ~$5.00 this week (conversational + background). ▲ $2.00 vs last week.',
    'no cache-trend line is appended when the window had zero cache activity',
  );
  assert.equal(
    recordedCacheHitRate,
    null,
    'recordSent receives null for the cache hit rate — the repository upsert preserves the prior persisted value rather than overwriting it',
  );
});

test('SECURITY: makeDefaultUsageCostDigestRun sends the DM to exactly the configured super admin id and no other recipient, even with an adapter registered on another platform', async () => {
  const { adapter, dms } = makeAdapter();
  const runOnce = makeDefaultUsageCostDigestRun([adapter], {
    wasSentRecently: async () => false,
    getStats: async () => ({ costUsd: 1, backgroundCostUsd: 0, cacheUsage: NO_CACHE_ACTIVITY }),
    getLastTotal: async () => null,
    getLastCacheHitRate: async () => null,
    recordSent: async () => {},
  });

  await runOnce();
  await flush();

  assert.equal(dms.length, 1, 'exactly one recipient — the single configured super admin');
  assert.equal(
    dms[0].userId,
    'super-1',
    'the DM goes only to the configured super-admin id (SUPER_ADMIN_DISCORD_IDS)',
  );
});

test('startUsageCostDigest: USAGE_COST_DIGEST_ENABLED unset (default) creates no timer', () => {
  const timer = startUsageCostDigest([]);
  assert.equal(timer, null, 'disabled by default — no timer, no extra queries');
});

// --- Repository: freshness guard + trend persistence (DB-integration) ------

test(
  'repository: wasUsageCostDigestSentRecently is false with no row, true within the freshness window, false past it',
  { skip },
  async () => {
    await pool.query('DELETE FROM usage_cost_digest_state');

    assert.equal(await wasUsageCostDigestSentRecently(7), false, 'no send recorded yet — not fresh');

    await recordUsageCostDigestSent(9.99, null);
    assert.equal(
      await wasUsageCostDigestSentRecently(7),
      true,
      'a send just recorded is within the 7-day freshness window',
    );

    await pool.query(`UPDATE usage_cost_digest_state SET sent_at = now() - interval '8 days'`);
    assert.equal(
      await wasUsageCostDigestSentRecently(7),
      false,
      'a send older than the window no longer counts as fresh — a restart past the window may send again',
    );

    await pool.query('DELETE FROM usage_cost_digest_state');
  },
);

test(
  'repository: getLastUsageCostDigestTotal is null with no row, then the persisted total after recordUsageCostDigestSent',
  { skip },
  async () => {
    await pool.query('DELETE FROM usage_cost_digest_state');

    assert.equal(await getLastUsageCostDigestTotal(), null, 'a first-ever run has no prior total at all');

    await recordUsageCostDigestSent(42.5, null);
    assert.equal(await getLastUsageCostDigestTotal(), 42.5, 'the exact total passed in is persisted');

    await pool.query('DELETE FROM usage_cost_digest_state');
  },
);

test(
  'repository: recordUsageCostDigestSent upserts the single global row rather than inserting a new one',
  { skip },
  async () => {
    await pool.query('DELETE FROM usage_cost_digest_state');

    await recordUsageCostDigestSent(1, null);
    await recordUsageCostDigestSent(2, null);
    await recordUsageCostDigestSent(3, null);

    const { rows } = await pool.query('SELECT total_cost_usd FROM usage_cost_digest_state');
    assert.equal(
      rows.length,
      1,
      'exactly one global row ever exists, regardless of how many times it is sent',
    );
    assert.equal(Number(rows[0].total_cost_usd), 3, 'the row reflects only the most recent total');

    await pool.query('DELETE FROM usage_cost_digest_state');
  },
);

test(
  'repository: getLastUsageCostDigestCacheHitRate is null with no row, then the persisted rate after recordUsageCostDigestSent',
  { skip },
  async () => {
    await pool.query('DELETE FROM usage_cost_digest_state');

    assert.equal(
      await getLastUsageCostDigestCacheHitRate(),
      null,
      'a first-ever run has no prior hit rate at all',
    );

    await recordUsageCostDigestSent(42.5, 88);
    assert.equal(await getLastUsageCostDigestCacheHitRate(), 88, 'the exact hit rate passed in is persisted');

    await pool.query('DELETE FROM usage_cost_digest_state');
  },
);

test(
  'repository: recordUsageCostDigestSent with cacheHitRate=null (a quiet week) preserves the previously-persisted hit rate rather than overwriting it',
  { skip },
  async () => {
    await pool.query('DELETE FROM usage_cost_digest_state');

    await recordUsageCostDigestSent(1, 65);
    assert.equal(await getLastUsageCostDigestCacheHitRate(), 65, 'the real rate is persisted first');

    await recordUsageCostDigestSent(2, null);
    assert.equal(
      await getLastUsageCostDigestCacheHitRate(),
      65,
      'a quiet week (null cacheHitRate) does not corrupt the previously-persisted rate',
    );

    await recordUsageCostDigestSent(3, 70);
    assert.equal(
      await getLastUsageCostDigestCacheHitRate(),
      70,
      'a subsequent real rate still overwrites normally',
    );

    await pool.query('DELETE FROM usage_cost_digest_state');
  },
);

test(
  'SECURITY: usage_cost_digest_state carries no per-admin identity — a community_users admin row existing alongside it has no bearing on the freshness guard or trend total',
  { skip },
  async () => {
    const adminId = `t${Date.now()}${Math.floor(Math.random() * 1e6)}-cost-digest-admin`;
    await upsertMember({ platform: 'discord', userId: adminId, role: 'admin', addedBy: `${adminId}-actor` });
    await pool.query('DELETE FROM usage_cost_digest_state');

    await recordUsageCostDigestSent(5, 42);
    const { rows } = await pool.query('SELECT * FROM usage_cost_digest_state');
    assert.equal(rows.length, 1);
    const columns = Object.keys(rows[0]);
    assert.deepEqual(
      columns.sort(),
      ['id', 'sent_at', 'total_cost_usd', 'last_cache_hit_rate'].sort(),
      'the table has exactly its four documented columns — no platform/user-id column ever added',
    );

    await pool.query('DELETE FROM usage_cost_digest_state');
    await pool.query(`DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = $1`, [
      adminId,
    ]);
  },
);
