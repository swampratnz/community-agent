import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallerContext } from '../src/auth/rbac.js';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';
// Community content registrations (prompt sections + persona roster) — the
// composition-root contract: src/index.ts registers these in production, so
// tests that assemble prompts register them explicitly here.
import '../src/agent/communityPromptSections.js';
import '../src/agent/personas.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching
// tests/agentCoreRequesterTag.test.ts's convention.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

// Captures the exact params passed to query() so tests can assert on the
// prompt shape (issue #783): a plain string when no image is attached
// (byte-identical to every pre-existing turn), or the single-message
// AsyncIterable<SDKUserMessage> form when one is.
let lastQueryParams: { prompt: unknown; options: { systemPrompt: string } } | null = null;

function mockQuery(params: { prompt: unknown; options: { systemPrompt: string } }) {
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

// query() is a static import inside src/agent/core.ts, so once core.js has
// been dynamically imported anywhere in this process the binding is fixed —
// install the mock once and reuse the cached import (see
// tests/agentCoreRequesterTag.test.ts for the identical trap/fix).
let corePromise: Promise<typeof import('../src/agent/core.js')> | null = null;
async function core(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!corePromise) {
    const real = await import('@anthropic-ai/claude-agent-sdk');
    t.mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { ...real, query: mockQuery } });
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

function makeCaller(overrides: Partial<CallerContext> = {}): CallerContext {
  return {
    platform: 'discord',
    userId: 'super-1',
    // Empty on purpose: renderRequesterTag (issue #508) prepends a
    // `[Requester: ...]` line to the prompt for any non-empty display name,
    // which is orthogonal to what these tests assert (the text/image content
    // shape reaching query()) — an empty name keeps the prompt exactly the
    // assembled userText, matching tests/agentCoreRequesterTag.test.ts's own
    // "no usable display name" case.
    userName: '',
    role: 'super_admin',
    conversationId: 'convo-1',
    isDirect: false,
    ...overrides,
  };
}

async function collectSingleUserMessage(prompt: unknown): Promise<{
  type: string;
  message: { role: string; content: Array<Record<string, unknown>> };
}> {
  assert.ok(
    prompt && typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function',
    'an image-bearing turn must pass an AsyncIterable, not a plain string',
  );
  const messages: unknown[] = [];
  for await (const m of prompt as AsyncIterable<unknown>) messages.push(m);
  assert.equal(
    messages.length,
    1,
    'exactly one SDKUserMessage must be yielded — a single turn, not a stream',
  );
  return messages[0] as { type: string; message: { role: string; content: Array<Record<string, unknown>> } };
}

test('runAgentTurn: with no image, the prompt passed to query() stays a plain string, byte-identical to every pre-existing turn (issue #783, acceptance criterion 1)', async (t) => {
  const { runAgentTurn } = await core(t);

  const reply = await runAgentTurn(makeCaller(), 'hello there', makeAdapter().adapter);

  assert.equal(reply.ok, true);
  assert.equal(typeof lastQueryParams!.prompt, 'string');
  assert.equal(lastQueryParams!.prompt, 'hello there');
});

test('runAgentTurn: with an image attached, query() receives a single-message AsyncIterable<SDKUserMessage> whose content is [text, image] (issue #783, acceptance criterion 2)', async (t) => {
  const { runAgentTurn } = await core(t);

  const image = { data: 'ZmFrZS1wbmctYnl0ZXM=', mimeType: 'image/png' as const };
  const reply = await runAgentTurn(
    makeCaller(),
    "what's this error?",
    makeAdapter().adapter,
    undefined,
    image,
  );

  assert.equal(reply.ok, true);
  const sdkMessage = await collectSingleUserMessage(lastQueryParams!.prompt);
  assert.equal(sdkMessage.type, 'user');
  assert.equal(sdkMessage.message.role, 'user');
  const [textBlock, imageBlock] = sdkMessage.message.content;
  assert.equal(textBlock.type, 'text');
  assert.equal(textBlock.text, "what's this error?");
  assert.equal(imageBlock.type, 'image');
  assert.deepEqual(imageBlock.source, {
    type: 'base64',
    media_type: 'image/png',
    data: 'ZmFrZS1wbmctYnl0ZXM=',
  });
});

test('SECURITY: the image content block carries the caller-supplied bytes/MIME type unmodified — no transcoding or truncation on the way to query() (issue #783)', async (t) => {
  const { runAgentTurn } = await core(t);

  const image = { data: 'd2VicC1ieXRlcy1oZXJl', mimeType: 'image/webp' as const };
  await runAgentTurn(makeCaller(), 'caption text', makeAdapter().adapter, undefined, image);

  const sdkMessage = await collectSingleUserMessage(lastQueryParams!.prompt);
  const imageBlock = sdkMessage.message.content[1] as { source: { media_type: string; data: string } };
  assert.equal(imageBlock.source.media_type, 'image/webp');
  assert.equal(imageBlock.source.data, 'd2VicC1ieXRlcy1oZXJl');
});
