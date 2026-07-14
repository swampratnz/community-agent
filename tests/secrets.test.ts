import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// (including full WhatsApp Cloud credentials) before importing anything
// that (transitively) loads it.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-oauth-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-discord-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_CLOUD_ACCESS_TOKEN ??= 'test-cloud-access-token';
process.env.WHATSAPP_CLOUD_VERIFY_TOKEN ??= 'test-cloud-verify-token';
process.env.WHATSAPP_CLOUD_APP_SECRET ??= 'test-cloud-app-secret';
// The dev-team bearer token is a credential too (config.devTeam.authToken).
// Set it WITHOUT DEV_TEAM_ENABLED so the config refine doesn't also require an
// endpoint URL — runtimeSecrets() includes the token regardless of the flag.
process.env.DEV_TEAM_AUTH_TOKEN ??= 'test-dev-team-token';

const { runtimeSecrets } = await import('../src/agent/secrets.js');
const { filterOutbound } = await import('../src/agent/outbound.js');

test('SECURITY: runtimeSecrets() includes the WhatsApp Cloud app secret', () => {
  const secrets = runtimeSecrets();
  assert.ok(
    secrets.includes('test-cloud-app-secret'),
    'the HMAC app secret must be covered by the belt-and-braces redaction layer',
  );
});

test('SECURITY: filterOutbound redacts every configured WhatsApp Cloud credential', () => {
  const secrets = runtimeSecrets();
  const text =
    'access=test-cloud-access-token verify=test-cloud-verify-token appSecret=test-cloud-app-secret';
  const out = filterOutbound(text, 'full', secrets);
  assert.ok(!out.includes('test-cloud-access-token'));
  assert.ok(!out.includes('test-cloud-verify-token'));
  assert.ok(!out.includes('test-cloud-app-secret'));
});

test('SECURITY: runtimeSecrets() includes the dev-team bearer token, and filterOutbound redacts it', () => {
  const secrets = runtimeSecrets();
  assert.ok(
    secrets.includes('test-dev-team-token'),
    'the dev-team service credential must be covered by the belt-and-braces redaction layer',
  );
  const out = filterOutbound('dispatched via token=test-dev-team-token', 'full', secrets);
  assert.ok(
    !out.includes('test-dev-team-token'),
    'the dev-team token must never survive the outbound filter',
  );
});
