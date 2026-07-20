import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

test('SECURITY: AC-5 — the WebSearch dedup check never logs the raw query text, at any level, denial or not', async (t) => {
  // Mock BEFORE the first import of core.js — see the same trap noted in
  // tests/agentWebSearchRateLimitFailClosed.test.ts / this issue's
  // agentWebSearchDedupFailClosed.test.ts. The dedup cache (tools.ts,
  // `webSearchQueryHistoryByConversation`) is in-memory only and never
  // handed a DB pool, so it structurally can't persist to `interactions`/
  // `admin_audit`; this test covers the remaining half of the invariant —
  // that the query text also never reaches the logger above (or at) debug.
  const secretQuery = 'unlogged secret admin research query 42';
  const logCalls: unknown[] = [];
  const realLogger = await import('../src/logger.js');
  t.mock.module('../src/logger.js', {
    namedExports: {
      ...realLogger,
      logger: {
        ...realLogger.logger,
        error: (...args: unknown[]) => logCalls.push(args),
        warn: (...args: unknown[]) => logCalls.push(args),
        info: (...args: unknown[]) => logCalls.push(args),
        debug: (...args: unknown[]) => logCalls.push(args),
      },
    },
  });

  const { buildQueryOptions } = await import('../src/agent/core.js');
  const opts = buildQueryOptions('admin', 'prompt', {}, null, 'ws-dedup-no-log') as {
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
  const hookOptions = { signal: new AbortController().signal };
  const preToolUseInput = (toolUseId: string) => ({
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript',
    cwd: '/tmp',
    hook_event_name: 'PreToolUse' as const,
    tool_name: 'WebSearch',
    tool_input: { query: secretQuery },
    tool_use_id: toolUseId,
  });

  // First occurrence, then an exact repeat that triggers the deny path —
  // exercise both branches since either could plausibly log the query.
  await fn(preToolUseInput('nl-1'), 'nl-1', hookOptions);
  await fn(preToolUseInput('nl-2'), 'nl-2', hookOptions);

  for (const call of logCalls) {
    assert.ok(
      !JSON.stringify(call).toLowerCase().includes(secretQuery.toLowerCase()),
      'the raw WebSearch query text must never reach the logger at any level',
    );
  }
});
