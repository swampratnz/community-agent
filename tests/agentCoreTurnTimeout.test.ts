import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/strings/notices.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';
import type { StoredSession } from '../src/storage/repository.js';
// Community content registrations (prompt sections + persona roster) — the
// composition-root contract: src/index.ts registers these in production, so
// tests that assemble prompts register them explicitly here.
import '../src/agent/communityPromptSections.js';
import '../src/agent/personas.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentCoreUsageLimit.test.ts. AGENT_TURN_TIMEOUT_MS is
// pinned short here (own process, per that file's convention) so the
// hang-simulation tests below run fast instead of waiting on the real
// 300_000ms default.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.AGENT_TURN_TIMEOUT_MS = '50';
// config.ts enforces AGENT_TURN_TIMEOUT_MS > IMAGE_GEN_TIMEOUT_MS at startup
// (issue #826 review), so the shortened ceiling above needs a correspondingly
// shorter inner tool timeout or this whole file fails to load. Keeping the
// real ordering rather than exempting the test is the point: the invariant
// holds everywhere, including here.
process.env.IMAGE_GEN_TIMEOUT_MS = '10';

// The tool registry's module-scope registrations (tool tiers, tool-server
// parts, feature-flag predicates) — the composition-root contract, matching
// tests/rbac.test.ts.
await import('../src/agent/tools/index.js');

type QueryBehavior =
  | { mode: 'hang' }
  | { mode: 'success'; text: string }
  // A wedge that CLEARS after the outer timeout has already fired — the
  // orphaned-generator case (issue #826 review). `release` is resolved by the
  // test once it holds the timed-out reply.
  | { mode: 'unwedges'; release: Promise<void>; onResume: () => void }
  // A thrown-before-timeout failure (issue #860): used only to pin that the
  // new per-turn AbortController is never aborted on this path, matching
  // tests/agentCoreUsageLimit.test.ts's existing 'throw' mode.
  | { mode: 'throw'; message: string };
let behavior: QueryBehavior = { mode: 'success', text: 'ok' };
let storedSession: StoredSession | null = null;

const capturedCalls: Array<{ prompt: string; options: { resume?: string } }> = [];

function mockQuery(params: { prompt: string; options: { resume?: string } }) {
  capturedCalls.push(params);
  return (async function* () {
    // Simulates a genuinely wedged query() iteration (issue #826): the
    // generator's first `next()` never resolves and never rejects, so only
    // the Promise.race timeout in execTurn can unblock the caller.
    if (behavior.mode === 'hang') await new Promise(() => {});
    if (behavior.mode === 'unwedges') {
      await behavior.release;
      behavior.onResume();
    }
    if (behavior.mode === 'throw') throw new Error(behavior.message);
    yield {
      type: 'result',
      subtype: 'success',
      result: behavior.mode === 'success' ? behavior.text : '',
      session_id: 'sess-1',
      total_cost_usd: 0,
    };
  })();
}

// query() and the repository functions are static imports inside
// src/agent/core.ts, so once core.js has been dynamically imported anywhere
// in this process the bindings are fixed — a later t.mock.module call can't
// retarget them (see tests/agentCoreSessionTail.test.ts for the same trap).
// Install the mocks once and reuse the cached import; `behavior`/`storedSession`
// are mutated per-test instead.
let corePromise: Promise<typeof import('../src/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    const realSdk = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...realSdk, query: mockQuery } });
    const realRepo = await import('../src/storage/repository.js');
    t.mock.module('../src/storage/repository.js', {
      namedExports: {
        ...realRepo,
        getClaudeSession: async () => storedSession,
        recentConversationTail: async () => [],
        searchMemory: async () => [],
      },
    });
    corePromise = import('../src/agent/core.js');
  }
  return corePromise;
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

function makeCaller(): CallerContext {
  return {
    platform: 'discord',
    userId: 'member-1',
    userName: 'Member',
    role: 'member',
    conversationId: 'convo-1',
    isDirect: false,
  };
}

function reset() {
  behavior = { mode: 'success', text: 'ok' };
  storedSession = null;
  capturedCalls.length = 0;
}

test('runAgentTurn: a query() call that never yields and never settles resolves within the configured timeout, not hangs (issue #826)', async (t) => {
  const { runAgentTurn, INTERNAL_ERROR_REPLY } = await core(t);
  reset();
  const { adapter } = makeAdapter();

  behavior = { mode: 'hang' };
  const reply = await runAgentTurn(makeCaller(), 'hello', adapter);

  assert.equal(reply.ok, false);
  assert.equal(reply.text, INTERNAL_ERROR_REPLY);
});

test('runAgentTurn: a wedged turn that CLEARS after the timeout cannot change the reply the member already received — the orphaned generator settles into nothing (issue #826 review)', async (t) => {
  // Documented residual: the timeout bounds the CALLER's wait, it does not
  // kill the underlying CLI subprocess (AbortController wiring is the named
  // growth path, deliberately out of scope for #826). So after the ceiling
  // fires, the abandoned `for await` loop is still alive and may later
  // resume. This pins the part that matters to a member: the reply they got
  // is final, and the late result is discarded rather than racing a second
  // reply into the conversation.
  const { runAgentTurn, INTERNAL_ERROR_REPLY } = await core(t);
  reset();
  const { adapter } = makeAdapter();

  let releaseWedge!: () => void;
  let resumed = false;
  const release = new Promise<void>((resolve) => {
    releaseWedge = resolve;
  });
  behavior = { mode: 'unwedges', release, onResume: () => (resumed = true) };

  const reply = await runAgentTurn(makeCaller(), 'hello', adapter);
  assert.equal(reply.ok, false);
  assert.equal(reply.text, INTERNAL_ERROR_REPLY, 'the member sees the generic internal-error reply');
  assert.equal(resumed, false, 'the generator is still wedged at the moment the caller gave up');

  // The wedge clears only now — strictly after the caller already returned.
  releaseWedge();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(
    reply.text,
    INTERNAL_ERROR_REPLY,
    'the already-returned reply is immutable — a late completion can never retroactively change what the member was told',
  );
  assert.equal(capturedCalls.length, 1, 'the late completion never triggers a second query() call');
});

test('runAgentTurn: resumeFailed is false on a turn timeout even when a resumable session was in play, and no retry is attempted (issue #826)', async (t) => {
  const { runAgentTurn } = await core(t);
  reset();
  const { adapter } = makeAdapter();

  storedSession = { sessionId: 'sess-live', turnCount: 1, updatedAt: new Date() };
  behavior = { mode: 'hang' };
  await runAgentTurn(makeCaller(), 'hello', adapter);

  // resumeFailed itself is internal to execTurn's TurnOutcome, never exposed
  // on the public AgentReply — its only observable effect is runAgentTurn's
  // fresh-session retry (core.ts: `if (!first.ok && first.resumeFailed && priorSession)`).
  // A timeout hard-codes resumeFailed to false, so that branch must never
  // fire here: exactly one query() call, still carrying the original resume
  // id, and no second attempt.
  assert.equal(
    capturedCalls.length,
    1,
    'a timeout must hard-code resumeFailed=false and so must not trigger the fresh-session retry a genuine resume failure would',
  );
  assert.equal(capturedCalls[0].options.resume, 'sess-live');
});

test(
  'SECURITY: the internal turn-timeout marker never appears anywhere in reply.text on a hang (issue #826) — ' +
    'only the existing, unmodified INTERNAL_ERROR_REPLY constant is ever returned',
  async (t) => {
    const { runAgentTurn, INTERNAL_ERROR_REPLY } = await core(t);
    reset();
    const { adapter } = makeAdapter();

    behavior = { mode: 'hang' };
    const reply = await runAgentTurn(makeCaller(), 'hello', adapter);

    assert.equal(reply.text, INTERNAL_ERROR_REPLY);
    assert.ok(!/timeout/i.test(reply.text), 'reply.text must not leak any internal timeout marker text');
  },
);

test(
  'SECURITY: a turn timeout is never classified as an upstream usage-limit/overload failure (issue #826) — ' +
    'no usage-limit reply text and no admin-notification DM',
  async (t) => {
    const { runAgentTurn } = await core(t);
    const { USAGE_LIMIT_REPLY, USAGE_LIMIT_REPLY_ADMIN_NOTIFIED } =
      await import('../src/agent/upstreamFailure.js');
    reset();
    const { adapter, dms } = makeAdapter();

    behavior = { mode: 'hang' };
    const reply = await runAgentTurn(makeCaller(), 'hello', adapter);

    assert.notEqual(reply.text, USAGE_LIMIT_REPLY);
    assert.notEqual(reply.text, USAGE_LIMIT_REPLY_ADMIN_NOTIFIED);
    assert.equal(dms.length, 0, 'a turn timeout must never trigger the usage-limit admin-alert DM path');
  },
);

test('runAgentTurn: a successful turn well within the timeout is entirely unaffected (issue #826, no regression)', async (t) => {
  const { runAgentTurn } = await core(t);
  reset();
  const { adapter } = makeAdapter();

  behavior = { mode: 'success', text: 'all good' };
  const reply = await runAgentTurn(makeCaller(), 'hello', adapter);

  assert.equal(reply.text, 'all good');
  assert.equal(reply.ok, true);
});

test('runAgentTurn: the per-turn timer is cleared once a normal turn settles — no leaked timer outlives the call (issue #826)', async (t) => {
  const { runAgentTurn } = await core(t);
  reset();
  const { adapter } = makeAdapter();

  const clearSpy = t.mock.method(globalThis, 'clearTimeout');
  behavior = { mode: 'success', text: 'ok' };
  await runAgentTurn(makeCaller(), 'hello', adapter);

  assert.ok(
    clearSpy.mock.calls.length >= 1,
    'clearTimeout must be called in the finally block on a normal (non-timeout) settle',
  );
});

test(
  "SECURITY: the turn's AbortController.abort() fires exactly once on a genuine timeout, and never on a " +
    'successful or thrown-error turn (issue #860)',
  async (t) => {
    const { runAgentTurn } = await core(t);
    const abortSpy = t.mock.method(AbortController.prototype, 'abort');

    reset();
    const { adapter } = makeAdapter();
    behavior = { mode: 'hang' };
    await runAgentTurn(makeCaller(), 'hello', adapter);
    assert.equal(
      abortSpy.mock.calls.length,
      1,
      'abort() must fire exactly once when the timeout branch runs',
    );

    abortSpy.mock.resetCalls();
    reset();
    behavior = { mode: 'success', text: 'ok' };
    await runAgentTurn(makeCaller(), 'hello', adapter);
    assert.equal(
      abortSpy.mock.calls.length,
      0,
      'abort() must never fire on a turn that completes within the timeout',
    );

    abortSpy.mock.resetCalls();
    reset();
    behavior = { mode: 'throw', message: 'boom' };
    await runAgentTurn(makeCaller(), 'hello', adapter);
    assert.equal(
      abortSpy.mock.calls.length,
      0,
      'abort() must never fire on a turn that throws before the timeout fires',
    );
  },
);

test(
  'SECURITY: the installed SDK still documents `abortController?: AbortController` on `Options` — the field ' +
    "this turn's timeout-abort wiring (issue #860) depends on",
  () => {
    const sdkDtsPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts',
    );
    const dts = readFileSync(sdkDtsPath, 'utf8');
    assert.match(
      dts,
      /abortController\?:\s*AbortController;/,
      "the SDK's Options type must still expose `abortController?: AbortController` — if this field's name or " +
        "shape changed, re-verify src/agent/core.ts's execTurn abort wiring against the new contract before " +
        'merging an SDK bump, or the abort call silently becomes a no-op',
    );
  },
);
