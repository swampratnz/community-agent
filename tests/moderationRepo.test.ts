import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Capture whether a REAL Postgres was provided BEFORE the dummy default below,
// so the after() cleanup is skipped cleanly (not run against an unreachable
// dummy) when DATABASE_URL is unset — see tests/repository.test.ts.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const {
  addWarning,
  countActiveWarnings,
  countMutedMembers,
  countStaleMutedMembers,
  clearWarnings,
  listMemberWarnings,
  listMutedMembers,
  purgeUserData,
} = await import('../src/storage/repository.js');
const { pool, closeDb } = await import('../src/storage/db.js');

const RUN = `modwarn-${Date.now()}`;
const USER = `${RUN}-user`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM member_warnings WHERE user_id LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

test('addWarning + countActiveWarnings: active count reflects uncleared rows', { skip }, async () => {
  await addWarning({
    platform: 'discord',
    userId: USER,
    reason: 'bad language ("test")',
    excerpt: 'a rude message',
    source: 'auto',
    issuedBy: null,
  });
  await addWarning({
    platform: 'discord',
    userId: USER,
    reason: 'bad language ("test2")',
    excerpt: 'another rude message',
    source: 'auto',
    issuedBy: null,
  });
  assert.equal(await countActiveWarnings('discord', USER), 2);
});

test(
  'clearWarnings clears active rows, returns the count cleared, and zeroes the active count',
  {
    skip,
  },
  async () => {
    const user = `${RUN}-clear`;
    await addWarning({
      platform: 'discord',
      userId: user,
      reason: 'x',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    await addWarning({
      platform: 'discord',
      userId: user,
      reason: 'y',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    const cleared = await clearWarnings('discord', user, 'admin-1');
    assert.equal(cleared, 2, 'both active warnings were cleared');
    assert.equal(await countActiveWarnings('discord', user), 0, 'no active warnings remain');
    // Clearing again is a no-op (nothing active left).
    assert.equal(await clearWarnings('discord', user, 'admin-1'), 0);
  },
);

test(
  'listMemberWarnings: returns every row for a member with both auto and admin warnings, newest first, ' +
    'with reason/excerpt/source/issuedBy/clearedAt intact (issue #410 acceptance criteria #1)',
  { skip },
  async () => {
    const user = `${RUN}-list`;
    await addWarning({
      platform: 'discord',
      userId: user,
      reason: 'bad language ("asshole")',
      excerpt: 'you are an asshole',
      source: 'auto',
      issuedBy: null,
    });
    await addWarning({
      platform: 'discord',
      userId: user,
      reason: 'spamming invite links',
      excerpt: null,
      source: 'admin',
      issuedBy: 'admin-7',
    });
    const cleared = await clearWarnings('discord', user, 'admin-7');
    assert.equal(cleared, 2, 'sanity: both rows are cleared before the read, so clearedAt is exercised too');

    const rows = await listMemberWarnings('discord', user);
    assert.equal(rows.length, 2);
    // Newest first: the admin row (added second) comes before the auto row.
    assert.equal(rows[0].source, 'admin');
    assert.equal(rows[0].reason, 'spamming invite links');
    assert.equal(rows[0].excerpt, null);
    assert.equal(rows[0].issuedBy, 'admin-7');
    assert.ok(rows[0].clearedAt instanceof Date, 'clearedAt is populated after clearWarnings');
    assert.equal(rows[0].clearedBy, 'admin-7');

    assert.equal(rows[1].source, 'auto');
    assert.equal(rows[1].reason, 'bad language ("asshole")');
    assert.equal(rows[1].excerpt, 'you are an asshole');
    assert.equal(rows[1].issuedBy, null);
    assert.ok(rows[1].clearedAt instanceof Date);

    await pool.query(`DELETE FROM member_warnings WHERE user_id = $1`, [user]);
  },
);

test(
  'listMemberWarnings: respects the limit parameter and defaults to 20 (issue #410)',
  { skip },
  async () => {
    const user = `${RUN}-list-limit`;
    for (let i = 0; i < 3; i++) {
      await addWarning({
        platform: 'discord',
        userId: user,
        reason: `strike-${i}`,
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });
    }
    const limited = await listMemberWarnings('discord', user, 2);
    assert.equal(limited.length, 2, 'an explicit limit is honoured');
    const defaulted = await listMemberWarnings('discord', user);
    assert.equal(defaulted.length, 3, 'the default limit (20) does not truncate a small history');

    await pool.query(`DELETE FROM member_warnings WHERE user_id = $1`, [user]);
  },
);

test(
  'countActiveWarnings with no window configured counts a strike regardless of age (regression: unset ⇒ unbounded, byte-for-byte identical to pre-window behaviour)',
  { skip },
  async () => {
    const user = `${RUN}-no-window`;
    await addWarning({
      platform: 'discord',
      userId: user,
      reason: 'old',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    await pool.query(
      `UPDATE member_warnings SET created_at = now() - interval '400 days'
        WHERE platform = 'discord' AND user_id = $1`,
      [user],
    );
    assert.equal(
      await countActiveWarnings('discord', user),
      1,
      'a year-old strike still counts when no window is configured',
    );
  },
);

test(
  'countActiveWarnings with a configured window excludes a strike older than the window and includes one inside it',
  { skip },
  async () => {
    const user = `${RUN}-window`;
    await addWarning({
      platform: 'discord',
      userId: user,
      reason: 'old',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    await addWarning({
      platform: 'discord',
      userId: user,
      reason: 'recent',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    // Age only the first strike past a 30-day window; the second stays fresh.
    await pool.query(
      `UPDATE member_warnings SET created_at = now() - interval '31 days'
        WHERE platform = 'discord' AND user_id = $1 AND reason = 'old'`,
      [user],
    );
    assert.equal(
      await countActiveWarnings('discord', user, 30),
      1,
      'only the strike inside the 30-day window counts',
    );
    assert.equal(
      await countActiveWarnings('discord', user),
      2,
      'both strikes still count when no window is passed, confirming the window is opt-in per call',
    );
  },
);

test(
  "SECURITY: countActiveWarnings' window is a bound query parameter, never string-interpolated — a hostile non-numeric value can't alter the query shape (e.g. inject via the interval)",
  { skip },
  async () => {
    const user = `${RUN}-hostile-window`;
    await addWarning({
      platform: 'discord',
      userId: user,
      reason: 'x',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    const hostile = '1); DROP TABLE member_warnings; --';
    await assert.rejects(
      // windowDays is typed as `number`; simulate a hostile/misconfigured value
      // reaching the query the same way a bound parameter would — it must be
      // rejected by Postgres's own $3::int cast, not spliced into the SQL text.
      countActiveWarnings('discord', user, hostile as unknown as number),
      /invalid input syntax for type integer/,
      'a non-numeric value is rejected by the bound ::int cast, proving the query text never changes shape',
    );
    // The table must still exist and the row must still be there — proof the
    // hostile value never reached the query as literal SQL.
    assert.equal(
      await countActiveWarnings('discord', user),
      1,
      'the member_warnings table and row are untouched — no injection occurred',
    );
  },
);

test(
  'countMutedMembers: counts distinct users at or over the strike limit, excludes below-limit users, and never double-counts a single over-limit user (issue #357)',
  { skip },
  async () => {
    const belowLimit = `${RUN}-muted-below`;
    const atLimit = `${RUN}-muted-at`;
    const overLimit = `${RUN}-muted-over`;
    // countMutedMembers is guild-wide by platform (not scoped to these test
    // users), so a concurrently-running test file's own muted fixtures can
    // add to the raw count — assert the DELTA against a captured baseline,
    // same convention as countAccessRequests/countPendingSuggestions's own
    // guild-wide-count tests in repository.test.ts.
    const before = await countMutedMembers('discord', 3);

    try {
      await addWarning({
        platform: 'discord',
        userId: belowLimit,
        reason: 'x',
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });

      for (let i = 0; i < 3; i++) {
        await addWarning({
          platform: 'discord',
          userId: atLimit,
          reason: `strike-${i}`,
          excerpt: null,
          source: 'auto',
          issuedBy: null,
        });
      }

      for (let i = 0; i < 5; i++) {
        await addWarning({
          platform: 'discord',
          userId: overLimit,
          reason: `strike-${i}`,
          excerpt: null,
          source: 'auto',
          issuedBy: null,
        });
      }

      assert.equal(
        await countMutedMembers('discord', 3),
        before + 2,
        'exactly the at-limit and over-limit users add to the count, once each — the below-limit user is ' +
          'excluded and the over-limit user is never double-counted per strike',
      );
    } finally {
      await pool.query(`DELETE FROM member_warnings WHERE user_id = ANY($1)`, [
        [belowLimit, atLimit, overLimit],
      ]);
    }
  },
);

test(
  'countMutedMembers: clearing warnings drops a member back under the limit and out of the count (issue #357)',
  { skip },
  async () => {
    const user = `${RUN}-muted-cleared`;
    const before = await countMutedMembers('discord', 3);

    try {
      for (let i = 0; i < 3; i++) {
        await addWarning({
          platform: 'discord',
          userId: user,
          reason: `strike-${i}`,
          excerpt: null,
          source: 'auto',
          issuedBy: null,
        });
      }
      assert.equal(
        await countMutedMembers('discord', 3),
        before + 1,
        'the at-limit user adds one to the count before clearing',
      );
      await clearWarnings('discord', user, 'admin-1');
      assert.equal(
        await countMutedMembers('discord', 3),
        before,
        'clear_warnings removes the user from the muted count — it is a live, uncleared-only signal',
      );
    } finally {
      await pool.query(`DELETE FROM member_warnings WHERE user_id = $1`, [user]);
    }
  },
);

test(
  'countMutedMembers: with a configured window, a user whose only strikes have aged out is excluded (issue #357)',
  { skip },
  async () => {
    const user = `${RUN}-muted-aged-out`;
    const beforeWindowed = await countMutedMembers('discord', 3, 30);
    const beforeUnwindowed = await countMutedMembers('discord', 3);

    try {
      for (let i = 0; i < 3; i++) {
        await addWarning({
          platform: 'discord',
          userId: user,
          reason: `strike-${i}`,
          excerpt: null,
          source: 'auto',
          issuedBy: null,
        });
      }
      await pool.query(
        `UPDATE member_warnings SET created_at = now() - interval '31 days'
          WHERE platform = 'discord' AND user_id = $1`,
        [user],
      );
      assert.equal(
        await countMutedMembers('discord', 3, 30),
        beforeWindowed,
        'all three strikes aged out of the 30-day window — the user adds nothing to the windowed count',
      );
      assert.equal(
        await countMutedMembers('discord', 3),
        beforeUnwindowed + 1,
        "the same user still counts when no window is passed, matching countActiveWarnings' own opt-in window",
      );
    } finally {
      await pool.query(`DELETE FROM member_warnings WHERE user_id = $1`, [user]);
    }
  },
);

test(
  'countStaleMutedMembers: counts a user whose strikes all aged out of the window (still over the unwindowed limit) while excluding a below-limit user and a user still over the windowed limit (issue #403)',
  { skip },
  async () => {
    const belowLimit = `${RUN}-stale-below`;
    const currentlyMuted = `${RUN}-stale-current`;
    const agedOut = `${RUN}-stale-aged-out`;
    const before = await countStaleMutedMembers('discord', 3, 30);

    try {
      await addWarning({
        platform: 'discord',
        userId: belowLimit,
        reason: 'x',
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });

      for (let i = 0; i < 3; i++) {
        await addWarning({
          platform: 'discord',
          userId: currentlyMuted,
          reason: `strike-${i}`,
          excerpt: null,
          source: 'auto',
          issuedBy: null,
        });
      }

      for (let i = 0; i < 3; i++) {
        await addWarning({
          platform: 'discord',
          userId: agedOut,
          reason: `strike-${i}`,
          excerpt: null,
          source: 'auto',
          issuedBy: null,
        });
      }
      await pool.query(
        `UPDATE member_warnings SET created_at = now() - interval '31 days'
          WHERE platform = 'discord' AND user_id = $1`,
        [agedOut],
      );

      assert.equal(
        await countStaleMutedMembers('discord', 3, 30),
        before + 1,
        'only the aged-out-but-still-over-the-unwindowed-limit user is counted — the below-limit user ' +
          'never crosses the limit, and the currently-windowed-muted user belongs to countMutedMembers, not this',
      );
    } finally {
      await pool.query(`DELETE FROM member_warnings WHERE user_id = ANY($1)`, [
        [belowLimit, currentlyMuted, agedOut],
      ]);
    }
  },
);

test(
  'countStaleMutedMembers: mutually exclusive with countMutedMembers — a user still over the windowed limit is never double-counted by both (issue #403 acceptance criteria)',
  { skip },
  async () => {
    const user = `${RUN}-stale-mutex`;
    const beforeMuted = await countMutedMembers('discord', 3, 30);
    const beforeStale = await countStaleMutedMembers('discord', 3, 30);

    try {
      for (let i = 0; i < 3; i++) {
        await addWarning({
          platform: 'discord',
          userId: user,
          reason: `strike-${i}`,
          excerpt: null,
          source: 'auto',
          issuedBy: null,
        });
      }

      assert.equal(
        await countMutedMembers('discord', 3, 30),
        beforeMuted + 1,
        'the user is currently over the windowed limit, so countMutedMembers counts them',
      );
      assert.equal(
        await countStaleMutedMembers('discord', 3, 30),
        beforeStale,
        'the same user must NOT also be counted by countStaleMutedMembers — the two sets are disjoint',
      );
    } finally {
      await pool.query(`DELETE FROM member_warnings WHERE user_id = $1`, [user]);
    }
  },
);

test(
  'countStaleMutedMembers: is an over-approximation — a user whose strikes accrued too slowly to ever cross the windowed limit is still included once their unwindowed count reaches it (issue #403 acceptance criteria #4)',
  { skip },
  async () => {
    const user = `${RUN}-stale-slow-accrual`;
    const before = await countStaleMutedMembers('discord', 3, 15);

    try {
      // Two strikes spaced outside a 15-day window, one inside it — spread
      // wide enough that the windowed count (currently 1) never reaches the
      // strikeLimit (3) at all, so this user was likely NEVER actually
      // muted. Their unwindowed total (3) still hits the limit, so this
      // function counts them anyway — the documented over-approximation.
      await addWarning({
        platform: 'discord',
        userId: user,
        reason: 'strike-old-1',
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });
      await addWarning({
        platform: 'discord',
        userId: user,
        reason: 'strike-old-2',
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });
      await pool.query(
        `UPDATE member_warnings SET created_at = now() - interval '20 days'
          WHERE platform = 'discord' AND user_id = $1`,
        [user],
      );
      await addWarning({
        platform: 'discord',
        userId: user,
        reason: 'strike-recent',
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });

      assert.equal(
        await countActiveWarnings('discord', user, 15),
        1,
        'sanity check: the windowed count for this user is 1, well under the limit of 3',
      );
      assert.equal(
        await countStaleMutedMembers('discord', 3, 15),
        before + 1,
        'unwindowed count (3) is still at the limit, so this over-approximation counts the user even though ' +
          'their windowed count never reached the limit — they likely were never actually muted',
      );
    } finally {
      await pool.query(`DELETE FROM member_warnings WHERE user_id = $1`, [user]);
    }
  },
);

test('countStaleMutedMembers: returns 0 without issuing any DB query when windowDays is undefined (issue #403 acceptance criteria #2)', async (t) => {
  const querySpy = t.mock.method(pool, 'query', async () => {
    throw new Error('must not query the database');
  });

  assert.equal(await countStaleMutedMembers('discord', 3), 0);
  assert.equal(
    querySpy.mock.calls.length,
    0,
    'with no window configured, windowed and unwindowed counts are always identical, so this cohort is ' +
      'provably empty — the function must short-circuit before ever touching the database',
  );
});

test(
  'SECURITY: a strike aging out of the configured window is never mutated or cleared — decay only changes what counts as active, never auto-unmutes (clear_warnings is still required)',
  { skip },
  async () => {
    const user = `${RUN}-decay-no-mutate`;
    await addWarning({
      platform: 'discord',
      userId: user,
      reason: 'aged-out',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    await pool.query(
      `UPDATE member_warnings SET created_at = now() - interval '400 days'
        WHERE platform = 'discord' AND user_id = $1`,
      [user],
    );
    assert.equal(
      await countActiveWarnings('discord', user, 30),
      0,
      'the aged-out strike no longer counts toward the mute threshold',
    );
    const { rows } = await pool.query(
      `SELECT cleared_at FROM member_warnings WHERE platform = 'discord' AND user_id = $1`,
      [user],
    );
    assert.equal(
      rows[0]?.cleared_at,
      null,
      'decay must never set cleared_at itself — only an explicit clear_warnings call may',
    );
    // Confirm the still-uncleared row is exactly what an admin must act on:
    // clearWarnings is the only path that ever flips cleared_at.
    const cleared = await clearWarnings('discord', user, 'admin-1');
    assert.equal(cleared, 1, 'clear_warnings is still required to actually clear the decayed-out strike');
  },
);

test(
  "SECURITY: purge_user_data deletes a member's warning history (purge coherence)",
  {
    skip,
  },
  async () => {
    const user = `${RUN}-purge`;
    await addWarning({
      platform: 'discord',
      userId: user,
      reason: 'z',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    assert.equal(await countActiveWarnings('discord', user), 1);
    await purgeUserData('discord', user);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM member_warnings WHERE platform = 'discord' AND user_id = $1`,
      [user],
    );
    assert.equal(rows[0].n, 0, 'purge_user_data removed all warning rows for the user');
  },
);

// listMutedMembers (issue #487): enumerates the union of countMutedMembers'
// and countStaleMutedMembers' cohorts by identity. These tests use a
// run-scoped fake `platform` value (never 'discord'/'whatsapp') so the guild-
// wide query is fully isolated from any concurrently-running test file's own
// fixtures — no delta-based counting needed, unlike the count-function tests
// above which share the real 'discord' platform.
const LIST_PLATFORM = `${RUN}-list-muted`;

test(
  'listMutedMembers: returns exactly the members countMutedMembers (active) and countStaleMutedMembers ' +
    '(stale) would each count, tagged accordingly, excluding a genuinely-clear member (issue #487 ' +
    'acceptance criteria #1)',
  { skip },
  async () => {
    const overLimit = `${RUN}-lm-over`;
    const agedOutStale = `${RUN}-lm-stale`;
    const belowLimit = `${RUN}-lm-below`;

    for (let i = 0; i < 3; i++) {
      await addWarning({
        platform: LIST_PLATFORM,
        userId: overLimit,
        reason: `strike-${i}`,
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });
    }
    for (let i = 0; i < 3; i++) {
      await addWarning({
        platform: LIST_PLATFORM,
        userId: agedOutStale,
        reason: `strike-${i}`,
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });
    }
    await pool.query(
      `UPDATE member_warnings SET created_at = now() - interval '31 days'
        WHERE platform = $1 AND user_id = $2`,
      [LIST_PLATFORM, agedOutStale],
    );
    await addWarning({
      platform: LIST_PLATFORM,
      userId: belowLimit,
      reason: 'x',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });

    const [rows, mutedCount, staleCount] = await Promise.all([
      listMutedMembers(LIST_PLATFORM, 3, 30),
      countMutedMembers(LIST_PLATFORM, 3, 30),
      countStaleMutedMembers(LIST_PLATFORM, 3, 30),
    ]);

    assert.equal(mutedCount, 1, 'sanity: countMutedMembers sees exactly the over-limit user');
    assert.equal(staleCount, 1, 'sanity: countStaleMutedMembers sees exactly the aged-out user');
    assert.equal(rows.length, 2, 'the below-limit user is excluded entirely');

    const byUser = new Map(rows.map((r) => [r.userId, r]));
    assert.equal(byUser.get(overLimit)?.status, 'active', 'the currently over-limit user is tagged active');
    assert.equal(
      byUser.get(agedOutStale)?.status,
      'stale',
      'the aged-out-but-still-over-unwindowed-limit user is tagged stale',
    );
    assert.equal(byUser.has(belowLimit), false, 'the genuinely-clear user never appears');

    await pool.query(`DELETE FROM member_warnings WHERE platform = $1`, [LIST_PLATFORM]);
  },
);

test(
  'listMutedMembers: active and stale tags are mutually exclusive — a user over both the windowed and ' +
    'unwindowed limit appears exactly once, tagged active (issue #487 acceptance criteria #2)',
  { skip },
  async () => {
    const user = `${RUN}-lm-mutex`;
    for (let i = 0; i < 3; i++) {
      await addWarning({
        platform: LIST_PLATFORM,
        userId: user,
        reason: `strike-${i}`,
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });
    }

    const rows = await listMutedMembers(LIST_PLATFORM, 3, 30);
    const matches = rows.filter((r) => r.userId === user);
    assert.equal(matches.length, 1, 'the user appears exactly once, never double-counted as both tags');
    assert.equal(matches[0]?.status, 'active');

    await pool.query(`DELETE FROM member_warnings WHERE platform = $1`, [LIST_PLATFORM]);
  },
);

test(
  'listMutedMembers: with windowDays unset (default), every returned row is tagged active and the stale ' +
    'cohort is always empty (issue #487 acceptance criteria #3, regression)',
  { skip },
  async () => {
    const user = `${RUN}-lm-no-window`;
    for (let i = 0; i < 3; i++) {
      await addWarning({
        platform: LIST_PLATFORM,
        userId: user,
        reason: `strike-${i}`,
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });
    }
    await pool.query(
      `UPDATE member_warnings SET created_at = now() - interval '400 days'
        WHERE platform = $1 AND user_id = $2`,
      [LIST_PLATFORM, user],
    );

    const rows = await listMutedMembers(LIST_PLATFORM, 3);
    assert.equal(rows.length, 1, 'the unwindowed count still qualifies the user');
    assert.equal(rows[0]?.status, 'active', 'with no window configured, every row is tagged active');
    assert.equal(
      rows.filter((r) => r.status === 'stale').length,
      0,
      'the stale cohort is always empty when windowDays is undefined',
    );

    await pool.query(`DELETE FROM member_warnings WHERE platform = $1`, [LIST_PLATFORM]);
  },
);

test(
  'listMutedMembers: caps output at the given limit, ordered newest-warning-first (issue #487 acceptance ' +
    'criteria #6)',
  { skip },
  async () => {
    const users = Array.from({ length: 5 }, (_, i) => `${RUN}-lm-cap-${i}`);
    for (const user of users) {
      for (let i = 0; i < 3; i++) {
        await addWarning({
          platform: LIST_PLATFORM,
          userId: user,
          reason: `strike-${i}`,
          excerpt: null,
          source: 'auto',
          issuedBy: null,
        });
      }
      // Space out last_warning_at so ordering is deterministic — later users
      // in the array get a strictly more recent timestamp.
      await pool.query(
        `UPDATE member_warnings SET created_at = now() - make_interval(secs => $2)
          WHERE platform = $1 AND user_id = $3`,
        [LIST_PLATFORM, (users.length - users.indexOf(user)) * 10, user],
      );
    }

    const rows = await listMutedMembers(LIST_PLATFORM, 3, undefined, 3);
    assert.equal(rows.length, 3, 'output is capped at the given limit even though 5 users qualify');
    assert.deepEqual(
      rows.map((r) => r.userId),
      [users[4], users[3], users[2]],
      'the 3 most-recently-warned qualifying users are returned, newest first',
    );

    await pool.query(`DELETE FROM member_warnings WHERE platform = $1`, [LIST_PLATFORM]);
  },
);

test(
  'listMutedMembers: the default cap is 50 rows even when more than 50 members qualify (issue #487 ' +
    'acceptance criteria #6)',
  { skip },
  async () => {
    for (let i = 0; i < 55; i++) {
      await addWarning({
        platform: LIST_PLATFORM,
        userId: `${RUN}-lm-default-cap-${i}`,
        reason: 'x',
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });
      await addWarning({
        platform: LIST_PLATFORM,
        userId: `${RUN}-lm-default-cap-${i}`,
        reason: 'y',
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });
      await addWarning({
        platform: LIST_PLATFORM,
        userId: `${RUN}-lm-default-cap-${i}`,
        reason: 'z',
        excerpt: null,
        source: 'auto',
        issuedBy: null,
      });
    }

    const rows = await listMutedMembers(LIST_PLATFORM, 3);
    assert.equal(rows.length, 50, 'the default limit caps output at 50 even with 55 qualifying members');

    await pool.query(`DELETE FROM member_warnings WHERE platform = $1`, [LIST_PLATFORM]);
  },
);

test(
  "SECURITY: listMutedMembers's platform/strikeLimit/windowDays/limit are bound query parameters, never " +
    "string-interpolated — a hostile non-numeric windowDays can't alter the query shape",
  { skip },
  async () => {
    const user = `${RUN}-lm-hostile`;
    await addWarning({
      platform: LIST_PLATFORM,
      userId: user,
      reason: 'x',
      excerpt: null,
      source: 'auto',
      issuedBy: null,
    });
    const hostile = '1); DROP TABLE member_warnings; --';
    await assert.rejects(
      listMutedMembers(LIST_PLATFORM, 3, hostile as unknown as number),
      /invalid input syntax for type integer/,
      'a non-numeric windowDays is rejected by the bound ::int cast, proving the query text never changes shape',
    );
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM member_warnings WHERE platform = $1 AND user_id = $2`,
      [LIST_PLATFORM, user],
    );
    assert.equal(rows[0]?.n, 1, 'the member_warnings table and row are untouched — no injection occurred');

    await pool.query(`DELETE FROM member_warnings WHERE platform = $1`, [LIST_PLATFORM]);
  },
);
