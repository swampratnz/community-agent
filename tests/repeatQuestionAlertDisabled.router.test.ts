import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// dailyReplyBudgetWarningDisabledRouter.test.ts. REPEAT_QUESTION_ALERT_ENABLED
// is deliberately left UNSET here (default off) — this file pins the
// SECURITY invariant that with the flag off, `respond()` performs zero
// `recentQuestionClusters` calls and zero DMs attributable to this feature,
// even against a run that would otherwise alert (issue #887 acceptance
// criterion 3), complementing repeatQuestionAlert.router.test.ts (the ONLY
// place the flag is 'true').
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';

const { config } = await import('../src/config.js');
const { Router } = await import('../src/router.js');
const { makeRouterDeps } = await import('../src/routerWiring.js');

function makeAdapter(): {
  adapter: PlatformAdapter;
  sent: OutgoingMessage[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage(h) {
      handler = h;
    },
    async sendMessage(out) {
      sent.push(out);
    },
    async sendDirectMessage() {},
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
    async sendTypingIndicator() {},
  };
  return {
    adapter,
    sent,
    trigger: async (msg) => {
      if (!handler) throw new Error('adapter.onMessage was never registered — call router.register() first');
      await handler(msg);
    },
  };
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'discord',
    conversationId: 'chan-1',
    userId: 'super-1',
    userName: 'Test User',
    text: 'what time does the ferry leave',
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

test('config: REPEAT_QUESTION_ALERT_ENABLED is off in this file (sanity check for the test below)', () => {
  assert.equal(config.repeatQuestionAlert.enabled, false);
});

test('SECURITY: REPEAT_QUESTION_ALERT_ENABLED off — respond() performs zero recentQuestionClusters calls and zero DMs, even against a cluster that would otherwise cross the threshold (issue #887 acceptance criterion 3)', async () => {
  const notifyCalls: { message: string; excludeUserId: string }[] = [];
  const clusterCalls: unknown[] = [];
  const router = new Router(
    makeRouterDeps({
      runTurn: async () => ({ text: 'Here is what I found.', ok: true }),
      typingRefireMs: 20,
      notifyAdminsFn: async (
        _adapterFor: (platform: string) => PlatformAdapter | undefined,
        message: string,
        excludeUserId: string,
      ) => {
        notifyCalls.push({ message, excludeUserId });
      },
      recentQuestionClustersFn: async (conversationIds: readonly string[] | null) => {
        clusterCalls.push(conversationIds);
        // Rigged to return a crossing cluster — proves the flag, not an empty
        // result set, is what suppresses the alert.
        return [{ representative: 'would have crossed the threshold', count: 99 }];
      },
    }),
  );
  const { adapter, sent, trigger } = makeAdapter();
  router.register(adapter);

  await trigger(makeMessage());

  assert.equal(sent[0].text, 'Here is what I found.', 'the member-facing reply is byte-identical');
  assert.equal(
    clusterCalls.length,
    0,
    'the flag being off must suppress the recentQuestionClusters call itself',
  );
  assert.equal(notifyCalls.length, 0, 'no DM attributable to this feature');
});
