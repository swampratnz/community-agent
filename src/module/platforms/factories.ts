import { config } from '../../base/config.js';
import { logger } from '../../base/logger.js';
import type { PlatformAdapter } from '../../base/platforms/types.js';
import type { AdapterFactory } from '../../base/platforms/registry.js';
import { descriptorFor } from '../../base/platforms/registry.js';
import { DiscordAdapter, DISCORD_TOOL_CAPABILITIES } from '../../base/platforms/discord/adapter.js';
import { BaileysAdapter, BAILEYS_TOOL_CAPABILITIES } from '../../base/platforms/whatsapp/baileysAdapter.js';
import {
  WhatsAppCloudAdapter,
  WHATSAPP_CLOUD_TOOL_CAPABILITIES,
} from '../../base/platforms/whatsapp/cloudAdapter.js';
import { BAILEYS_TEXT_PACK, DISCORD_TEXT_PACK, WHATSAPP_CLOUD_TEXT_PACK } from './textPacks.js';
// Binds the community slash commands' Discord halves onto their registry
// entries at module scope. The Discord adapter drives registration/dispatch
// through the base mechanism (`discord/slashDispatch.ts`) and so no longer
// imports the commands themselves — this composition file is where they are
// pulled into the graph, before any adapter it builds can be started.
import './discord/slashCommands.js';

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
  }
  return adapters;
}
