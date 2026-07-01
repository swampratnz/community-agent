import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { buildQueryOptions } = await import('../src/agent/core.js');
const { ADMIN_TOOLS, SUPER_ADMIN_TOOLS } = await import('../src/auth/rbac.js');

test('SECURITY: built-in Claude Code tools are disabled (tools: [])', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null);
    assert.deepEqual(opts.tools, [], `tools must be [] for ${role} — allowedTools alone does NOT restrict`);
  }
});

test('SECURITY: member turns never carry admin or super-admin tools', () => {
  const opts = buildQueryOptions('member', 'prompt', {}, null);
  for (const t of [...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
    assert.ok(!opts.allowedTools.includes(t), `member allowedTools must not include ${t}`);
  }
});

test('SECURITY: admin turns never carry super-admin tools', () => {
  const opts = buildQueryOptions('admin', 'prompt', {}, null);
  for (const t of SUPER_ADMIN_TOOLS) {
    assert.ok(!opts.allowedTools.includes(t), `admin allowedTools must not include ${t}`);
  }
  for (const t of ADMIN_TOOLS) {
    assert.ok(opts.allowedTools.includes(t), `admin allowedTools must include ${t}`);
  }
});

test('super-admin turns carry the full surface', () => {
  const opts = buildQueryOptions('super_admin', 'prompt', {}, null);
  for (const t of [...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
    assert.ok(opts.allowedTools.includes(t));
  }
});

test('host ~/.claude config is never loaded', () => {
  const opts = buildQueryOptions('super_admin', 'prompt', {}, null);
  assert.deepEqual(opts.settingSources, []);
});

test('resume only set when a session id exists', () => {
  assert.ok(!('resume' in buildQueryOptions('member', 'p', {}, null)));
  assert.equal(buildQueryOptions('member', 'p', {}, 'sess-1').resume, 'sess-1');
});
