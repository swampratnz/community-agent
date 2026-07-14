import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. A regression of the bug this
// guards against (empty optional numeric env vars failing
// z.coerce.number().positive()) would make this whole test file exit(1)
// during import instead of failing a single assertion.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
// Reproduce the shipped .env.example: blank optional numeric vars.
process.env.HEALTH_PORT = '';
process.env.WHATSAPP_CLOUD_WEBHOOK_PORT = '';
process.env.INTERACTION_RETENTION_DAYS = '';
process.env.ROSTER_DEPARTED_RETENTION_DAYS = '';

const { config, emptyStringsToUndefined } = await import('../src/config.js');

test('emptyStringsToUndefined: blank values become undefined, everything else passes through', () => {
  const result = emptyStringsToUndefined({
    HEALTH_PORT: '',
    WHATSAPP_CLOUD_WEBHOOK_PORT: '',
    AGENT_MODEL: 'claude-sonnet-5',
    DISCORD_GUILD_ID: '0',
  });
  assert.equal(result.HEALTH_PORT, undefined);
  assert.equal(result.WHATSAPP_CLOUD_WEBHOOK_PORT, undefined);
  assert.equal(result.AGENT_MODEL, 'claude-sonnet-5');
  assert.equal(result.DISCORD_GUILD_ID, '0', 'a literal "0" is a real value, not blank — must survive');
});

test('config: blank HEALTH_PORT (as shipped in .env.example) is treated as unset, not 0', () => {
  assert.equal(config.behaviour.healthPort, undefined);
});

test('config: blank optional coerced-number env var falls back to its default', () => {
  assert.equal(config.whatsapp.cloud.webhookPort, 8080);
  assert.equal(config.behaviour.interactionRetentionDays, 0);
});

test('config: ROSTER_DEPARTED_RETENTION_DAYS unset (default) is disabled — zero behaviour change (issue #136)', () => {
  assert.equal(config.behaviour.rosterDepartedRetentionDays, 0);
});

test('config: MODERATION_STRIKE_WINDOW_DAYS unset (default) is undefined — unbounded strike accumulation, unchanged from before this option existed (issue #194)', () => {
  assert.equal(config.moderation.strikeWindowDays, undefined);
});

test('config: WhatsApp group welcome is off by default with a sensible cooldown', () => {
  assert.equal(config.whatsapp.welcome.enabled, false);
  assert.equal(config.whatsapp.welcome.cooldownMinutes, 180);
});

test('config: Anthropic status check (issue #206) is off by default, pointed at the real status endpoint, on a 5-minute poll', () => {
  assert.equal(config.statusCheck.enabled, false);
  assert.equal(config.statusCheck.apiUrl, 'https://status.claude.com/api/v2/summary.json');
  assert.equal(config.statusCheck.pollMinutes, 5);
});

test('SECURITY: STATUS_CHECK_API_URL must be https — a non-https override fails config validation at startup, same enforcement as DOCS_INGEST_INDEX_URL', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        STATUS_CHECK_API_URL: 'http://status.claude.com/api/v2/summary.json',
      },
    },
  );
  assert.notEqual(result.status, 0, 'a non-https STATUS_CHECK_API_URL must fail config validation, not load');
  assert.match(result.stderr, /STATUS_CHECK_API_URL must be https/);
});

test('SECURITY: default CONTEXT_EXPORT_PATH is untracked (issue #108) — the unattended exporter must never dirty a tracked file the nightly redeploy checks', () => {
  assert.equal(config.contextExport.path, 'var/community-context.md');
  assert.notEqual(
    config.contextExport.path,
    'docs/COMMUNITY-CONTEXT.md',
    'must not default to the committed, human-curated file',
  );

  const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.ok(
    gitignore.split('\n').some((line) => line.trim() === '/var/'),
    ".gitignore must exclude the export default path's directory",
  );
});

test('config: KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL unset (default) is disabled — zero behaviour change (issue #337)', () => {
  assert.equal(config.behaviour.knowledgeLowRatedCaveatMinUnhelpful, 0);
});

test('SECURITY: KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL=1 fails config validation — a single rater must never trigger the caveat', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL: '1',
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    'KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL=1 must fail config validation, not load',
  );
  assert.match(
    result.stderr,
    /KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL must be 0 \(disabled\) or at least 2/,
  );
});

test('config: AGENT_MAX_TURNS_MEMBER defaults to 6 (issue #347)', () => {
  assert.equal(config.llm.memberMaxTurns, 6);
});

test('SECURITY: AGENT_MAX_TURNS_MEMBER rejects a non-positive value — validated identically to AGENT_MAX_TURNS, fail-fast rather than a silently unbounded member/guest loop', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        AGENT_MAX_TURNS_MEMBER: '0',
      },
    },
  );
  assert.notEqual(result.status, 0, 'AGENT_MAX_TURNS_MEMBER=0 must fail config validation, not load');
  assert.match(result.stderr, /AGENT_MAX_TURNS_MEMBER/);
});

test('config: AGENT_MODEL_MEMBER unset (default) resolves to undefined — opt-out, byte-identical model resolution (issue #382)', () => {
  assert.equal(config.llm.memberModel, undefined);
});

test('config: AGENT_MODEL_MEMBER empty string resolves to undefined, same as unset (issue #382)', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        AGENT_MODEL_MEMBER: '',
      },
    },
  );
  assert.equal(result.status, 0, 'empty AGENT_MODEL_MEMBER must load cleanly');
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.llm.memberModel, undefined);
});

test("config: AGENT_MODEL_MEMBER set to a non-empty string resolves to that exact string, no allow-list validation beyond AGENT_MODEL's own (issue #382)", () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        AGENT_MODEL_MEMBER: 'claude-haiku-4-5-20251001',
      },
    },
  );
  assert.equal(result.status, 0, 'a non-empty AGENT_MODEL_MEMBER must load cleanly');
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.llm.memberModel, 'claude-haiku-4-5-20251001');
});

test('config: AGENT_MODEL_CLASSIFIER unset (default) resolves to undefined — opt-out, byte-identical model resolution (issue #394)', () => {
  assert.equal(config.llm.classifierModel, undefined);
});

test('config: AGENT_MODEL_CLASSIFIER empty string resolves to undefined, same as unset (issue #394)', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        AGENT_MODEL_CLASSIFIER: '',
      },
    },
  );
  assert.equal(result.status, 0, 'empty AGENT_MODEL_CLASSIFIER must load cleanly');
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.llm.classifierModel, undefined);
});

test("config: AGENT_MODEL_CLASSIFIER set to a non-empty string resolves to that exact string, no allow-list validation beyond AGENT_MODEL's own (issue #394)", () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        AGENT_MODEL_CLASSIFIER: 'claude-haiku-4-5-20251001',
      },
    },
  );
  assert.equal(result.status, 0, 'a non-empty AGENT_MODEL_CLASSIFIER must load cleanly');
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.llm.classifierModel, 'claude-haiku-4-5-20251001');
});

test('config: KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL=2 (the refined minimum) loads cleanly', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL: '2',
      },
    },
  );
  assert.equal(result.status, 0, 'KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL=2 must load cleanly');
});

test('config: KNOWLEDGE_STALE_MAX_AGE_DAYS unset (default) is disabled — zero behaviour change (issue #380)', () => {
  assert.equal(config.adminDigest.knowledgeStaleMaxAgeDays, 0);
});

test('SECURITY: KNOWLEDGE_STALE_MAX_AGE_DAYS=50 fails config validation — below the 90-day floor (issue #380)', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        KNOWLEDGE_STALE_MAX_AGE_DAYS: '50',
      },
    },
  );
  assert.notEqual(result.status, 0, 'KNOWLEDGE_STALE_MAX_AGE_DAYS=50 must fail config validation, not load');
  assert.match(result.stderr, /KNOWLEDGE_STALE_MAX_AGE_DAYS must be 0 \(disabled\) or at least 90/);
});

test('SECURITY: KNOWLEDGE_STALE_MAX_AGE_DAYS smaller than a nonzero KNOWLEDGE_STALE_DAYS fails config validation — the absolute ceiling must never be shorter than the popularity-aware window (issue #380)', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        KNOWLEDGE_STALE_DAYS: '100',
        KNOWLEDGE_STALE_MAX_AGE_DAYS: '90',
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    'KNOWLEDGE_STALE_MAX_AGE_DAYS=90 with KNOWLEDGE_STALE_DAYS=100 must fail config validation, not load — both individually clear their own floor, but the ceiling would be shorter than the popularity-aware window',
  );
  assert.match(
    result.stderr,
    /KNOWLEDGE_STALE_MAX_AGE_DAYS must not be smaller than a nonzero KNOWLEDGE_STALE_DAYS/,
  );
});

test('config: KNOWLEDGE_STALE_MAX_AGE_DAYS=90 (the floor) loads cleanly', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        KNOWLEDGE_STALE_MAX_AGE_DAYS: '90',
      },
    },
  );
  assert.equal(result.status, 0, 'KNOWLEDGE_STALE_MAX_AGE_DAYS=90 must load cleanly');
});

test('config: KNOWLEDGE_CANDIDATE_STALE_DAYS unset (default) is disabled — zero behaviour change (issue #398)', () => {
  assert.equal(config.adminDigest.knowledgeCandidateStaleDays, 0);
});

test('config: KNOWLEDGE_CANDIDATE_STALE_DAYS=0 loads cleanly (explicit disable, issue #398)', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        KNOWLEDGE_CANDIDATE_STALE_DAYS: '0',
      },
    },
  );
  assert.equal(result.status, 0, 'KNOWLEDGE_CANDIDATE_STALE_DAYS=0 must load cleanly');
});

test('config: KNOWLEDGE_CANDIDATE_STALE_DAYS=14 (the floor) loads cleanly (issue #398)', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        KNOWLEDGE_CANDIDATE_STALE_DAYS: '14',
      },
    },
  );
  assert.equal(result.status, 0, 'KNOWLEDGE_CANDIDATE_STALE_DAYS=14 must load cleanly');
});

test('config: KNOWLEDGE_CANDIDATE_STALE_DAYS=90 (well above the floor) loads cleanly (issue #398)', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        KNOWLEDGE_CANDIDATE_STALE_DAYS: '90',
      },
    },
  );
  assert.equal(result.status, 0, 'KNOWLEDGE_CANDIDATE_STALE_DAYS=90 must load cleanly');
});

test('SECURITY: KNOWLEDGE_CANDIDATE_STALE_DAYS=13 fails config validation — below the 14-day floor (issue #398)', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        KNOWLEDGE_CANDIDATE_STALE_DAYS: '13',
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    'KNOWLEDGE_CANDIDATE_STALE_DAYS=13 must fail config validation, not load',
  );
  assert.match(result.stderr, /KNOWLEDGE_CANDIDATE_STALE_DAYS must be 0 \(disabled\) or at least 14/);
});

test('SECURITY: KNOWLEDGE_CANDIDATE_STALE_DAYS=1 fails config validation — below the 14-day floor (issue #398)', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        KNOWLEDGE_CANDIDATE_STALE_DAYS: '1',
      },
    },
  );
  assert.notEqual(result.status, 0, 'KNOWLEDGE_CANDIDATE_STALE_DAYS=1 must fail config validation, not load');
  assert.match(result.stderr, /KNOWLEDGE_CANDIDATE_STALE_DAYS must be 0 \(disabled\) or at least 14/);
});

test('config: AGENT_WEB_SEARCH_RATE_LIMIT_PER_HOUR defaults to 20 (issue #412)', () => {
  assert.equal(config.llm.webSearchRateLimitPerHour, 20);
});

test('SECURITY: AGENT_WEB_SEARCH_RATE_LIMIT_PER_HOUR rejects a non-positive value — fail-fast rather than a silently unbounded WebSearch cap (issue #412)', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        AGENT_WEB_SEARCH_RATE_LIMIT_PER_HOUR: '0',
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    'AGENT_WEB_SEARCH_RATE_LIMIT_PER_HOUR=0 must fail config validation, not load',
  );
  assert.match(result.stderr, /AGENT_WEB_SEARCH_RATE_LIMIT_PER_HOUR/);
});

test('config: dev-team dispatch service is off by default with no endpoint/token and a 1-minute watch poll', () => {
  assert.equal(config.devTeam.enabled, false);
  assert.equal(config.devTeam.endpointUrl, undefined);
  assert.equal(config.devTeam.authToken, undefined);
  assert.equal(config.devTeam.watchPollMinutes, 1);
});

test('config: DEV_TEAM_* env vars parse — enabled, an http:// tailnet endpoint, and a token all load cleanly (http is allowed for the tailnet-internal endpoint)', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        DEV_TEAM_ENABLED: 'true',
        DEV_TEAM_ENDPOINT_URL: 'http://ubuntudevagent:8738',
        DEV_TEAM_AUTH_TOKEN: 'dev-team-secret-token',
        DEV_TEAM_WATCH_POLL_MINUTES: '2',
      },
    },
  );
  assert.equal(
    result.status,
    0,
    'a fully-configured dev-team block must load cleanly, http endpoint included',
  );
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.devTeam.enabled, true);
  assert.equal(printed.devTeam.endpointUrl, 'http://ubuntudevagent:8738');
  assert.equal(printed.devTeam.authToken, 'dev-team-secret-token');
  assert.equal(printed.devTeam.watchPollMinutes, 2);
});

test('SECURITY: DEV_TEAM_ENABLED=true without an endpoint URL and token fails config validation — fail-fast rather than at the first dispatch', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        DEV_TEAM_ENABLED: 'true',
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    'DEV_TEAM_ENABLED=true with no url/token must fail config validation, not load',
  );
  assert.match(result.stderr, /DEV_TEAM_ENDPOINT_URL and DEV_TEAM_AUTH_TOKEN are both required/);
});

test('SECURITY: DEV_TEAM_ENABLED=true with an endpoint but NO token still fails config validation — a credential-less enable is refused', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/loadConfig.ts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        DEV_TEAM_ENABLED: 'true',
        DEV_TEAM_ENDPOINT_URL: 'http://ubuntudevagent:8738',
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    'DEV_TEAM_ENABLED=true with a url but no token must fail config validation',
  );
  assert.match(result.stderr, /DEV_TEAM_ENDPOINT_URL and DEV_TEAM_AUTH_TOKEN are both required/);
});
