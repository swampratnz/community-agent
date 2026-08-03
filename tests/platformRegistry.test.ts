import { test, after } from 'node:test';
import assert from 'node:assert/strict';
// The default bad-word list is community content registered at its own module
// scope (src/index.ts imports it in production); the moderation wordlist fails
// closed until then, and constructing a Discord adapter builds a Moderator.
import '../src/module/moderation/badWords.js';
// The adapters take their community text pack as a required constructor
// parameter now (agent-base plan item 6) — production hands it over in
// src/module/platforms/factories.ts, so these constructions pass the same pack.
import {
  BAILEYS_TEXT_PACK,
  DISCORD_TEXT_PACK,
  WHATSAPP_CLOUD_TEXT_PACK,
} from '../src/module/platforms/textPacks.js';
import type { PlatformAdapter } from '../src/base/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/toolRegistry.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
// HARD assignment, not ??=: CI's job env exports WHATSAPP_PROVIDER=disabled,
// which would otherwise win and collapse the composition test below to one
// adapter (the exact 1 !== 2 failure this pin fixes). The mirror test's
// premise is the two-adapter discord+baileys composition, so the provider
// must be deterministic here regardless of the surrounding environment.
process.env.WHATSAPP_PROVIDER = 'baileys';

const { closeDb } = await import('../src/base/storage/db.js');
const { TOOL_REGISTRY } = await import('../src/module/agent/tools/index.js');
const { KNOWN_PLATFORMS, PLATFORM_DESCRIPTORS, descriptorFor, assertToolAvailabilityConsistent } =
  await import('../src/base/platforms/registry.js');
const { ADAPTER_FACTORIES, createConfiguredAdapters, WHATSAPP_TOOL_CAPABILITIES } =
  await import('../src/module/platforms/factories.js');
const { DiscordAdapter, DISCORD_ADMIN_CAPABILITIES, DISCORD_TOOL_CAPABILITIES } =
  await import('../src/base/platforms/discord/adapter.js');
const { BaileysAdapter, BAILEYS_ADMIN_CAPABILITIES, BAILEYS_TOOL_CAPABILITIES } =
  await import('../src/base/platforms/whatsapp/baileysAdapter.js');
const { WhatsAppCloudAdapter, WHATSAPP_CLOUD_ADMIN_CAPABILITIES, WHATSAPP_CLOUD_TOOL_CAPABILITIES } =
  await import('../src/base/platforms/whatsapp/cloudAdapter.js');

after(async () => {
  await closeDb();
});

// The platform registry (agent-base plan item 9): `Platform` is an open
// string now, so the tests below pin the things the old closed union used to
// (partially) enforce by type — the set of registered platforms, that every
// tool's platform restriction is DERIVED from adapter capability
// declarations rather than hand-mirrored, and that those declarations are
// honest against the real adapter classes.

// The full inventory of platform-restricted tools at the flip — every one a
// Discord capability no WhatsApp provider declares. A change here must be a
// conscious availability decision, never registry drift.
const DISCORD_ONLY_TOOLS = [
  'create_poll',
  'end_poll',
  'create_thread',
  'archive_thread',
  'assign_community_role',
  'remove_community_role',
  'list_assignable_roles',
  'create_event',
  'cancel_event',
  'list_events',
].sort();

test('SECURITY: every platform restriction in the tool registry is capability-derived and consistent with the adapter factories', () => {
  // The real registry × the real factories passes the invariant — the same
  // call index.ts makes at startup.
  assertToolAvailabilityConsistent(TOOL_REGISTRY, ADAPTER_FACTORIES);

  // Every def that restricts platforms names the capability justifying it
  // (the invariant enforces this; assert directly so a message regression
  // in the checker can't silently drop the rule).
  for (const def of TOOL_REGISTRY) {
    if (def.platforms !== undefined) {
      assert.notEqual(
        def.requiresCapability,
        undefined,
        `${def.name}: platform restriction without a requiresCapability`,
      );
    }
  }

  // And the derivation didn't change any tool's availability: the restricted
  // set is exactly the historical Discord-only ten, everything else is
  // offered everywhere.
  const restricted = TOOL_REGISTRY.filter((def) => def.platforms !== undefined).map((def) => def.name);
  assert.deepEqual(restricted.sort(), DISCORD_ONLY_TOOLS);
  for (const def of TOOL_REGISTRY) {
    if (def.platforms !== undefined) {
      assert.deepEqual(def.platforms, ['discord'], `${def.name}: unexpected restriction shape`);
    }
  }
  // react_to_message stays offered on every platform (the deliberate-
  // inclusion case), justified by its capability rather than by folklore.
  const react = TOOL_REGISTRY.find((def) => def.name === 'react_to_message');
  assert.ok(react);
  assert.equal(react.platforms, undefined);
  assert.equal(react.requiresCapability, 'react_to_message');
});

test('SECURITY: an inconsistent platform restriction is rejected by the invariant, in both drift directions', () => {
  // Too WIDE: offered on a platform whose adapters never declare the
  // capability — the tool would be dead there.
  assert.throws(
    () =>
      assertToolAvailabilityConsistent(
        [{ name: 'evil_poll', platforms: ['discord', 'whatsapp'], requiresCapability: 'create_poll' }],
        ADAPTER_FACTORIES,
      ),
    /no adapter can execute it on: whatsapp/,
  );
  // Too NARROW: the react_to_message regression — WhatsApp declares the
  // capability (a provider implements it), so quietly narrowing the def to
  // Discord must fail rather than silently dropping the tool there.
  assert.throws(
    () =>
      assertToolAvailabilityConsistent(
        [{ name: 'react_to_message', platforms: ['discord'], requiresCapability: 'react_to_message' }],
        ADAPTER_FACTORIES,
      ),
    /silently unavailable on: whatsapp/,
  );
  // Unjustified: a restriction with no capability behind it is exactly the
  // hand-maintained drift the invariant exists to kill.
  assert.throws(
    () => assertToolAvailabilityConsistent([{ name: 'mystery', platforms: ['discord'] }], ADAPTER_FACTORIES),
    /without a requiresCapability/,
  );
  // Unregistered platform: naming a platform that doesn't exist is refused.
  assert.throws(
    () =>
      assertToolAvailabilityConsistent(
        [{ name: 'wrong_place', platforms: ['telegram'], requiresCapability: 'create_poll' }],
        ADAPTER_FACTORIES,
      ),
    /unregistered platform "telegram"/,
  );
});

test('SECURITY: the declared capability sets are honest — each adapter instance implements exactly what its declaration claims', () => {
  // Typed through the contract so the optional-method probes below are
  // legal on providers whose class never declares them.
  const discord: PlatformAdapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const baileys: PlatformAdapter = new BaileysAdapter(BAILEYS_TEXT_PACK);
  const cloud: PlatformAdapter = new WhatsAppCloudAdapter(WHATSAPP_CLOUD_TEXT_PACK);

  // The instances expose the SAME admin-capability sets the factories
  // declare from (shared consts, so drift is impossible by construction).
  assert.equal(discord.adminCapabilities, DISCORD_ADMIN_CAPABILITIES);
  assert.equal(baileys.adminCapabilities, BAILEYS_ADMIN_CAPABILITIES);
  assert.equal(cloud.adminCapabilities, WHATSAPP_CLOUD_ADMIN_CAPABILITIES);

  // Each provider's tool-capability declaration is its admin capabilities
  // plus feature capabilities that MATCH the optional methods the instance
  // actually implements.
  const extras = (declared: ReadonlySet<string>, admin: ReadonlySet<string>) =>
    [...declared].filter((c) => !admin.has(c)).sort();
  // Presence probe for an OPTIONAL adapter method — reads via a plain record
  // so the reference never trips unbound-method lint (we probe, never call).
  const implementsMethod = (adapter: PlatformAdapter, name: string): boolean =>
    typeof (adapter as unknown as Record<string, unknown>)[name] === 'function';
  assert.deepEqual(extras(DISCORD_TOOL_CAPABILITIES, DISCORD_ADMIN_CAPABILITIES), [
    'list_events',
    'react_to_message',
  ]);
  assert.equal(implementsMethod(discord, 'reactToMessage'), true);
  assert.equal(implementsMethod(discord, 'listUpcomingEvents'), true);

  assert.deepEqual(extras(BAILEYS_TOOL_CAPABILITIES, BAILEYS_ADMIN_CAPABILITIES), ['react_to_message']);
  assert.equal(implementsMethod(baileys, 'reactToMessage'), true);
  assert.equal(
    implementsMethod(baileys, 'listUpcomingEvents'),
    false,
    'baileys must not grow list_events silently',
  );

  assert.deepEqual(extras(WHATSAPP_CLOUD_TOOL_CAPABILITIES, WHATSAPP_CLOUD_ADMIN_CAPABILITIES), [
    'react_to_message',
  ]);
  assert.equal(implementsMethod(cloud, 'reactToMessage'), true);
  assert.equal(
    implementsMethod(cloud, 'listUpcomingEvents'),
    false,
    'cloud must not grow list_events silently',
  );

  // The WhatsApp PLATFORM declaration is the union over its providers — so
  // availability never varies with provider selection, and a capability only
  // one provider implements stays declared (react_to_message's history).
  assert.deepEqual(
    [...WHATSAPP_TOOL_CAPABILITIES].sort(),
    [...new Set([...BAILEYS_TOOL_CAPABILITIES, ...WHATSAPP_CLOUD_TOOL_CAPABILITIES])].sort(),
  );
});

test('the factory registry mirrors the old index.ts composition: aligned descriptors, same construction order, adapters report their registered platform', () => {
  // Descriptors and factories cover the same platforms, in the same order.
  assert.deepEqual(KNOWN_PLATFORMS, ['discord', 'whatsapp']);
  assert.deepEqual(
    ADAPTER_FACTORIES.map((f) => f.platform),
    [...KNOWN_PLATFORMS],
  );
  assert.equal(PLATFORM_DESCRIPTORS.length, KNOWN_PLATFORMS.length);
  for (const factory of ADAPTER_FACTORIES) {
    assert.ok(descriptorFor(factory.platform), `${factory.platform}: factory without a descriptor`);
  }
  assert.equal(descriptorFor('telegram'), undefined);

  // Under this file's pinned env (WHATSAPP_PROVIDER=baileys, set in the
  // preamble precisely so CI's job-level 'disabled' can't change the
  // composition), building constructs Discord then Baileys — exactly the
  // adapters the old inline index.ts block constructed — and each reports
  // the platform it was registered under.
  const adapters = createConfiguredAdapters();
  assert.equal(adapters.length, 2);
  assert.ok(adapters[0] instanceof DiscordAdapter);
  assert.ok(adapters[1] instanceof BaileysAdapter);
  assert.deepEqual(
    adapters.map((a) => a.platform),
    ['discord', 'whatsapp'],
  );
});
