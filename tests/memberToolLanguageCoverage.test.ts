import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SECURITY: structural coverage test (issue #1328) — CI enforcement for
 * "every `minTier: 'member'` tool file threads `getLanguagePreference`", a
 * property #1147 and #1176 each separately (and wrongly) claimed to have
 * completed by hand. `reactions.ts` was the file both sweeps missed — this
 * turns re-verification from something a human gets wrong twice into
 * something CI enforces going forward, same spirit as `toolTierMap.test.ts`.
 *
 * Deliberately a SOURCE-TEXT scan, not a runtime check over
 * `COMMUNITY_TOOL_TIERS`: the tier map has no per-tool file attribution, and
 * a property test over rendered strings would have to invoke every tool's
 * handler with a fabricated 'mi' preference — exactly the fragile,
 * per-tool-effort shape this test exists to avoid. A source scan is cheap,
 * mechanical, and impossible to satisfy without actually calling the helper.
 */
const TOOLS_DIR = fileURLToPath(new URL('../src/module/agent/tools/', import.meta.url));

/**
 * Deliberate exception: `prefs.ts`'s two tools (`set_response_style`,
 * `set_language_preference`) confirm a preference change in the instant of
 * making it — the member has no STANDING preference yet for that reply to
 * honour, which is a different design question from every other member
 * tool's "reply ignores an already-standing preference" bug. Keep this list
 * to exactly this one entry; a new member-tool file belongs on the
 * `getLanguagePreference` side, not here.
 */
const ALLOWLIST = new Set(['prefs.ts']);

test(
  "SECURITY: every minTier: 'member' tool file calls getLanguagePreference, or is on the explicit, " +
    'commented allowlist',
  () => {
    const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));
    const memberFiles: string[] = [];
    const uncovered: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(TOOLS_DIR, file), 'utf8');
      if (!/minTier:\s*'member'/.test(source)) continue;
      memberFiles.push(file);
      if (ALLOWLIST.has(file)) continue;
      if (!source.includes('getLanguagePreference')) {
        uncovered.push(file);
      }
    }
    // Sanity-checks the scan itself: a directory-listing or regex regression
    // that silently found zero files must not pass this test by vacuous truth.
    assert.ok(
      memberFiles.length >= 11,
      `expected at least 11 files declaring minTier: 'member', found ${memberFiles.length}: ${memberFiles.join(', ')}`,
    );
    assert.deepEqual(
      uncovered,
      [],
      'these minTier: \'member\' tool files have no getLanguagePreference call and are not on the ' +
        `explicit allowlist: ${uncovered.join(', ')} — every member-tool reply must honour a standing ` +
        'language preference, or be added to ALLOWLIST here with a documented reason',
    );
  },
);
