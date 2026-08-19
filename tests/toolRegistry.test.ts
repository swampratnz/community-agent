import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/tools.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { closeDb } = await import('@swampratnz/agent-base/storage/db.js');
const { config } = await import('@swampratnz/agent-base/config.js');
await import('./support/registerToolRegistry.js');
const { TOOL_REGISTRY, flaggedToolPredicates } = await import('../src/module/agent/tools/index.js');
const { buildToolServer } = await import('../src/module/agent/tools.js');
const { MEMBER_TOOLS, ADMIN_TOOLS, SUPER_ADMIN_TOOLS, toolsForRole } =
  await import('@swampratnz/agent-base/auth/rbac.js');
const { filterFeatureFlaggedTools } = await import('@swampratnz/agent-base/agent/core.js');

after(async () => {
  await closeDb();
});

// The registry (src/module/agent/tools/index.ts) is THE single source of truth for
// every tool's name, tier, platform restriction and feature flag — rbac.ts's
// tier arrays, toolsForRole's platform filtering and core.ts's flag filter
// are all DERIVED from it (docs/TOOL-REGISTRY-DESIGN.md §2's flip). The old
// strangler-era cross-checks against the hand arrays became tautological the
// moment those arrays were derived; what this file pins instead are the
// registry's own structural invariants, which no longer hold "by
// convention" anywhere else.

const prefixed = (name: string) => `mcp__community__${name}`;

test('registry names are unique, exactly 121 defs, and every def is registered on a built server', () => {
  const names = TOOL_REGISTRY.map((def) => def.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool name in TOOL_REGISTRY');
  // The full inventory at the flip, +1 for issue #944's team_setup, +1 for
  // issue #1006's decline_access_request, +1 for issue #1008's
  // find_knowledge, +1 for issue #1024's list_top_knowledge. A change here
  // must be a conscious tool addition/removal, never a domain file falling
  // out of the registry.
  assert.equal(names.length, 122);

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
  } as unknown as import('@swampratnz/agent-base/platforms/types.js').PlatformAdapter;
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
  assert.equal(Object.keys(registered).length, names.length, 'server registered tools beyond the registry');
});

test('SECURITY: the derived tier arrays partition the registry — every def in exactly the array matching its minTier, no overlap', () => {
  const tierArrays: Record<'member' | 'admin' | 'super_admin', readonly string[]> = {
    member: MEMBER_TOOLS,
    admin: ADMIN_TOOLS,
    super_admin: SUPER_ADMIN_TOOLS,
  };
  for (const def of TOOL_REGISTRY) {
    for (const [tier, arr] of Object.entries(tierArrays)) {
      assert.equal(
        arr.includes(prefixed(def.name)),
        tier === def.minTier,
        `${def.name} (minTier '${def.minTier}') membership in the '${tier}' tier array is wrong`,
      );
    }
  }
  // The three arrays cover the whole registry and nothing else.
  assert.equal(MEMBER_TOOLS.length + ADMIN_TOOLS.length + SUPER_ADMIN_TOOLS.length, TOOL_REGISTRY.length);
});

test("SECURITY: toolsForRole('member', 'whatsapp') excludes every platforms:['discord'] def and still includes react_to_message", () => {
  const onWhatsapp = new Set(toolsForRole('member', 'whatsapp'));
  for (const def of TOOL_REGISTRY) {
    if (def.minTier !== 'member') continue;
    const discordOnly =
      def.platforms !== undefined && def.platforms.length === 1 && def.platforms[0] === 'discord';
    assert.equal(
      onWhatsapp.has(prefixed(def.name)),
      !discordOnly,
      `${def.name}: platforms ${JSON.stringify(def.platforms)} vs the WhatsApp member surface disagree`,
    );
  }
  // react_to_message is the canary: implemented on BOTH WhatsApp adapters
  // (Baileys: issue #495, Cloud: issue #528), so it must never be swept up
  // by the Discord-only platform filter.
  assert.ok(onWhatsapp.has(prefixed('react_to_message')));
  // And the super-admin Discord surface is the full registry, so the filter
  // above is the only thing platform ever subtracts.
  assert.equal(toolsForRole('super_admin', 'discord').length, TOOL_REGISTRY.length);
});

test('SECURITY: a member surface never contains an admin or super_admin def name, on either platform', () => {
  const higher = TOOL_REGISTRY.filter((def) => def.minTier !== 'member').map((def) => prefixed(def.name));
  for (const platform of ['discord', 'whatsapp'] as const) {
    const member = new Set(toolsForRole('member', platform));
    const guest = new Set(toolsForRole('guest', platform));
    for (const name of higher) {
      assert.ok(!member.has(name), `${name} leaked onto the member surface on ${platform}`);
      assert.ok(!guest.has(name), `${name} leaked onto the guest surface on ${platform}`);
    }
  }
});

test('SECURITY: every off-flag def is dropped by filterFeatureFlaggedTools, and the filter is purely subtractive', () => {
  const predicates = flaggedToolPredicates();
  // Exactly the defs declaring a featureFlag are flagged — the set is
  // derived, so this pins that derivation stayed 1:1.
  assert.deepEqual(
    predicates.map((p) => p.name).sort(),
    TOOL_REGISTRY.filter((def) => def.featureFlag !== undefined)
      .map((def) => prefixed(def.name))
      .sort(),
  );
  const offNames = predicates.filter((p) => !p.enabled(config)).map((p) => p.name);
  // This test file's dummy env leaves every gating flag at its false
  // default, so the off set must be the whole flagged set here — if this
  // env ever changes, the assertion below still covers whatever is off.
  assert.ok(offNames.length > 0, 'expected at least one off-flag tool under the test env');
  const full = toolsForRole('super_admin', 'discord');
  const filtered = filterFeatureFlaggedTools(full);
  for (const name of offNames) {
    assert.ok(full.includes(name), `${name} missing from the unfiltered surface`);
    assert.ok(!filtered.includes(name), `${name} offered while its feature flag is off`);
  }
  // Purely subtractive: everything the filter kept was already offered, and
  // nothing unflagged was touched.
  const fullSet = new Set(full);
  assert.ok(filtered.every((t) => fullSet.has(t)));
  const offSet = new Set(offNames);
  assert.deepEqual(
    filtered,
    full.filter((t) => !offSet.has(t)),
  );
});
