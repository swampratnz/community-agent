import type {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { IncomingMessage, Platform } from '../platforms/types.js';
import type { Tier } from '../auth/rbac.js';
import type { WhatsAppTextCommandDeps } from '../commands.js';
import type { SlashCommandDeps } from '../platforms/discord/slashCommands.js';

// The base command-registry MECHANISM (agent-base plan §Phase-2 Stage 3a):
// the sentinel, the handler/binding/command types, the fail-loud
// registration slot the community command list (src/commands.ts) registers
// itself into at its own module's import time, and the Discord late-binding
// hook. No command content lives here — the router's WhatsApp `!` intercept
// and Discord slash registration both read whatever list was registered, so
// neither mechanism file imports the community commands module.

export type { WhatsAppTextCommandDeps } from '../commands.js';

/**
 * Sentinel a WhatsApp handler returns when the text simply isn't its command
 * — the dispatcher tries the next entry. Distinct from `null`, which means
 * "matched, but fall through to a normal agent turn" (the deliberate
 * no-denial-reply tier-gate behaviour: a WhatsApp group reply has no
 * ephemeral concept, so a bespoke denial would out an ineligible caller's
 * tier to the whole group — see the router call site's comment).
 */
export const TEXT_COMMAND_UNMATCHED: unique symbol = Symbol('whatsapp-text-command-unmatched');

export type WhatsAppTextCommandHandler = (
  text: string,
  msg: IncomingMessage,
  role: Tier,
  deps: WhatsAppTextCommandDeps,
) => Promise<string | null | typeof TEXT_COMMAND_UNMATCHED>;

/** The Discord half of a command: its slash registration JSON plus the deferred-ephemeral handler. */
export interface DiscordCommandBinding {
  build: () => RESTPostAPIChatInputApplicationCommandsJSONBody;
  handle: (interaction: ChatInputCommandInteraction, deps: SlashCommandDeps) => Promise<void>;
}

export interface RegisteredCommand {
  name: string;
  platforms: readonly Platform[];
  /**
   * WhatsApp `!` text handler (issue #859) — absent for Discord-only
   * commands (`/kb` is deliberately WhatsApp-absent:
   * `KNOWLEDGE_SHORTCUT_ENABLED` already gives WhatsApp an implicit,
   * similarity-matched equivalent, so a second literal-prefix path to the
   * same knowledge read would be redundant scope).
   *
   * Tier floors mirror each Discord handler's REAL minimum exactly:
   * `who_is_into`/`list_projects`/`community_digest` are structurally
   * reachable by every role (including guest) via `toolsForRole` — none of
   * them are Discord-only tools — so `atLeast(role, 'member')` alone is
   * equivalent to Discord's own `toolsForRole(...).includes(...) ||
   * !atLeast(...)` check for these three. `community_guidelines` has no tier
   * floor in either handler.
   */
  whatsapp?: WhatsAppTextCommandHandler;
  /** Bound by slashCommands.ts at Discord module load (`bindDiscordCommand`) — see the file doc above. */
  discord?: DiscordCommandBinding;
}

let registered: readonly RegisteredCommand[] | undefined;

/**
 * Register THE command list — called exactly once, by the community commands
 * module (src/commands.ts) at its own module scope, mirroring
 * `registerNoticePack`/`registerToolTiers`. Double registration throws (two
 * modules both claiming to be the command list is a wiring bug, never a
 * merge), and the stored list is a frozen shallow copy so no later mutation
 * of the caller's array can change what the dispatchers see —
 * `bindDiscordCommand` below attaches each entry's Discord half in place,
 * which a shallow freeze deliberately still permits.
 */
export function registerCommands(commands: readonly RegisteredCommand[]): void {
  if (registered) {
    throw new Error('registerCommands: a command list is already registered — it can only be set once');
  }
  registered = Object.freeze([...commands]);
}

/**
 * The registered command list, for the two command surfaces (the router's
 * WhatsApp `!` intercept and Discord slash registration/dispatch). Fails
 * LOUD — never an empty roster — when no list has been registered: silence
 * here would mean every command quietly stopped matching because a
 * composition root forgot the side-effect import.
 */
export function registeredCommands(): readonly RegisteredCommand[] {
  if (!registered) {
    throw new Error(
      'registeredCommands: no command list registered — import the community commands module ' +
        '(src/commands.ts) before using a command surface',
    );
  }
  return registered;
}

/**
 * Attach a command's Discord half. Called from slashCommands.ts at module
 * scope, once per command; rejects unknown names (a binding must correspond
 * to a registry entry that declares the discord platform) and double binds.
 */
export function bindDiscordCommand(name: string, binding: DiscordCommandBinding): void {
  const command = registeredCommands().find((c) => c.name === name && c.platforms.includes('discord'));
  if (!command) throw new Error(`bindDiscordCommand: no registry entry for Discord command "${name}"`);
  if (command.discord) throw new Error(`bindDiscordCommand: "${name}" is already bound`);
  command.discord = binding;
}
