import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The two dependencies that own this bot's RBAC/CONFIRM/secret-redaction
 * security spine (issue #1307, community-feedback #1292) must be bare exact
 * semver pins, not a caret/tilde/range — otherwise an unrelated
 * `npm install` (adding a package, `npm update`, a grouped dependabot bump)
 * can silently re-resolve the framework to a later, never-reviewed version
 * with no diff landing in this repo for any gate to catch.
 *
 * `@anthropic-ai/claude-agent-sdk` is deliberately NOT asserted here — the
 * 2026-07-22 CHANGELOG entry chose to leave its caret range alone, and this
 * proposal is scoped narrower than that policy call.
 */

const BARE_EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { dependencies: Record<string, string> };

test('SECURITY: @swampratnz/agent-base is a bare exact version pin, no caret/tilde/range', () => {
  assert.match(packageJson.dependencies['@swampratnz/agent-base'], BARE_EXACT_SEMVER);
});

test('SECURITY: @whiskeysockets/baileys is a bare exact version pin, no caret/tilde/range', () => {
  assert.match(packageJson.dependencies['@whiskeysockets/baileys'], BARE_EXACT_SEMVER);
});

test('SECURITY: the bare-exact-semver matcher rejects a caret range (positive control)', () => {
  assert.doesNotMatch('^0.6.4', BARE_EXACT_SEMVER);
});
