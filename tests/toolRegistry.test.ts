import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/tools.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { closeDb } = await import('../src/storage/db.js');
const { TOOL_REGISTRY } = await import('../src/agent/tools/index.js');
const { buildToolServer } = await import('../src/agent/tools.js');
const { MEMBER_TOOLS, ADMIN_TOOLS, SUPER_ADMIN_TOOLS, toolsForRole } = await import('../src/auth/rbac.js');

after(async () => {
  await closeDb();
});

// During the strangler migration (docs/TOOL-REGISTRY-DESIGN.md §4) there are
// two sources of truth for a converted tool's tier/platform/flag metadata:
// its ToolDef and the still-authoritative hand arrays in src/auth/rbac.ts /
// src/agent/core.ts. This file is what makes that safe — it fails the build
// the moment the registry and the hand arrays disagree, for every converted
// tool, and grows automatically as later stages convert more domains.

const prefixed = (name: string) => `mcp__community__${name}`;

test('SECURITY: every registry def is listed in exactly the rbac tier array matching its minTier', () => {
  const tierArrays: Record<'member' | 'admin' | 'super_admin', readonly string[]> = {
    member: MEMBER_TOOLS,
    admin: ADMIN_TOOLS,
    super_admin: SUPER_ADMIN_TOOLS,
  };
  for (const def of TOOL_REGISTRY) {
    for (const [tier, arr] of Object.entries(tierArrays)) {
      const listed = arr.includes(prefixed(def.name));
      if (tier === def.minTier) {
        assert.equal(
          listed,
          true,
          `${def.name}: declared minTier '${def.minTier}' but ${prefixed(def.name)} is missing from that rbac tier array`,
        );
      } else {
        assert.equal(
          listed,
          false,
          `${def.name}: declared minTier '${def.minTier}' but ${prefixed(def.name)} also appears in the '${tier}' rbac tier array`,
        );
      }
    }
  }
});

test("SECURITY: a registry def declares platforms:['discord'] iff rbac's platform filter drops it on WhatsApp", () => {
  const onDiscord = new Set(toolsForRole('super_admin', 'discord'));
  const onWhatsapp = new Set(toolsForRole('super_admin', 'whatsapp'));
  for (const def of TOOL_REGISTRY) {
    const name = prefixed(def.name);
    assert.equal(onDiscord.has(name), true, `${def.name}: not offered to super_admin on Discord at all`);
    const discordOnlyPerRbac = !onWhatsapp.has(name);
    const discordOnlyPerDef =
      def.platforms !== undefined && def.platforms.length === 1 && def.platforms[0] === 'discord';
    assert.equal(
      discordOnlyPerDef,
      discordOnlyPerRbac,
      `${def.name}: registry platforms metadata (${JSON.stringify(def.platforms)}) disagrees with rbac's DISCORD_ONLY_TOOLS filtering`,
    );
  }
});

test("SECURITY: a registry def carries a featureFlag predicate iff core.ts's FEATURE_FLAGGED_TOOL_GROUPS names it", () => {
  // Hand-copied from src/agent/core.ts's FEATURE_FLAGGED_TOOL_GROUPS (the
  // authoritative list until the flip): the 10 tools gated behind a config
  // flag today. When a group is added/removed there, update this set in the
  // same diff — that's the point of the cross-check.
  const flagged = new Set([
    'generate_image',
    'suggest_issue',
    'dev_team_dispatch',
    'dev_team_status',
    'dev_team_result',
    'dev_team_backlog',
    'dev_team_findings',
    'dev_team_verify',
    'set_helper_availability',
    'find_helper',
  ]);
  for (const def of TOOL_REGISTRY) {
    assert.equal(
      def.featureFlag !== undefined,
      flagged.has(def.name),
      `${def.name}: featureFlag presence (${String(def.featureFlag !== undefined)}) disagrees with core.ts's flagged set`,
    );
  }
});

test('registry names are unique and every def is actually registered on a built server', () => {
  const names = TOOL_REGISTRY.map((def) => def.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool name in TOOL_REGISTRY');

  const adapter = {
    platform: 'discord',
    start: async () => {},
    stop: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    sendMessage: async () => {},
    sendDirectMessage: async () => {},
    conversationsForUser: async () => [],
    adminCapabilities: new Set(),
    performAdminAction: async () => {
      throw new Error('not implemented in stub');
    },
  } as unknown as import('../src/platforms/types.js').PlatformAdapter;
  const server = buildToolServer(
    {
      platform: 'discord',
      userId: 'registry-probe',
      userName: 'Probe',
      role: 'super_admin',
      conversationId: 'registry-probe-convo',
      isDirect: false,
    },
    adapter,
  );
  // Same private-field reflection tests/tools.test.ts uses: the SDK server
  // keeps its registered tools in `_registeredTools`, keyed by bare name.
  const registered = (server.instance as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  for (const name of names) {
    assert.ok(name in registered, `${name}: in TOOL_REGISTRY but not registered on the MCP server`);
  }
  // The strangle must never drop or duplicate a tool: registry-built tools
  // plus the remaining closure tools must still total exactly 117.
  assert.equal(Object.keys(registered).length, 117);
});
