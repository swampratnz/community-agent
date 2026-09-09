-- ---------------------------------------------------------------------------
-- Module fragment: who_is_into's self-match push complement opt-in (issue
-- #1332) — every other pull-only admin review queue (list_appeals,
-- list_suggestions, list_knowledge_candidates, list_access_requests,
-- list_roster, list_reports) already got a push complement; who_is_into's
-- self-match path (searchMemberInterestsForSelf) was the one member-facing
-- discovery pull with none. A module-owned auxiliary table sitting beside
-- the base `member_interests` row, the same "base owns the row, module
-- tracks something alongside it" pattern find_helper_requests.ts (fragment
-- 84) established, because the module can't add a column to a base table.
--
-- Deliberately BARE: (platform, user_id) primary key and no other column —
-- no interest text, no match data, no timestamp beyond what the row needs.
-- The row's mere existence is the opt-in; see
-- interestMatchAlertOptIns.ts's registerPurgeContributor call for the
-- (platform, user_id)-keyed purge this identity-bearing row requires, same
-- as find_helper_requests.
--
-- No FK to member_interests or any base table (this module's established
-- no-FK stance for auxiliary tables).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interest_match_alert_optins (
  platform TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  PRIMARY KEY (platform, user_id)
);
