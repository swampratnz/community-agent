import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. AGENT_MODEL_MEMBER must be set
// BEFORE config.js is first imported in this process (it resolves once, at
// import time), so this scenario needs its own file rather than reusing
// tests/agentOptions.test.ts (which asserts the unset/default baseline).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.AGENT_MODEL_MEMBER = 'claude-haiku-4-5-20251001';

const { config } = await import('../src/config.js');
const { buildQueryOptions } = await import('../src/agent/core.js');
const { toolsForRole } = await import('../src/auth/rbac.js');

test('config: AGENT_MODEL_MEMBER set resolves to config.llm.memberModel (issue #382)', () => {
  assert.equal(config.llm.memberModel, 'claude-haiku-4-5-20251001');
  assert.notEqual(
    config.llm.memberModel,
    config.llm.model,
    'fixture must use a value distinct from AGENT_MODEL for the assertions below to be meaningful',
  );
});

test('AGENT_MODEL_MEMBER set: guest/member resolve to it, admin/super_admin still resolve to config.llm.model (issue #382)', () => {
  for (const role of ['guest', 'member'] as const) {
    assert.equal(
      buildQueryOptions(role, 'prompt', {}, null, 'conv-1').model,
      config.llm.memberModel,
      `${role} must resolve to config.llm.memberModel when AGENT_MODEL_MEMBER is set`,
    );
  }
  for (const role of ['admin', 'super_admin'] as const) {
    assert.equal(
      buildQueryOptions(role, 'prompt', {}, null, 'conv-1').model,
      config.llm.model,
      `${role} must still resolve to config.llm.model, unaffected by AGENT_MODEL_MEMBER`,
    );
  }
});

test('SECURITY: AGENT_MODEL_MEMBER set ⇒ tools/allowedTools/disallowedTools are unaffected by the model-tiering field (issue #382, matches the unset baseline in tests/agentOptions.test.ts)', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    const webSearch = role === 'admin' || role === 'super_admin';
    assert.deepEqual(opts.tools, webSearch ? ['WebSearch'] : []);
    assert.deepEqual(
      [...opts.allowedTools].sort(),
      [...toolsForRole(role), ...(webSearch ? ['WebSearch'] : [])].sort(),
    );
    assert.ok(opts.disallowedTools.includes('Task'));
    assert.ok(opts.disallowedTools.includes('WebFetch'));
    assert.equal(opts.disallowedTools.includes('WebSearch'), !webSearch);
  }
});
