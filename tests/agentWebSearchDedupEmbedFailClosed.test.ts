import { test } from 'node:test';
import assert from 'node:assert/strict';

// Issue #706 AC4 (SECURITY): a rejected embed() call during the
// embedding-similarity half of the WebSearch dedup check must still fail
// closed (deny), extending #412 AC-5 / #589's fail-closed guarantee to the
// new code path — isDuplicateWebSearchQuery deliberately does NOT catch a
// thrown embed() itself (see its doc comment in tools.ts), relying on the
// SAME outer try/catch in core.ts's PreToolUse hook that
// tests/agentWebSearchDedupFailClosed.test.ts already pins for a thrown
// isDuplicateWebSearchQuery. This file exercises that same outer catch via
// a REAL isDuplicateWebSearchQuery hitting a REJECTED embed() specifically,
// rather than a directly-thrown isDuplicateWebSearchQuery mock — the two are
// not equivalent: a bug that wrapped only the top-level function body in
// try/catch but missed the embed() await inside it would pass the existing
// test while failing this one.
//
// Mock BEFORE the first import of core.js — a later t.mock.module call
// can't retarget an already-imported module (same trap noted in
// tests/agentWebSearchDedupFailClosed.test.ts), so this lives in its OWN
// file, same split as that file / tests/agentWebSearchDedupEmbedShortCircuit.test.ts.

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

test('SECURITY: issue #706 AC4 — a rejected embed() call during the similarity check fails closed (denies), never lets the call through unbounded', async (t) => {
  t.mock.module('../src/storage/embeddings.js', {
    namedExports: {
      embed: async () => {
        throw new Error('boom: simulated embedding-backend failure');
      },
    },
  });

  const { buildQueryOptions } = await import('../src/agent/core.js');
  const opts = buildQueryOptions('admin', 'prompt', {}, null, 'ws-dedup-embed-fail-closed') as {
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

  // The very first query for this conversation is never an exact match (the
  // history is empty), so it falls through to the embedding half of the
  // check — which is exactly the rejected embed() this test mocks.
  const result = await fn(
    {
      session_id: 'sess-1',
      transcript_path: '/tmp/transcript',
      cwd: '/tmp',
      hook_event_name: 'PreToolUse',
      tool_name: 'WebSearch',
      tool_input: { query: 'a brand new query that must be embedded' },
      tool_use_id: 'tool-1',
    },
    'tool-1',
    { signal: new AbortController().signal },
  );

  assert.equal(result.continue, true, 'the hook itself must never throw/reject out to the SDK');
  assert.equal(
    result.hookSpecificOutput?.permissionDecision,
    'deny',
    'a rejected embed() call must fail closed (deny), never allow the call through unbounded',
  );
});
