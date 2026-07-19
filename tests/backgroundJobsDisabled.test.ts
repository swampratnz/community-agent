import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time. CONTEXT_BUILDER_ENABLED /
// KNOWLEDGE_REFRESH_ENABLED / DOCS_INGEST_ENABLED / KNOWLEDGE_LINK_CHECK_ENABLED /
// INTERACTION_RETENTION_DAYS / ROSTER_DEPARTED_RETENTION_DAYS / STATUS_CHECK_ENABLED /
// ADMIN_DIGEST_ENABLED / DEPARTED_ADMIN_ALERT_ENABLED / USAGE_COST_DIGEST_ENABLED / ENGAGEMENT_ALERT_ENABLED are deliberately left unset
// (all default off/0) so this file exercises the disabled-by-default
// path in its own process, separate from tests/backgroundJobs.test.ts and
// tests/statusCheckAlert.test.ts which pin their respective flags on — config
// is parsed once per process at import time, so "enabled" and "disabled"
// behaviour can't be exercised from the same file.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const {
  startContextBuilder,
  startKnowledgeRefresh,
  startDocsIngest,
  startKnowledgeLinkCheck,
  startStatusCheck,
  startEmbeddingHealthCheckJob,
} = await import('../src/backgroundJobs.js');
const { startRetentionPurge } = await import('../src/interactionRetention.js');
const { startRosterRetentionPurge } = await import('../src/rosterRetention.js');
const { startAdminDigest } = await import('../src/adminDigest.js');
const { startDepartedAdminAlert } = await import('../src/departedAdminAlert.js');
const { startUsageCostDigest } = await import('../src/usageCostDigest.js');
const { startEngagementAlert } = await import('../src/engagementAlert.js');

function makeAdapter(): { adapter: PlatformAdapter; dms: Array<{ userId: string; text: string }> } {
  const dms: Array<{ userId: string; text: string }> = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage() {},
    async sendMessage(_out: OutgoingMessage) {},
    async sendDirectMessage(userId: string, text: string) {
      dms.push({ userId, text });
    },
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return { adapter, dms };
}

const JOBS = [
  ['startContextBuilder', startContextBuilder],
  ['startKnowledgeRefresh', startKnowledgeRefresh],
  ['startDocsIngest', startDocsIngest],
  ['startKnowledgeLinkCheck', startKnowledgeLinkCheck],
  ['startRetentionPurge', startRetentionPurge],
  ['startRosterRetentionPurge', startRosterRetentionPurge],
  ['startAdminDigest', startAdminDigest],
  ['startDepartedAdminAlert', startDepartedAdminAlert],
  ['startUsageCostDigest', startUsageCostDigest],
  ['startEngagementAlert', startEngagementAlert],
] as const;

test('SECURITY: a job whose own enable flag is off creates no timer, never invokes runOnce, and can never DM — zero behaviour change for a deployment that has not opted in', () => {
  for (const [name, start] of JOBS) {
    const { adapter, dms } = makeAdapter();
    const runOnce = async () => {
      throw new Error(`unreachable: ${name} is disabled — runOnce must never be invoked`);
    };
    const timer = start([adapter], runOnce);
    assert.equal(timer, null, `${name}: disabled by default — no timer created, no extra queries`);
    assert.equal(dms.length, 0, `${name}: no DM ever sent for a job whose enable flag is off`);
  }
});

test('SECURITY: startStatusCheck creates no timer, never invokes runOnce, and can never DM when STATUS_CHECK_ENABLED is unset — zero behaviour change for a deployment that has not opted in (issue #321)', () => {
  const { adapter, dms } = makeAdapter();
  const runOnce = async () => {
    throw new Error('unreachable: status check is disabled — runOnce must never be invoked');
  };
  const timer = startStatusCheck([adapter], runOnce);
  assert.equal(timer, null, 'disabled by default — no timer created, no extra polling');
  assert.equal(dms.length, 0, 'no DM ever sent when the status check is disabled');
});

test('startEmbeddingHealthCheckJob creates a timer unconditionally — unlike every job above, it has no enable flag to leave off (issue #376)', () => {
  const { adapter } = makeAdapter();
  const timer = startEmbeddingHealthCheckJob([adapter], async () => {});
  assert.ok(
    timer,
    'the embedding-model health check runs even when every other background job is disabled by default',
  );
  clearInterval(timer);
});
