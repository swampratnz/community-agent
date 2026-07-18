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
const { config } = await import('../src/config.js');

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

// The 9 tools issue #535 filters out of allowedTools when their config flag
// is off (default). Kept in one place here so the two tests below (the
// no-drift pin and the default-config exclusion pin) can't silently disagree
// about which tools are feature-flagged.
const FEATURE_FLAGGED_TOOLS = [
  'mcp__community__generate_image',
  'mcp__community__suggest_issue',
  'mcp__community__dev_team_dispatch',
  'mcp__community__dev_team_status',
  'mcp__community__dev_team_result',
  'mcp__community__dev_team_backlog',
  'mcp__community__dev_team_findings',
  'mcp__community__dev_team_verify',
] as const;

test('SECURITY: allowedTools tracks toolsForRole exactly, modulo feature-flag/platform filtering — no drift between rbac.ts and core.ts', () => {
  // Default config (this test process sets none of IMAGE_GEN_ENABLED /
  // GITHUB_ISSUE_ENABLED / DEV_TEAM_ENABLED) — all three flags are off.
  assert.equal(config.imageGen.enabled, false, 'precondition: image-gen is off in this test process');
  assert.equal(config.github.enabled, false, 'precondition: github-issue is off in this test process');
  assert.equal(config.devTeam.enabled, false, 'precondition: dev-team is off in this test process');
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    for (const platform of ['discord', 'whatsapp'] as const) {
      const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1', platform);
      const webSearch = role === 'admin' || role === 'super_admin';
      const expected = [...toolsForRole(role, platform), ...(webSearch ? ['WebSearch'] : [])].filter(
        (t) => !(FEATURE_FLAGGED_TOOLS as readonly string[]).includes(t),
      );
      assert.deepEqual(
        [...opts.allowedTools].sort(),
        [...expected].sort(),
        `${role}/${platform} allowedTools must be exactly toolsForRole(${role}, ${platform}) plus tier-gated ` +
          'WebSearch, minus the feature-flagged tools disabled in this process — no other difference',
      );
    }
  }
});

test('SECURITY: acceptance criterion 1 — default config excludes all 9 feature-flagged tools from a super_admin turn', () => {
  const opts = buildQueryOptions('super_admin', 'prompt', {}, null, 'conv-1', 'discord');
  for (const t of FEATURE_FLAGGED_TOOLS) {
    assert.ok(!opts.allowedTools.includes(t), `default config must exclude ${t} from allowedTools`);
  }
});

test('platform filtering — WhatsApp excludes list_events (member) and create_event/cancel_event (admin+)', () => {
  const member = buildQueryOptions('member', 'prompt', {}, null, 'conv-1', 'whatsapp');
  assert.ok(!member.allowedTools.includes('mcp__community__list_events'));
  for (const role of ['admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1', 'whatsapp');
    assert.ok(!opts.allowedTools.includes('mcp__community__create_event'));
    assert.ok(!opts.allowedTools.includes('mcp__community__cancel_event'));
  }
});

test('platform filtering — Discord is unaffected: list_events (member+) and create_event/cancel_event (admin+) still present', () => {
  for (const role of ['member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1', 'discord');
    assert.ok(opts.allowedTools.includes('mcp__community__list_events'));
  }
  for (const role of ['admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1', 'discord');
    assert.ok(opts.allowedTools.includes('mcp__community__create_event'));
    assert.ok(opts.allowedTools.includes('mcp__community__cancel_event'));
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
    // generate_image is feature-flagged (off by default in this test process,
    // issue #535) and is correctly ABSENT here — every other admin tool must
    // still be present.
    if ((FEATURE_FLAGGED_TOOLS as readonly string[]).includes(t)) continue;
    assert.ok(opts.allowedTools.includes(t), `admin allowedTools must include ${t}`);
  }
});

test('super-admin turns carry the full surface, minus feature-flagged tools disabled by default', () => {
  const opts = buildQueryOptions('super_admin', 'prompt', {}, null, 'conv-1');
  for (const t of [...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
    if ((FEATURE_FLAGGED_TOOLS as readonly string[]).includes(t)) continue;
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
    const expected = [...toolsForRole(role), ...(webSearch ? ['WebSearch'] : [])].filter(
      (t) => !(FEATURE_FLAGGED_TOOLS as readonly string[]).includes(t),
    );
    assert.deepEqual([...opts.allowedTools].sort(), [...expected].sort());
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
