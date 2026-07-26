import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { config } = await import('../src/config.js');
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

// A pool of genuinely UNRELATED topics, same convention/rationale as
// tests/agentWebSearchDedup.test.ts's DISTINCT_TOPICS: a numeric-suffix
// pattern like "test query admin-0" / "test query admin-1" is exactly the
// shape the embedding-similarity dedup guard (issue #706) is DESIGNED to
// catch — adjacent numeric-suffix queries embedded well above
// AGENT_WEB_SEARCH_DEDUP_SIMILARITY_THRESHOLD's default 0.9 against the
// real local embedding model, which silently broke this file's volume-cap
// isolation (dedup denied several loop iterations before the cap was ever
// reached, so "one more call over the cap" was wrongly allowed instead of
// denied). These 25 topics stay below ~0.45 cosine similarity pairwise.
const DISTINCT_TOPICS = [
  'nz contractor tax rules',
  'auckland public transport fares',
  'best pgvector index type',
  'kiwi bird conservation status',
  'wellington earthquake building code',
  'discord webhook rate limits',
  'lemon cake baking recipe',
  'glacier melting rate antarctica',
  'opera house ticket prices',
  'lentil soup nutrition facts',
  'satellite internet coverage rural nz',
  'harbour bridge toll history',
  'cactus watering schedule',
  'choir rehearsal scheduling app',
  'tunnel boring machine specs',
  'rugby world cup schedule',
  'bitcoin mining energy usage',
  'volcano eruption warning signs',
  'string theory basics explained',
  'sourdough starter troubleshooting',
  'electric vehicle charging stations nz',
  'shakespeare play summaries',
  'coral reef bleaching causes',
  'jazz music history 1920s',
  'mount everest climbing permits',
];

assert.ok(
  config.llm.webSearchRateLimitPerHour < DISTINCT_TOPICS.length - 1,
  'DISTINCT_TOPICS must have enough genuinely-unrelated entries to cover the configured rate limit, ' +
    "with one spare for '-over' calls",
);

/** Maps a `<prefix>-<n>` toolUseId to a genuinely distinct topic; any other shape (e.g. `admin-over`) gets the pool's last (unused-by-any-loop) entry. */
function queryForToolUseId(toolUseId: string): string {
  const match = /-(\d+)$/.exec(toolUseId);
  if (match) {
    return DISTINCT_TOPICS[Number(match[1]) % DISTINCT_TOPICS.length];
  }
  return DISTINCT_TOPICS[DISTINCT_TOPICS.length - 1];
}

function preToolUseInput(toolUseId: string, query = queryForToolUseId(toolUseId)) {
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

/** Extract the WebSearch PreToolUse callback `buildQueryOptions` wires (issue #412), asserting it exists. */
function webSearchHook(opts: ReturnType<typeof buildQueryOptions>): PreToolUseHook {
  const hooks = (opts as { hooks?: { PreToolUse?: Array<{ matcher?: string; hooks: PreToolUseHook[] }> } })
    .hooks;
  const matcher = hooks?.PreToolUse?.find((m) => m.matcher === 'WebSearch');
  assert.ok(matcher, 'expected buildQueryOptions to construct a WebSearch PreToolUse matcher');
  return matcher.hooks[0];
}

test('SECURITY: AC-0/AC-1 — admin WebSearch PreToolUse hook allows under AGENT_WEB_SEARCH_RATE_LIMIT_PER_HOUR and denies once exhausted', async () => {
  const conversationId = 'ws-cap-admin';
  const fn = webSearchHook(buildQueryOptions('admin', 'prompt', {}, null, conversationId));

  for (let i = 0; i < config.llm.webSearchRateLimitPerHour; i++) {
    const result = await fn(preToolUseInput(`admin-${i}`), `admin-${i}`, hookOptions);
    assert.equal(result.continue, true, `call ${i} within the cap must continue`);
    assert.equal(result.hookSpecificOutput, undefined, `call ${i} within the cap must not be denied`);
  }

  const overLimit = await fn(preToolUseInput('admin-over'), 'admin-over', hookOptions);
  assert.equal(overLimit.continue, true, 'a denial is still a well-formed continue: true response');
  assert.equal(overLimit.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.equal(overLimit.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(
    overLimit.hookSpecificOutput?.permissionDecisionReason ?? '',
    new RegExp(`${config.llm.webSearchRateLimitPerHour}/hour`),
  );
});

test('AC-2: the WebSearch cap is independent per conversationId — exhausting one never denies another', async () => {
  const exhausted = 'ws-cap-independence-a';
  const untouched = 'ws-cap-independence-b';

  const exhaustedFn = webSearchHook(buildQueryOptions('admin', 'prompt', {}, null, exhausted));
  for (let i = 0; i < config.llm.webSearchRateLimitPerHour; i++) {
    await exhaustedFn(preToolUseInput(`a-${i}`), `a-${i}`, hookOptions);
  }
  const overLimit = await exhaustedFn(preToolUseInput('a-over'), 'a-over', hookOptions);
  assert.equal(
    overLimit.hookSpecificOutput?.permissionDecision,
    'deny',
    'the exhausted conversation must be denied',
  );

  const untouchedFn = webSearchHook(buildQueryOptions('admin', 'prompt', {}, null, untouched));
  const stillAllowed = await untouchedFn(preToolUseInput('b-1'), 'b-1', hookOptions);
  assert.equal(stillAllowed.continue, true);
  assert.equal(
    stillAllowed.hookSpecificOutput,
    undefined,
    "a different conversation must not be denied by another conversation's exhausted cap",
  );
});

test('AC-3: super_admin WebSearch is capped identically to admin — no unbounded tier', async () => {
  const conversationId = 'ws-cap-super-admin';
  const fn = webSearchHook(buildQueryOptions('super_admin', 'prompt', {}, null, conversationId));

  for (let i = 0; i < config.llm.webSearchRateLimitPerHour; i++) {
    const result = await fn(preToolUseInput(`super-${i}`), `super-${i}`, hookOptions);
    assert.equal(result.continue, true, `call ${i} within the cap must continue`);
  }

  const overLimit = await fn(preToolUseInput('super-over'), 'super-over', hookOptions);
  assert.equal(
    overLimit.hookSpecificOutput?.permissionDecision,
    'deny',
    'super_admin must hit the same cap as admin, not an unbounded one',
  );
});

test('SECURITY: AC-4 — member/guest turns never construct a hooks.PreToolUse WebSearch matcher (nothing to gate)', () => {
  for (const role of ['guest', 'member'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'ws-cap-low-trust') as { hooks?: unknown };
    assert.equal(
      opts.hooks,
      undefined,
      `${role} must not construct any hooks — tools/allowedTools already exclude WebSearch for this tier`,
    );
  }
});
