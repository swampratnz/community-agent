import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/tools.test.ts. Image generation must be explicitly
// enabled (and GROK_BIN must be absolute once it is — see src/config.ts)
// for generate_image's handler to reach past its feature-flag gate.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.IMAGE_GEN_ENABLED ??= 'true';
process.env.GROK_BIN ??= '/usr/bin/grok';

const { closeDb } = await import('../src/storage/db.js');

after(async () => {
  await closeDb();
});

/**
 * generate_image's handler calls src/media/grokImage.ts's generateImage(),
 * which spawns a real `grok` CLI subprocess — mock it out so this test
 * exercises only the caption plumbing (issue #174), not image generation
 * itself. node:test module mocking requires a TestContext (`t.mock`) and must
 * be installed before tools.js is first imported in this process, so it's
 * done lazily on first use and the resulting import cached, mirroring the
 * pattern in tests/knowledgeScope.test.ts.
 */
let toolsPromise: Promise<typeof import('../src/agent/tools.js')> | null = null;
function tools(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!toolsPromise) {
    t.mock.module('../src/media/grokImage.js', {
      namedExports: {
        generateImage: async () => ({
          data: Buffer.from('fake-image-bytes'),
          mimeType: 'image/jpeg',
          ext: 'jpg',
        }),
      },
    });
    toolsPromise = import('../src/agent/tools.js');
  }
  return toolsPromise;
}

function stubAdapter(sendImage: NonNullable<PlatformAdapter['sendImage']>): PlatformAdapter {
  return {
    platform: 'discord',
    start: async () => {},
    stop: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    sendMessage: async () => {},
    sendDirectMessage: async () => {},
    sendImage,
    conversationsForUser: async () => [],
    adminCapabilities: new Set(),
    performAdminAction: async () => {
      throw new Error('not implemented in stub');
    },
  };
}

test('generate_image passes the generation prompt through as the image caption — no image is ever posted bare (issue #174)', async (t) => {
  const { buildToolServer } = await tools(t);
  const calls: Array<{ conversationId: string; caption?: string }> = [];
  const adapter = stubAdapter(async (conversationId, _image, caption) => {
    calls.push({ conversationId, caption });
  });
  const caller = {
    platform: 'discord' as const,
    userId: 'admin-1',
    userName: 'Admin',
    role: 'admin' as const,
    conversationId: 'convo-1',
    isDirect: false,
  };
  const server = buildToolServer(caller, adapter);
  const registeredTool = (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (args: { prompt: string }) => Promise<{ content: Array<{ type: string; text: string }> }>;
        }
      >;
    }
  )._registeredTools['generate_image'];

  const result = await registeredTool.handler({ prompt: 'a cat wearing a hat' });

  assert.equal(calls.length, 1, 'adapter.sendImage must be called exactly once');
  assert.equal(calls[0].conversationId, 'convo-1');
  assert.equal(
    calls[0].caption,
    'a cat wearing a hat',
    'the validated prompt must be passed through as the caption',
  );
  assert.match(result.content[0].text, /posted/i);
});
