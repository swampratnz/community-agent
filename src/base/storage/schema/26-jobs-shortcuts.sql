-- NOTE: the job/kind value lists below stay literal SQL for now — per-module registrations of new values (docs/AGENT-BASE-PLAN.md §3, 'migrations') are deferred.

-- ---------------------------------------------------------------------------
-- Cost of the three standalone background `query()` calls (issue #401) that
-- spend from the shared Max pool but write no `interactions` row, so
-- `usageStats()` (interactions-only) never saw them: the opt-in Stage-2 LLM
-- abuse classifier (`classifyAbuseWithLlm`), the offline context-builder
-- digest call (`summarizeCluster`), and the daily knowledge-refresh research
-- call (`researchTopic`). `job` is a fixed enum, never free text or anything
-- derived from chat content. Bare aggregate data only, same as
-- `admin_digest_sends` — no user id, conversation id, or platform, so
-- forget_me/purge_user_data have nothing to touch here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS background_job_costs (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job        TEXT        NOT NULL CHECK (job IN ('moderation_llm', 'context_builder', 'knowledge_refresh')),
  cost_usd   NUMERIC     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS background_job_costs_created_at_idx
  ON background_job_costs (created_at DESC);

-- ---------------------------------------------------------------------------
-- Durable hit counts for the four env-gated turn-skipping shortcuts (issue
-- #440) — each avoids a `query()` call against the shared Max pool but, until
-- now, recorded nothing beyond a single `logger.debug`/`.info` line, so a
-- super admin who enables one has no evidence of how often it actually fires.
-- `kind` is a fixed enum, never free text or anything derived from message
-- content — deliberately narrower than `interactions` (no user id,
-- conversation id, or platform) and narrower than `background_job_costs`
-- (no tie to a specific job run): a bare event marker, mirrored on that
-- table's shape. The `knowledge` kind counts only the member-facing knowledge
-- shortcut (`sendKnowledgeShortcut`) — the separate guest knowledge shortcut
-- (`sendGuestKnowledgeShortcut`) is deliberately excluded (see router.ts) so
-- this count is never misread as covering both. forget_me/purge_user_data
-- have nothing to touch here, same as background_job_costs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shortcut_hits (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       TEXT        NOT NULL CHECK (kind IN ('ack', 'knowledge', 'repeat_question', 'repeat_max_turns')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shortcut_hits_created_at_idx
  ON shortcut_hits (created_at DESC);

-- Widens the kind enum beyond the four the CREATE TABLE above pins:
--  - 'slash_command'         Discord slash commands (issues #744, #863) — an
--                            equally real zero-`query()`-call shortcut.
--  - 'whatsapp_text_command' WhatsApp's `!`-prefixed text commands (issues
--                            #859, #874) — the WhatsApp counterpart. A
--                            distinct kind rather than reusing
--                            'slash_command': that value is documented as
--                            Discord-specific, so folding WhatsApp hits into
--                            it would misname the mechanism and corrupt any
--                            per-kind analysis.
--
-- ONE drop/re-add pair, listing every kind. When you add a kind, EDIT the list
-- below — never append a second DROP/ADD pair for this same constraint name.
-- migrate() replays this whole file as a single multi-statement query on every
-- run, so two pairs execute in order: the earlier, NARROWER one runs against
-- live data and `ALTER TABLE ... ADD CONSTRAINT` validates existing rows, so a
-- single row holding a kind that only the LATER pair allows aborts the
-- statement — and because it is one query, the entire migration rolls back.
-- That is not hypothetical: stacking these two pairs meant one
-- 'whatsapp_text_command' row blocked every subsequent migration, with CI blind
-- to it because CI always starts from an empty database. See
-- tests/schemaConstraintIdempotency.test.ts, which fails if a constraint name
-- is re-added more than once anywhere in this file.
ALTER TABLE shortcut_hits DROP CONSTRAINT IF EXISTS shortcut_hits_kind_check;
ALTER TABLE shortcut_hits ADD CONSTRAINT shortcut_hits_kind_check
  CHECK (kind IN ('ack', 'knowledge', 'repeat_question', 'repeat_max_turns', 'slash_command', 'whatsapp_text_command'));
