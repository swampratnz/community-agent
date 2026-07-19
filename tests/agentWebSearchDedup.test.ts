import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { buildQueryOptions } = await import('../src/agent/core.js');

type PreToolUseResult = {
  continue?: boolean;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};

type PreToolUseHook = (
  input: unknown,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<PreToolUseResult>;

const hookOptions = { signal: new AbortController().signal };

function preToolUseInput(toolUseId: string, query: string) {
  return {
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript',
    cwd: '/tmp',
    hook_event_name: 'PreToolUse' as const,
    tool_name: 'WebSearch',
    tool_input: { query },
    tool_use_id: toolUseId,
  };
}

/** Extract the WebSearch PreToolUse callback `buildQueryOptions` wires (issue #412/#589), asserting it exists. */
function webSearchHook(opts: ReturnType<typeof buildQueryOptions>): PreToolUseHook {
  const hooks = (opts as { hooks?: { PreToolUse?: Array<{ matcher?: string; hooks: PreToolUseHook[] }> } })
    .hooks;
  const matcher = hooks?.PreToolUse?.find((m) => m.matcher === 'WebSearch');
  assert.ok(matcher, 'expected buildQueryOptions to construct a WebSearch PreToolUse matcher');
  return matcher.hooks[0];
}

test('SECURITY: AC-1 — an exact-normalized repeat of a recent WebSearch query in the same conversation is denied with a clear, non-generic reason', async () => {
  const conversationId = 'ws-dedup-repeat';
  const fn = webSearchHook(buildQueryOptions('admin', 'prompt', {}, null, conversationId));

  const first = await fn(preToolUseInput('r-1', 'best pgvector index type'), 'r-1', hookOptions);
  assert.equal(first.continue, true);
  assert.equal(first.hookSpecificOutput, undefined, 'the first occurrence of a query must never be denied');

  // Same query, differing only in leading/trailing whitespace, internal
  // whitespace run, and casing — the normalization the approved AC requires.
  const repeat = await fn(preToolUseInput('r-2', '  Best   PGVECTOR Index Type  '), 'r-2', hookOptions);
  assert.equal(repeat.continue, true, 'a denial is still a well-formed continue: true response');
  assert.equal(repeat.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.equal(repeat.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(
    repeat.hookSpecificOutput?.permissionDecisionReason ?? '',
    /already searched/i,
    'the dedup denial reason must be clear and specific, not the generic rate-limit message',
  );
  assert.doesNotMatch(
    repeat.hookSpecificOutput?.permissionDecisionReason ?? '',
    /\/hour/,
    'a dedup denial must not reuse the rate-limit-cap wording',
  );
});

test('AC-2: a genuinely different query in the same conversation and window is allowed — the dedup check never false-positives', async () => {
  const conversationId = 'ws-dedup-distinct';
  const fn = webSearchHook(buildQueryOptions('admin', 'prompt', {}, null, conversationId));

  const first = await fn(preToolUseInput('d-1', 'nz immigration visa categories'), 'd-1', hookOptions);
  assert.equal(first.hookSpecificOutput, undefined);

  const second = await fn(preToolUseInput('d-2', 'auckland public transport fares'), 'd-2', hookOptions);
  assert.equal(second.continue, true);
  assert.equal(
    second.hookSpecificOutput,
    undefined,
    'a distinct query researching a different sub-question must never be denied by the dedup guard',
  );
});

test('AC-3: WebSearch dedup state is scoped per conversation — an identical query in a different conversation is never blocked', async () => {
  const convA = 'ws-dedup-conv-a';
  const convB = 'ws-dedup-conv-b';
  const query = 'latest discord api rate limits';

  const fnA = webSearchHook(buildQueryOptions('admin', 'prompt', {}, null, convA));
  const firstInA = await fnA(preToolUseInput('a-1', query), 'a-1', hookOptions);
  assert.equal(firstInA.hookSpecificOutput, undefined);
  const repeatInA = await fnA(preToolUseInput('a-2', query), 'a-2', hookOptions);
  assert.equal(
    repeatInA.hookSpecificOutput?.permissionDecision,
    'deny',
    'a genuine repeat within the same conversation must be denied',
  );

  const fnB = webSearchHook(buildQueryOptions('admin', 'prompt', {}, null, convB));
  const firstInB = await fnB(preToolUseInput('b-1', query), 'b-1', hookOptions);
  assert.equal(firstInB.continue, true);
  assert.equal(
    firstInB.hookSpecificOutput,
    undefined,
    "an identical query in a DIFFERENT conversation must not be blocked by conversation A's recent search",
  );
});

test('AC-7: the existing rate-limit behaviour is unchanged when the query differs — a non-duplicate call still consumes a volume slot', async () => {
  const { config } = await import('../src/config.js');
  const conversationId = 'ws-dedup-rate-unaffected';
  const fn = webSearchHook(buildQueryOptions('admin', 'prompt', {}, null, conversationId));

  for (let i = 0; i < config.llm.webSearchRateLimitPerHour; i++) {
    const result = await fn(preToolUseInput(`u-${i}`, `distinct query number ${i}`), `u-${i}`, hookOptions);
    assert.equal(result.hookSpecificOutput, undefined, `distinct query ${i} must not be denied by dedup`);
  }

  // Every prior call was a distinct query, so the volume cap — not dedup —
  // must be exactly exhausted now; one more distinct query is still denied.
  const overLimit = await fn(preToolUseInput('u-over', 'yet another distinct query'), 'u-over', hookOptions);
  assert.equal(overLimit.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(
    overLimit.hookSpecificOutput?.permissionDecisionReason ?? '',
    /\/hour/,
    'a non-duplicate call denied at the ceiling must still be the rate-limit denial, proving the volume cap still ran',
  );
});

test('AC-8: the dedup history evicts the oldest query once more than historySize distinct queries have been recorded', async () => {
  const { config } = await import('../src/config.js');
  const conversationId = 'ws-dedup-eviction';
  const fn = webSearchHook(buildQueryOptions('admin', 'prompt', {}, null, conversationId));
  const historySize = config.llm.webSearchDedupHistorySize;

  const first = await fn(preToolUseInput('e-first', 'query zero'), 'e-first', hookOptions);
  assert.equal(first.hookSpecificOutput, undefined);

  // Fill the history with (historySize) MORE distinct queries, pushing
  // "query zero" out the back once the history exceeds historySize entries.
  for (let i = 1; i <= historySize; i++) {
    const result = await fn(preToolUseInput(`e-${i}`, `query ${i}`), `e-${i}`, hookOptions);
    assert.equal(result.hookSpecificOutput, undefined, `distinct query ${i} must not be denied by dedup`);
  }

  // "query zero" has now been evicted, so repeating it must be treated as a
  // brand-new query, not a duplicate.
  const repeatEvicted = await fn(preToolUseInput('e-repeat', 'query zero'), 'e-repeat', hookOptions);
  assert.equal(
    repeatEvicted.hookSpecificOutput,
    undefined,
    'a query evicted from the (bounded) history must no longer be treated as a duplicate',
  );
});

test('AC-9: a query denied by the volume cap is never recorded into the dedup history — a retry of it is denied by the SAME rate-limit reason, not misreported as "already searched"', async () => {
  const { config } = await import('../src/config.js');
  const conversationId = 'ws-dedup-rate-then-retry';
  const fn = webSearchHook(buildQueryOptions('admin', 'prompt', {}, null, conversationId));

  // Exhaust the volume cap with distinct queries, none of which collide
  // with the query used below.
  for (let i = 0; i < config.llm.webSearchRateLimitPerHour; i++) {
    const result = await fn(preToolUseInput(`f-${i}`, `filler query number ${i}`), `f-${i}`, hookOptions);
    assert.equal(result.hookSpecificOutput, undefined, `filler query ${i} must not be denied by dedup`);
  }

  // A genuinely new, never-before-seen query is now denied by the volume
  // cap — not the dedup guard, since it is not a repeat of anything.
  const first = await fn(preToolUseInput('g-1', 'a brand new never searched query'), 'g-1', hookOptions);
  assert.equal(first.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(
    first.hookSpecificOutput?.permissionDecisionReason ?? '',
    /\/hour/,
    'a call denied purely by the volume cap must carry the rate-limit reason',
  );

  // Retrying the SAME query must be denied for the SAME rate-limit reason —
  // if the first call had wrongly been recorded into the dedup history
  // despite never actually searching, this retry would instead get the
  // dedup guard's "already searched" denial.
  const retry = await fn(preToolUseInput('g-2', 'a brand new never searched query'), 'g-2', hookOptions);
  assert.equal(retry.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(
    retry.hookSpecificOutput?.permissionDecisionReason ?? '',
    /\/hour/,
    'a retry of a call that was only ever rate-limited (never actually searched) must still be denied ' +
      'by the rate-limit reason, not misreported as an "already searched" dedup denial',
  );
  assert.doesNotMatch(
    retry.hookSpecificOutput?.permissionDecisionReason ?? '',
    /already searched/i,
    'a query that was denied by the volume cap (never recorded as searched) must not be dedup-denied on retry',
  );
});

// AC-4 (fail-closed) and AC-5 (no-log) each need to t.mock.module a
// dependency of core.ts BEFORE core.ts's first import — and this file
// already imports core.js at module top-level above for AC-1/2/3/7 — so
// each lives in its OWN test file (its own child process under the `node
// --test` runner), same split as agentWebSearchRateLimit.test.ts /
// agentWebSearchRateLimitFailClosed.test.ts: see
// tests/agentWebSearchDedupFailClosed.test.ts and
// tests/agentWebSearchDedupNoLog.test.ts.
