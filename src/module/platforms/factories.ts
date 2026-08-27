import { config } from '@swampratnz/agent-base/config.js';
import { logger } from '@swampratnz/agent-base/logger.js';
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';
import type { AdapterFactory } from '@swampratnz/agent-base/platforms/registry.js';
import { descriptorFor } from '@swampratnz/agent-base/platforms/registry.js';
import {
  DiscordAdapter,
  DISCORD_TOOL_CAPABILITIES,
} from '@swampratnz/agent-base/platforms/discord/adapter.js';
import {
  BaileysAdapter,
  BAILEYS_TOOL_CAPABILITIES,
} from '@swampratnz/agent-base/platforms/whatsapp/baileysAdapter.js';
import {
  WhatsAppCloudAdapter,
  WHATSAPP_CLOUD_TOOL_CAPABILITIES,
} from '@swampratnz/agent-base/platforms/whatsapp/cloudAdapter.js';
import { BAILEYS_TEXT_PACK, DISCORD_TEXT_PACK, WHATSAPP_CLOUD_TEXT_PACK } from './textPacks.js';
// The Discord adapter drives registration/dispatch through the base mechanism
// (`discord/slashDispatch.ts`) and so no longer imports the commands itself.
// Binding is CALLED below, from createConfiguredAdapters — never done at
// module scope, because binding reads the command list and `createAgent`
// registers that list from the manifest well after this module has been
// evaluated as part of index.ts's static import graph.
import { bindCommunitySlashCommands } from './discord/slashCommands.js';
// Same rationale, WhatsApp side (issue #1194): `!admindigest` needs the live
// WhatsApp adapter, and commands.ts's WhatsApp handlers are the fixed,
// zero-adapter WhatsAppTextCommandDeps shape — called below, never at module
// scope, for the identical reason bindCommunitySlashCommands is.
import { bindCommunityWhatsAppAdapter } from '../commands.js';

/**
 * The adapter factory registrations (agent-base plan item 9, §3 `adapters`
 * row) — the heavy half of the platform registry (see registry.ts for the
 * split), and the composition file a community module will eventually own.
 * `index.ts` no longer constructs adapters or switches on the WhatsApp
 * provider; it calls {@link createConfiguredAdapters}.
 */

/**
 * WhatsApp's platform-level tool-capability declaration: the UNION over its
 * selectable providers (Baileys ∪ Cloud), because tool availability is
 * per-platform and must not vary with the deployment's provider choice —
 * a capability only one provider implements (e.g. Baileys' `kick_user`,
 * historically react_to_message) is declared here and feature-checked in the
 * tool handler at runtime, exactly as those handlers always have.
 */
export const WHATSAPP_TOOL_CAPABILITIES: ReadonlySet<string> = new Set([
  ...BAILEYS_TOOL_CAPABILITIES,
  ...WHATSAPP_CLOUD_TOOL_CAPABILITIES,
]);

/**
 * The provider switch that used to live inline in index.ts step 3, verbatim
 * semantics: `baileys` and `cloud` select their adapter; anything else (the
 * `'disabled'` enum value) logs the same warning and yields no adapter. Each
 * provider is handed its own community text pack (agent-base plan item 6) —
 * the adapters carry no default of their own.
 */
function createWhatsAppAdapter(): PlatformAdapter | null {
  if (config.whatsapp.provider === 'baileys') return new BaileysAdapter(BAILEYS_TEXT_PACK);
  if (config.whatsapp.provider === 'cloud') return new WhatsAppCloudAdapter(WHATSAPP_CLOUD_TEXT_PACK);
  logger.warn('WhatsApp provider disabled');
  return null;
}

/**
 * Every adapter factory this codebase ships, in the exact construction order
 * index.ts used (Discord first, then WhatsApp). Adding a platform = one
 * entry here + a descriptor in registry.ts.
 */
export const ADAPTER_FACTORIES: readonly AdapterFactory[] = [
  {
    platform: 'discord',
    toolCapabilities: DISCORD_TOOL_CAPABILITIES,
    create: () => new DiscordAdapter(DISCORD_TEXT_PACK),
  },
  {
    platform: 'whatsapp',
    toolCapabilities: WHATSAPP_TOOL_CAPABILITIES,
    create: createWhatsAppAdapter,
  },
];

/**
 * Build every enabled adapter from the factory registry, in registration
 * order. Fail-fast composition checks (never reachable in a correctly
 * registered build, cheap insurance while the registry is young): each
 * factory's platform must have a descriptor, and a created adapter must
 * report the platform it was registered under — an adapter smuggled in under
 * the wrong key would otherwise corrupt the router's per-platform lookup.
 */
export function createConfiguredAdapters(): PlatformAdapter[] {
  const adapters: PlatformAdapter[] = [];
  for (const factory of ADAPTER_FACTORIES) {
    if (!descriptorFor(factory.platform)) {
      throw new Error(`Adapter factory "${factory.platform}" has no registered platform descriptor`);
    }
    const adapter = factory.create();
    if (adapter === null) continue;
    if (adapter.platform !== factory.platform) {
      throw new Error(
        `Adapter factory "${factory.platform}" created an adapter reporting platform "${adapter.platform}"`,
      );
    }
    adapters.push(adapter);
    // Bind the slash commands' Discord halves right after the Discord adapter
    // is constructed (issue #1004) — still strictly before any adapter starts
    // listening for interactions (construction alone doesn't attach
    // listeners; that happens later in index.ts's startup sequence), so the
    // original guarantee ("after createAgent registered the command list,
    // before dispatch is possible") is preserved. This is the first command
    // whose data source is an adapter method rather than a repository read
    // (`/events` → `adapter.listUpcomingEvents`), so binding now needs the
    // live Discord adapter instance threaded in, not just the command list.
    // Doing this at module scope instead threw at startup (#961), because
    // static imports are evaluated before index.ts's body runs at all.
    if (factory.platform === 'discord') {
      bindCommunitySlashCommands(adapter);
    }
    // Same need, WhatsApp side (issue #1194): `!admindigest` calls
    // `buildAdminDigestForAdmin`, which needs a live `PlatformAdapter` for
    // `adapter.conversationsForUser` — captured here, before any WhatsApp
    // message can be routed to the command dispatcher.
    if (factory.platform === 'whatsapp') {
      bindCommunityWhatsAppAdapter(adapter);
    }
  }
  return adapters;
}
