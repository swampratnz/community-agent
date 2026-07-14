import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { buildQueryOptions } = await import('../src/agent/core.js');
const { ADMIN_TOOLS, SUPER_ADMIN_TOOLS, toolsForRole } = await import('../src/auth/rbac.js');

test('SECURITY: members/guests get NO built-in tools; admin+ get exactly WebSearch', () => {
  for (const role of ['guest', 'member'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    assert.deepEqual(opts.tools, [], `tools must be [] for ${role} — allowedTools alone does NOT restrict`);
    assert.ok(opts.disallowedTools.includes('WebSearch'), `${role} must have WebSearch disallowed`);
    assert.ok(!opts.allowedTools.includes('WebSearch'));
  }
  for (const role of ['admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    assert.deepEqual(opts.tools, ['WebSearch'], `${role} built-ins must be exactly [WebSearch]`);
    assert.ok(opts.allowedTools.includes('WebSearch'));
  }
});

test('SECURITY: WebFetch is disallowed for every tier (exfiltration channel)', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    assert.ok(opts.disallowedTools.includes('WebFetch'), `${role} must have WebFetch disallowed`);
    assert.ok(!opts.tools.includes('WebFetch'));
    assert.ok(!opts.allowedTools.includes('WebFetch'));
  }
});

test('SECURITY: Task (sub-agent spawning) is disallowed for every tier', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    assert.ok(opts.disallowedTools.includes('Task'), `${role} must have Task disallowed`);
  }
});

test('SECURITY: settingSources is empty for every tier (host ~/.claude config is never loaded)', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    assert.deepEqual(buildQueryOptions(role, 'prompt', {}, null, 'conv-1').settingSources, []);
  }
});

test('SECURITY: allowedTools tracks toolsForRole exactly — no drift between rbac.ts and core.ts', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
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
  const opts = buildQueryOptions('member', 'prompt', {}, null, 'conv-1');
  for (const t of [...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
    assert.ok(!opts.allowedTools.includes(t), `member allowedTools must not include ${t}`);
  }
});

test('SECURITY: admin turns never carry super-admin tools', () => {
  const opts = buildQueryOptions('admin', 'prompt', {}, null, 'conv-1');
  for (const t of SUPER_ADMIN_TOOLS) {
    assert.ok(!opts.allowedTools.includes(t), `admin allowedTools must not include ${t}`);
  }
  for (const t of ADMIN_TOOLS) {
    assert.ok(opts.allowedTools.includes(t), `admin allowedTools must include ${t}`);
  }
});

test('super-admin turns carry the full surface', () => {
  const opts = buildQueryOptions('super_admin', 'prompt', {}, null, 'conv-1');
  for (const t of [...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
    assert.ok(opts.allowedTools.includes(t));
  }
});

test('resume only set when a session id exists', () => {
  assert.ok(!('resume' in buildQueryOptions('member', 'p', {}, null, 'conv-1')));
  assert.equal(buildQueryOptions('member', 'p', {}, 'sess-1', 'conv-1').resume, 'sess-1');
});

test('config: member/guest turns get the tiered AGENT_MAX_TURNS_MEMBER ceiling (issue #347)', async () => {
  const { config } = await import('../src/config.js');
  for (const role of ['guest', 'member'] as const) {
    assert.equal(
      buildQueryOptions(role, 'prompt', {}, null, 'conv-1').maxTurns,
      config.llm.memberMaxTurns,
      `${role} must resolve to config.llm.memberMaxTurns`,
    );
  }
});

test('config: admin/super_admin maxTurns is byte-identical to pre-tiering behaviour (issue #347)', async () => {
  const { config } = await import('../src/config.js');
  for (const role of ['admin', 'super_admin'] as const) {
    assert.equal(
      buildQueryOptions(role, 'prompt', {}, null, 'conv-1').maxTurns,
      config.llm.maxTurns,
      `${role} must still resolve to config.llm.maxTurns, unchanged`,
    );
  }
});

test('config: AGENT_MODEL_MEMBER unset ⇒ buildQueryOptions.model is byte-identical to config.llm.model for every role (issue #382)', async () => {
  const { config } = await import('../src/config.js');
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    assert.equal(
      buildQueryOptions(role, 'prompt', {}, null, 'conv-1').model,
      config.llm.model,
      `${role} must resolve to config.llm.model when AGENT_MODEL_MEMBER is unset`,
    );
  }
});

test('SECURITY: AGENT_MODEL_MEMBER unset ⇒ tools/allowedTools/disallowedTools are unaffected by the model-tiering field (issue #382 baseline run)', () => {
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

test('SECURITY: under default config, member/guest maxTurns is strictly lower than admin/super_admin — tiering can never silently collapse to uniform (or invert) for the lower-trust tier', () => {
  const lowTrust = ['guest', 'member'] as const;
  const highTrust = ['admin', 'super_admin'] as const;
  for (const lo of lowTrust) {
    const loTurns = buildQueryOptions(lo, 'prompt', {}, null, 'conv-1').maxTurns;
    for (const hi of highTrust) {
      const hiTurns = buildQueryOptions(hi, 'prompt', {}, null, 'conv-1').maxTurns;
      assert.ok(
        loTurns < hiTurns,
        `${lo} maxTurns (${loTurns}) must be strictly less than ${hi} maxTurns (${hiTurns})`,
      );
    }
  }
});
