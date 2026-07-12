import { config } from '../config.js';

/**
 * Exact secret values that must never leave the process in any outbound
 * message. Consumed by the adapters' send paths (see outbound.redactSecrets).
 * Empty/short values are ignored by redactSecrets, so unset optionals are safe.
 */
export function runtimeSecrets(): string[] {
  return [
    config.llm.oauthToken,
    config.discord.botToken,
    config.db.url,
    config.whatsapp.cloud.accessToken ?? '',
    config.whatsapp.cloud.verifyToken ?? '',
    config.whatsapp.cloud.appSecret ?? '',
    config.devTeam.authToken ?? '',
  ];
}
