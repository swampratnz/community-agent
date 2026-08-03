import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { emptyStringsToUndefined, normalizedEnv, type EnvRefinement } from './config/env.js';
import { alertsRefinements, alertsSlice } from './config/alerts.js';
import { behaviourRefinements, behaviourSlice } from './config/behaviour.js';
import { dbSection, dbSlice } from './config/db.js';
import { discordSlice } from './config/discord.js';
import { integrationsRefinements, integrationsSlice } from './config/integrations.js';
import { knowledgeSlice } from './config/knowledge.js';
import { llmSlice } from './config/llm.js';
import { logSection, logSlice } from './config/log.js';
import { moderationSlice } from './config/moderation.js';
import { rbacSlice } from './config/rbac.js';
import { whatsappRefinements, whatsappSlice } from './config/whatsapp.js';

// The blank-env normaliser lives in config/env.ts (shared with the boot path);
// re-exported here so existing importers keep working unchanged.
export { emptyStringsToUndefined };

/** Parse a comma-separated env var into a trimmed, non-empty string array. */
function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// The full environment schema, composed from the per-domain slice fragments
// in src/config/ — each var's zod chain (and its doc comment) lives with its
// domain there; this barrel only merges, cross-checks, and parses.
const EnvSchema = z.object({
  ...llmSlice,
  ...discordSlice,
  ...moderationSlice,
  ...integrationsSlice,
  ...whatsappSlice,
  ...rbacSlice,
  ...dbSlice,
  ...behaviourSlice,
  ...alertsSlice,
  ...knowledgeSlice,
  ...logSlice,
});

type ParsedEnv = z.infer<typeof EnvSchema>;

// Slice-LOCAL refinements travel with their slice as data (see EnvRefinement)
// and are applied to the merged schema here. Each one's predicate only sees
// its own slice's keys by construction.
const sliceRefinements: EnvRefinement<ParsedEnv>[] = [
  ...whatsappRefinements,
  ...behaviourRefinements,
  ...alertsRefinements,
  ...integrationsRefinements,
];

const EnvSchemaChecked = sliceRefinements
  .reduce((schema, r) => schema.refine(r.check, r.params), EnvSchema)
  .refine((e) => e.AGENT_TURN_TIMEOUT_MS > e.IMAGE_GEN_TIMEOUT_MS, {
    // The one CROSS-slice refine (behaviour vs integrations), so it lives
    // here rather than with either slice. The turn ceiling is the OUTER bound
    // around a whole turn; image generation is an inner tool call with its
    // own timeout. Set the outer one at or below the inner one and a
    // legitimately in-flight image-gen turn is killed before its own timeout
    // can fire — the exact bug class the 300_000 default was chosen to avoid
    // (issue #826 review). Pinning only the shipped default in a unit test
    // does not stop an operator tightening AGENT_TURN_TIMEOUT_MS in .env and
    // silently reintroducing it, so fail fast at startup, same as the
    // KNOWLEDGE_STALE_MAX_AGE_DAYS vs KNOWLEDGE_STALE_DAYS pairing.
    message:
      'AGENT_TURN_TIMEOUT_MS must be strictly greater than IMAGE_GEN_TIMEOUT_MS, or the outer turn ceiling can kill an in-flight image-generation tool call before its own timeout fires',
    path: ['AGENT_TURN_TIMEOUT_MS'],
  });

/** Shape the parsed env into the exported config object (single source of its shape). */
function buildConfig(env: ParsedEnv) {
  return {
    llm: {
      oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
      model: env.AGENT_MODEL,
      memberModel: env.AGENT_MODEL_MEMBER,
      classifierModel: env.AGENT_MODEL_CLASSIFIER,
      fallbackModel: env.AGENT_MODEL_FALLBACK,
      maxTurns: env.AGENT_MAX_TURNS,
      memberMaxTurns: env.AGENT_MAX_TURNS_MEMBER,
      webSearchRateLimitPerHour: env.AGENT_WEB_SEARCH_RATE_LIMIT_PER_HOUR,
      webSearchDedupWindowSeconds: env.AGENT_WEB_SEARCH_DEDUP_WINDOW_SECONDS,
      webSearchDedupHistorySize: env.AGENT_WEB_SEARCH_DEDUP_HISTORY_SIZE,
      webSearchDedupSimilarityThreshold: env.AGENT_WEB_SEARCH_DEDUP_SIMILARITY_THRESHOLD,
    },
    agentSkills: {
      enabled: env.AGENT_SKILLS_ENABLED ?? false,
    },
    discord: {
      botToken: env.DISCORD_BOT_TOKEN,
      guildId: env.DISCORD_GUILD_ID,
      allowedChannelIds: csv(env.DISCORD_ALLOWED_CHANNEL_IDS),
      welcome: {
        enabled: env.DISCORD_WELCOME_ENABLED ?? false,
        channelId: env.DISCORD_WELCOME_CHANNEL_ID,
      },
      autoEnrollMembers: env.DISCORD_AUTO_ENROLL_MEMBERS ?? false,
      archiveAllMessages: env.DISCORD_ARCHIVE_ALL_MESSAGES ?? false,
      assignableRoleIds: csv(env.DISCORD_ASSIGNABLE_ROLES),
      slashCommandsEnabled: env.DISCORD_SLASH_COMMANDS_ENABLED ?? false,
      autoAnswerChannelIds: csv(env.AUTO_ANSWER_CHANNEL_IDS),
      autoAnswerRateLimitPerHour: env.AUTO_ANSWER_RATE_LIMIT_PER_HOUR,
      voice: {
        enabled: env.DISCORD_VOICE_ENABLED ?? false,
        model: env.DISCORD_VOICE_MODEL,
        maxSeconds: env.DISCORD_VOICE_MAX_SECONDS,
        minRole: env.DISCORD_VOICE_MIN_ROLE,
        rateLimitPerHour: env.DISCORD_VOICE_RATE_LIMIT_PER_HOUR,
      },
      image: {
        enabled: env.IMAGE_INPUT_ENABLED ?? false,
        minRole: env.IMAGE_INPUT_MIN_ROLE,
        maxBytes: env.IMAGE_INPUT_MAX_BYTES,
        dailyLimitPerUser: env.IMAGE_INPUT_DAILY_LIMIT_PER_USER,
      },
    },
    moderation: {
      enabled: env.DISCORD_MODERATION_ENABLED ?? false,
      badWords: csv(env.MODERATION_BAD_WORDS),
      strikeLimit: env.MODERATION_STRIKE_LIMIT,
      strikeWindowDays: env.MODERATION_STRIKE_WINDOW_DAYS,
      mutedRoleName: env.MODERATION_MUTED_ROLE_NAME,
      adminChannelName: env.MODERATION_ADMIN_CHANNEL_NAME,
      llmAbuseEnabled: env.MODERATION_LLM_ABUSE_ENABLED ?? false,
      appealCooldownHours: env.MODERATION_APPEAL_COOLDOWN_HOURS,
      alertRateLimitPerHour: env.MODERATION_ALERT_RATE_LIMIT_PER_HOUR,
    },
    github: {
      enabled: env.GITHUB_ISSUE_ENABLED ?? false,
      repo: env.GITHUB_ISSUE_REPO,
      token: env.GITHUB_ISSUE_TOKEN,
      labels: csv(env.GITHUB_ISSUE_LABELS),
      dailyLimit: env.GITHUB_ISSUE_DAILY_LIMIT,
    },
    imageGen: {
      enabled: env.IMAGE_GEN_ENABLED ?? false,
      grokBin: env.GROK_BIN,
      timeoutMs: env.IMAGE_GEN_TIMEOUT_MS,
      dailyLimit: env.IMAGE_GEN_DAILY_LIMIT,
    },
    devTeam: {
      enabled: env.DEV_TEAM_ENABLED ?? false,
      endpointUrl: env.DEV_TEAM_ENDPOINT_URL,
      authToken: env.DEV_TEAM_AUTH_TOKEN,
      watchPollMinutes: env.DEV_TEAM_WATCH_POLL_MINUTES,
      dailyLimit: env.DEV_TEAM_DAILY_LIMIT,
    },
    whatsapp: {
      provider: env.WHATSAPP_PROVIDER,
      authDir: env.WHATSAPP_AUTH_DIR,
      allowedJids: csv(env.WHATSAPP_ALLOWED_JIDS),
      maxReconnectAttempts: env.WHATSAPP_MAX_RECONNECT_ATTEMPTS,
      welcome: {
        enabled: env.WHATSAPP_WELCOME_ENABLED ?? false,
        cooldownMinutes: env.WHATSAPP_WELCOME_COOLDOWN_MINUTES,
      },
      archiveGroupJids: csv(env.WHATSAPP_ARCHIVE_GROUP_JIDS),
      archiveAllGroups: env.WHATSAPP_ARCHIVE_ALL_GROUPS ?? false,
      voice: {
        enabled: env.WHATSAPP_VOICE_ENABLED ?? false,
        model: env.WHATSAPP_VOICE_MODEL,
        maxSeconds: env.WHATSAPP_VOICE_MAX_SECONDS,
        minRole: env.WHATSAPP_VOICE_MIN_ROLE,
        rateLimitPerHour: env.WHATSAPP_VOICE_RATE_LIMIT_PER_HOUR,
      },
      image: {
        enabled: env.WHATSAPP_IMAGE_INPUT_ENABLED ?? false,
        minRole: env.WHATSAPP_IMAGE_INPUT_MIN_ROLE,
        maxBytes: env.WHATSAPP_IMAGE_INPUT_MAX_BYTES,
        dailyLimitPerUser: env.WHATSAPP_IMAGE_INPUT_DAILY_LIMIT_PER_USER,
      },
      cloud: {
        phoneNumberId: env.WHATSAPP_CLOUD_PHONE_NUMBER_ID,
        accessToken: env.WHATSAPP_CLOUD_ACCESS_TOKEN,
        verifyToken: env.WHATSAPP_CLOUD_VERIFY_TOKEN,
        appSecret: env.WHATSAPP_CLOUD_APP_SECRET,
        webhookPort: env.WHATSAPP_CLOUD_WEBHOOK_PORT,
        welcomeEnabled: env.WHATSAPP_CLOUD_WELCOME_ENABLED ?? false,
        image: {
          enabled: env.WHATSAPP_CLOUD_IMAGE_INPUT_ENABLED ?? false,
          minRole: env.WHATSAPP_CLOUD_IMAGE_INPUT_MIN_ROLE,
          maxBytes: env.WHATSAPP_CLOUD_IMAGE_INPUT_MAX_BYTES,
          dailyLimitPerUser: env.WHATSAPP_CLOUD_IMAGE_INPUT_DAILY_LIMIT_PER_USER,
        },
        voice: {
          enabled: env.WHATSAPP_CLOUD_VOICE_ENABLED ?? false,
          model: env.WHATSAPP_CLOUD_VOICE_MODEL,
          maxBytes: env.WHATSAPP_CLOUD_VOICE_MAX_BYTES,
          minRole: env.WHATSAPP_CLOUD_VOICE_MIN_ROLE,
          rateLimitPerHour: env.WHATSAPP_CLOUD_VOICE_RATE_LIMIT_PER_HOUR,
        },
      },
    },
    db: dbSection(env),
    rbac: {
      superAdminDiscordIds: csv(env.SUPER_ADMIN_DISCORD_IDS),
      superAdminWhatsappNumbers: csv(env.SUPER_ADMIN_WHATSAPP_NUMBERS),
      // Keyed by registered platform id; typed as an open string map since
      // `Platform` opened (agent-base plan item 9) so `accessMode[platform]`
      // stays indexable. Read only with adapter-envelope platforms, which
      // always name one of the two keys built here.
      accessMode: {
        discord: env.ACCESS_MODE_DISCORD,
        whatsapp: env.ACCESS_MODE_WHATSAPP,
      } as Record<string, 'gated' | 'open'>,
    },
    contextBuilder: {
      enabled: env.CONTEXT_BUILDER_ENABLED ?? false,
      windowDays: env.CONTEXT_BUILDER_WINDOW_DAYS,
      maxSummaries: env.CONTEXT_BUILDER_MAX_SUMMARIES,
      minDistinctUsers: env.CONTEXT_BUILDER_MIN_DISTINCT_USERS,
    },
    knowledgeRefresh: {
      enabled: env.KNOWLEDGE_REFRESH_ENABLED ?? false,
      maxTurns: env.KNOWLEDGE_REFRESH_MAX_TURNS,
    },
    docsIngest: {
      enabled: env.DOCS_INGEST_ENABLED ?? false,
      indexUrl: env.DOCS_INGEST_INDEX_URL,
      maxPages: env.DOCS_INGEST_MAX_PAGES,
      maxChunks: env.DOCS_INGEST_MAX_CHUNKS,
      concurrency: env.DOCS_INGEST_CONCURRENCY,
      excludePaths: csv(env.DOCS_INGEST_EXCLUDE_PATHS),
      deadUrlRuns: env.DOCS_INGEST_DEAD_URL_RUNS,
      deadUrlRecheckDays: env.DOCS_INGEST_DEAD_URL_RECHECK_DAYS,
    },
    knowledgeLinkCheck: {
      enabled: env.KNOWLEDGE_LINK_CHECK_ENABLED ?? false,
    },
    statusCheck: {
      enabled: env.STATUS_CHECK_ENABLED ?? false,
      apiUrl: env.STATUS_CHECK_API_URL,
      pollMinutes: env.STATUS_CHECK_POLL_MINUTES,
    },
    contextCandidates: {
      enabled: env.CONTEXT_CANDIDATES_ENABLED ?? false,
    },
    knowledgeAnswerCandidate: {
      enabled: env.KNOWLEDGE_ANSWER_CANDIDATE_ENABLED ?? false,
    },
    contextExport: {
      enabled: env.CONTEXT_EXPORT_ENABLED ?? false,
      windowDays: env.CONTEXT_EXPORT_WINDOW_DAYS,
      minDistinctUsers: env.CONTEXT_EXPORT_MIN_DISTINCT_USERS,
      path: env.CONTEXT_EXPORT_PATH,
    },
    adminDigest: {
      enabled: env.ADMIN_DIGEST_ENABLED ?? false,
      trendsEnabled: env.ADMIN_DIGEST_TRENDS_ENABLED ?? false,
      knowledgeStaleDays: env.KNOWLEDGE_STALE_DAYS,
      knowledgeStaleMaxAgeDays: env.KNOWLEDGE_STALE_MAX_AGE_DAYS,
      knowledgeCandidateStaleDays: env.KNOWLEDGE_CANDIDATE_STALE_DAYS,
    },
    departedAdminAlert: {
      enabled: env.DEPARTED_ADMIN_ALERT_ENABLED ?? false,
    },
    engagementAlert: {
      enabled: env.ENGAGEMENT_ALERT_ENABLED ?? false,
    },
    adminLeverageAlert: {
      enabled: env.ADMIN_LEVERAGE_ALERT_ENABLED ?? false,
    },
    knowledgeGapAlert: {
      enabled: env.KNOWLEDGE_GAP_ALERT_ENABLED ?? false,
      threshold: env.KNOWLEDGE_GAP_ALERT_THRESHOLD,
      rateLimitPerHour: env.KNOWLEDGE_GAP_ALERT_RATE_LIMIT_PER_HOUR,
    },
    knowledgeStaleAlert: {
      enabled: env.KNOWLEDGE_STALE_ALERT_ENABLED ?? false,
      rateLimitPerHour: env.KNOWLEDGE_STALE_ALERT_RATE_LIMIT_PER_HOUR,
    },
    repeatQuestionAlert: {
      enabled: env.REPEAT_QUESTION_ALERT_ENABLED ?? false,
      threshold: env.REPEAT_QUESTION_ALERT_THRESHOLD,
      rateLimitPerHour: env.REPEAT_QUESTION_ALERT_RATE_LIMIT_PER_HOUR,
      cooldownMinutes: env.REPEAT_QUESTION_ALERT_COOLDOWN_MINUTES,
    },
    accessRequestAlert: {
      enabled: env.ACCESS_REQUEST_ALERT_ENABLED ?? false,
      rateLimitPerHour: env.ACCESS_REQUEST_ALERT_RATE_LIMIT_PER_HOUR,
    },
    usageCostDigest: {
      enabled: env.USAGE_COST_DIGEST_ENABLED ?? false,
    },
    backgroundJobCostAlert: {
      enabled: env.BACKGROUND_JOB_COST_ALERT_ENABLED ?? false,
      multiplier: env.BACKGROUND_JOB_COST_ALERT_MULTIPLIER,
      minUsd: env.BACKGROUND_JOB_COST_ALERT_MIN_USD,
    },
    memberDigest: {
      enabled: env.MEMBER_DIGEST_ENABLED ?? false,
      channelId: env.MEMBER_DIGEST_CHANNEL_ID,
      minDistinctUsers: env.MEMBER_DIGEST_MIN_DISTINCT_USERS,
    },
    releaseWatch: {
      enabled: env.RELEASE_WATCH_ENABLED ?? false,
      docPaths: csv(env.RELEASE_WATCH_DOC_PATHS),
    },
    findHelper: {
      enabled: env.FIND_HELPER_ENABLED ?? false,
    },
    behaviour: {
      memoryTopK: env.MEMORY_TOP_K,
      memoryRelevanceThreshold: env.MEMORY_RELEVANCE_THRESHOLD,
      dailyReplyLimitPerUser: env.DAILY_REPLY_LIMIT_PER_USER,
      sessionMaxTurns: env.SESSION_MAX_TURNS,
      sessionMaxAgeHours: env.SESSION_MAX_AGE_HOURS,
      sessionRolloverTailCount: env.SESSION_ROLLOVER_TAIL_COUNT,
      agentTurnTimeoutMs: env.AGENT_TURN_TIMEOUT_MS,
      maxIncomingMessageChars: env.MAX_INCOMING_MESSAGE_CHARS,
      interactionRetentionDays: env.INTERACTION_RETENTION_DAYS,
      rosterDepartedRetentionDays: env.ROSTER_DEPARTED_RETENTION_DAYS,
      accessRequestRetentionDays: env.ACCESS_REQUEST_RETENTION_DAYS,
      healthAlertAfterMinutes: env.HEALTH_ALERT_AFTER_MINUTES,
      healthPort: env.HEALTH_PORT,
      healthHost: env.HEALTH_HOST,
      usageAlertDailyReplies: env.USAGE_ALERT_DAILY_REPLIES,
      upstreamLimitAlertEnabled: env.UPSTREAM_LIMIT_ALERT_ENABLED ?? false,
      ackShortcutEnabled: env.ACK_SHORTCUT_ENABLED ?? false,
      knowledgeShortcutEnabled: env.KNOWLEDGE_SHORTCUT_ENABLED ?? false,
      knowledgeShortcutThreshold: env.KNOWLEDGE_SHORTCUT_THRESHOLD,
      knowledgeLowRatedCaveatMinUnhelpful: env.KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL,
      knowledgeTopicsListLimit: env.KNOWLEDGE_TOPICS_LIST_LIMIT,
      guestKnowledgeShortcutEnabled: env.GUEST_KNOWLEDGE_SHORTCUT_ENABLED ?? false,
      repeatQuestionShortcutEnabled: env.REPEAT_QUESTION_SHORTCUT_ENABLED ?? false,
      repeatMaxTurnsShortcutEnabled: env.REPEAT_MAX_TURNS_SHORTCUT_ENABLED ?? false,
      whatsappTextCommandsEnabled: env.WHATSAPP_TEXT_COMMANDS_ENABLED ?? false,
      escalationToAdminEnabled: env.ESCALATION_TO_ADMIN_ENABLED ?? false,
      dailyReplyBudgetWarnEnabled: env.DAILY_REPLY_BUDGET_WARN_ENABLED ?? false,
      dailyReplyBudgetWarnRemaining: env.DAILY_REPLY_BUDGET_WARN_REMAINING,
      autoRetractReplyEnabled: env.AUTO_RETRACT_REPLY_ENABLED ?? false,
      shutdownDrainTimeoutMs: env.SHUTDOWN_DRAIN_TIMEOUT_MS,
    },
    log: logSection(env),
  } as const;
}

const parsed = EnvSchemaChecked.safeParse(normalizedEnv);
if (!parsed.success) {
  // Fail fast with a readable message rather than crashing deep inside a module.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = buildConfig(parsed.data);

export type Config = typeof config;

/**
 * Pure variant of the singleton parse above for tests/tooling: validates the
 * GIVEN env (blank-normalised the same way, but no dotenv load and no
 * process.exit) against the full merged schema and returns a Config-shaped
 * object. On failure it THROWS one Error whose message aggregates every
 * issue, mirroring the console output of the fail-fast path.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = EnvSchemaChecked.safeParse(emptyStringsToUndefined(env));
  if (!result.success) {
    throw new Error(
      [
        'Invalid environment configuration:',
        ...result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`),
      ].join('\n'),
    );
  }
  return buildConfig(result.data);
}

/**
 * Absolute paths of THIS deployment's on-disk secrets: the bot's `.env` and
 * the WhatsApp auth dir (which may be configured relative — the default
 * `./whatsapp-auth` — so it resolves against cwd). Injected into
 * `media/grokImage.ts`'s kernel deny-list (issue #225's sandbox): the config
 * module owns what counts as a secret on disk, and the image-gen client just
 * denies whatever list it is handed — it has no knowledge of this bot's
 * secret layout. Parameterised (with production defaults) so tests can pin
 * the resolution rules without touching real env.
 */
export function onDiskSecretPaths(
  cwd: string = process.cwd(),
  authDir: string = config.whatsapp.authDir,
): string[] {
  return [join(cwd, '.env'), isAbsolute(authDir) ? authDir : join(cwd, authDir)];
}
