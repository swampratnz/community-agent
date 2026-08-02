-- ---------------------------------------------------------------------------
-- Durable completion-DM watches for the super-admin dev-team dispatch tools
-- (dev_team_dispatch, dev_team_verify). One row per dispatched job: who asked
-- (platform + user id, for the DM back), plus the job's mode/repo for the
-- verdict text (for mode 'verify' the repo column carries the SOURCE
-- assessment job id instead — all the verdict DM needs to name). A
-- background poller (src/backgroundJobs.ts) reads unnotified rows, checks each
-- job's status over the tailnet, and on a terminal state (succeeded/failed)
-- DMs the requester then stamps notified_at — so a ~20-min run's completion
-- ping survives a bot restart and is sent at most once (the primary key +
-- notified_at guard prevent a double-send). Identity + job metadata only,
-- never any part of the requester's message content or the service's report.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dev_team_watches (
  job_id             TEXT        PRIMARY KEY,
  requester_platform TEXT        NOT NULL,
  requester_user_id  TEXT        NOT NULL,
  mode               TEXT        NOT NULL,
  repo               TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at        TIMESTAMPTZ
);

-- The poller scans only unnotified rows every ~minute; a partial index keeps
-- that scan cheap as completed-and-notified rows accumulate.
CREATE INDEX IF NOT EXISTS dev_team_watches_unnotified_idx
  ON dev_team_watches (created_at)
  WHERE notified_at IS NULL;
