import { z } from 'zod';

/** Discord slice (config.discord): adapter, welcome, voice and image input. */
export const discordSlice = {
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
  // Auto-enroll (issue #605): on every non-bot Discord join, grant standing
  // member-tier `community_users` access instead of leaving the joiner a
  // gated guest until an admin runs `add_member`. A genuine RBAC-posture
  // change (see .env.example) — off by default.
  DISCORD_AUTO_ENROLL_MEMBERS: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
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
  // Guild-scoped Discord slash commands (issue #744): /kb, /projects, /whois,
  // /guidelines — zero-model-call, ephemeral reads over existing tool-handler
  // repository functions, registered on ClientReady. Off by default, same
  // convention as the other shortcut flags above; see docs/ARCHITECTURE.md.
  DISCORD_SLASH_COMMANDS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Auto-answer mode (issue #477): operator-curated allowlist of Discord
  // channel ids where a top-level human post that does NOT address the bot
  // still gets an answer, contained in a thread on that post — the router's
  // summon gate (`!addressedToBot && !isDirect`) is relaxed for exactly these
  // channels, nothing else. Unset/empty = feature fully off, byte-identical
  // to today (no post that isn't addressed/direct ever produces a reply).
  // Discord-only by design (WhatsApp/Baileys auto-answer carries separate
  // ToS/ban risk — a different proposal, see docs/SECURITY.md).
  AUTO_ANSWER_CHANNEL_IDS: z.string().optional(),
  // Per-channel rolling-hour cap on auto-answers (sliding window, mirroring
  // agent/tools.ts's reserveAnnounceSlot/ANNOUNCE_RATE_LIMIT_PER_HOUR shape)
  // — bounds the flood/cost risk of this new untrusted-input path. Unlike
  // ANNOUNCE_RATE_LIMIT_PER_HOUR this is operator-tunable: an allowlisted
  // channel's traffic varies far more than the admin-only announce tool's.
  // Never applies to an addressed/mention reply in the same channel.
  AUTO_ANSWER_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(10),

  // Discord counterpart to WHATSAPP_VOICE_* above (issue #732): transcribes a
  // native Discord voice-message bubble (an attachment reporting
  // `duration_secs`) via the exact same local, offline transformers.js
  // Whisper pipeline — no new dependency, network call, or cost centre.
  // Independently configurable from the WhatsApp knobs since a guild's risk
  // profile (public-ish, larger membership) differs from a single WhatsApp
  // number. OFF by default; SUPER-ADMIN ONLY at the default minRole, enforced
  // in the adapter before any attachment is fetched (see docs/SECURITY.md).
  DISCORD_VOICE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  DISCORD_VOICE_MODEL: z.string().default('Xenova/whisper-base.en'),
  // Voice messages longer than this are ignored WITHOUT fetching the
  // attachment — bounds the per-message CPU/latency of local transcription.
  DISCORD_VOICE_MAX_SECONDS: z.coerce.number().int().positive().default(120),
  // Minimum tier eligible for voice transcription. Defaults to 'super_admin' —
  // the pure isSuperAdmin env check with no DB call — mirroring
  // WHATSAPP_VOICE_MIN_ROLE's conservative default.
  DISCORD_VOICE_MIN_ROLE: z.enum(['super_admin', 'admin', 'member', 'guest']).default('super_admin'),
  // Rolling hourly cap on transcribed voice messages per sender (0 =
  // unlimited). Only bites once an operator lowers DISCORD_VOICE_MIN_ROLE
  // below 'super_admin' — bounds the resource-exhaustion surface a larger,
  // less-trusted guild population could otherwise hit.
  DISCORD_VOICE_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(0).default(0),

  // Discord image-attachment input (issue #783, CAPABILITY-IDEAS.md §A1): a
  // single image attachment (screenshot, stack trace, billing page) is
  // base64-encoded and passed to query() as an image content block alongside
  // the turn's text, so the model can ground its answer in what was actually
  // shown rather than whatever caption (or nothing) was typed. OFF by
  // default. Unlike DISCORD_VOICE_* above — which only ever produces ordinary
  // `text` that flows through the same moderation/injection handling every
  // typed message gets — an image is a genuinely NEW untrusted-input class:
  // text rendered inside an image is interpreted model-side and is invisible
  // to moderator.scan and every other inbound filter, defended only by the
  // explicit systemPrompt.ts clause (no sanitizer can inspect model-side
  // image interpretation). So IMAGE_INPUT_MIN_ROLE defaults to 'super_admin'
  // — a deliberate correction of CAPABILITY-IDEAS.md's own draft text
  // ('member+'), matching the same conservative-default precedent
  // DISCORD_VOICE_MIN_ROLE/WHATSAPP_VOICE_MIN_ROLE already established
  // (see the comment above WHATSAPP_VOICE_MIN_ROLE).
  IMAGE_INPUT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  IMAGE_INPUT_MIN_ROLE: z.enum(['super_admin', 'admin', 'member', 'guest']).default('super_admin'),
  // Comfortably inside the Anthropic API's own per-image limit; refused
  // WITHOUT fetching, bounding per-turn download/encode cost.
  IMAGE_INPUT_MAX_BYTES: z.coerce.number().int().positive().default(5_000_000),
  // Rolling calendar-day cap per sender (0 = unlimited), checked BEFORE any
  // attachment fetch — same shape and discipline as IMAGE_GEN_DAILY_LIMIT/
  // DEV_TEAM_DAILY_LIMIT, bounding the real per-image multimodal token cost a
  // single caller could otherwise run up.
  IMAGE_INPUT_DAILY_LIMIT_PER_USER: z.coerce.number().int().min(0).default(10),
};
