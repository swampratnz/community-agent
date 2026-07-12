import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

test('SECURITY: AC-5 — a thrown error inside the WebSearch rate-limit check fails closed (denies), never lets the call through unbounded', async (t) => {
  // Mock BEFORE the first import of core.js — a later t.mock.module call
  // can't retarget an already-imported module (see the same trap noted in
  // tests/agentCoreUsageLimit.test.ts). Preserve every real export except
  // reserveWebSearchSlot, which is replaced with one that always throws, so
  // this exercises buildQueryOptions's own fail-closed try/catch rather than
  // any unverifiable SDK default behaviour on a hook exception.
  const real = await import('../src/agent/tools.js');
  t.mock.module('../src/agent/tools.js', {
    namedExports: {
      ...real,
      reserveWebSearchSlot: () => {
        throw new Error('boom: simulated rate-limit-check failure');
      },
    },
  });

  const { buildQueryOptions } = await import('../src/agent/core.js');
  const opts = buildQueryOptions('admin', 'prompt', {}, null, 'ws-cap-fail-closed') as {
    hooks?: {
      PreToolUse?: Array<{
        matcher?: string;
        hooks: Array<
          (
            input: unknown,
            toolUseID: string | undefined,
            options: { signal: AbortSignal },
          ) => Promise<{
            continue?: boolean;
            hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
          }>
        >;
      }>;
    };
  };
  const matcher = opts.hooks?.PreToolUse?.find((m) => m.matcher === 'WebSearch');
  assert.ok(matcher, 'expected buildQueryOptions to construct a WebSearch PreToolUse matcher');
  const fn = matcher.hooks[0];

  const result = await fn(
    {
      session_id: 'sess-1',
      transcript_path: '/tmp/transcript',
      cwd: '/tmp',
      hook_event_name: 'PreToolUse',
      tool_name: 'WebSearch',
      tool_input: { query: 'test query' },
      tool_use_id: 'tool-1',
    },
    'tool-1',
    { signal: new AbortController().signal },
  );

  assert.equal(result.continue, true, 'the hook itself must never throw/reject out to the SDK');
  assert.equal(
    result.hookSpecificOutput?.permissionDecision,
    'deny',
    'a thrown rate-limit check must fail closed (deny), never allow the call through',
  );
});
