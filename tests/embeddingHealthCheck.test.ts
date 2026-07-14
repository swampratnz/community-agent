import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';

// backgroundJobs.js statically imports storage/embeddings.js, so — same trap
// documented in tests/knowledgeScope.test.ts's `repo()` helper — the mock
// below must be installed via the FIRST test's TestContext, before the
// FIRST (and only) dynamic import of backgroundJobs.js in this process; a
// later t.mock.module call cannot retarget the binding backgroundJobs.js
// already closed over. Every test in this file reuses that one import, and
// controls the mocked embed()'s behaviour through the two `let`s below
// rather than re-mocking.
let embedShouldFail = false;
let lastProbe: string | null = null;

let bgJobsPromise: Promise<typeof import('../src/backgroundJobs.js')> | null = null;
function bgJobs(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!bgJobsPromise) {
    t.mock.module('../src/storage/embeddings.js', {
      namedExports: {
        embed: async (text: string) => {
          lastProbe = text;
          if (embedShouldFail) throw new Error('sentinel-real-embed-error-should-never-leak-9f3a');
          return new Array(384).fill(0);
        },
      },
    });
    bgJobsPromise = import('../src/backgroundJobs.js');
  }
  return bgJobsPromise;
}

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

// run()'s alert path is fire-and-forget, so give the microtask queue a turn
// after each tick before asserting — same technique as
// tests/backgroundJobs.test.ts.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const SIX_HOURS_MS = 6 * 3_600_000;

test('SECURITY: defaultEmbeddingHealthCheckRun probes a fixed, non-content constant — never member-supplied text (issue #376)', async (t) => {
  const { defaultEmbeddingHealthCheckRun } = await bgJobs(t);
  embedShouldFail = false;
  lastProbe = null;

  await defaultEmbeddingHealthCheckRun();

  assert.equal(
    lastProbe,
    'embedding-model-health-check-probe',
    'the probe is a fixed compile-time constant, not derived from any request or member input',
  );
});

test('SECURITY: startEmbeddingHealthCheckJob alerts exactly once on 3 consecutive REAL embed() failures, and the alert body never contains the underlying error text (issue #376)', async (t) => {
  const { startEmbeddingHealthCheckJob, defaultEmbeddingHealthCheckRun } = await bgJobs(t);
  const { adapter, dms } = makeAdapter();
  embedShouldFail = true;

  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startEmbeddingHealthCheckJob([adapter], defaultEmbeddingHealthCheckRun);
  try {
    await flush(); // 1st scheduled run (fires immediately) fails for real
    assert.equal(dms.length, 0, 'no DM after the 1st consecutive failure');
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // 2nd
    assert.equal(dms.length, 0, 'no DM after the 2nd consecutive failure');
    t.mock.timers.tick(SIX_HOURS_MS);
    await flush(); // 3rd — threshold reached
    assert.equal(dms.length, 1, 'exactly one DM on the 3rd consecutive failure');
    const body = dms[0].text;
    assert.ok(
      !body.includes('sentinel-real-embed-error-should-never-leak-9f3a'),
      'the DM body must never contain the underlying embed() error',
    );
    assert.match(
      body,
      /^⚠️ Background job 'embedding-model' has failed 3 consecutive times \(last success: never this run\)\. Check server logs for details\.$/,
    );
  } finally {
    clearInterval(timer!);
    embedShouldFail = false;
  }
});
