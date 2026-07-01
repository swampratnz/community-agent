import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv({ quiet: true });

/** Parse a comma-separated env var into a trimmed, non-empty string array. */
function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const EnvSchema = z.object({
  // LLM / Claude
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1, 'CLAUDE_CODE_OAUTH_TOKEN is required (run `claude setup-token`)'),
  AGENT_MODEL: z.string().default('claude-sonnet-5'),
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(12),

  // Discord
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_ADMIN_ROLE_IDS: z.string().optional(),
  DISCORD_ADMIN_USER_IDS: z.string().optional(),
  DISCORD_ALLOWED_CHANNEL_IDS: z.string().optional(),

  // WhatsApp
  WHATSAPP_PROVIDER: z.enum(['baileys', 'cloud', 'disabled']).default('baileys'),
  WHATSAPP_AUTH_DIR: z.string().default('./whatsapp-auth'),
  WHATSAPP_ADMIN_NUMBERS: z.string().optional(),
  WHATSAPP_ALLOWED_JIDS: z.string().optional(),
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_CLOUD_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_CLOUD_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_CLOUD_WEBHOOK_PORT: z.coerce.number().int().positive().default(8080),

  // Database
  DATABASE_URL: z.string().min(1),
  EMBEDDING_MODEL: z.string().default('Xenova/all-MiniLM-L6-v2'),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(384),

  // Behaviour
  MEMORY_TOP_K: z.coerce.number().int().nonnegative().default(6),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_PRETTY: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable message rather than crashing deep inside a module.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

export const config = {
  llm: {
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    model: env.AGENT_MODEL,
    maxTurns: env.AGENT_MAX_TURNS,
  },
  discord: {
    botToken: env.DISCORD_BOT_TOKEN,
    guildId: env.DISCORD_GUILD_ID,
    adminRoleIds: csv(env.DISCORD_ADMIN_ROLE_IDS),
    adminUserIds: csv(env.DISCORD_ADMIN_USER_IDS),
    allowedChannelIds: csv(env.DISCORD_ALLOWED_CHANNEL_IDS),
  },
  whatsapp: {
    provider: env.WHATSAPP_PROVIDER,
    authDir: env.WHATSAPP_AUTH_DIR,
    adminNumbers: csv(env.WHATSAPP_ADMIN_NUMBERS),
    allowedJids: csv(env.WHATSAPP_ALLOWED_JIDS),
    cloud: {
      phoneNumberId: env.WHATSAPP_CLOUD_PHONE_NUMBER_ID,
      accessToken: env.WHATSAPP_CLOUD_ACCESS_TOKEN,
      verifyToken: env.WHATSAPP_CLOUD_VERIFY_TOKEN,
      webhookPort: env.WHATSAPP_CLOUD_WEBHOOK_PORT,
    },
  },
  db: {
    url: env.DATABASE_URL,
    embeddingModel: env.EMBEDDING_MODEL,
    embeddingDim: env.EMBEDDING_DIM,
  },
  behaviour: {
    memoryTopK: env.MEMORY_TOP_K,
  },
  log: {
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY ?? false,
  },
} as const;

export type Config = typeof config;
