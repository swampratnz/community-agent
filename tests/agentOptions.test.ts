import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { buildQueryOptions } = await import('../src/agent/core.js');
const { ADMIN_TOOLS, SUPER_ADMIN_TOOLS, toolsForRole } = await import('../src/auth/rbac.js');

test('SECURITY: members/guests get NO built-in tools; admin+ get exactly WebSearch', () => {
  for (const role of ['guest', 'member'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null);
    assert.deepEqual(opts.tools, [], `tools must be [] for ${role} — allowedTools alone does NOT restrict`);
    assert.ok(opts.disallowedTools.includes('WebSearch'), `${role} must have WebSearch disallowed`);
    assert.ok(!opts.allowedTools.includes('WebSearch'));
  }
  for (const role of ['admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null);
    assert.deepEqual(opts.tools, ['WebSearch'], `${role} built-ins must be exactly [WebSearch]`);
    assert.ok(opts.allowedTools.includes('WebSearch'));
  }
});

test('SECURITY: WebFetch is disallowed for every tier (exfiltration channel)', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null);
    assert.ok(opts.disallowedTools.includes('WebFetch'), `${role} must have WebFetch disallowed`);
    assert.ok(!opts.tools.includes('WebFetch'));
    assert.ok(!opts.allowedTools.includes('WebFetch'));
  }
});

test('SECURITY: Task (sub-agent spawning) is disallowed for every tier', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null);
    assert.ok(opts.disallowedTools.includes('Task'), `${role} must have Task disallowed`);
  }
});

test('SECURITY: settingSources is empty for every tier (host ~/.claude config is never loaded)', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    assert.deepEqual(buildQueryOptions(role, 'prompt', {}, null).settingSources, []);
  }
});

test('SECURITY: allowedTools tracks toolsForRole exactly — no drift between rbac.ts and core.ts', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null);
    const webSearch = role === 'admin' || role === 'super_admin';
    const expected = [...toolsForRole(role), ...(webSearch ? ['WebSearch'] : [])];
    assert.deepEqual(
      [...opts.allowedTools].sort(),
      [...expected].sort(),
      `${role} allowedTools must be exactly toolsForRole(${role}) plus tier-gated WebSearch`,
    );
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

test('resume only set when a session id exists', () => {
  assert.ok(!('resume' in buildQueryOptions('member', 'p', {}, null)));
  assert.equal(buildQueryOptions('member', 'p', {}, 'sess-1').resume, 'sess-1');
});
