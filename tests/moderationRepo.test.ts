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
