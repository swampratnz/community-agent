import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. All three job flags are pinned
// ON here (opposite of tests/backgroundJobsDisabled.test.ts, in its own
// process — config is parsed once per process at import time, so "enabled"
// and "disabled" behaviour can't share a file) so the alerting wiring below
// can be exercised end to end with injected `runOnce` functions and mocked
// timers — never a real DB call, real network fetch, or real 6h wait.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';
process.env.CONTEXT_BUILDER_ENABLED = 'true';
process.env.KNOWLEDGE_REFRESH_ENABLED = 'true';
process.env.DOCS_INGEST_ENABLED = 'true';

const { startContextBuilder, startKnowledgeRefresh, startDocsIngest } =
  await import('../src/backgroundJobs.js');

const SIX_HOURS_MS = 6 * 3_600_000;

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

// run()'s alert path is fire-and-forget (`void alertSuperAdmins(...)`, no
// await), so give the microtask queue a turn after each tick before
// asserting — same technique as tests/agentCoreUsageLimitAlert.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const JOBS = [
  ['startContextBuilder', startContextBuilder],
  ['startKnowledgeRefresh', startKnowledgeRefresh],
  ['startDocsIngest', startDocsIngest],
] as const;

for (const [name, start] of JOBS) {
  test(`${name}: sends exactly one super-admin DM after its run function throws on 3 consecutive scheduled ticks, and zero DMs while failures stay below threshold`, async (t) => {
    const { adapter, dms } = makeAdapter();
    const runOnce = async () => {
      throw new Error(`sentinel-${name}`);
    };

    t.mock.timers.enable({ apis: ['setInterval'] });
    const timer = start([adapter], runOnce);
    assert.ok(timer, `${name}: enabled — a timer is created`);
    try {
      await flush(); // 1st scheduled run (fires immediately) fails
      assert.equal(dms.length, 0, `${name}: no DM after the 1st consecutive failure`);
      t.mock.timers.tick(SIX_HOURS_MS);
      await flush(); // 2nd
      assert.equal(dms.length, 0, `${name}: no DM after the 2nd consecutive failure`);
      t.mock.timers.tick(SIX_HOURS_MS);
      await flush(); // 3rd — threshold reached
      assert.equal(dms.length, 1, `${name}: exactly one DM on the 3rd consecutive failure`);
      t.mock.timers.tick(SIX_HOURS_MS);
      await flush(); // 4th — still failing
      assert.equal(dms.length, 1, `${name}: no repeat DM while the failure streak continues`);
    } finally {
      clearInterval(timer);
    }
  });
}

test('each of the three jobs keeps an independent tracker: one failure each (below threshold) alerts zero times total', async (t) => {
  const { adapter, dms } = makeAdapter();
  const failOnce = async () => {
    throw new Error('sentinel-independent');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timers = [
    startContextBuilder([adapter], failOnce),
    startKnowledgeRefresh([adapter], failOnce),
    startDocsIngest([adapter], failOnce),
  ];
  try {
    await flush();
    assert.equal(
      dms.length,
      0,
      'three distinct jobs each failing once (< threshold) never alerts — trackers are independent',
    );
  } finally {
    for (const timer of timers) if (timer) clearInterval(timer);
  }
});

test("startContextBuilder: a successful run after a failure streak resets that job's tracker, so a fresh streak of 3 further failures alerts again (not a one-shot latch)", async (t) => {
  const { adapter, dms } = makeAdapter();
  let mode: 'fail' | 'succeed' = 'fail';
  const runOnce = async () => {
    if (mode === 'fail') throw new Error('sentinel-rearm');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startContextBuilder([adapter], runOnce);
  try {
    await flush(); // failure 1
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 2
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 3 -> alert
    assert.equal(dms.length, 1, 'first streak of 3 consecutive failures alerts once');

    mode = 'succeed';
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // success -> silently resets the tracker
    assert.equal(dms.length, 1, 'a successful run never itself sends a DM');

    mode = 'fail';
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 1 of the new streak
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 2
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // failure 3 -> alerts again
    assert.equal(dms.length, 2, 'a fresh streak of 3 failures after recovery alerts again');
  } finally {
    clearInterval(timer!);
  }
});

test('DM routing: the alert is delivered via sendDirectMessage + superAdminIds(platform), skipping any adapter whose isConnected() is false', async (t) => {
  const { adapter: connected, dms: connectedDms } = makeAdapter();
  const { adapter: disconnectedBase, dms: disconnectedDms } = makeAdapter();
  const disconnected: PlatformAdapter = { ...disconnectedBase, isConnected: () => false };

  const alwaysFail = async () => {
    throw new Error('sentinel-routing');
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDocsIngest([connected, disconnected], alwaysFail);
  try {
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // threshold reached
    assert.equal(connectedDms.length, 1, 'the connected adapter receives the alert DM');
    assert.equal(disconnectedDms.length, 0, 'a disconnected adapter is skipped, never DMed');
  } finally {
    clearInterval(timer!);
  }
});

test('SECURITY: the alert DM body never contains the caught error message or stack — only the fixed template (job name, failure count, last-success timestamp)', async (t) => {
  const sentinel = 'sentinel-secret-path-or-query-fragment-9f3a';
  const { adapter, dms } = makeAdapter();
  const runOnce = async () => {
    throw new Error(sentinel);
  };

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startDocsIngest([adapter], runOnce);
  try {
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush();
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // threshold reached
    assert.equal(dms.length, 1, 'threshold reached, one alert sent');
    const body = dms[0].text;
    assert.ok(!body.includes(sentinel), 'the DM body must never contain the caught error message');
    assert.match(
      body,
      /^⚠️ Background job 'docs-ingest' has failed 3 consecutive times \(last success: never this run\)\. Check server logs for details\.$/,
    );
  } finally {
    clearInterval(timer!);
  }
});
