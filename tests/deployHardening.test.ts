import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// docs/SECURITY.md's operational checklist has said "whatsapp-auth/
// directory is chmod 700, not in git" for a while, but nothing in the deploy
// path enforced it: deploy/community-agent.service had no UMask= directive
// (so anything the service creates inherits the host's default umask,
// typically 022, i.e. world-readable) and docs/DEPLOYMENT.md's WhatsApp
// linking step — the actual creation point, run manually before the service
// exists — had no umask/chmod of its own. whatsapp-auth/ holds the Baileys
// session state; reading it is a full session hijack. See issue #1301.
const SERVICE_UNIT = fileURLToPath(new URL('../deploy/community-agent.service', import.meta.url));
const DEPLOYMENT_DOC = fileURLToPath(new URL('../docs/DEPLOYMENT.md', import.meta.url));

test('SECURITY: deploy/community-agent.service sets UMask=0077', () => {
  const unit = readFileSync(SERVICE_UNIT, 'utf8');
  assert.match(unit, /^UMask=0077$/m, 'the systemd unit must set UMask=0077 in the [Service] section');
});

test('SECURITY: docs/DEPLOYMENT.md sets umask 077 before the WhatsApp linking command', () => {
  const doc = readFileSync(DEPLOYMENT_DOC, 'utf8');
  const umaskIndex = doc.indexOf('umask 077');
  const linkIndex = doc.indexOf('npm run whatsapp:link');
  assert.notEqual(umaskIndex, -1, 'expected a `umask 077` invocation in the WhatsApp linking step');
  assert.notEqual(linkIndex, -1, 'expected the `npm run whatsapp:link` command');
  assert.ok(
    umaskIndex < linkIndex,
    'umask 077 must textually precede the npm run whatsapp:link command in the linking step',
  );
});
