import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/appealStaleAlert.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

import { fakePolicyStore } from './support/fakePolicyStore.js';

const {
  persistedCrossingLatch,
  persistedPerKeyCrossingLatch,
  CROSSING_LATCH_ACTIVE_MARKER,
  CROSSING_LATCH_INACTIVE_MARKER,
} = await import('../src/module/crossingLatch.js');
const {
  APPEAL_STALE_ALERT_POLICY_KEY,
  SUGGESTION_STALE_ALERT_POLICY_KEY,
  KNOWLEDGE_CANDIDATE_STALE_ALERT_POLICY_KEY,
  ACCESS_REQUEST_STALE_ALERT_POLICY_KEY,
  ROSTER_STALE_ALERT_POLICY_KEY,
  DEPARTED_ADMIN_ALERT_POLICY_KEY,
  REPORT_STALE_ALERT_POLICY_KEY,
} = await import('../src/module/storage/policies.js');

const ALL_SIX_KEYS = [
  APPEAL_STALE_ALERT_POLICY_KEY,
  SUGGESTION_STALE_ALERT_POLICY_KEY,
  KNOWLEDGE_CANDIDATE_STALE_ALERT_POLICY_KEY,
  ACCESS_REQUEST_STALE_ALERT_POLICY_KEY,
  ROSTER_STALE_ALERT_POLICY_KEY,
  DEPARTED_ADMIN_ALERT_POLICY_KEY,
];

test('CROSSING_LATCH_ACTIVE_MARKER/CROSSING_LATCH_INACTIVE_MARKER are the fixed, non-identifying marker values', () => {
  assert.equal(CROSSING_LATCH_ACTIVE_MARKER, 'true');
  assert.equal(CROSSING_LATCH_INACTIVE_MARKER, '');
});

test('persistedCrossingLatch: a crossing computes shouldAlert:true but writes nothing until commit() is called', async () => {
  const store = fakePolicyStore();
  const latch = persistedCrossingLatch('test_key', store);

  const step = await latch.step(1);
  assert.equal(step.shouldAlert, true);
  assert.equal(store.written.length, 0, 'no write before commit() is called');

  await step.commit();
  assert.deepEqual(store.written, [{ key: 'test_key', value: 'true', updatedBy: 'system' }]);
});

test('persistedCrossingLatch: a still->=1 tick after the first never re-alerts and never writes again', async () => {
  const store = fakePolicyStore();
  const latch = persistedCrossingLatch('test_key', store);
  const first = await latch.step(1);
  await first.commit();

  const second = await latch.step(3);
  assert.equal(second.shouldAlert, false);
  assert.equal(store.written.length, 1, 'no additional write while the latch stays active');
});

test('persistedCrossingLatch: dropping to 0 clears the marker automatically, with no commit() call needed', async () => {
  const store = fakePolicyStore();
  const latch = persistedCrossingLatch('test_key', store);
  const first = await latch.step(2);
  await first.commit();

  const rearm = await latch.step(0);
  assert.equal(rearm.shouldAlert, false);
  assert.deepEqual(store.written, [
    { key: 'test_key', value: 'true', updatedBy: 'system' },
    { key: 'test_key', value: '', updatedBy: 'system' },
  ]);
});

test('persistedCrossingLatch: a partial decrease that never reaches 0 writes nothing', async () => {
  const store = fakePolicyStore();
  const latch = persistedCrossingLatch('test_key', store);
  const first = await latch.step(3);
  await first.commit();

  const partial = await latch.step(1);
  assert.equal(partial.shouldAlert, false);
  assert.equal(store.written.length, 1, 'a partial decrease (3 -> 1) writes nothing new');
});

test('persistedCrossingLatch: restart-safety — seeded from a store already holding the active marker, a still->=1 first tick never alerts', async () => {
  const store = fakePolicyStore({ test_key: 'true' });
  const latch = persistedCrossingLatch('test_key', store);

  const step = await latch.step(5);
  assert.equal(
    step.shouldAlert,
    false,
    'a fresh process must not re-fire for an already-active, still-stale backlog',
  );
});

test('persistedCrossingLatch: reads the policy store exactly once (on the first step()), never again for later ticks', async () => {
  let reads = 0;
  const store = fakePolicyStore();
  const wrapped = {
    readPolicy: async (key: string) => {
      reads += 1;
      return store.readPolicy(key);
    },
    updatePolicy: store.updatePolicy,
  };
  const latch = persistedCrossingLatch('test_key', wrapped);

  await latch.step(0);
  await latch.step(1);
  await latch.step(1);
  await latch.step(0);
  await latch.step(1);

  assert.equal(
    reads,
    1,
    "the tracker is seeded once and kept in memory, like every job's own pre-#1198 tracker",
  );
});

// --- SECURITY (issue #1198 acceptance criterion 7) --------------------------

test('SECURITY: across all six registered stale-alert policy keys, persistedCrossingLatch never writes anything but the fixed active/inactive markers, with "system" as the actor', async () => {
  const store = fakePolicyStore();
  for (const key of ALL_SIX_KEYS) {
    const latch = persistedCrossingLatch(key, store);
    const up = await latch.step(3); // 0 -> 3, crosses
    await up.commit();
    await latch.step(1); // stays >0, no write
    await latch.step(0); // re-arms, writes ''
    const upAgain = await latch.step(2); // crosses again
    await upAgain.commit();
  }

  assert.ok(store.written.length > 0);
  for (const write of store.written) {
    assert.ok(ALL_SIX_KEYS.includes(write.key), `unexpected key: ${write.key}`);
    assert.ok(
      write.value === CROSSING_LATCH_ACTIVE_MARKER || write.value === CROSSING_LATCH_INACTIVE_MARKER,
      `unexpected value for ${write.key}: ${JSON.stringify(write.value)} — never an id, name, platform, or content string`,
    );
    assert.equal(
      write.updatedBy,
      'system',
      'jobs have no caller identity — the actor must always be "system"',
    );
  }
  for (const key of ALL_SIX_KEYS) {
    assert.ok(
      store.written.some((w) => w.key === key),
      `no write recorded for ${key}`,
    );
  }
});

// --- persistedPerKeyCrossingLatch (issue #1271) ------------------------------

test('persistedPerKeyCrossingLatch: a crossing computes shouldAlert:true but writes nothing until commit() is called', async () => {
  const store = fakePolicyStore();
  const latch = persistedPerKeyCrossingLatch('test_key', store);

  const step = await latch.step('admin-a', 1);
  assert.equal(step.shouldAlert, true);
  assert.equal(store.written.length, 0, 'no write before commit() is called');

  await step.commit();
  assert.deepEqual(store.written, [{ key: 'test_key', value: ['admin-a'], updatedBy: 'system' }]);
});

test('persistedPerKeyCrossingLatch: a still->=1 tick after the first never re-alerts and never writes again, for that key', async () => {
  const store = fakePolicyStore();
  const latch = persistedPerKeyCrossingLatch('test_key', store);
  const first = await latch.step('admin-a', 1);
  await first.commit();

  const second = await latch.step('admin-a', 3);
  assert.equal(second.shouldAlert, false);
  assert.equal(store.written.length, 1, 'no additional write while the latch stays active');
});

test('persistedPerKeyCrossingLatch: dropping a key to 0 clears it from the active set automatically, with no commit() call needed', async () => {
  const store = fakePolicyStore();
  const latch = persistedPerKeyCrossingLatch('test_key', store);
  const first = await latch.step('admin-a', 2);
  await first.commit();

  const rearm = await latch.step('admin-a', 0);
  assert.equal(rearm.shouldAlert, false);
  assert.deepEqual(store.written, [
    { key: 'test_key', value: ['admin-a'], updatedBy: 'system' },
    { key: 'test_key', value: [], updatedBy: 'system' },
  ]);
});

test('persistedPerKeyCrossingLatch: a partial decrease that never reaches 0 writes nothing', async () => {
  const store = fakePolicyStore();
  const latch = persistedPerKeyCrossingLatch('test_key', store);
  const first = await latch.step('admin-a', 3);
  await first.commit();

  const partial = await latch.step('admin-a', 1);
  assert.equal(partial.shouldAlert, false);
  assert.equal(store.written.length, 1, 'a partial decrease (3 -> 1) writes nothing new');
});

test(
  'persistedPerKeyCrossingLatch: restart-safety — seeded from a store already holding a key in the active ' +
    "array, that key's still->=1 first tick never alerts",
  async () => {
    const store = fakePolicyStore({ test_key: ['admin-a'] });
    const latch = persistedPerKeyCrossingLatch('test_key', store);

    const step = await latch.step('admin-a', 5);
    assert.equal(
      step.shouldAlert,
      false,
      'a fresh process must not re-fire for an already-active, still-stale key',
    );
  },
);

test('persistedPerKeyCrossingLatch: reads the policy store exactly once across many step() calls, for any key', async () => {
  let reads = 0;
  const store = fakePolicyStore();
  const wrapped = {
    readPolicy: async (key: string) => {
      reads += 1;
      return store.readPolicy(key);
    },
    updatePolicy: store.updatePolicy,
  };
  const latch = persistedPerKeyCrossingLatch('test_key', wrapped);

  await latch.step('admin-a', 0);
  await latch.step('admin-a', 1);
  await latch.step('admin-b', 1);
  await latch.step('admin-a', 0);
  await latch.step('admin-b', 0);

  assert.equal(reads, 1, 'the tracker map is seeded once and kept in memory across every key');
});

test(
  "persistedPerKeyCrossingLatch: per-key isolation — one key's crossing/re-arm never mutates another key's " +
    'persisted active-set membership',
  async () => {
    const store = fakePolicyStore();
    const latch = persistedPerKeyCrossingLatch('test_key', store);

    const aUp = await latch.step('admin-a', 2);
    await aUp.commit();
    assert.deepEqual(await store.readPolicy('test_key'), ['admin-a']);

    const bUp = await latch.step('admin-b', 3);
    await bUp.commit();
    assert.deepEqual(
      await store.readPolicy('test_key'),
      ['admin-a', 'admin-b'],
      "admin-b's crossing must not drop admin-a from the persisted active set",
    );

    await latch.step('admin-a', 0); // admin-a re-arms
    assert.deepEqual(
      await store.readPolicy('test_key'),
      ['admin-b'],
      "admin-a's re-arm must not affect admin-b's still-active membership",
    );
  },
);

test(
  'persistedPerKeyCrossingLatch: a non-array, malformed stored value seeds an empty active set with no throw — ' +
    'identical to a fresh deployment',
  async () => {
    const store = fakePolicyStore({ test_key: 'not-an-array' });
    const latch = persistedPerKeyCrossingLatch('test_key', store);

    const step = await latch.step('admin-a', 3);
    assert.equal(step.shouldAlert, true, 'a malformed stored value must not suppress a genuine crossing');
  },
);

// --- SECURITY (issue #1271 acceptance criterion 5) ---------------------------

test(
  'SECURITY: across a multi-admin/multi-tick simulation, persistedPerKeyCrossingLatch never writes anything ' +
    'but well-formed platform:platformUserId strings drawn from the keys passed into step(), with "system" as ' +
    'the actor',
  async () => {
    const store = fakePolicyStore();
    const latch = persistedPerKeyCrossingLatch(REPORT_STALE_ALERT_POLICY_KEY, store);
    const keys = ['discord:admin-a', 'discord:admin-b', 'whatsapp:64211234567'];

    const aUp = await latch.step(keys[0], 3); // 0 -> 3, crosses
    await aUp.commit();
    await latch.step(keys[0], 1); // stays >0, no write

    const bUp = await latch.step(keys[1], 2); // crosses
    await bUp.commit();
    await latch.step(keys[1], 0); // re-arms
    const bUpAgain = await latch.step(keys[1], 5); // crosses again
    await bUpAgain.commit();

    await latch.step(keys[2], 0); // never crosses — no write

    assert.ok(store.written.length > 0);
    for (const write of store.written) {
      assert.equal(write.key, REPORT_STALE_ALERT_POLICY_KEY);
      assert.equal(
        write.updatedBy,
        'system',
        'jobs have no caller identity — the actor must always be "system"',
      );
      assert.ok(Array.isArray(write.value), `value must be an array: ${JSON.stringify(write.value)}`);
      for (const entry of write.value as unknown[]) {
        assert.equal(typeof entry, 'string');
        assert.match(
          entry as string,
          /^[a-z]+:\S+$/,
          `unexpected shape: ${entry} — must be a bare platform:platformUserId string`,
        );
        assert.ok(
          keys.includes(entry as string),
          `unexpected value: ${entry} — never a report id, reporter/target identity, or reason`,
        );
      }
    }

    assert.deepEqual(await store.readPolicy(REPORT_STALE_ALERT_POLICY_KEY), [
      'discord:admin-a',
      'discord:admin-b',
    ]);
  },
);
