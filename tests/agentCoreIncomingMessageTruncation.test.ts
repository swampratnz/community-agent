import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';
import type { CallerContext } from '@swampratnz/agent-base/auth/rbac.js';
import type {
  IncomingMessage,
  OutgoingMessage,
  PlatformAdapter,
} from '@swampratnz/agent-base/platforms/types.js';
// Community content registrations (prompt sections + persona roster) — the
// composition-root contract: src/index.ts registers these in production, so
// tests that assemble prompts register them explicitly here.
import './support/registerPromptSections.js';
import './support/registerPersonas.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentCoreRequesterTag.test.ts. A small, fixed cap
// (rather than the real 8,000 default) keeps the fixtures below short and
// the assertions exact.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS ??= 'super-1';
process.env.MAX_INCOMING_MESSAGE_CHARS ??= '20';

// The tool registry's module-scope registrations (tool tiers, tool-server
// parts, feature-flag predicates) — the composition-root contract, matching
// tests/rbac.test.ts.
await import('./support/registerToolRegistry.js');

// Captures the exact params passed to query() so tests can assert on the
// assembled user-turn prompt, mirroring tests/agentCoreRequesterTag.test.ts.
let lastQueryParams: { prompt: string; options: { systemPrompt: string } } | null = null;

function mockQuery(params: { prompt: string; options: { systemPrompt: string } }) {
  lastQueryParams = params;
  return (async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      result: 'ok',
      session_id: 'sess-1',
      total_cost_usd: 0,
    };
  })();
}

// query() is a static import inside src/base/agent/core.ts, so once core.js has
// been dynamically imported anywhere in this process the binding is fixed —
// install the mock once and reuse the cached import (see
// tests/agentCoreMaxTurns.test.ts for the same trap).
let corePromise: Promise<typeof import('@swampratnz/agent-base/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    const real = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...real, query: mockQuery } });
    corePromise = import('@swampratnz/agent-base/agent/core.js');
  }
  return corePromise;
}

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): { adapter: PlatformAdapter } {
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
    ...overrides,
  };
  return { adapter };
}

function makeCaller(overrides: Partial<CallerContext> = {}): CallerContext {
  return {
    platform: 'discord',
    userId: 'member-1',
    userName: 'Member',
    role: 'member',
    conversationId: 'convo-1',
    isDirect: false,
    ...overrides,
  };
}

test('runAgentTurn: a message exactly at MAX_INCOMING_MESSAGE_CHARS reaches the prompt byte-identical, with no marker (acceptance criterion 1)', async (t) => {
  const { runAgentTurn } = await core(t);

  const atCap = 'a'.repeat(20);
  const reply = await runAgentTurn(makeCaller(), atCap, makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(lastQueryParams!.prompt, `[Requester: Member]\n\n${atCap}`);
});

test('runAgentTurn: a message just under MAX_INCOMING_MESSAGE_CHARS is also a no-op (acceptance criterion 1)', async (t) => {
  const { runAgentTurn } = await core(t);

  const underCap = 'a'.repeat(19);
  const reply = await runAgentTurn(makeCaller(), underCap, makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(lastQueryParams!.prompt, `[Requester: Member]\n\n${underCap}`);
});

test('runAgentTurn: a message over MAX_INCOMING_MESSAGE_CHARS is truncated to exactly the cap length, followed by a fixed marker stating the exact omitted count, deterministically across runs (acceptance criterion 2)', async (t) => {
  const { runAgentTurn } = await core(t);

  const original = 'a'.repeat(30); // 10 chars over the 20-char cap

  const reply1 = await runAgentTurn(makeCaller(), original, makeAdapter().adapter);
  const prompt1 = lastQueryParams!.prompt;
  const reply2 = await runAgentTurn(makeCaller(), original, makeAdapter().adapter);
  const prompt2 = lastQueryParams!.prompt;

  assert.equal(reply1.ok, true);
  assert.equal(reply2.ok, true);
  assert.equal(
    prompt1,
    prompt2,
    'the marker must be byte-for-byte identical across two runs on the same input',
  );

  const expected = `[Requester: Member]\n\n${'a'.repeat(20)}\n\n[message truncated: 10 characters omitted]`;
  assert.equal(prompt1, expected);
});

test('truncateIncomingMessage: maxChars <= 0 disables truncation for any length (acceptance criterion 3; see tests/agentCoreIncomingMessageTruncationDisabled.test.ts for the MAX_INCOMING_MESSAGE_CHARS=0 end-to-end path)', async (t) => {
  const { truncateIncomingMessage } = await core(t);

  const huge = 'z'.repeat(50_000);
  assert.equal(truncateIncomingMessage(huge, 0), huge);
});

test('SECURITY: truncateIncomingMessage steps the cut back off a split UTF-16 surrogate pair rather than slicing through one (acceptance criterion 4)', async (t) => {
  const { truncateIncomingMessage } = await core(t);

  // U+1F600 encodes as the surrogate pair 0xD83D 0xDE00. 19 plain chars
  // before it puts the pair at indices 19-20 — exactly where a naive
  // `slice(0, 20)` would split it in half.
  const original = `${'a'.repeat(19)}\u{1F600}${'b'.repeat(20)}`;
  const result = truncateIncomingMessage(original, 20);

  for (const ch of result) {
    const code = ch.codePointAt(0)!;
    assert.ok(code < 0xd800 || code > 0xdfff, `a lone surrogate survived truncation: U+${code.toString(16)}`);
  }
  assert.ok(result.startsWith('a'.repeat(19)), 'the retained prefix stops before the straddling pair');
  assert.ok(!result.includes('\u{1F600}'), 'the straddling emoji is dropped whole, never half-sliced');
});

test("SECURITY: MAX_INCOMING_MESSAGE_CHARS truncation touches only runAgentTurn's local copy — the caller's own message text is never mutated (acceptance criterion 5)", async (t) => {
  const { runAgentTurn } = await core(t);

  const original = 'x'.repeat(30); // over the 20-char cap
  const reply = await runAgentTurn(makeCaller(), original, makeAdapter().adapter);

  assert.equal(reply.ok, true);
  // The model-bound copy was truncated to exactly the cap plus the marker...
  assert.equal(
    lastQueryParams!.prompt,
    `[Requester: Member]\n\n${'x'.repeat(20)}\n\n[message truncated: 10 characters omitted]`,
  );
  // ...but the caller's own string binding is completely unaffected — a
  // string is immutable and passed by value, so nothing inside runAgentTurn
  // can reach back and mutate what router.ts still holds as `msg.text` for
  // archiving, CONFIRM/escalation classification, dedup-normalize and the
  // admin-notify echo.
  assert.equal(original, 'x'.repeat(30), 'the original string binding must be unchanged after the call');
});

test("SECURITY: the router's own IncomingMessage.text is unaffected by MAX_INCOMING_MESSAGE_CHARS — only the model-bound copy inside runAgentTurn shrinks (acceptance criterion 5, end-to-end)", async (t) => {
  const { runAgentTurn } = await core(t);
  const { Router } = await import('@swampratnz/agent-base/router.js');
  const { makeRouterDeps } = await import('../src/module/routerWiring.js');

  const router = new Router(makeRouterDeps({ runTurn: runAgentTurn }));
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const { adapter } = makeAdapter({
    onMessage(h) {
      handler = h;
    },
  });
  router.register(adapter);

  const original = 'x'.repeat(30); // over the 20-char cap
  const msg: IncomingMessage = {
    platform: 'discord',
    conversationId: 'convo-decouple',
    userId: 'super-1',
    userName: 'Test User',
    text: original,
    isDirect: false,
    addressedToBot: true,
    timestamp: Date.now(),
  };

  await handler!(msg);

  assert.ok(lastQueryParams, 'runAgentTurn must have been invoked for an addressed super-admin message');
  // Check the trailing, userText-derived segment specifically (assemblePrompt
  // always joins userText last) rather than searching the whole prompt for
  // the original substring: the router's own fire-and-forget recordInteraction
  // call embeds the FULL original text for recall, so a same-turn memory hit
  // can legitimately reintroduce it elsewhere in the prompt — that would be a
  // false failure unrelated to whether the userText copy itself was truncated.
  assert.ok(
    lastQueryParams.prompt.endsWith(`${'x'.repeat(20)}\n\n[message truncated: 10 characters omitted]`),
    'the model-bound copy must have been truncated to exactly the cap plus the marker',
  );
  assert.equal(
    msg.text,
    original,
    'the router-held IncomingMessage.text must remain the full, untruncated original',
  );
});
