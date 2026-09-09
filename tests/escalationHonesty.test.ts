import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What a PR-repair loop's escalation comment is allowed to claim
 * (.github/actions/agent-verify-push/action.yml, issue #1349).
 *
 * The shared verify step knows exactly one fact: the PR's tip did not move.
 * It used to publish a great deal more than that. Autofix's fixed prose said
 * "the cause needs a workflow-file change I can't push, or it was not safely
 * fixable"; on PR #1270 both halves were false — the agent had ended its turn
 * waiting on a background command, so the flake-vs-defect triage CLAUDE.md
 * requires of it never ran, and the real fix was a test-file change squarely
 * inside its own push scope. A maintainer read that sentence, believed it, and
 * the PR sat for seven days. The conflict resolver made the same shape of
 * claim ("the two sides are semantically incompatible") about #609, which a
 * human then merged cleanly in minutes.
 *
 * So there are two things to pin, and neither is cosmetic:
 *
 *   1. The loops' fixed prose states an OUTCOME and never a CAUSE. Any wording
 *      that survives here is what a human reads before deciding whether to
 *      look at a PR at all.
 *   2. The stall detector fires on the real stall transcripts and not on an
 *      ordinary refusal. Its regex is EXTRACTED FROM THE ACTION and run
 *      through the real `grep -E` with the same flags the action uses — a
 *      string assertion would pass on a pattern that compiles and matches the
 *      wrong set, which is the only failure that matters.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

const ACTION = read('.github/actions/agent-verify-push/action.yml');

/** The loops whose fixed escalation prose a maintainer reads on a red PR. */
const LOOPS: Array<{ file: string; label: string }> = [
  { file: '.github/workflows/pipeline-pr-autofix.yml', label: 'autofix' },
  { file: '.github/workflows/pipeline-pr-revise.yml', label: 'revise' },
  { file: '.github/workflows/pipeline-pr-conflict.yml', label: 'conflict resolver' },
];

/**
 * The prose a loop hands the shared action, scoped to those values rather than
 * the whole file: the surrounding comments must stay free to *explain* the
 * claims this guard removed, or documenting the fix would trip the guard on
 * itself.
 */
function escalationProse(file: string): string {
  // `\s{12,}`, not `\s{10,}`: sibling keys in the same `with:` block sit at
  // exactly 10 spaces, so a 10-space continuation swept straight past this
  // field's value into `summary-title:` and whatever followed it. Harmless
  // with today's content, but it made the guard's real scope something other
  // than what this docstring claims, and a future edit could have tripped it
  // on a neighbouring field's unrelated wording.
  const bodies = [
    ...read(file).matchAll(/^\s*(?:escalation-body|no-summary-note):[^\n]*\n((?:\s{12,}[^\n]*\n)+)/gm),
  ]
    .map((m) => m[1] ?? '')
    .join('\n');
  assert.notEqual(bodies.length, 0, `no escalation prose found in ${file} — restructured?`);
  return bodies;
}

test("SECURITY: no PR-repair loop's escalation prose asserts the code is unfixable", () => {
  for (const loop of LOOPS) {
    assert.doesNotMatch(
      escalationProse(loop.file),
      /not safely fixable/i,
      `${loop.label}: this claim was false on #1270 and cost the PR seven days`,
    );
  }
});

test("SECURITY: no PR-repair loop's escalation prose asserts the conflict is unresolvable", () => {
  for (const loop of LOOPS) {
    assert.doesNotMatch(
      escalationProse(loop.file),
      /semantically incompatible/i,
      `${loop.label}: this claim was false on #609, which a human merged cleanly in minutes`,
    );
  }
});

test('SECURITY: no PR-repair loop guesses a cause from the absence of an agent summary', () => {
  // Deliberately keyed on `usually means` rather than the full phrase autofix
  // happened to use. The first version of this guard required the literal
  // "which usually means" and so walked straight past revise.yml's "That
  // usually means a gate it could not make green, a `.github/workflows/`
  // change it cannot push, …" — the same cause-guess, one word apart, in a
  // loop this very LOOPS array already listed. A guard that only catches the
  // wording you already removed catches nothing.
  for (const loop of LOOPS) {
    assert.doesNotMatch(
      escalationProse(loop.file),
      /\busually means\b/i,
      `${loop.label}: a missing summary is an absence of evidence, not evidence of a cause`,
    );
  }
});

// ---------------------------------------------------------------------------
// The stall detector.
// ---------------------------------------------------------------------------

const grepAvailable = spawnSync('grep', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = grepAvailable ? false : 'grep not installed — the action itself requires it on the runner';

/** Slice the double-quoted ERE out of the action's `grep -qiE "..."` call. */
function extractStallPattern(): string {
  const marker = 'grep -qiE "';
  const from = ACTION.indexOf(marker);
  assert.notEqual(from, -1, 'stall detector not found — action restructured?');
  const bodyStart = from + marker.length;
  const to = ACTION.indexOf('"', bodyStart);
  assert.notEqual(to, -1, 'unterminated stall pattern — action restructured?');
  // The YAML holds the shell source, so `\b` is written `\\b` there.
  return ACTION.slice(bodyStart, to).replace(/\\\\/g, '\\');
}

const STALL_PATTERN = extractStallPattern();

function matchesStall(summary: string): boolean {
  const res = spawnSync('grep', ['-qiE', STALL_PATTERN], { input: summary, encoding: 'utf8' });
  assert.ok(res.status === 0 || res.status === 1, `grep errored: ${res.stderr}`);
  return res.status === 0;
}

/**
 * The first three are the agents' ACTUAL final messages from the three runs
 * that produced this failure mode. If a pattern change stops matching these,
 * the detector no longer detects the thing it was written for.
 */
const STALLS: Array<{ name: string; summary: string }> = [
  {
    name: 'autofix on #1270',
    summary: "I'll stop issuing further calls and wait for the background test run to complete.",
  },
  {
    name: 'revise on #606',
    summary:
      "I'll wait for the monitor notification before continuing with the security test suite, build, and push.",
  },
  {
    name: 'conflict resolver on #609 (Monitor task)',
    summary: 'The merge is staged. Waiting on the Monitor task before I commit and push.',
  },
  {
    name: 'a deferral phrased as a check-back',
    summary: 'Tests are running in the background; I will check back once they finish.',
  },
];

/**
 * Refusals the FIRST version of the detector wrongly flagged. Its second arm
 * was `once (the|that|this)[^.]{0,40}\b(finish|complet|return|land)` with no
 * word boundary on the pronouns, so "the" matched as a substring of "they" —
 * which is also the only reason the check-back fixture above passed. It fired
 * on all three of these, i.e. it told a maintainer that a fully-reasoned stop
 * meant "nobody has looked yet". Kept as named cases rather than folded into
 * REAL_STOPS so a future rewrite of the pattern has to answer for them.
 */
const NEAR_MISS_STOPS: string[] = [
  'I could not finish this once the CI logs landed',
  'Once these tests land I expect green, but the failure is real and I did not push',
  'The reviewer asked that this land in a separate PR, so I did not finish here',
];

test('SECURITY: the escalation flags every known stall shape', { skip }, () => {
  for (const c of STALLS) {
    assert.equal(
      matchesStall(c.summary),
      true,
      `${c.name}: a stall that reads as a diagnosis is what cost #1270 seven days`,
    );
  }
});

/**
 * The other half of the contract. A principled stop is a real verdict from a
 * run that did the work, and burying it under "this looks like a stall" would
 * be the same disservice in the opposite direction.
 */
const REAL_STOPS: string[] = [
  'The fix requires editing .github/workflows/ci.yml, which my token cannot push. Escalating.',
  'I ran the failing tests in isolation and they fail there too: the PR genuinely breaks the tier map. I did not push a change that would paper over it.',
  'Reproduced the failure, but the correct fix changes the public tool schema, which is beyond what this PR asked for.',
  'security-floor.json disagreed with the true counts; regenerating it did not make CI green, so the failure is real.',
];

test('SECURITY: a principled refusal is never mislabelled as a stall', { skip }, () => {
  for (const summary of [...REAL_STOPS, ...NEAR_MISS_STOPS]) {
    assert.equal(matchesStall(summary), false, `wrongly flagged as a stall: ${summary}`);
  }
});

test('the stall note tells the reader what it does NOT mean, not just what it might', () => {
  // The whole failure was a maintainer believing a confident wrong sentence.
  // The replacement has to be explicit about its own uncertainty and about the
  // conclusion it must not be read as supporting.
  const note = ACTION.slice(ACTION.indexOf('looks like a stall'));
  assert.match(note, /nobody has looked yet/i);
  assert.match(note, /NOT as/);
  assert.match(note, /re-queue/i);
});

test('a non-success stop reason is reported instead of the stall guess', () => {
  // error_max_turns and error_during_execution are facts the execution log
  // states outright; guessing past them would be the original bug again.
  assert.match(ACTION, /error_max_turns\)/);
  assert.match(ACTION, /ran out of turns/i);
  assert.match(ACTION, /ended in an error/i);
  // The stall heuristic must not overwrite a stop reason the log already knows.
  assert.match(ACTION, /if \[ -z "\$\{outcome_note\}" \] && \[ -n "\$\{summary\}" \]/);
});
