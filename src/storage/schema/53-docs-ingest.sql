-- ---------------------------------------------------------------------------
-- Per-URL consecutive fetch-failure tracking for the docs-ingest job
-- (issue #611, the growth path #613 deferred). Anthropic's llms.txt index
-- habitually lists a tranche of pages that don't exist (one observed run:
-- 157/586 404ing, all under api/terraform/beta/*), and every weekly run
-- re-fetched all of them. A URL that fails DOCS_INGEST_DEAD_URL_RUNS runs in
-- a row is reported ONCE and then skipped, with a periodic re-probe
-- (DOCS_INGEST_DEAD_URL_RECHECK_DAYS) so an upstream fix self-heals.
--
-- A row exists only while a URL is CURRENTLY failing: a successful fetch
-- deletes it, and a row whose URL has left the index entirely (dropped
-- upstream, or newly excluded) is reaped on the next run — so this table stays
-- bounded by the current dead tranche and never needs its own retention purge.
-- Holds first-party docs URLs only — no user identifier, so
-- forget_me/purge_user_data have nothing to touch here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS docs_ingest_url_failures (
  url                  TEXT        PRIMARY KEY,
  consecutive_failures INTEGER     NOT NULL DEFAULT 1,
  first_failed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when the URL crossed the dead threshold and was reported, so the
  -- operator is told once rather than every run.
  reported_at          TIMESTAMPTZ
);
