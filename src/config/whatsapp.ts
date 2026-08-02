import { z } from 'zod';
import type { EnvRefinement } from './env.js';

/** WhatsApp slice (config.whatsapp): Baileys and Cloud API adapters. */
export const whatsappSlice = {
  // WhatsApp
  WHATSAPP_PROVIDER: z.enum(['baileys', 'cloud', 'disabled']).default('baileys'),
  WHATSAPP_AUTH_DIR: z.string().default('./whatsapp-auth'),
  WHATSAPP_ALLOWED_JIDS: z.string().optional(),
  // Cap on consecutive Baileys reconnect attempts before the adapter STOPS
  // retrying (issue: the 2026-07-29 405 outage). The backoff is
  // 3s·2^(n-1) capped at 5 min, so the default 20 spends roughly an hour
  // retrying — long enough to ride out a genuine transient outage, far short
  // of the 73 attempts over ~6 h that the unbounded loop actually ran.
  //
  // Why cap at all: a 405 is WhatsApp REFUSING the connection, not a network
  // blip, and docs/SECURITY.md treats Baileys ToS/ban exposure as a real risk
  // — indefinitely hammering a server that is actively rejecting us is the
  // wrong posture. Giving up is also more visible than looping forever: the
  // adapter stays disconnected, so health.ts's existing sustained-disconnect
  // alert keeps notifying super admins.
  //
  // `0` means unlimited, preserving the old behaviour as an escape hatch for
  // an operator who would rather retry forever than restart by hand.
  WHATSAPP_MAX_RECONNECT_ATTEMPTS: z.coerce.number().int().min(0).default(20),
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
  // Blanket ambient archiving for EVERY group Dave is in, present and future —
  // the WhatsApp counterpart to DISCORD_ARCHIVE_ALL_MESSAGES, and a deliberate
  // reversal of the per-group allowlist's original rationale (issue #103,
  // docs/SECURITY.md): that allowlist existed because adding a JID by hand WAS
  // the operator's assertion that the group's notice had been posted. A blanket
  // flag removes that per-group step, so the notice obligation moves entirely
  // onto the operator — turning this on is an assertion that every group the
  // bot is in has been told, including groups it is added to later.
  //
  // Off by default, and it does NOT widen what is archived beyond groups:
  // `!msg.isDirect` still gates the write, so a guest's 1:1 DM is never stored
  // regardless of this flag (pinned by a SECURITY: test).
  WHATSAPP_ARCHIVE_ALL_GROUPS: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
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
  // Minimum tier eligible for voice transcription (issue #507). Defaults to
  // 'super_admin' — byte-identical to the original super-admin-only gate,
  // which stays a pure isSuperAdmin env check with no DB call. Lowering this
  // opens on-demand local Whisper inference to a larger, less-trusted
  // population; pair with WHATSAPP_VOICE_RATE_LIMIT_PER_HOUR (see
  // docs/SECURITY.md §13).
  WHATSAPP_VOICE_MIN_ROLE: z.enum(['super_admin', 'admin', 'member', 'guest']).default('super_admin'),
  // Rolling hourly cap on transcribed voice notes per sender (0 = unlimited,
  // matching this repo's "0/unset = off" convention). Only bites once an
  // operator lowers WHATSAPP_VOICE_MIN_ROLE below 'super_admin' — bounds the
  // resource-exhaustion surface a much larger population could otherwise hit.
  WHATSAPP_VOICE_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(0).default(0),

  // WhatsApp (Baileys only) counterpart to IMAGE_INPUT_* above (issue #879):
  // mirrors Discord's #783 image-attachment input onto BaileysAdapter,
  // reusing the exact same untrusted-input class and residual-risk story —
  // see the comment above IMAGE_INPUT_ENABLED for why the conservative
  // 'super_admin' default matters here too. WHATSAPP_-prefixed and fully
  // independent of the unprefixed Discord flags above, mirroring the
  // existing DISCORD_VOICE_*/WHATSAPP_VOICE_* split rather than the unified
  // IMAGE_INPUT_* shape, so an operator can enable/tune each platform's
  // rollout separately.
  WHATSAPP_IMAGE_INPUT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  WHATSAPP_IMAGE_INPUT_MIN_ROLE: z.enum(['super_admin', 'admin', 'member', 'guest']).default('super_admin'),
  // Same default as IMAGE_INPUT_MAX_BYTES — comfortably inside the Anthropic
  // API's own per-image limit; refused WITHOUT downloading.
  WHATSAPP_IMAGE_INPUT_MAX_BYTES: z.coerce.number().int().positive().default(5_000_000),
  // Same default as IMAGE_INPUT_DAILY_LIMIT_PER_USER, checked BEFORE any
  // download — bounds the real per-image multimodal token cost a single
  // sender could otherwise run up.
  WHATSAPP_IMAGE_INPUT_DAILY_LIMIT_PER_USER: z.coerce.number().int().min(0).default(10),

  WHATSAPP_CLOUD_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_CLOUD_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_CLOUD_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_CLOUD_APP_SECRET: z.string().optional(),
  WHATSAPP_CLOUD_WEBHOOK_PORT: z.coerce.number().int().positive().default(8080),
  // First-contact welcome for the Cloud API (issue #255): the Cloud API has
  // no group-join event to hook (WHATSAPP_WELCOME_ENABLED is Baileys-only),
  // so this fires off a sender's own first-ever inbound message instead
  // (detected via isKnownConversation). Off by default, matching every other
  // opt-in welcome surface in this repo.
  WHATSAPP_CLOUD_WELCOME_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // WhatsApp Cloud API counterpart to WHATSAPP_IMAGE_INPUT_* above (issue
  // #891): closes the last silent-drop gap on the docs' own recommended
  // production WhatsApp path, mirroring Baileys' #879 gate order and
  // conservative-default rationale (see the comment above IMAGE_INPUT_ENABLED)
  // adapted to the Cloud webhook shape. WHATSAPP_CLOUD_-prefixed and fully
  // independent of both WHATSAPP_IMAGE_INPUT_* (Baileys) and IMAGE_INPUT_*
  // (Discord) — an operator enables/tunes each platform's rollout separately.
  WHATSAPP_CLOUD_IMAGE_INPUT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  WHATSAPP_CLOUD_IMAGE_INPUT_MIN_ROLE: z
    .enum(['super_admin', 'admin', 'member', 'guest'])
    .default('super_admin'),
  // Same default as WHATSAPP_IMAGE_INPUT_MAX_BYTES — comfortably inside the
  // Anthropic API's own per-image limit. Unlike Baileys' `fileLength` (present
  // on the message itself, pre-download), Meta's Cloud webhook `image` object
  // carries no byte size, so this is enforced once the media-URL resolve call
  // reports `file_size` — strictly BEFORE the separate byte-download call.
  WHATSAPP_CLOUD_IMAGE_INPUT_MAX_BYTES: z.coerce.number().int().positive().default(5_000_000),
  // Same default as WHATSAPP_IMAGE_INPUT_DAILY_LIMIT_PER_USER, checked before
  // any Graph media call — bounds the real per-image multimodal token cost a
  // single sender could otherwise run up.
  WHATSAPP_CLOUD_IMAGE_INPUT_DAILY_LIMIT_PER_USER: z.coerce.number().int().min(0).default(10),

  // WhatsApp Cloud API counterpart to WHATSAPP_VOICE_* above (issue #910):
  // closes the last silent-drop gap on the docs' own recommended production
  // WhatsApp path for voice, mirroring the #891 image-parity shape and this
  // adapter's own image gate order adapted to voice. WHATSAPP_CLOUD_-prefixed
  // and fully independent of both WHATSAPP_VOICE_* (Baileys) and
  // DISCORD_VOICE_* — an operator enables/tunes each platform's rollout
  // separately. OFF by default; SUPER-ADMIN ONLY at the default minRole,
  // enforced in the adapter before any Graph API call.
  WHATSAPP_CLOUD_VOICE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  WHATSAPP_CLOUD_VOICE_MODEL: z.string().default('Xenova/whisper-base.en'),
  // Unlike Baileys' `audio.seconds` (present on the message itself,
  // pre-download), Meta's Cloud webhook `audio` object carries no duration at
  // all — the same gap #891 hit for image `file_size`. So this is a BYTE cap,
  // not a seconds cap, enforced once the media-URL resolve call reports
  // `file_size` — strictly BEFORE the separate byte-download call — mirroring
  // WHATSAPP_CLOUD_IMAGE_INPUT_MAX_BYTES exactly. A "duration from webhook"
  // cap is unimplementable on this adapter (see issue #910's adversarial
  // review); this replaces it with the enforceable equivalent.
  WHATSAPP_CLOUD_VOICE_MAX_BYTES: z.coerce.number().int().positive().default(10_000_000),
  // Minimum tier eligible for voice transcription. Defaults to 'super_admin'
  // — the pure isSuperAdmin env check with no DB call — mirroring
  // WHATSAPP_VOICE_MIN_ROLE/WHATSAPP_CLOUD_IMAGE_INPUT_MIN_ROLE's
  // conservative default.
  WHATSAPP_CLOUD_VOICE_MIN_ROLE: z.enum(['super_admin', 'admin', 'member', 'guest']).default('super_admin'),
  // Rolling hourly cap on transcribed voice notes per sender (0 = unlimited).
  // Only bites once an operator lowers WHATSAPP_CLOUD_VOICE_MIN_ROLE below
  // 'super_admin' — bounds the resource-exhaustion surface a larger,
  // less-trusted population could otherwise hit. Reserved under its own
  // `whatsapp-cloud:${senderId}` key prefix (see reserveVoiceTranscriptionSlot)
  // so it never shares Baileys' hourly quota.
  WHATSAPP_CLOUD_VOICE_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(0).default(0),
};

export type WhatsappEnv = z.infer<z.ZodObject<typeof whatsappSlice>>;

export const whatsappRefinements: EnvRefinement<WhatsappEnv>[] = [
  {
    check: (e) =>
      e.WHATSAPP_PROVIDER !== 'cloud' ||
      (e.WHATSAPP_CLOUD_PHONE_NUMBER_ID &&
        e.WHATSAPP_CLOUD_ACCESS_TOKEN &&
        e.WHATSAPP_CLOUD_VERIFY_TOKEN &&
        e.WHATSAPP_CLOUD_APP_SECRET),
    params: {
      message:
        'WHATSAPP_PROVIDER=cloud requires WHATSAPP_CLOUD_PHONE_NUMBER_ID, WHATSAPP_CLOUD_ACCESS_TOKEN, ' +
        'WHATSAPP_CLOUD_VERIFY_TOKEN, and WHATSAPP_CLOUD_APP_SECRET',
      path: ['WHATSAPP_PROVIDER'],
    },
  },
];
