import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment before
// importing router.ts, matching tests/router.test.ts's convention.
// ACCESS_MODE_WHATSAPP=open (default is 'gated') is required so a message
// from an unresolvable-role sender (resolveRole throws against the
// unreachable DATABASE_URL below, falling back to 'guest') still reaches the
// daily-reply-budget check instead of being diverted into the gated-guest
// flow, which never touches alertSuperAdminsBudgetCheckFailed at all.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.ACCESS_MODE_WHATSAPP = 'open';
process.env.SUPER_ADMIN_WHATSAPP_NUMBERS = 'super-1,super-2';

const { Router } = await import('../src/router.js');
const { WindowClosedError } = await import('../src/platforms/whatsapp/cloudAdapter.js');

/**
 * A fake Cloud-like adapter (same shape as
 * notifyAdminsWindowReopenQueue.test.ts's makeFakeCloudAdapter), doubling as
 * both the adapter the triggering message arrives on and the target of
 * `alertSuperAdminsBudgetCheckFailed`'s per-super-admin DM loop —
 * `alertSuperAdminsBudgetCheckFailed` iterates every connected adapter in
 * `this.adapters`, not just the triggering message's platform, so a single
 * registered adapter is enough to observe both.
 */
function makeCloudAdapter(rejections: Record<string, unknown>): {
  adapter: PlatformAdapter;
  dms: Array<{ userId: string; text: string }>;
  queued: Array<{ userId: string; message: string; priority: 'system' | 'low' }>;
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  const dms: Array<{ userId: string; text: string }> = [];
  const queued: Array<{ userId: string; message: string; priority: 'system' | 'low' }> = [];
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const adapter: PlatformAdapter = {
    platform: 'whatsapp',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage(h) {
      handler = h;
    },
    async sendMessage() {
      return undefined;
    },
    async sendDirectMessage(userId: string, text: string) {
      if (userId in rejections) throw rejections[userId];
      dms.push({ userId, text });
    },
    queueForWindowReopen(userId: string, message: string, priority: 'system' | 'low') {
      queued.push({ userId, message, priority });
    },
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return {
    adapter,
    dms,
    queued,
    trigger: async (msg) => {
      if (!handler) throw new Error('adapter.onMessage was never registered — call router.register() first');
      await handler(msg);
    },
  };
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'whatsapp',
    conversationId: 'chan-1',
    userId: 'member-1',
    userName: 'Member One',
    text: 'hello bot',
    isDirect: true,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

/** alertSuperAdminsBudgetCheckFailed is fire-and-forget (`void this.alertSuperAdminsBudgetCheckFailed()`, no await inside handle()), and its own per-recipient sendDirectMessage().catch() calls are themselves not awaited — same shape as usageCostDigest.ts's alertSuperAdmins. Give the microtask queue a turn before asserting, same technique as tests/usageCostDigest.test.ts. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test(
  'SECURITY: alertSuperAdminsBudgetCheckFailed — a WindowClosedError rejection queues via queueForWindowReopen at ' +
    "'system' priority instead of only logging, matching this function's existing all-disconnected " +
    "queuePendingAlert(message, 'system') branch (issue #922 acceptance criterion 2)",
  async () => {
    const { adapter, dms, queued, trigger } = makeCloudAdapter({
      'super-2': new WindowClosedError('super-2'),
    });
    const router = new Router(
      async () => ({ text: 'ok' }), // runTurn
      20, // typingRefireMs
      undefined, // checkPaused
      undefined, // searchKnowledgeForShortcut
      undefined, // recordShortcutRetrieval
      async () => {
        throw new Error('daily reply budget check: DB unreachable');
      }, // countReplies — forces the budget-check-failed path
    );
    router.register(adapter);

    await trigger(makeMessage());
    await flush();

    assert.deepEqual(
      dms.map((d) => d.userId),
      ['super-1'],
      'the open-window super admin is still delivered live',
    );
    assert.equal(queued.length, 1, 'exactly one recipient was queued');
    assert.equal(queued[0]?.userId, 'super-2');
    assert.equal(queued[0]?.priority, 'system');
    assert.match(queued[0]?.message ?? '', /Daily reply-budget check failed/);
  },
);

test(
  'SECURITY: alertSuperAdminsBudgetCheckFailed — a rejection that is NOT a WindowClosedError (e.g. a generic Graph ' +
    'API error) is never queued via queueForWindowReopen; it stays logged-and-dropped exactly as today (issue #922 ' +
    'non-regression criterion)',
  async () => {
    const { adapter, dms, queued, trigger } = makeCloudAdapter({
      'super-2': new Error('502 from Graph API'),
    });
    const router = new Router(
      async () => ({ text: 'ok' }),
      20,
      undefined,
      undefined,
      undefined,
      async () => {
        throw new Error('daily reply budget check: DB unreachable');
      },
    );
    router.register(adapter);

    await trigger(makeMessage());
    await flush();

    assert.deepEqual(
      dms.map((d) => d.userId),
      ['super-1'],
    );
    assert.deepEqual(
      queued,
      [],
      'a non-WindowClosedError rejection must never populate the per-recipient window-reopen queue',
    );
  },
);
