import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Reads the INSTALLED agent-base package's own source, resolved through its
// export map rather than a hardcoded dist/ path so a layout change follows
// instead of silently passing. `docs/SECURITY.md` §31 makes a claim about what
// agent-base's base-side `runtimeSecrets()` list contains — a claim two review
// rounds on PR #1341 flagged as unverifiable from this repo, since the
// framework lives in a package. It IS verifiable; it just has to be checked
// mechanically rather than asserted in prose. Doing it here means the claim
// can never drift from the package this repo is pinned to (exact-pinned since
// #1308, so a framework bump is always a reviewed diff that reddens this file
// if it drops an entry).
const require = createRequire(import.meta.url);

/** Resolve through the package's export map and read it, or fail loudly — a
 * gate that passes because it could not find its subject is not a gate. */
function readInstalled(specifier: string): string {
  try {
    return readFileSync(require.resolve(specifier), 'utf8');
  } catch (err) {
    throw new Error(
      `could not read ${specifier} from the installed @swampratnz/agent-base. If the package ` +
        `moved or renamed this file, re-read it and update docs/SECURITY.md §31 to match.`,
      { cause: err },
    );
  }
}

/** Just the runtimeSecrets() body, so a match can't come from an unrelated part of the file. */
function runtimeSecretsBody(): string {
  const source = readInstalled('@swampratnz/agent-base/agent/secrets.js');
  const start = source.indexOf('function runtimeSecrets');
  assert.notEqual(start, -1, 'runtimeSecrets() must exist in the installed agent-base package');
  return source.slice(start);
}

test("SECURITY: agent-base's base-side runtimeSecrets() list still contains every credential docs/SECURITY.md section 31 says it does", () => {
  const body = runtimeSecretsBody();

  // The exact set section 31 enumerates as "already covered base-side". A
  // future agent-base that drops one silently reopens the M2-class hole this
  // backstop exists to close; it reddens here instead of shipping.
  for (const configPath of [
    'config.llm.oauthToken',
    'config.discord.botToken',
    'config.db.url',
    'config.whatsapp.cloud.accessToken',
    'config.whatsapp.cloud.verifyToken',
    'config.whatsapp.cloud.appSecret',
    'config.devTeam.authToken',
    'config.github.token',
  ]) {
    assert.ok(
      body.includes(configPath),
      `${configPath} must still be in agent-base's runtimeSecrets() list (docs/SECURITY.md section 31 says it is)`,
    );
  }
});

test("SECURITY: agent-base's runtimeSecrets() still spreads module-registered getters, the seam agentModule.ts's runtimeSecrets field fills", () => {
  // Without this spread the manifest's runtimeSecrets field would register a
  // getter that is never read — the registration a silent no-op, and
  // FLEET_SUPERVISOR_TOKEN unredacted again with nothing to show it.
  assert.match(
    runtimeSecretsBody(),
    /\.\.\.registered\.map\(/,
    "runtimeSecrets() must still spread module-registered getters, or the manifest's runtimeSecrets field is a no-op",
  );
});

test('SECURITY: agent-base still reads the fleet bearer token from FLEET_SUPERVISOR_TOKEN, the exact name agentModule.ts registers', () => {
  // The registered getter names this variable itself, so a rename upstream
  // makes the registration a permanent silent no-op — covered by nothing, and
  // invisible, since the feature is inert on this deployment today.
  assert.match(
    readInstalled('@swampratnz/agent-base/fleet/heartbeat.js'),
    /env\.FLEET_SUPERVISOR_TOKEN/,
    'agent-base must still read env.FLEET_SUPERVISOR_TOKEN — a rename makes the manifest registration a silent no-op',
  );

  const manifest = readFileSync(new URL('../src/module/agentModule.ts', import.meta.url), 'utf8');
  assert.match(
    manifest,
    /process\.env\.FLEET_SUPERVISOR_TOKEN/,
    'agentModule.ts must register the same variable name agent-base reads',
  );
});
