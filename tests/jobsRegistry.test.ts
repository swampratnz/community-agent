import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it, matching the convention in
// tests/backgroundJobsDisabled.test.ts. The assertions below never read this
// process-level config: every gate check goes through the pure loadConfig()
// so each row exercises exactly one env flag against an otherwise-minimal env.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { JOB_REGISTRY } = await import('../src/jobs/registry.js');
const { loadConfig } = await import('../src/config.js');

// The minimal valid environment: exactly the four required vars (same set as
// tests/configSlices.test.ts), so every job's enable flag sits at its default.
const BASE_ENV: NodeJS.ProcessEnv = {
  CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
  DISCORD_BOT_TOKEN: 'test-token',
  DISCORD_GUILD_ID: '1',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
};

/**
 * One row per registered job, in REGISTRY ORDER — this table doubles as the
 * pinned start-order list (it is exactly the order index.ts's hand-wired
 * startX() calls ran in before the registry existed; see
 * src/jobs/registry.ts for why reordering must be deliberate).
 *
 * `on` is the env that turns the job's gate on (numeric gates use their
 * config minimums; dev-team's flag refinement requires its endpoint+token);
 * `null` marks the two always-on jobs that have no enable flag by design.
 */
const JOBS: ReadonlyArray<{ name: string; on: NodeJS.ProcessEnv | null }> = [
  { name: 'interaction-retention-purge', on: { INTERACTION_RETENTION_DAYS: '7' } },
  { name: 'roster-retention-purge', on: { ROSTER_DEPARTED_RETENTION_DAYS: '30' } },
  { name: 'access-request-retention-purge', on: { ACCESS_REQUEST_RETENTION_DAYS: '30' } },
  { name: 'disconnect-alerts', on: null },
  { name: 'embedding-model', on: null },
  { name: 'usage-alert', on: { USAGE_ALERT_DAILY_REPLIES: '100' } },
  { name: 'usage-cost-digest', on: { USAGE_COST_DIGEST_ENABLED: 'true' } },
  { name: 'background-job-cost-alert', on: { BACKGROUND_JOB_COST_ALERT_ENABLED: 'true' } },
  { name: 'context-builder', on: { CONTEXT_BUILDER_ENABLED: 'true' } },
  { name: 'knowledge-refresh', on: { KNOWLEDGE_REFRESH_ENABLED: 'true' } },
  { name: 'docs-ingest', on: { DOCS_INGEST_ENABLED: 'true' } },
  { name: 'knowledge-link-check', on: { KNOWLEDGE_LINK_CHECK_ENABLED: 'true' } },
  { name: 'anthropic-status-check', on: { STATUS_CHECK_ENABLED: 'true' } },
  { name: 'admin-digest', on: { ADMIN_DIGEST_ENABLED: 'true' } },
  { name: 'departed-admin-alert', on: { DEPARTED_ADMIN_ALERT_ENABLED: 'true' } },
  { name: 'engagement-alert', on: { ENGAGEMENT_ALERT_ENABLED: 'true' } },
  { name: 'admin-leverage-alert', on: { ADMIN_LEVERAGE_ALERT_ENABLED: 'true' } },
  { name: 'member-digest', on: { MEMBER_DIGEST_ENABLED: 'true' } },
  {
    name: 'dev-team-watch',
    on: {
      DEV_TEAM_ENABLED: 'true',
      DEV_TEAM_ENDPOINT_URL: 'https://dev-team.example.test',
      DEV_TEAM_AUTH_TOKEN: 'test-token',
    },
  },
];

test('registry: every JobSpec name is unique', () => {
  const names = JOB_REGISTRY.map((spec) => spec.name);
  assert.equal(new Set(names).size, names.length, `duplicate job name in: ${names.join(', ')}`);
});

test('registry: start order matches the pinned pre-registry index.ts order, entry for entry', () => {
  assert.deepEqual(
    JOB_REGISTRY.map((spec) => spec.name),
    JOBS.map((row) => row.name),
    'JOB_REGISTRY order is pinned to the old hand-wired startX() sequence — a reorder (or an ' +
      'unregistered/renamed job) must update this table deliberately, in the same diff',
  );
});

test('SECURITY: with a minimal env (no opt-in flag set) only the two always-on jobs are enabled — a registry gate can never turn on a job the deployment has not opted into', () => {
  const cfg = loadConfig(BASE_ENV);
  for (const row of JOBS) {
    const spec = JOB_REGISTRY.find((s) => s.name === row.name)!;
    assert.equal(
      spec.enabled(cfg),
      row.on === null,
      row.on === null
        ? `${row.name}: always-on by design (no enable flag) — must report enabled on any valid config`
        : `${row.name}: opt-in — must report disabled when its flag is unset`,
    );
  }
});

test("registry: each opt-in gate reads exactly its own config flag — flipping one job's env enables that job and no other opt-in job", () => {
  for (const row of JOBS) {
    if (row.on === null) continue;
    const cfg = loadConfig({ ...BASE_ENV, ...row.on });
    for (const other of JOBS) {
      const spec = JOB_REGISTRY.find((s) => s.name === other.name)!;
      const expected = other.on === null || other.name === row.name;
      assert.equal(
        spec.enabled(cfg),
        expected,
        `${row.name} env on: ${other.name}.enabled() must be ${expected} — a gate reading the wrong ` +
          'config key (or two jobs sharing a flag) would flip here',
      );
    }
  }
});

// startRegisteredJobs/stopRegisteredJobs are deliberately NOT driven here:
// the registry starts each spec's real production starter (no runOnce
// injection point, by design), and the always-on embedding-model job's
// immediate first run would load the real embedding model as a side effect
// of a "pure" registry test. Per-starter behaviour (gates, trackers, DMs,
// disabled-means-no-timer) is already pinned by tests/backgroundJobs.test.ts
// and tests/backgroundJobsDisabled.test.ts against the SAME starter
// functions the specs delegate to.
