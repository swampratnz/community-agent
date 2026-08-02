import type { Platform } from '../../platforms/types.js';
import { logger } from '../../logger.js';
import { pool } from '../db.js';
import { registerPurgeContributor } from '../lifecycle.js';

/**
 * Standing per-member preferences: response style (issue #126) and language
 * (issue #189). Both are single primary-key lookups on the hot path — every
 * turn reads them — so both reads deliberately DEGRADE TO THE DEFAULT rather
 * than throwing when the DB hiccups (issue #52's fail-open convention, shared
 * with getCodeAnswersPolicy): a preference lookup must never be what fails a
 * reply. The writes are plain upserts and are allowed to throw.
 *
 * Extracted verbatim from repository.ts (see repository.ts's header for why the
 * split exists); `repository.ts` re-exports everything here, so every existing
 * import site is unchanged.
 */

// --- Standing response-style preference (issue #126) ------------------------

export type ResponseStyle = 'standard' | 'plain';

/**
 * The caller's standing response-style preference, or 'standard' (today's
 * default behaviour) when they've never called `set_response_style`. A
 * single primary-key lookup, so this is a negligible per-turn cost.
 */
export async function getResponseStyle(platform: Platform, userId: string): Promise<ResponseStyle> {
  try {
    const { rows } = await pool.query(
      `SELECT style FROM response_style_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    return rows[0]?.style === 'plain' ? 'plain' : 'standard';
  } catch (err) {
    // Hot-path read on every turn: a DB hiccup must not fail the turn (issue
    // #52) — degrade to the default reply style, same as getCodeAnswersPolicy.
    logger.warn({ err, platform, userId }, 'Response-style read failed; using standard');
    return 'standard';
  }
}

/** Upsert the caller's response-style preference. */
export async function setResponseStyle(
  platform: Platform,
  userId: string,
  style: ResponseStyle,
): Promise<void> {
  await pool.query(
    `INSERT INTO response_style_prefs (platform, user_id, style, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (platform, user_id) DO UPDATE SET style = $3, updated_at = now()`,
    [platform, userId, style],
  );
}

// --- Standing language preference (issue #189) -------------------------------

export type LanguagePreference = 'auto' | 'en' | 'mi';

/**
 * The caller's standing language preference, or 'auto' (today's per-message
 * mirroring default, issue #68) when they've never called
 * `set_language_preference`. A single primary-key lookup, same cost shape as
 * getResponseStyle.
 */
export async function getLanguagePreference(platform: Platform, userId: string): Promise<LanguagePreference> {
  try {
    const { rows } = await pool.query(
      `SELECT language FROM language_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    const language = rows[0]?.language;
    return language === 'en' || language === 'mi' ? language : 'auto';
  } catch (err) {
    // Hot-path read on every turn: a DB hiccup must not fail the turn (issue
    // #52) — degrade to 'auto', same as getResponseStyle.
    logger.warn({ err, platform, userId }, 'Language-preference read failed; using auto');
    return 'auto';
  }
}

/** Upsert the caller's standing language preference. */
export async function setLanguagePreference(
  platform: Platform,
  userId: string,
  language: LanguagePreference,
): Promise<void> {
  await pool.query(
    `INSERT INTO language_prefs (platform, user_id, language, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (platform, user_id) DO UPDATE SET language = $3, updated_at = now()`,
    [platform, userId, language],
  );
}

// --- Lifecycle registration (storage/lifecycle.ts) ---------------------------

registerPurgeContributor({
  name: 'response_style_prefs',
  order: 70,
  async purge({ platform, userId }, tx) {
    // response_style_prefs (issue #126) is keyed the same way — purge coherence
    // for anyone who opted into the plain-language preference.
    const { rowCount: responseStyle } = await tx.query(
      `DELETE FROM response_style_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    return responseStyle ?? 0;
  },
});

registerPurgeContributor({
  name: 'language_prefs',
  order: 80,
  async purge({ platform, userId }, tx) {
    // language_prefs (issue #189) is keyed the same way — purge coherence for
    // anyone who opted into a standing language preference.
    const { rowCount: languagePreference } = await tx.query(
      `DELETE FROM language_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    return languagePreference ?? 0;
  },
});
