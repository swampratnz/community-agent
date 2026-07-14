import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentCoreLanguagePreference.test.ts.
// UPSTREAM_LIMIT_ALERT_ENABLED is left unset here (default false) so this
// file pins the default USAGE_LIMIT_REPLY_MI (not the admin-notified
// variant); tests/agentCoreFailureFallbacksMiAlertEnabled.test.ts covers the
// flag-on path in its own process (config is parsed once at import time).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

type LangBehavior = { mode: 'value'; value: 'auto' | 'en' | 'mi' | undefined } | { mode: 'throw' };
let langBehavior: LangBehavior = { mode: 'value', value: 'auto' };

type QueryBehavior =
  | { mode: 'throw'; message: string }
  | { mode: 'nonSuccess'; subtype: string }
  | { mode: 'success'; text: string };
let behavior: QueryBehavior = { mode: 'success', text: 'ok' };

function mockQuery() {
  return (async function* () {
    if (behavior.mode === 'throw') throw new Error(behavior.message);
    if (behavior.mode === 'nonSuccess') {
      yield {
        type: 'result',
        subtype: behavior.subtype,
        result: '',
        session_id: 'sess-1',
        total_cost_usd: 0.01,
      };
      return;
    }
    yield {
      type: 'result',
      subtype: 'success',
      result: behavior.text,
      session_id: 'sess-1',
      total_cost_usd: 0,
    };
  })();
}

// Both query() and getLanguagePreference() are static imports inside
// src/agent/core.ts, so once core.js has been dynamically imported anywhere
// in this process the bindings are fixed — a later t.mock.module call can't
// retarget them (see tests/agentCoreLanguagePreference.test.ts for the same
// trap). Install both mocks once and reuse the cached import; `behavior` and
// `langBehavior` are mutated per-test to vary the underlying outcomes.
let corePromise: Promise<typeof import('../src/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    const realSdk = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...realSdk, query: mockQuery } });
    const realRepo = await import('../src/storage/repository.js');
    t.mock.module('../src/storage/repository.js', {
      namedExports: {
        ...realRepo,
        getLanguagePreference: async () => {
          if (langBehavior.mode === 'throw') throw new Error('language-preference lookup exploded');
          return langBehavior.value;
        },
      },
    });
    corePromise = import('../src/agent/core.js');
  }
  return corePromise;
}

function makeAdapter(): { adapter: PlatformAdapter } {
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage() {},
    async sendMessage(_out: OutgoingMessage) {},
    async sendDirectMessage() {},
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return { adapter };
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

test("runAgentTurn: a thrown error for a caller with a stored 'mi' preference returns INTERNAL_ERROR_REPLY_MI (issue #396)", async (t) => {
  const { runAgentTurn, INTERNAL_ERROR_REPLY_MI } = await core(t);
  langBehavior = { mode: 'value', value: 'mi' };
  behavior = { mode: 'throw', message: 'ECONNRESET' };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.text, INTERNAL_ERROR_REPLY_MI);
  assert.equal(reply.ok, false);
});

test("runAgentTurn: resultSubtype === 'error_max_turns' for a 'mi' caller returns MAX_TURNS_REPLY_MI (issue #396)", async (t) => {
  const { runAgentTurn, MAX_TURNS_REPLY_MI } = await core(t);
  langBehavior = { mode: 'value', value: 'mi' };
  behavior = { mode: 'nonSuccess', subtype: 'error_max_turns' };

  const reply = await runAgentTurn(makeCaller(), 'a very long ask', makeAdapter().adapter);

  assert.equal(reply.text, MAX_TURNS_REPLY_MI);
  assert.equal(reply.ok, false);
  assert.equal(reply.maxTurnsExceeded, true);
});

test("runAgentTurn: any other non-success subtype for a 'mi' caller returns TURN_FAILED_REPLY_MI (issue #396)", async (t) => {
  const { runAgentTurn, TURN_FAILED_REPLY_MI } = await core(t);
  langBehavior = { mode: 'value', value: 'mi' };
  behavior = { mode: 'nonSuccess', subtype: 'error_during_execution' };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.text, TURN_FAILED_REPLY_MI);
  assert.equal(reply.ok, false);
});

test("runAgentTurn: a usage-limit-classified failure for a 'mi' caller returns USAGE_LIMIT_REPLY_MI when the admin-alert flag is off (default, issue #396)", async (t) => {
  const { runAgentTurn } = await core(t);
  const { USAGE_LIMIT_REPLY_MI, USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_MI } =
    await import('../src/agent/upstreamFailure.js');
  langBehavior = { mode: 'value', value: 'mi' };
  behavior = { mode: 'throw', message: 'rate_limit_error: Number of request tokens has exceeded your limit' };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.text, USAGE_LIMIT_REPLY_MI);
  assert.notEqual(reply.text, USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_MI);
  assert.equal(reply.ok, false);
});

for (const value of ['auto', 'en', undefined] as const) {
  test(`runAgentTurn: all four failure fallbacks stay byte-identical English text for languagePreference=${String(value)} (regression, issue #396)`, async (t) => {
    const { runAgentTurn, INTERNAL_ERROR_REPLY, MAX_TURNS_REPLY, TURN_FAILED_REPLY } = await core(t);
    const { USAGE_LIMIT_REPLY } = await import('../src/agent/upstreamFailure.js');
    langBehavior = { mode: 'value', value };

    behavior = { mode: 'throw', message: 'ECONNRESET' };
    assert.equal(
      (await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter)).text,
      INTERNAL_ERROR_REPLY,
    );

    behavior = { mode: 'nonSuccess', subtype: 'error_max_turns' };
    assert.equal(
      (await runAgentTurn(makeCaller(), 'a very long ask', makeAdapter().adapter)).text,
      MAX_TURNS_REPLY,
    );

    behavior = { mode: 'nonSuccess', subtype: 'error_during_execution' };
    assert.equal((await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter)).text, TURN_FAILED_REPLY);

    behavior = { mode: 'throw', message: 'rate_limit_error: exceeded your limit' };
    assert.equal((await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter)).text, USAGE_LIMIT_REPLY);
  });
}

test('SECURITY: the mi substitution never fires when outcome.ok === true, even when the genuine answer text literally equals a fixed fallback constant (issue #396)', async (t) => {
  const { runAgentTurn, INTERNAL_ERROR_REPLY_MI, INTERNAL_ERROR_REPLY } = await core(t);
  langBehavior = { mode: 'value', value: 'mi' };
  // Contrive a successful turn whose real answer text happens to equal the
  // English fallback constant — must be returned unchanged, never rewritten
  // to the _MI variant, since the substitution is gated on outcome.ok, not
  // on matching the text (the #259 discipline).
  behavior = { mode: 'success', text: INTERNAL_ERROR_REPLY };

  const reply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(
    reply.text,
    INTERNAL_ERROR_REPLY,
    'a genuine answer must never be rewritten to its _MI variant',
  );
  assert.notEqual(reply.text, INTERNAL_ERROR_REPLY_MI);
});

test('SECURITY: when getLanguagePreference rejects during a turn, all four failure fallbacks still return their English default rather than throwing (issue #396, fail-open per #52)', async (t) => {
  const { runAgentTurn, INTERNAL_ERROR_REPLY, MAX_TURNS_REPLY, TURN_FAILED_REPLY } = await core(t);
  const { USAGE_LIMIT_REPLY } = await import('../src/agent/upstreamFailure.js');
  langBehavior = { mode: 'throw' };

  behavior = { mode: 'throw', message: 'ECONNRESET' };
  const internalErrorReply = await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter);
  assert.equal(internalErrorReply.text, INTERNAL_ERROR_REPLY);
  assert.equal(internalErrorReply.languagePreference, undefined);

  behavior = { mode: 'nonSuccess', subtype: 'error_max_turns' };
  assert.equal(
    (await runAgentTurn(makeCaller(), 'a very long ask', makeAdapter().adapter)).text,
    MAX_TURNS_REPLY,
  );

  behavior = { mode: 'nonSuccess', subtype: 'error_during_execution' };
  assert.equal((await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter)).text, TURN_FAILED_REPLY);

  behavior = { mode: 'throw', message: 'rate_limit_error: exceeded your limit' };
  assert.equal((await runAgentTurn(makeCaller(), 'hello', makeAdapter().adapter)).text, USAGE_LIMIT_REPLY);
});
