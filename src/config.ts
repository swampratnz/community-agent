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
  DISCORD_ALLOWED_CHANNEL_IDS: z.string().optional(),
  // Welcome message for new server joiners; off unless explicitly enabled.
  DISCORD_WELCOME_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Fallback text channel to post the welcome in if the DM fails (e.g. DMs closed).
  DISCORD_WELCOME_CHANNEL_ID: z.string().optional(),

  // WhatsApp
  WHATSAPP_PROVIDER: z.enum(['baileys', 'cloud', 'disabled']).default('baileys'),
  WHATSAPP_AUTH_DIR: z.string().default('./whatsapp-auth'),
  WHATSAPP_ALLOWED_JIDS: z.string().optional(),

  // RBAC: super admins are env-bootstrapped (never grantable via chat).
  SUPER_ADMIN_DISCORD_IDS: z.string().optional(),
  SUPER_ADMIN_WHATSAPP_NUMBERS: z.string().optional(),
  // Access mode per platform: 'gated' = only registered members get replies.
  ACCESS_MODE_DISCORD: z.enum(['gated', 'open']).default('gated'),
  ACCESS_MODE_WHATSAPP: z.enum(['gated', 'open']).default('gated'),
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_CLOUD_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_CLOUD_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_CLOUD_APP_SECRET: z.string().optional(),
  WHATSAPP_CLOUD_WEBHOOK_PORT: z.coerce.number().int().positive().default(8080),

  // Database
  DATABASE_URL: z.string().min(1),
  EMBEDDING_MODEL: z.string().default('Xenova/all-MiniLM-L6-v2'),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(384),

  // Behaviour
  MEMORY_TOP_K: z.coerce.number().int().nonnegative().default(6),
  // Max agent replies per user per rolling 24h (0 = unlimited).
  DAILY_REPLY_LIMIT_PER_USER: z.coerce.number().int().nonnegative().default(50),
  // Session hygiene: start a fresh Claude session past either cap.
  SESSION_MAX_TURNS: z.coerce.number().int().positive().default(30),
  SESSION_MAX_AGE_HOURS: z.coerce.number().positive().default(24),
  // Age-based purge of raw `interactions` content. Unset/0 = disabled (no
  // behaviour change on upgrade). knowledge/admin_audit/sessions are never
  // touched by this — see storage/repository.ts:purgeOldInteractions.
  INTERACTION_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),
  // Sustained platform disconnect -> one debounced super-admin DM alert.
  HEALTH_ALERT_AFTER_MINUTES: z.coerce.number().positive().default(5),
  // Proactive super-admin alert when rolling-24h outbound reply count
  // reaches this threshold — a coarse proxy for shared Max-pool draw (short
  // vs long replies draw differently; tune to your traffic). Unset/0 =
  // disabled (no timer, no behaviour change on upgrade).
  USAGE_ALERT_DAILY_REPLIES: z.coerce.number().int().nonnegative().default(0),
  // /healthz endpoint (native http, no auth). Unset = disabled; bind to
  // localhost via reverse proxy if you expose it, like the Cloud webhook.
  HEALTH_PORT: z.coerce.number().int().positive().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_PRETTY: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

// Retention must stay well clear of the active-conversation window
// (SESSION_MAX_AGE_HOURS) so a low value can't silently gut memory recall
// for users still mid-conversation.
const MIN_INTERACTION_RETENTION_DAYS = 7;

const EnvSchemaChecked = EnvSchema.refine(
  (e) =>
    e.WHATSAPP_PROVIDER !== 'cloud' ||
    (e.WHATSAPP_CLOUD_PHONE_NUMBER_ID &&
      e.WHATSAPP_CLOUD_ACCESS_TOKEN &&
      e.WHATSAPP_CLOUD_VERIFY_TOKEN &&
      e.WHATSAPP_CLOUD_APP_SECRET),
  {
    message:
      'WHATSAPP_PROVIDER=cloud requires WHATSAPP_CLOUD_PHONE_NUMBER_ID, WHATSAPP_CLOUD_ACCESS_TOKEN, ' +
      'WHATSAPP_CLOUD_VERIFY_TOKEN, and WHATSAPP_CLOUD_APP_SECRET',
    path: ['WHATSAPP_PROVIDER'],
  },
).refine((e) => e.INTERACTION_RETENTION_DAYS === 0 || e.INTERACTION_RETENTION_DAYS >= MIN_INTERACTION_RETENTION_DAYS, {
  message: `INTERACTION_RETENTION_DAYS must be 0 (disabled) or at least ${MIN_INTERACTION_RETENTION_DAYS}`,
  path: ['INTERACTION_RETENTION_DAYS'],
});

const parsed = EnvSchemaChecked.safeParse(process.env);
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
    allowedChannelIds: csv(env.DISCORD_ALLOWED_CHANNEL_IDS),
    welcome: {
      enabled: env.DISCORD_WELCOME_ENABLED ?? false,
      channelId: env.DISCORD_WELCOME_CHANNEL_ID,
    },
  },
  whatsapp: {
    provider: env.WHATSAPP_PROVIDER,
    authDir: env.WHATSAPP_AUTH_DIR,
    allowedJids: csv(env.WHATSAPP_ALLOWED_JIDS),
    cloud: {
      phoneNumberId: env.WHATSAPP_CLOUD_PHONE_NUMBER_ID,
      accessToken: env.WHATSAPP_CLOUD_ACCESS_TOKEN,
      verifyToken: env.WHATSAPP_CLOUD_VERIFY_TOKEN,
      appSecret: env.WHATSAPP_CLOUD_APP_SECRET,
      webhookPort: env.WHATSAPP_CLOUD_WEBHOOK_PORT,
    },
  },
  db: {
    url: env.DATABASE_URL,
    embeddingModel: env.EMBEDDING_MODEL,
    embeddingDim: env.EMBEDDING_DIM,
  },
  rbac: {
    superAdminDiscordIds: csv(env.SUPER_ADMIN_DISCORD_IDS),
    superAdminWhatsappNumbers: csv(env.SUPER_ADMIN_WHATSAPP_NUMBERS),
    accessMode: {
      discord: env.ACCESS_MODE_DISCORD,
      whatsapp: env.ACCESS_MODE_WHATSAPP,
    } as Record<'discord' | 'whatsapp', 'gated' | 'open'>,
  },
  behaviour: {
    memoryTopK: env.MEMORY_TOP_K,
    dailyReplyLimitPerUser: env.DAILY_REPLY_LIMIT_PER_USER,
    sessionMaxTurns: env.SESSION_MAX_TURNS,
    sessionMaxAgeHours: env.SESSION_MAX_AGE_HOURS,
    interactionRetentionDays: env.INTERACTION_RETENTION_DAYS,
    healthAlertAfterMinutes: env.HEALTH_ALERT_AFTER_MINUTES,
    healthPort: env.HEALTH_PORT,
    usageAlertDailyReplies: env.USAGE_ALERT_DAILY_REPLIES,
  },
  log: {
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY ?? false,
  },
} as const;

export type Config = typeof config;
