import { z } from 'zod';

/** Moderation slice (config.moderation). */
export const moderationSlice = {
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
  // Per-caller cooldown (hours) on appeal_moderation (issue #496) — a member
  // with an active warning/mute can ask admins to double-check it, at most
  // once per window. In-memory/best-effort for the MVP (no new table): a
  // restart merely permits one extra appeal DM, harmless for a non-
  // destructive notification.
  MODERATION_APPEAL_COOLDOWN_HOURS: z.coerce.number().int().positive().default(24),
  // Guild-wide rolling-hour cap on postAdminAlert calls from Moderator.scan()
  // (issue #517) — every other admin-notification path already has one
  // (ESCALATION_RATE_LIMIT_PER_HOUR, ACCESS_REQUEST_ALERT_RATE_LIMIT_PER_HOUR,
  // AUTO_ANSWER_RATE_LIMIT_PER_HOUR, WARN_USER_RATE_LIMIT_PER_HOUR); mod-alerts
  // was the sole exception, so a raid/flood could bury the one alert channel
  // whose entire purpose is carrying moderation signal. Default generous
  // enough that normal traffic never engages it. Never gates enforcement
  // (addWarning/muteUser/warnUser/warnInChannel) — only the admin-channel
  // notification, see src/moderation/moderator.ts.
  MODERATION_ALERT_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(30),
};
