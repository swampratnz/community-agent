import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/module/strings/notices.js';

// Issue #706 AC3: once isDuplicateWebSearchQuery falls through to the
// embedding-similarity check, it calls embed() — but the exact-normalized-
// match fast path above it must NEVER call embed(), same true-short-circuit
// discipline already proven for candidateTopicAlreadyReviewed (repository.ts,
// issue #503 AC1, tests/knowledgeCandidateDedupDegradation.test.ts). Mocking
// embed() to throw pins that the exact-match path structurally cannot reach
// it. Mock BEFORE the first import of core.js/webSearchGuard.js — a later
// t.mock.module call can't retarget an already-imported module (same trap
// noted in tests/agentWebSearchDedupFailClosed.test.ts) — so this lives in
// its OWN file, same split as that file / tests/agentWebSearchDedupNoLog.test.ts.

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

// The tool registry's module-scope registrations (tool tiers, tool-server
// parts, feature-flag predicates) — the composition-root contract, matching
// tests/rbac.test.ts.
await import('../src/module/agent/tools/index.js');

test('SECURITY: issue #706 AC3 — a verbatim (post-normalization) repeat is denied WITHOUT any ADDITIONAL call to embed()', async (t) => {
  // The FIRST occurrence of any query is, by definition, never an exact
  // match (the history is empty) — it must still fall through to embed() so
  // its vector is available for LATER similarity comparisons. So this mock
  // stays non-throwing (a throw there would fail-closed-deny the setup call
  // itself, which is issue #412 AC-5 / #589's territory, not this AC). What
  // this test pins is that the SECOND call — an exact-normalized repeat —
  // adds no further embed() call at all: the count after the repeat must
  // equal the count after the first call.
  let embedCalls = 0;
  t.mock.module('../src/base/storage/embeddings.js', {
    namedExports: {
      embed: async () => {
        embedCalls += 1;
        return new Array(384).fill(0);
      },
    },
  });

  const { buildQueryOptions } = await import('../src/base/agent/core.js');
  const opts = buildQueryOptions('admin', 'prompt', {}, null, 'ws-dedup-embed-short-circuit') as {
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
  const preToolUseInput = (toolUseId: string, query: string) => ({
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript',
    cwd: '/tmp',
    hook_event_name: 'PreToolUse' as const,
    tool_name: 'WebSearch',
    tool_input: { query },
    tool_use_id: toolUseId,
  });

  const first = await fn(preToolUseInput('s-1', 'exact repeat short circuit query'), 's-1', hookOptions);
  assert.equal(first.hookSpecificOutput, undefined, 'the first occurrence must never be denied');
  const embedCallsAfterFirst = embedCalls;
  assert.equal(
    embedCallsAfterFirst,
    1,
    'a genuinely new query with an empty history embeds once, to seed history',
  );

  // Same query, differing only in whitespace/casing — the normalized
  // exact-match fast path must catch this without ever reaching embed()
  // again.
  const repeat = await fn(
    preToolUseInput('s-2', '  Exact   REPEAT Short Circuit Query  '),
    's-2',
    hookOptions,
  );
  assert.equal(repeat.hookSpecificOutput?.permissionDecision, 'deny', 'the exact repeat is still denied');
  assert.equal(
    repeat.hookSpecificOutput?.permissionDecisionReason,
    'You already searched for this in the last few minutes — use what you found.',
  );
  assert.equal(
    embedCalls,
    embedCallsAfterFirst,
    'the exact-match fast path added no further embed() call — a true short circuit',
  );
});
