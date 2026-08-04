import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Community content registrations (prompt sections + persona roster) — the
// composition-root contract: src/index.ts registers these in production, so
// tests that assemble prompts register them explicitly here.
import './support/registerPromptSections.js';

// The byte-stability pin for buildSystemPrompt (agent-base plan item 8).
//
// Byte-stability is load-bearing for prompt caching: the system prompt
// prefixes the growing conversation history under the Agent SDK's prompt
// cache, so ANY byte of drift per (role, policy, persona, day) silently
// doubles per-turn cost rather than failing a test. This file freezes the
// FULL assembled output as sha256 hashes over the whole reachable input
// matrix, against a committed baseline captured from the pre-refactor
// assembler — the slot-based restructuring (and any later edit) must
// reproduce every one of these outputs byte-identically, or fail here.
//
// A deliberate prompt-text change is allowed to move the baseline, but only
// explicitly: regenerate with
//   UPDATE_SYSTEM_PROMPT_BASELINE=1 npx tsx --test tests/systemPromptByteStability.test.ts
// and commit the fixture diff in the same PR, so the cache invalidation is a
// reviewed decision, never an accident.

// systemPrompt.js loads config.ts (guild id for jump links), which validates
// env at import time — set a dummy env before dynamically importing it.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= 'ci-dummy-guild';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { buildSystemPrompt } = await import('@swampratnz/agent-base/agent/systemPrompt.js');
await import('./support/registerPersonas.js');
const { getPersona } = await import('../src/module/agent/personas.js');
const { config } = await import('@swampratnz/agent-base/config.js');

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'systemPromptByteStability.json',
);

// Date grounding enters buildSystemPrompt via the injectable `now` parameter
// (day-granularity NZ rendering) — hold it constant so the matrix pins
// everything, date line included. A second summer instant additionally pins
// the NZDT rendering of the same format.
const WINTER_NOW = new Date('2026-07-06T02:00:00Z'); // Monday, 6 July 2026 NZST
const SUMMER_NOW = new Date('2026-01-05T11:30:00Z'); // Tuesday, 6 January 2026 NZDT

const ROLES = ['guest', 'member', 'admin', 'super_admin'] as const;
const CODE_POLICIES = ['off', 'snippets', 'full'] as const;
const RESPONSE_STYLES = ['standard', 'plain'] as const;
const LANGUAGE_PREFERENCES = ['auto', 'en', 'mi'] as const;

const caller = {
  platform: 'discord' as const,
  userId: 'u1',
  userName: 'Chris',
  role: 'member' as const,
  conversationId: 'chan1',
  isDirect: false,
};

/**
 * The skills and image-input flags are read from live config at CALL time by
 * guidelines() (the module-scope-capture fix documented in systemPrompt.ts),
 * so both branches are reachable in-process by toggling the parsed config
 * object — no per-flag process forks needed here. Config's `as const` is
 * type-level only (the object is not frozen at runtime), so a narrow mutable
 * cast is enough. Every flag is restored in a finally so no other test in
 * this file can observe a stray value.
 */
type MutableFlag = { enabled: boolean };
const flags = {
  skills: config.agentSkills as MutableFlag,
  discordImage: config.discord.image as MutableFlag,
  whatsappImage: config.whatsapp.image as MutableFlag,
  cloudImage: config.whatsapp.cloud.image as MutableFlag,
};

function withFlags<T>(skills: boolean, image: boolean, fn: () => T): T {
  const prev = {
    skills: flags.skills.enabled,
    discordImage: flags.discordImage.enabled,
    whatsappImage: flags.whatsappImage.enabled,
    cloudImage: flags.cloudImage.enabled,
  };
  flags.skills.enabled = skills;
  // The IMAGE_INPUT_CLAUSE is keyed on the OR of all three image flags; the
  // matrix drives the Discord one and pins the OR equivalence separately.
  flags.discordImage.enabled = image;
  flags.whatsappImage.enabled = false;
  flags.cloudImage.enabled = false;
  try {
    return fn();
  } finally {
    flags.skills.enabled = prev.skills;
    flags.discordImage.enabled = prev.discordImage;
    flags.whatsappImage.enabled = prev.whatsappImage;
    flags.cloudImage.enabled = prev.cloudImage;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Every (role × code policy × style × language × skills × image) output, keyed for the fixture. */
function buildMatrix(): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const skills of [false, true]) {
    for (const image of [false, true]) {
      for (const role of ROLES) {
        for (const codeAnswers of CODE_POLICIES) {
          for (const responseStyle of RESPONSE_STYLES) {
            for (const languagePreference of LANGUAGE_PREFERENCES) {
              const key = `${role}|code=${codeAnswers}|style=${responseStyle}|lang=${languagePreference}|skills=${skills ? 'on' : 'off'}|image=${image ? 'on' : 'off'}`;
              const prompt = withFlags(skills, image, () =>
                buildSystemPrompt(
                  { ...caller, role },
                  { codeAnswers, responseStyle, languagePreference },
                  undefined,
                  WINTER_NOW,
                ),
              );
              hashes[key] = sha256(prompt);
            }
          }
        }
      }
    }
  }
  return hashes;
}

const CANONICAL_KEY = 'member|code=snippets|style=standard|lang=auto|skills=off|image=off';

function canonicalPrompt(): string {
  return withFlags(false, false, () =>
    buildSystemPrompt(
      caller,
      { codeAnswers: 'snippets', responseStyle: 'standard', languagePreference: 'auto' },
      undefined,
      WINTER_NOW,
    ),
  );
}

interface Fixture {
  note: string;
  now: string;
  hashes: Record<string, string>;
  canonicalKey: string;
  canonicalFull: string;
}

if (process.env.UPDATE_SYSTEM_PROMPT_BASELINE === '1') {
  const fixture: Fixture = {
    note:
      'Committed baseline for tests/systemPromptByteStability.test.ts — sha256 of the FULL ' +
      'buildSystemPrompt output per (role, code policy, response style, language preference, ' +
      'skills flag, image flag) at the fixed NZ date below. Regenerate ONLY for a deliberate ' +
      'prompt change: UPDATE_SYSTEM_PROMPT_BASELINE=1 npx tsx --test tests/systemPromptByteStability.test.ts',
    now: WINTER_NOW.toISOString(),
    hashes: buildMatrix(),
    canonicalKey: CANONICAL_KEY,
    canonicalFull: canonicalPrompt(),
  };
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
}

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

test('the full (role × policy × persona-default × flags) matrix is byte-identical to the committed baseline', () => {
  const actual = buildMatrix();
  assert.deepEqual(
    Object.keys(actual).sort(),
    Object.keys(fixture.hashes).sort(),
    'the matrix key set must match the baseline exactly — a new dimension needs a deliberate baseline regeneration',
  );
  for (const [key, hash] of Object.entries(fixture.hashes)) {
    assert.equal(
      actual[key],
      hash,
      `buildSystemPrompt output drifted for ${key} — byte-stability is load-bearing for prompt caching; ` +
        'if this change is deliberate, regenerate the baseline (see the fixture note) in the same PR',
    );
  }
});

test('the canonical member prompt matches the committed full text byte-for-byte (readable diff on drift)', () => {
  // The hash matrix proves identity but a hex mismatch is undiagnosable; this
  // one full-text pin makes the actual drifted bytes visible in the failure.
  assert.equal(fixture.hashes[CANONICAL_KEY], sha256(fixture.canonicalFull), 'fixture self-consistency');
  assert.equal(canonicalPrompt(), fixture.canonicalFull);
});

test('persona handling is pinned: default, explicit default id, and unknown id all yield the identical bytes', () => {
  const policy = { codeAnswers: 'snippets', responseStyle: 'standard', languagePreference: 'auto' } as const;
  const viaDefault = withFlags(false, false, () => buildSystemPrompt(caller, policy, undefined, WINTER_NOW));
  const viaId = withFlags(false, false, () =>
    buildSystemPrompt(caller, policy, getPersona('dave'), WINTER_NOW),
  );
  const viaUnknown = withFlags(false, false, () =>
    buildSystemPrompt(caller, policy, getPersona('no-such-persona'), WINTER_NOW),
  );
  assert.equal(viaDefault, viaId, 'explicitly passing the default persona must not change a byte');
  assert.equal(
    viaDefault,
    viaUnknown,
    'an unknown persona id must fall back to the default, byte-identically',
  );
});

test('the three image-input flags are byte-equivalent: any one of them produces the same prompt', () => {
  const policy = { codeAnswers: 'snippets', responseStyle: 'standard', languagePreference: 'auto' } as const;
  const build = () => buildSystemPrompt(caller, policy, undefined, WINTER_NOW);
  const viaDiscord = withFlags(false, true, build);
  const viaBaileys = withFlags(false, false, () => {
    flags.whatsappImage.enabled = true;
    try {
      return build();
    } finally {
      flags.whatsappImage.enabled = false;
    }
  });
  const viaCloud = withFlags(false, false, () => {
    flags.cloudImage.enabled = true;
    try {
      return build();
    } finally {
      flags.cloudImage.enabled = false;
    }
  });
  assert.equal(viaDiscord, viaBaileys);
  assert.equal(viaDiscord, viaCloud);
});

test('the date line format itself is pinned, NZST and NZDT (the one per-day-varying byte range)', () => {
  const policy = { codeAnswers: 'snippets', responseStyle: 'standard', languagePreference: 'auto' } as const;
  const winter = withFlags(false, false, () => buildSystemPrompt(caller, policy, undefined, WINTER_NOW));
  const summer = withFlags(false, false, () => buildSystemPrompt(caller, policy, undefined, SUMMER_NOW));
  assert.match(winter, /\n- Current date \(NZ\): Monday, 6 July 2026\n/);
  assert.match(summer, /\n- Current date \(NZ\): Tuesday, 6 January 2026\n/);
  // Day granularity only — a time-of-day component would invalidate the
  // cached prefix on every turn instead of once per NZ day.
  assert.doesNotMatch(winter, /\d{1,2}:\d{2}/);
  // The date line is the ONLY divergence between the two instants: same
  // day-keyed prompt shape, so within one NZ day the prompt is one exact string.
  assert.equal(
    winter.replace('Monday, 6 July 2026', ''),
    summer.replace('Tuesday, 6 January 2026', ''),
    'everything except the date line must be byte-identical across days',
  );
});
