import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it. Separate process
// from tests/agentCoreUsageLimit.test.ts so UPSTREAM_LIMIT_ALERT_ENABLED can
// be pinned on here without affecting the default-off pin there (config is
// parsed once at import time).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.UPSTREAM_LIMIT_ALERT_ENABLED = 'true';
process.env.SUPER_ADMIN_DISCORD_IDS = 'super-1';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS = 'super-wa-1,super-wa-2';

type QueryBehavior = { mode: 'throw'; message: string } | { mode: 'success'; text: string };
let behavior: QueryBehavior = { mode: 'success', text: 'ok' };

function mockQuery() {
  return (async function* () {
    if (behavior.mode === 'throw') throw new Error(behavior.message);
    yield {
      type: 'result',
      subtype: 'success',
      result: behavior.text,
      session_id: 'sess-1',
      total_cost_usd: 0,
    };
  })();
}

// See tests/agentCoreUsageLimit.test.ts for why the mock must be installed
// once, before core.js's first dynamic import, and reused thereafter.
let corePromise: Promise<typeof import('../src/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    // Preserve the real createSdkMcpServer/tool (agent/tools.ts needs them to
    // build the MCP tool server) and override only query.
    const real = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...real, query: mockQuery } });
    corePromise = import('../src/agent/core.js');
  }
  return corePromise;
}

function makeAdapter(
  platform: PlatformAdapter['platform'] = 'discord',
  connected = true,
): { adapter: PlatformAdapter; dms: Array<{ userId: string; text: string }> } {
  const dms: Array<{ userId: string; text: string }> = [];
  const adapter: PlatformAdapter = {
    platform,
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => connected,
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

// sendDirectMessage above is synchronous/awaited inline, but core.ts fires it
// fire-and-forget (`.catch()`, no await) — give the microtask queue a turn
// so the DM lands before assertions run.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('runAgentTurn: a usage-limit/overload error DMs super admins once, then stays silent while it persists, and re-arms on recovery (issue #131)', async (t) => {
  const { runAgentTurn } = await core(t);
  const { USAGE_LIMIT_REPLY_ADMIN_NOTIFIED } = await import('../src/agent/upstreamFailure.js');
  const { adapter, dms } = makeAdapter();
  const caller = makeCaller();

  behavior = { mode: 'throw', message: 'overloaded_error: Overloaded' };
  const first = await runAgentTurn(caller, 'hello', adapter);
  await flush();
  assert.equal(
    first.text,
    USAGE_LIMIT_REPLY_ADMIN_NOTIFIED,
    'reply says an admin was notified once the flag is on',
  );
  assert.equal(dms.length, 1, 'exactly one DM on the first failure');
  assert.equal(dms[0].userId, 'super-1');

  const second = await runAgentTurn(caller, 'hello again', adapter);
  await flush();
  assert.equal(second.text, USAGE_LIMIT_REPLY_ADMIN_NOTIFIED);
  assert.equal(dms.length, 1, 'no repeat DM while the condition is still ongoing');

  behavior = { mode: 'success', text: 'back to normal' };
  const recovered = await runAgentTurn(caller, 'ok now', adapter);
  await flush();
  assert.equal(recovered.text, 'back to normal');
  assert.equal(dms.length, 1, 'a successful turn never itself sends a DM');

  behavior = { mode: 'throw', message: 'overloaded_error: Overloaded again' };
  const thirdFailure = await runAgentTurn(caller, 'hello a third time', adapter);
  await flush();
  assert.equal(thirdFailure.text, USAGE_LIMIT_REPLY_ADMIN_NOTIFIED);
  assert.equal(dms.length, 2, 'a new window after recovery DMs again');
});

test('runAgentTurn: a usage-limit failure on a Discord-originated turn also DMs WhatsApp super admins via getAdapter, none excluded, and never resends within the same window (issue #325)', async (t) => {
  const { runAgentTurn } = await core(t);
  const { adapter, dms } = makeAdapter('discord');
  const { adapter: waAdapter, dms: waDms } = makeAdapter('whatsapp');
  const caller = makeCaller();
  const getAdapter = (platform: 'discord' | 'whatsapp') => (platform === 'whatsapp' ? waAdapter : adapter);

  // The usage-limit debounce latch is module-wide (not per-test), so start
  // from a known "recovered" state before asserting a fresh window alerts.
  behavior = { mode: 'success', text: 'reset' };
  await runAgentTurn(caller, 'reset', adapter, getAdapter);
  await flush();
  dms.length = 0;
  waDms.length = 0;

  behavior = { mode: 'throw', message: 'overloaded_error: Overloaded' };
  await runAgentTurn(caller, 'hello', adapter, getAdapter);
  await flush();

  assert.equal(dms.length, 1, 'origin platform still gets exactly one DM');
  assert.equal(dms[0].userId, 'super-1');
  assert.equal(waDms.length, 2, 'the second connected platform gets one DM per its own super admin');
  assert.deepEqual(
    waDms.map((d) => d.userId).sort(),
    ['super-wa-1', 'super-wa-2'],
    'every whatsapp super admin id is reached — no excludeUserId/self-exclusion is applied to this system alert',
  );

  // Same ongoing window: a second failure must not resend on either platform.
  behavior = { mode: 'throw', message: 'overloaded_error: Overloaded still' };
  await runAgentTurn(caller, 'hello again', adapter, getAdapter);
  await flush();
  assert.equal(dms.length, 1, 'debounce still one-per-window on the origin platform');
  assert.equal(waDms.length, 2, 'debounce still one-per-window on the fanned-out platform');
});

test('runAgentTurn: an unregistered or disconnected second platform is silently skipped — no throw, no DM there, member-facing reply unchanged (issue #325)', async (t) => {
  const { runAgentTurn } = await core(t);
  const { USAGE_LIMIT_REPLY_ADMIN_NOTIFIED } = await import('../src/agent/upstreamFailure.js');
  const caller = makeCaller();

  // (a) getAdapter resolves nothing for whatsapp — platform unregistered in this deployment.
  {
    const { adapter, dms } = makeAdapter('discord');
    // Reset the module-wide debounce latch to "recovered" before asserting a
    // fresh window alerts (see the sibling test above for why).
    behavior = { mode: 'success', text: 'reset' };
    await runAgentTurn(caller, 'reset', adapter, () => undefined);
    await flush();
    dms.length = 0;

    behavior = { mode: 'throw', message: 'overloaded_error: Overloaded' };
    const reply = await runAgentTurn(caller, 'hello', adapter, () => undefined);
    await flush();
    assert.equal(
      reply.text,
      USAGE_LIMIT_REPLY_ADMIN_NOTIFIED,
      'reply text unchanged from the single-platform case',
    );
    assert.equal(dms.length, 1, 'origin platform DM still sent');
  }

  // (b) whatsapp is registered but its adapter reports disconnected.
  {
    const { adapter, dms } = makeAdapter('discord');
    const { adapter: waAdapter, dms: waDms } = makeAdapter('whatsapp', false);
    // Reset the module-wide debounce latch — part (a) above left it mid-window.
    behavior = { mode: 'success', text: 'reset' };
    await runAgentTurn(caller, 'reset', adapter, () => waAdapter);
    await flush();
    dms.length = 0;

    behavior = { mode: 'throw', message: 'overloaded_error: Overloaded' };
    const reply = await runAgentTurn(caller, 'hello', adapter, () => waAdapter);
    await flush();
    assert.equal(
      reply.text,
      USAGE_LIMIT_REPLY_ADMIN_NOTIFIED,
      'reply text unchanged from the single-platform case',
    );
    assert.equal(dms.length, 1, 'origin platform DM still sent');
    assert.equal(waDms.length, 0, 'disconnected platform receives zero DMs, no throw');
  }
});

test("SECURITY: the all-platform usage-limit alert only ever reaches ids in that platform's configured superAdminIds(), and only for a connected, resolvable adapter (issue #325)", async (t) => {
  const { runAgentTurn } = await core(t);
  const { superAdminIds } = await import('../src/auth/roles.js');
  const { adapter, dms } = makeAdapter('discord');
  const { adapter: waAdapter, dms: waDms } = makeAdapter('whatsapp');
  const { dms: unregisteredDms } = makeAdapter('discord'); // never returned by getAdapter — must never receive anything
  const caller = makeCaller();
  const getAdapter = (platform: 'discord' | 'whatsapp') => (platform === 'whatsapp' ? waAdapter : undefined);

  // Reset the module-wide debounce latch to "recovered" first (see the
  // sibling fan-out test above for why this is needed).
  behavior = { mode: 'success', text: 'reset' };
  await runAgentTurn(caller, 'reset', adapter, getAdapter);
  await flush();
  dms.length = 0;
  waDms.length = 0;
  unregisteredDms.length = 0;

  behavior = { mode: 'throw', message: 'overloaded_error: Overloaded' };
  await runAgentTurn(caller, 'hello', adapter, getAdapter);
  await flush();

  const discordAllowed = new Set(superAdminIds('discord'));
  const whatsappAllowed = new Set(superAdminIds('whatsapp'));
  for (const dm of dms) assert.ok(discordAllowed.has(dm.userId), `unexpected discord recipient ${dm.userId}`);
  for (const dm of waDms)
    assert.ok(whatsappAllowed.has(dm.userId), `unexpected whatsapp recipient ${dm.userId}`);
  assert.equal(
    unregisteredDms.length,
    0,
    'an adapter instance never returned by getAdapter must receive nothing',
  );
});

// --- Shared pending-alert queue extension (issue #593) ---

test('runAgentTurn: a usage-limit alert with EVERY platform disconnected is queued exactly ONCE (not once per platform), and no send is attempted anywhere (issue #593)', async (t) => {
  const { runAgentTurn } = await core(t);
  const { getPendingAlertsForTests, resetPendingAlertsForTests } =
    await import('../src/pendingAlertQueue.js');
  resetPendingAlertsForTests();
  const { adapter, dms } = makeAdapter('discord', false);
  const { adapter: waAdapter, dms: waDms } = makeAdapter('whatsapp', false);
  const caller = makeCaller();
  const getAdapter = (platform: 'discord' | 'whatsapp') => (platform === 'whatsapp' ? waAdapter : undefined);

  // Reset the module-wide debounce latch to "recovered" first, via a
  // connected adapter so the reset turn itself doesn't queue anything.
  const { adapter: resetAdapter } = makeAdapter('discord', true);
  behavior = { mode: 'success', text: 'reset' };
  await runAgentTurn(caller, 'reset', resetAdapter, () => undefined);
  await flush();
  resetPendingAlertsForTests();

  behavior = { mode: 'throw', message: 'overloaded_error: Overloaded' };
  await runAgentTurn(caller, 'hello', adapter, getAdapter);
  await flush();

  assert.equal(dms.length, 0, 'no send is attempted through the disconnected origin adapter');
  assert.equal(waDms.length, 0, 'no send is attempted through the disconnected fanned-out adapter');
  assert.equal(
    getPendingAlertsForTests().length,
    1,
    'the alert is queued exactly once across the whole outage, not once per platform',
  );
  resetPendingAlertsForTests();
});

test("SECURITY: agent/core.ts's usage-limit alert queues an entry with no `recipients` field — issue #625 only added an opt-in recipient set for notifyAdmins; this producer is unaffected and still flushes to superAdminIds()", async (t) => {
  const { runAgentTurn } = await core(t);
  const { getPendingAlertEntriesForTests, resetPendingAlertsForTests } =
    await import('../src/pendingAlertQueue.js');
  resetPendingAlertsForTests();
  const { adapter } = makeAdapter('discord', false);
  const { adapter: waAdapter } = makeAdapter('whatsapp', false);
  const caller = makeCaller();
  const getAdapter = (platform: 'discord' | 'whatsapp') => (platform === 'whatsapp' ? waAdapter : undefined);

  const { adapter: resetAdapter } = makeAdapter('discord', true);
  behavior = { mode: 'success', text: 'reset' };
  await runAgentTurn(caller, 'reset', resetAdapter, () => undefined);
  await flush();
  resetPendingAlertsForTests();

  behavior = { mode: 'throw', message: 'overloaded_error: Overloaded' };
  await runAgentTurn(caller, 'hello', adapter, getAdapter);
  await flush();

  const entries = getPendingAlertEntriesForTests();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.recipients, undefined);
  resetPendingAlertsForTests();
});

test('runAgentTurn: with at least one connected platform, behaviour stays byte-identical to before #593 — live send, nothing queued', async (t) => {
  const { runAgentTurn } = await core(t);
  const { getPendingAlertsForTests, resetPendingAlertsForTests } =
    await import('../src/pendingAlertQueue.js');
  resetPendingAlertsForTests();
  const { adapter, dms } = makeAdapter('discord', true);
  const caller = makeCaller();

  behavior = { mode: 'success', text: 'reset' };
  await runAgentTurn(caller, 'reset', adapter, () => undefined);
  await flush();
  dms.length = 0;
  resetPendingAlertsForTests();

  behavior = { mode: 'throw', message: 'overloaded_error: Overloaded' };
  await runAgentTurn(caller, 'hello', adapter, () => undefined);
  await flush();

  assert.equal(dms.length, 1, 'the connected origin adapter still receives the alert live, as before');
  assert.deepEqual(
    getPendingAlertsForTests(),
    [],
    'nothing is queued when at least one platform is connected',
  );
  resetPendingAlertsForTests();
});

test('SECURITY: the usage-limit alert queues the message byte-identical to its live-send text, at "system" priority, surviving a low-priority flood (issue #593)', async (t) => {
  const { runAgentTurn } = await core(t);
  const { getPendingAlertsForTests, resetPendingAlertsForTests, queuePendingAlert, PENDING_ALERT_QUEUE_CAP } =
    await import('../src/pendingAlertQueue.js');
  resetPendingAlertsForTests();
  const caller = makeCaller();

  // Capture the live-send text via a connected adapter.
  const { adapter: liveAdapter, dms: liveDms } = makeAdapter('discord', true);
  behavior = { mode: 'success', text: 'reset' };
  await runAgentTurn(caller, 'reset', liveAdapter, () => undefined);
  await flush();
  behavior = { mode: 'throw', message: 'overloaded_error: Overloaded' };
  await runAgentTurn(caller, 'hello', liveAdapter, () => undefined);
  await flush();
  const liveText = liveDms[0]?.text;
  assert.ok(liveText, 'a live send happened to capture the exact text');
  resetPendingAlertsForTests();

  // Same condition with every adapter disconnected must queue byte-identical text.
  const { adapter: downAdapter } = makeAdapter('discord', false);
  behavior = { mode: 'success', text: 'reset' };
  await runAgentTurn(caller, 'reset', downAdapter, () => undefined);
  await flush();
  resetPendingAlertsForTests();
  behavior = { mode: 'throw', message: 'overloaded_error: Overloaded' };
  await runAgentTurn(caller, 'hello', downAdapter, () => undefined);
  await flush();

  assert.deepEqual(getPendingAlertsForTests(), [liveText], 'queued text is byte-identical to the live text');

  // Simulate tools.ts's notifySuperAdmins (member-reachable, 'low' priority)
  // flooding the shared queue past its cap — this system-priority alert must
  // never be evicted (issue #545's fix).
  for (let i = 0; i < PENDING_ALERT_QUEUE_CAP * 2; i++) queuePendingAlert(`low-flood-${i}`, 'low');
  assert.ok(
    getPendingAlertsForTests().includes(liveText),
    'the system-priority usage-limit alert survives a low-priority flood',
  );
  resetPendingAlertsForTests();
});
