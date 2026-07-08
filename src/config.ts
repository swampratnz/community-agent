import { isAbsolute } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv({ quiet: true });

// dotenv (and shell `set -a; . ./.env`) load a blank `KEY=` line as the empty
// string, not as absent. For every optional/coerced field that means "unset"
// silently becomes "0" or an invalid enum value instead of the intended
// default. Normalise blank values to undefined up front so optional env vars
// behave the same whether they're commented out or left empty.
export function emptyStringsToUndefined(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value === '' ? undefined : value;
  }
  return result;
}

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
  CLAUDE_CODE_OAUTH_TOKEN: z
    .string()
    .min(1, 'CLAUDE_CODE_OAUTH_TOKEN is required (run `claude setup-token`)'),
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
  // Ambient archiving (issue #48): store EVERY message in allowed guild
  // channels — including from gated-mode guests — not just messages that
  // address the bot. A deliberate privacy-posture change; requires visible
  // community notice BEFORE enabling (see SECURITY.md). Off by default.
  DISCORD_ARCHIVE_ALL_MESSAGES: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Cosmetic/community Discord roles (issue #232) — e.g. "verified builder",
  // regional tags — the bot may assign/remove via assign_community_role /
  // remove_community_role. Comma-separated Discord role ids, curated by a
  // human; strictly orthogonal to the bot's own RBAC tiers (see
  // docs/SECURITY.md). Unset/empty = feature fully off (both tools refuse
  // every roleId). This allowlist is necessary but NOT sufficient on its
  // own: a role's permission bitfield is re-checked live at assign time
  // (src/platforms/discord/adapter.ts), since it can change after curation.
  DISCORD_ASSIGNABLE_ROLES: z.string().optional(),
  // Auto-moderation (Discord): scan every message for bad language / abuse,
  // warn the member, and after MODERATION_STRIKE_LIMIT active strikes assign a
  // muted role that blocks posting until an admin clears their warnings. Off by
  // default — enabling it is a privacy-posture change (every message is
  // scanned) and requires the bot to have Manage Roles + Manage Channels (see
  // SECURITY.md). Admins and super admins are never warned or muted.
  DISCORD_MODERATION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Comma-separated bad-language / slur terms, matched case-insensitively as
  // whole words on every scanned message (Stage 1, zero token cost). Unset =
  // a small built-in default list (see src/moderation/wordlist.ts).
  MODERATION_BAD_WORDS: z.string().optional(),
  // Active strikes at which the member is muted (blocked from posting).
  MODERATION_STRIKE_LIMIT: z.coerce.number().int().positive().default(3),
  // Optional rolling window (days): only strikes newer than this count toward
  // MODERATION_STRIKE_LIMIT. Unset = unbounded (today's behaviour — every
  // uncleared strike counts forever, no matter its age). Never auto-unmutes:
  // an already-muted member stays muted until an admin runs `clear_warnings`,
  // even if their strikes age out of the window. The leave/rejoin re-mute
  // check deliberately IGNORES this window (anti-evasion — otherwise leaving
  // and waiting out the window would bypass clear_warnings; docs/SECURITY.md).
  MODERATION_STRIKE_WINDOW_DAYS: z.coerce.number().int().positive().optional(),
  // Discord role the bot creates (if missing) and assigns to block posting;
  // per-channel overwrites deny it Send Messages. Removed when an admin clears.
  MODERATION_MUTED_ROLE_NAME: z.string().default('Muted'),
  // Private admin channel the bot creates (if missing) and posts warning /
  // block alerts to; locked to admins by permission overwrites.
  MODERATION_ADMIN_CHANNEL_NAME: z.string().default('mod-alerts'),
  // Stage 2 (opt-in, OFF by default): escalate messages NOT caught by the
  // wordlist to an LLM abuse classifier — one Claude call per escalated message
  // on the shared Max pool, so enable deliberately. Stage 1 (wordlist) runs
  // regardless whenever moderation is enabled.
  MODERATION_LLM_ABUSE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Image generation via the host Grok Build CLI (uses its SuperGrok
  // subscription login — no API key). OFF by default; admin/super-admin only.
  IMAGE_GEN_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Path to the `grok` binary (installed + logged in on the host).
  GROK_BIN: z.string().default('grok'),
  // Hard timeout for a single image generation (ms).
  IMAGE_GEN_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  // Max images one admin can generate per rolling calendar day (abuse cap on
  // top of the per-user in-flight guard). 0 = unlimited.
  IMAGE_GEN_DAILY_LIMIT: z.coerce.number().int().min(0).default(25),

  // --- GitHub issue filing (suggest_issue) ---------------------------------
  // Lets a SUPER ADMIN file an issue on the repo straight from chat. OFF by
  // default. GITHUB_ISSUE_TOKEN must be a FINE-GRAINED PAT scoped to
  // `Issues: write` on GITHUB_ISSUE_REPO ONLY (never the
  // CLAUDE_CODE_OAUTH_TOKEN) — see docs/SECURITY.md + docs/DEPLOYMENT.md. This
  // is the bot's only GitHub egress / write credential.
  GITHUB_ISSUE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  GITHUB_ISSUE_REPO: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'GITHUB_ISSUE_REPO must be "owner/repo"')
    .default('swampratnz/community-agent'),
  GITHUB_ISSUE_TOKEN: z.string().optional(),
  // Labels applied to every filed issue (comma-separated). Default
  // `community-feedback` so it enters the research pipeline as evidence rather
  // than a proposal that skips adversarial review (see docs/PIPELINE.md).
  GITHUB_ISSUE_LABELS: z.string().default('community-feedback'),
  // Max issues one super admin can file per rolling calendar day. 0 = unlimited.
  GITHUB_ISSUE_DAILY_LIMIT: z.coerce.number().int().min(0).default(10),

  // WhatsApp
  WHATSAPP_PROVIDER: z.enum(['baileys', 'cloud', 'disabled']).default('baileys'),
  WHATSAPP_AUTH_DIR: z.string().default('./whatsapp-auth'),
  WHATSAPP_ALLOWED_JIDS: z.string().optional(),
  // Welcome message posted to a group on group-participants.update (Baileys
  // only); off unless explicitly enabled.
  WHATSAPP_WELCOME_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Minimum gap between welcome posts to the same group, so a burst of
  // sequential joins can't turn the bot into a per-join spammer.
  WHATSAPP_WELCOME_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(180),
  // Ambient archiving parity for WhatsApp groups (issue #103, extends #48):
  // an explicit per-group opt-in allowlist — narrower than Discord's single
  // all-channels flag, since WhatsApp groups have no "public channel"
  // convention and each requires its own posted notice before its JID is
  // added here (see SECURITY.md). Unset/empty = feature fully off, zero
  // behaviour change. 1:1 DMs are never archived for gated guests regardless.
  WHATSAPP_ARCHIVE_GROUP_JIDS: z.string().optional(),
  // Voice-note transcription (Baileys only). A super admin's voice message is
  // transcribed locally (transformers.js Whisper, no external API/key — same
  // model-download pattern as embeddings) and the transcript is actioned as if
  // typed. OFF by default; SUPER-ADMIN ONLY is enforced in the adapter before
  // any media download (see docs/SECURITY.md). Requires ffmpeg on the host.
  WHATSAPP_VOICE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  WHATSAPP_VOICE_MODEL: z.string().default('Xenova/whisper-base.en'),
  // Voice notes longer than this are ignored WITHOUT downloading — bounds the
  // per-note CPU/latency of local transcription.
  WHATSAPP_VOICE_MAX_SECONDS: z.coerce.number().int().positive().default(120),

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
  // Age-based purge of `server_roster` rows for members who have LEFT
  // (left_at IS NOT NULL). Unset/0 = disabled (no behaviour change on
  // upgrade). Currently-present members (left_at IS NULL) are never touched
  // regardless of this setting — see storage/repository.ts:purgeDepartedRoster.
  ROSTER_DEPARTED_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),
  // Sustained platform disconnect -> one debounced super-admin DM alert.
  HEALTH_ALERT_AFTER_MINUTES: z.coerce.number().positive().default(5),
  // Proactive super-admin alert when rolling-24h outbound reply count
  // reaches this threshold — a coarse proxy for shared Max-pool draw (short
  // vs long replies draw differently; tune to your traffic). Unset/0 =
  // disabled (no timer, no behaviour change on upgrade).
  USAGE_ALERT_DAILY_REPLIES: z.coerce.number().int().nonnegative().default(0),
  // Debounced super-admin DM when an agent turn fails on an upstream Claude
  // usage-limit/overload condition (issue #131) — distinct from usage-alert's
  // proactive threshold on successful replies. Off by default, consistent
  // with this repo's convention for new proactive DMs.
  UPSTREAM_LIMIT_ALERT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Offline context builder (issue #51): distills stored interactions into
  // durable context_digests on a ~daily cadence. Off by default; when on,
  // each run makes AT MOST CONTEXT_BUILDER_MAX_SUMMARIES short tool-less
  // model calls (hard cap enforced in code) and is skipped entirely while
  // the usage-alert threshold is breached.
  CONTEXT_BUILDER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  CONTEXT_BUILDER_WINDOW_DAYS: z.coerce.number().int().positive().max(30).default(1),
  CONTEXT_BUILDER_MAX_SUMMARIES: z.coerce.number().int().positive().max(20).default(5),
  // k-floor: a cluster needs at least this many distinct authors to be
  // digested, so a digest can't become a one-person profile. Never below 2.
  CONTEXT_BUILDER_MIN_DISTINCT_USERS: z.coerce.number().int().min(2).default(3),
  // Knowledge-candidate generation (issue #102, the deferred half of #51):
  // rides the existing builder run's per-digest summarisation call — no new
  // job, no extra model call, so the documented CONTEXT_BUILDER_MAX_SUMMARIES
  // worst case is unchanged with this on. Off by default, and off whenever
  // the builder itself is off. Candidates are review-gated (admin-only,
  // accept_knowledge_candidate) — this flag only controls whether they're
  // ever drafted.
  CONTEXT_CANDIDATES_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Daily knowledge refresh: a scheduled job web-researches a small fixed set
  // of fast-moving Claude/Anthropic topics and writes the briefings straight
  // into the knowledge base (one upserted entry per topic, clearly marked
  // auto-generated). OFF by default. NOTE: unlike knowledge candidates, this
  // path has NO human review gate — auto entries are labelled as machine-
  // researched/unverified precisely because of that (see docs/SECURITY.md).
  KNOWLEDGE_REFRESH_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Max agentic turns for one topic's web-research call (bounds cost).
  KNOWLEDGE_REFRESH_MAX_TURNS: z.coerce.number().int().positive().max(30).default(10),
  // Docs ingest: backfill Anthropic's official docs into the knowledge base as
  // RAG chunks (provenance 'docs'), refreshed ~weekly with a content diff so
  // only changed sections re-embed. OFF by default. Reads ONE fixed official
  // source over HTTPS (the llms.txt index → per-page .md); no model in the loop.
  DOCS_INGEST_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // The official machine-readable docs index (llms.txt). Fixed default; override
  // only if Anthropic moves it.
  DOCS_INGEST_INDEX_URL: z
    .string()
    .url()
    .startsWith('https://', 'DOCS_INGEST_INDEX_URL must be https')
    .default('https://platform.claude.com/llms.txt'),
  // Safety caps so a bloated index can't run away (pages fetched, chunks written).
  DOCS_INGEST_MAX_PAGES: z.coerce.number().int().positive().max(5000).default(2500),
  DOCS_INGEST_MAX_CHUNKS: z.coerce.number().int().positive().max(60000).default(20000),
  // Concurrent page fetches — kept small to be polite to the docs host.
  DOCS_INGEST_CONCURRENCY: z.coerce.number().int().positive().max(16).default(5),
  // Doc-path prefixes to EXCLUDE from ingest (comma-separated, matched against
  // the page path, e.g. "api/go"). Default drops the auto-generated per-language
  // SDK/CLI reference — ~90% of the corpus by volume and near-useless for a chat
  // bot — keeping the conceptual guides + core API. Set empty to ingest all.
  DOCS_INGEST_EXCLUDE_PATHS: z
    .string()
    .default('api/go,api/csharp,api/java,api/python,api/typescript,api/ruby,api/php,api/cli,api/compliance'),
  // Anthropic status check (issue #206): poll Anthropic's own public status
  // page on a background timer and expose the cached result via the
  // member-tier check_status tool, so "is this me or an Anthropic incident"
  // gets an authoritative answer without widening WebSearch (admin+ only)
  // to every member. OFF by default, matching every other opt-in background
  // poll in this repo. No model in the fetch/parse loop.
  STATUS_CHECK_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Anthropic's official Statuspage summary endpoint. Fixed default; override
  // only if Anthropic moves it. Same https-only enforcement as
  // DOCS_INGEST_INDEX_URL — this is a config default, never user/chat-supplied.
  STATUS_CHECK_API_URL: z
    .string()
    .url()
    .startsWith('https://', 'STATUS_CHECK_API_URL must be https')
    .default('https://status.claude.com/api/v2/summary.json'),
  // How often to re-poll. A member's turn only ever reads the in-memory
  // cache — it never triggers a live fetch.
  STATUS_CHECK_POLL_MINUTES: z.coerce.number().int().positive().max(1440).default(5),
  // Anonymised community-context export (issue #53): render digests into a
  // file the research loop can read. Off by default. The export applies its
  // own k-floor and PII scrub — see src/context/export.ts and SECURITY.md for
  // the egress boundary.
  //
  // The default path is untracked/git-ignored (issue #108): the *committed*
  // docs/COMMUNITY-CONTEXT.md is a human artefact (#53), refreshed only by a
  // human running `npm run export:context` — pointed at the docs file if they
  // want to overwrite it — and reviewing + committing the result. If this
  // defaulted to a tracked path, the in-process exporter would dirty a
  // tracked file on the server after every producing builder run, and
  // scripts/redeploy.sh's clean-tree check would then permanently abort the
  // nightly redeploy.
  CONTEXT_EXPORT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  CONTEXT_EXPORT_WINDOW_DAYS: z.coerce.number().int().positive().max(90).default(30),
  CONTEXT_EXPORT_MIN_DISTINCT_USERS: z.coerce.number().int().min(2).default(3),
  CONTEXT_EXPORT_PATH: z.string().default('var/community-context.md'),
  // Weekly proactive per-admin DM digest of recurring-question clusters in
  // their own scoped conversations (issue #97) — a push companion to the
  // on-demand `question_digest` tool. Off by default (no timer, no extra
  // queries). Recipients are `community_users` admins only; super admins keep
  // the on-demand tool instead (see storage/repository.ts:listAdmins).
  ADMIN_DIGEST_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Fifth admin-digest signal (issue #199): nudge admins toward knowledge
  // entries neither edited nor retrieved in this many days. Unset/0 =
  // disabled (no extra query, no behaviour change on upgrade), matching the
  // "0 disabled, else a sane minimum" convention of
  // INTERACTION_RETENTION_DAYS/ROSTER_DEPARTED_RETENTION_DAYS above.
  KNOWLEDGE_STALE_DAYS: z.coerce.number().int().nonnegative().default(0),
  // Skip the agent turn entirely for pure acknowledgements ("thanks", "👍")
  // with no other content — sends one static reply instead. Off by default;
  // an operator opts in after confirming the canned reply tone fits their
  // community. See src/ackClassifier.ts.
  ACK_SHORTCUT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Skip the agent turn entirely when a message near-exactly matches an
  // existing knowledge entry — replies with that entry's content directly
  // instead of spawning a query() turn. Off by default; see src/router.ts
  // and docs/ARCHITECTURE.md "Known cost/latency characteristic".
  KNOWLEDGE_SHORTCUT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Cosine-similarity floor for the knowledge shortcut above — deliberately
  // much stricter than KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD (0.35, the
  // `knowledge_search` tool's "worth mentioning" floor): this bar gates an
  // unsupervised full-turn skip, not a suggestion the model can hedge on, so
  // it must only fire on a near-exact match. Tuned against
  // tests/fixtures/knowledgeEval.json's negativeQueries.
  KNOWLEDGE_SHORTCUT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  // Extend the knowledge shortcut above to gated guests (issue #165),
  // restricted to `scope='global'` entries only, before the static "ask an
  // admin" pointer. Reuses KNOWLEDGE_SHORTCUT_THRESHOLD — no separate knob to
  // tune. Off by default: with it unset, the gated-guest path is
  // byte-for-byte unchanged. See src/router.ts.
  GUEST_KNOWLEDGE_SHORTCUT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // How long shutdown() waits for in-flight per-conversation turns to settle
  // before proceeding to adapter.stop()/closeDb() (issue #210). Comfortably
  // inside systemd's default 90s TimeoutStopSec for community-agent.service
  // (see docs/DEPLOYMENT.md), so a normal restart never needs tuning this.
  SHUTDOWN_DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // /healthz + /readyz endpoints (native http, no auth). Unset = disabled.
  HEALTH_PORT: z.coerce.number().int().positive().optional(),
  // Interface the health server binds to. Defaults to loopback so the
  // unauthenticated endpoint is NOT reachable off-box unless the operator
  // deliberately fronts it with a reverse proxy or sets 0.0.0.0 (issue #220).
  HEALTH_HOST: z.string().min(1).default('127.0.0.1'),
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

// list_roster's churn windows ("joined/left this week") are 7 days; a 30-day
// floor comfortably preserves that pulse while still bounding retention.
const MIN_ROSTER_DEPARTED_RETENTION_DAYS = 30;

// A threshold below a month would flag entries an admin just as plausibly
// hasn't gotten around to re-checking yet rather than ones that are stale.
const MIN_KNOWLEDGE_STALE_DAYS = 30;

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
)
  .refine(
    (e) =>
      e.INTERACTION_RETENTION_DAYS === 0 || e.INTERACTION_RETENTION_DAYS >= MIN_INTERACTION_RETENTION_DAYS,
    {
      message: `INTERACTION_RETENTION_DAYS must be 0 (disabled) or at least ${MIN_INTERACTION_RETENTION_DAYS}`,
      path: ['INTERACTION_RETENTION_DAYS'],
    },
  )
  .refine(
    (e) =>
      e.ROSTER_DEPARTED_RETENTION_DAYS === 0 ||
      e.ROSTER_DEPARTED_RETENTION_DAYS >= MIN_ROSTER_DEPARTED_RETENTION_DAYS,
    {
      message: `ROSTER_DEPARTED_RETENTION_DAYS must be 0 (disabled) or at least ${MIN_ROSTER_DEPARTED_RETENTION_DAYS}`,
      path: ['ROSTER_DEPARTED_RETENTION_DAYS'],
    },
  )
  .refine((e) => e.KNOWLEDGE_STALE_DAYS === 0 || e.KNOWLEDGE_STALE_DAYS >= MIN_KNOWLEDGE_STALE_DAYS, {
    message: `KNOWLEDGE_STALE_DAYS must be 0 (disabled) or at least ${MIN_KNOWLEDGE_STALE_DAYS}`,
    path: ['KNOWLEDGE_STALE_DAYS'],
  })
  .refine((e) => !e.IMAGE_GEN_ENABLED || isAbsolute(e.GROK_BIN), {
    // A bare `grok` is PATH-resolved; a writable PATH entry could shadow it with
    // a hostile binary run as the service user (see docs/SECURITY.md §8). Fail
    // fast when the feature is on rather than trusting the deploy to get it right.
    message: 'GROK_BIN must be an absolute path when IMAGE_GEN_ENABLED=true (avoids PATH hijack)',
    path: ['GROK_BIN'],
  })
  .refine((e) => !e.GITHUB_ISSUE_ENABLED || Boolean(e.GITHUB_ISSUE_TOKEN), {
    // No point enabling the tool without a credential — fail fast at startup
    // rather than at the first super-admin who tries to file an issue.
    message: 'GITHUB_ISSUE_TOKEN is required when GITHUB_ISSUE_ENABLED=true',
    path: ['GITHUB_ISSUE_TOKEN'],
  });

const parsed = EnvSchemaChecked.safeParse(emptyStringsToUndefined(process.env));
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
    archiveAllMessages: env.DISCORD_ARCHIVE_ALL_MESSAGES ?? false,
    assignableRoleIds: csv(env.DISCORD_ASSIGNABLE_ROLES),
  },
  moderation: {
    enabled: env.DISCORD_MODERATION_ENABLED ?? false,
    badWords: csv(env.MODERATION_BAD_WORDS),
    strikeLimit: env.MODERATION_STRIKE_LIMIT,
    strikeWindowDays: env.MODERATION_STRIKE_WINDOW_DAYS,
    mutedRoleName: env.MODERATION_MUTED_ROLE_NAME,
    adminChannelName: env.MODERATION_ADMIN_CHANNEL_NAME,
    llmAbuseEnabled: env.MODERATION_LLM_ABUSE_ENABLED ?? false,
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
  whatsapp: {
    provider: env.WHATSAPP_PROVIDER,
    authDir: env.WHATSAPP_AUTH_DIR,
    allowedJids: csv(env.WHATSAPP_ALLOWED_JIDS),
    welcome: {
      enabled: env.WHATSAPP_WELCOME_ENABLED ?? false,
      cooldownMinutes: env.WHATSAPP_WELCOME_COOLDOWN_MINUTES,
    },
    archiveGroupJids: csv(env.WHATSAPP_ARCHIVE_GROUP_JIDS),
    voice: {
      enabled: env.WHATSAPP_VOICE_ENABLED ?? false,
      model: env.WHATSAPP_VOICE_MODEL,
      maxSeconds: env.WHATSAPP_VOICE_MAX_SECONDS,
    },
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
  },
  statusCheck: {
    enabled: env.STATUS_CHECK_ENABLED ?? false,
    apiUrl: env.STATUS_CHECK_API_URL,
    pollMinutes: env.STATUS_CHECK_POLL_MINUTES,
  },
  contextCandidates: {
    enabled: env.CONTEXT_CANDIDATES_ENABLED ?? false,
  },
  contextExport: {
    enabled: env.CONTEXT_EXPORT_ENABLED ?? false,
    windowDays: env.CONTEXT_EXPORT_WINDOW_DAYS,
    minDistinctUsers: env.CONTEXT_EXPORT_MIN_DISTINCT_USERS,
    path: env.CONTEXT_EXPORT_PATH,
  },
  adminDigest: {
    enabled: env.ADMIN_DIGEST_ENABLED ?? false,
    knowledgeStaleDays: env.KNOWLEDGE_STALE_DAYS,
  },
  behaviour: {
    memoryTopK: env.MEMORY_TOP_K,
    dailyReplyLimitPerUser: env.DAILY_REPLY_LIMIT_PER_USER,
    sessionMaxTurns: env.SESSION_MAX_TURNS,
    sessionMaxAgeHours: env.SESSION_MAX_AGE_HOURS,
    interactionRetentionDays: env.INTERACTION_RETENTION_DAYS,
    rosterDepartedRetentionDays: env.ROSTER_DEPARTED_RETENTION_DAYS,
    healthAlertAfterMinutes: env.HEALTH_ALERT_AFTER_MINUTES,
    healthPort: env.HEALTH_PORT,
    healthHost: env.HEALTH_HOST,
    usageAlertDailyReplies: env.USAGE_ALERT_DAILY_REPLIES,
    upstreamLimitAlertEnabled: env.UPSTREAM_LIMIT_ALERT_ENABLED ?? false,
    ackShortcutEnabled: env.ACK_SHORTCUT_ENABLED ?? false,
    knowledgeShortcutEnabled: env.KNOWLEDGE_SHORTCUT_ENABLED ?? false,
    knowledgeShortcutThreshold: env.KNOWLEDGE_SHORTCUT_THRESHOLD,
    guestKnowledgeShortcutEnabled: env.GUEST_KNOWLEDGE_SHORTCUT_ENABLED ?? false,
    shutdownDrainTimeoutMs: env.SHUTDOWN_DRAIN_TIMEOUT_MS,
  },
  log: {
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY ?? false,
  },
} as const;

export type Config = typeof config;
