import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Persisted WhatsApp LID -> phone mapping (src/storage/schema/70-whatsapp.sql,
 * docs/SECURITY.md §6b).
 *
 * The adapter always learned this mapping, but only in an in-memory Map that
 * died with the process. Persisting it lets a LID be RESOLVED to a phone
 * number instead of merely refused — which is the difference between "add
 * @Ryan" working and an admin having to go and find his number by hand.
 *
 * DB-integration: these skip cleanly without DATABASE_URL, per CLAUDE.md.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb ? false : 'DATABASE_URL not set — skipping DB-integration tests';

const RUN = `lidmap-${Date.now()}`;
const LID = `9${Date.now()}`.slice(0, 15);
const PHONE = '64270000001';

test('remembers a LID -> phone mapping and reads it back', { skip }, async () => {
  const { rememberLidPhone, phoneForLid, forgetLidMappingsForPhone } =
    await import('../src/storage/repository/whatsappLidMap.js');
  try {
    assert.equal(await phoneForLid(LID), null, 'unknown LID resolves to null, not a guess');
    await rememberLidPhone(LID, PHONE);
    assert.equal(await phoneForLid(LID), PHONE);
  } finally {
    await forgetLidMappingsForPhone(PHONE);
  }
});

test('re-learning a LID is idempotent, and a REASSIGNED lid takes the newest number', { skip }, async () => {
  const { rememberLidPhone, phoneForLid, forgetLidMappingsForPhone } =
    await import('../src/storage/repository/whatsappLidMap.js');
  const newer = '64270000002';
  try {
    await rememberLidPhone(LID, PHONE);
    await rememberLidPhone(LID, PHONE); // idempotent
    assert.equal(await phoneForLid(LID), PHONE);

    // WhatsApp can re-issue a LID. The newest envelope wins: a stale mapping
    // would resolve someone to a number that is no longer theirs, which is
    // worse than having no mapping at all.
    await rememberLidPhone(LID, newer);
    assert.equal(await phoneForLid(LID), newer);
  } finally {
    await forgetLidMappingsForPhone(PHONE);
    await forgetLidMappingsForPhone(newer);
  }
});

test(
  'SECURITY: forget_me erases the LID mapping — a privacy id must not stay de-anonymised after erasure',
  { skip },
  async () => {
    const { rememberLidPhone, phoneForLid, forgetLidMappingsForPhone } =
      await import('../src/storage/repository/whatsappLidMap.js');
    // Via the BARREL, not budgetsPrivacy.js directly: purgeUserData now runs
    // the registered PurgeContributor set (src/storage/lifecycle.ts), and the
    // contributors register at module load of their owning domain files —
    // which the barrel's `export *` lines are what load, same as production.
    const { purgeUserData } = await import('../src/storage/repository.js');
    const lidA = `8${Date.now()}`.slice(0, 15);
    const lidB = `7${Date.now()}`.slice(0, 15);
    const phone = '64270000003';
    try {
      // One person can accumulate more than one LID over time, so the purge is
      // keyed on the phone rather than deleting a single row.
      await rememberLidPhone(lidA, phone);
      await rememberLidPhone(lidB, phone);
      assert.equal(await phoneForLid(lidA), phone);
      assert.equal(await phoneForLid(lidB), phone);

      await purgeUserData('whatsapp', phone);

      assert.equal(await phoneForLid(lidA), null, 'purge_user_data must erase every LID mapping');
      assert.equal(await phoneForLid(lidB), null, 'including a second LID for the same person');
    } finally {
      await forgetLidMappingsForPhone(phone);
    }
  },
);

test(`SECURITY: erasing one person's mapping leaves another's intact`, { skip }, async () => {
  const { rememberLidPhone, phoneForLid, forgetLidMappingsForPhone } =
    await import('../src/storage/repository/whatsappLidMap.js');
  const mine = `6${Date.now()}`.slice(0, 15);
  const theirs = `5${Date.now()}`.slice(0, 15);
  try {
    await rememberLidPhone(mine, '64270000004');
    await rememberLidPhone(theirs, '64270000005');
    await forgetLidMappingsForPhone('64270000004');
    assert.equal(await phoneForLid(mine), null);
    assert.equal(await phoneForLid(theirs), '64270000005', 'an unrelated person must be untouched');
  } finally {
    await forgetLidMappingsForPhone('64270000004');
    await forgetLidMappingsForPhone('64270000005');
  }
});

test(`${RUN}: forgetting an unknown phone is a no-op, never an error`, { skip }, async () => {
  const { forgetLidMappingsForPhone } = await import('../src/storage/repository/whatsappLidMap.js');
  assert.equal(await forgetLidMappingsForPhone('64279999999'), 0);
});

test(
  'purge_user_data COUNTS the LID mappings it erased, so the reported total is honest',
  { skip },
  async () => {
    // PR #935 review: the purge originally inlined the DELETE and discarded its
    // row count, so `purge_user_data`'s "deleted N stored record(s)" reply
    // under-reported whenever the identity had LID mappings. The count is part
    // of the privacy contract — a member told "3 records deleted" when it was 5
    // has been given a wrong answer about their own data.
    const { rememberLidPhone, forgetLidMappingsForPhone } =
      await import('../src/storage/repository/whatsappLidMap.js');
    // Via the BARREL, not budgetsPrivacy.js directly: purgeUserData now runs
    // the registered PurgeContributor set (src/storage/lifecycle.ts), and the
    // contributors register at module load of their owning domain files —
    // which the barrel's `export *` lines are what load, same as production.
    const { purgeUserData } = await import('../src/storage/repository.js');
    const phone = '64270000006';
    const lids = [`4${Date.now()}`.slice(0, 15), `3${Date.now()}`.slice(0, 15)];
    try {
      for (const lid of lids) await rememberLidPhone(lid, phone);
      // This identity has no other data, so the total IS the mapping count.
      const deleted = await purgeUserData('whatsapp', phone);
      assert.equal(deleted, lids.length, `expected both mappings counted, got ${deleted}`);
    } finally {
      await forgetLidMappingsForPhone(phone);
    }
  },
);

test(
  'forgetLidMappingsForPhone runs on a caller-supplied client, so erasure is atomic with the rest of a purge',
  { skip },
  async () => {
    // Not cosmetic: the purge runs inside BEGIN/COMMIT on a checked-out client.
    // Calling the pool-based default from in there would delete on a SEPARATE
    // connection, which would survive a rollback and leave the mapping gone
    // while everything else came back. Proven by rolling back deliberately.
    const { pool } = await import('../src/storage/db.js');
    const { rememberLidPhone, phoneForLid, forgetLidMappingsForPhone } =
      await import('../src/storage/repository/whatsappLidMap.js');
    const phone = '64270000007';
    const lid = `2${Date.now()}`.slice(0, 15);
    const client = await pool.connect();
    try {
      await rememberLidPhone(lid, phone);
      await client.query('BEGIN');
      const removed = await forgetLidMappingsForPhone(phone, client);
      assert.equal(removed, 1, 'deleted inside the transaction');
      await client.query('ROLLBACK');
      assert.equal(
        await phoneForLid(lid),
        phone,
        'the rollback must restore it — proving the delete used the caller’s transaction, not a separate connection',
      );
    } finally {
      client.release();
      await forgetLidMappingsForPhone(phone);
    }
  },
);
