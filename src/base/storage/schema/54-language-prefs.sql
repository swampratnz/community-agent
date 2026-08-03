-- ---------------------------------------------------------------------------
-- Standing language-reply preference (issue #189), set by the member/guest-
-- tier `set_language_preference` tool so a caller who wants every reply in a
-- specific language doesn't need to re-ask each message. Keyed on raw
-- (platform, user_id) like `response_style_prefs` above, not
-- `community_users`, so it works for a guest in open mode too. No row (or
-- 'auto') means today's default per-message language-mirroring behaviour
-- (issue #68) — see `getLanguagePreference` in repository.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS language_prefs (
  platform      TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  language      TEXT        NOT NULL DEFAULT 'auto' CHECK (language IN ('auto', 'en', 'mi')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, user_id)
);
