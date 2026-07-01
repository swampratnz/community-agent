import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { buildQueryOptions } = await import('../src/agent/core.js');
const { ADMIN_TOOLS } = await import('../src/auth/rbac.js');

test('SECURITY: built-in Claude Code tools are disabled (tools: [])', () => {
  const opts = buildQueryOptions('user', 'prompt', {}, null);
  assert.deepEqual(opts.tools, [], 'tools must be an empty array — allowedTools alone does NOT restrict the surface');
});

test('SECURITY: user turns never carry admin tools in allowedTools', () => {
  const opts = buildQueryOptions('user', 'prompt', {}, null);
  for (const t of ADMIN_TOOLS) {
    assert.ok(!opts.allowedTools.includes(t), `user allowedTools must not include ${t}`);
  }
});

test('admin turns carry admin tools', () => {
  const opts = buildQueryOptions('admin', 'prompt', {}, null);
  for (const t of ADMIN_TOOLS) {
    assert.ok(opts.allowedTools.includes(t), `admin allowedTools must include ${t}`);
  }
});

test('host ~/.claude config is never loaded', () => {
  const opts = buildQueryOptions('admin', 'prompt', {}, null);
  assert.deepEqual(opts.settingSources, []);
});

test('resume only set when a session id exists', () => {
  assert.ok(!('resume' in buildQueryOptions('user', 'p', {}, null)));
  assert.equal(buildQueryOptions('user', 'p', {}, 'sess-1').resume, 'sess-1');
});
