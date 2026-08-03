import type { Client, Interaction } from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { registeredCommands, type SlashCommandDeps } from '../../commands/registry.js';

/**
 * The Discord slash-command MECHANISM (agent-base plan §Phase-2 Stage 4):
 * registration and dispatch, driven entirely by whatever command list was
 * registered into `commands/registry.ts`. No command content lives here —
 * the handlers and their registration JSON are the module's
 * (`platforms/discord/slashCommands.ts`), bound onto their registry entries
 * at that module's own import time, which is what lets the adapter own the
 * two Discord-client hooks below without importing a single community
 * command.
 */

/**
 * Every registered command's Discord registration JSON, in registry order —
 * the exact order this function has always returned. A command with no
 * Discord half bound is skipped, so an unimported (or platform-absent)
 * command surface simply registers nothing.
 */
export function buildSlashCommands() {
  return registeredCommands().flatMap((command) => (command.discord ? [command.discord.build()] : []));
}

/**
 * Guild-scoped registration on `ClientReady` (never global — this deployment
 * is single-guild, and global registration propagates over up to an hour and
 * widens exposure to any guild the bot token might ever join). Fire-and-
 * forget, same shape as `backfillRoster`/`reconcileMutedRole`: a registration
 * failure must never block message handling.
 */
export async function registerSlashCommands(client: Client): Promise<void> {
  try {
    if (!client.application) {
      logger.warn('Slash command registration skipped: client.application unavailable');
      return;
    }
    await client.application.commands.set(buildSlashCommands(), config.discord.guildId);
    logger.info('Discord slash commands registered');
  } catch (err) {
    logger.warn({ err }, 'Slash command registration failed');
  }
}

/** Route a chat-input interaction to its registry entry's bound handler; ignore anything else. */
export async function handleInteraction(interaction: Interaction, deps: SlashCommandDeps): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  const command = registeredCommands().find((c) => c.name === interaction.commandName);
  if (!command?.discord) return;
  await command.discord.handle(interaction, deps);
}
