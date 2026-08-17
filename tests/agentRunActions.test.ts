import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The shared agent-run actions (.github/actions/agent-checkpoint,
 * .github/actions/agent-verify-push).
 *
 * Four workflows carried near-identical copies of the checkpoint step and three
 * carried near-identical copies of the verify step, and they DRIFTED: at
 * extraction time only the three PR loops had the 40-hex guard on the `gh api`
 * lookup and the ancestor pre-check, while only the build worker had the
 * push-failure fallback to a side ref. That is the same failure mode the
 * review-verdict contract hit (#731) — one fix, landed in some copies.
 *
 * These tests pin the two halves that a refactor like this can silently break:
 *
 *   1. WIRING. Composite actions ignore unknown `with:` keys silently, so a
 *      renamed input degrades to the default with no error anywhere — for the
 *      checkpoint that means "no recovery comment", for the verify step it
 *      means the escalation loses its marker. And a caller that regresses to a
 *      LOCAL `./` reference would hand PR-head content the definition of the
 *      steps that publish work and decide escalation.
 *   2. BEHAVIOUR. The extracted shell is executed against stub `git`/`gh`
 *      binaries, so the guards are tested rather than assumed — the same
 *      approach tests/reviewVerdict.test.ts takes with the verdict helpers.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepoFile = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

const CHECKPOINT_ACTION = '.github/actions/agent-checkpoint/action.yml';
const VERIFY_ACTION = '.github/actions/agent-verify-push/action.yml';

/** Workflows that must use the shared actions, and which ones each one calls. */
const CALLERS: Record<string, { checkpoint: boolean; verify: boolean }> = {
  'pipeline-build.yml': { checkpoint: true, verify: false },
  'pipeline-pr-autofix.yml': { checkpoint: true, verify: true },
  'pipeline-pr-revise.yml': { checkpoint: true, verify: true },
  'pipeline-pr-conflict.yml': { checkpoint: true, verify: true },
};

const OWNER_REPO = 'swampratnz/community-agent';
/** The repo-qualified, default-branch-pinned form callers must use. */
const CHECKPOINT_REF = `${OWNER_REPO}/.github/actions/agent-checkpoint@main`;
const VERIFY_REF = `${OWNER_REPO}/.github/actions/agent-verify-push@main`;

/**
 * Pull the `run: |` body out of a composite action and strip the YAML block
 * indentation, so it can be executed directly.
 */
function extractRunBody(source: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'run: |');
  assert.notEqual(start, -1, 'no `run: |` block found');
  const body = lines.slice(start + 1);
  const indent = body[0].length - body[0].trimStart().length;
  const out: string[] = [];
  for (const line of body) {
    if (line.trim() !== '' && line.length - line.trimStart().length < indent) break;
    out.push(line.slice(indent));
  }
  return out.join('\n');
}

/** Declared input names of a composite action (top-level keys under `inputs:`). */
function declaredInputs(source: string): Set<string> {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === 'inputs:');
  assert.notEqual(start, -1, 'no `inputs:` block');
  const names = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

/** The `with:` keys a workflow passes at each `uses:` of the given action. */
function withKeysFor(workflow: string, usesRef: string): string[][] {
  const lines = workflow.split('\n');
  const calls: string[][] = [];
  lines.forEach((line, i) => {
    if (!line.trim().endsWith(`uses: ${usesRef}`) && line.trim() !== `uses: ${usesRef}`) return;
    const keys: string[] = [];
    let seenWith = false;
    for (const next of lines.slice(i + 1)) {
      if (next.trim() === 'with:') {
        seenWith = true;
        continue;
      }
      if (!seenWith) {
        if (next.trim().startsWith('- ') || next.trim() === '') break;
        continue;
      }
      // Stop at the next step (a `- name:`/`- uses:` bullet) or a dedent.
      if (/^\s*- /.test(next)) break;
      const match = /^\s{10}([a-z0-9-]+):/.exec(next);
      if (match) keys.push(match[1]);
      else if (next.trim() !== '' && !/^\s{12,}/.test(next) && !next.trim().startsWith('#')) break;
    }
    calls.push(keys);
  });
  return calls;
}

// ---------------------------------------------------------------------------
// 1 · Wiring
// ---------------------------------------------------------------------------

test('SECURITY: the shared agent actions are pinned to the default branch, never referenced locally', () => {
  // A local `./.github/actions/...` reference resolves from the WORKSPACE at
  // step-run time. The three PR loops check out the pull request's head branch
  // and the agent edits that tree, so `./` would let PR-controlled content
  // define the step that publishes the agent's work and the step that decides
  // whether the run escalates to a human. The repo-qualified `@main` form is
  // fetched from the default branch instead, matching the property these
  // workflow FILES already have (their triggers only ever run main's copy).
  for (const name of Object.keys(CALLERS)) {
    const source = readRepoFile(`.github/workflows/${name}`);
    assert.equal(
      /uses:\s*\.\//.test(source),
      false,
      `${name} references an action by local ./ path; PR-head content must never define the checkpoint or verify steps`,
    );
    for (const line of source.match(/^.*uses:.*agent-(checkpoint|verify-push).*$/gm) ?? []) {
      assert.match(
        line.trim(),
        /^uses: swampratnz\/community-agent\/\.github\/actions\/agent-(checkpoint|verify-push)@main$/,
        `${name} must pin the shared action to the default branch (found: ${line.trim()})`,
      );
    }
  }
});

test('every workflow that runs a repair agent uses the shared checkpoint and verify actions', () => {
  for (const [name, expected] of Object.entries(CALLERS)) {
    const source = readRepoFile(`.github/workflows/${name}`);
    assert.equal(
      source.includes(`uses: ${CHECKPOINT_REF}`),
      expected.checkpoint,
      `${name} checkpoint wiring`,
    );
    assert.equal(source.includes(`uses: ${VERIFY_REF}`), expected.verify, `${name} verify wiring`);
  }
});

test('no workflow keeps an inline copy of the checkpoint or verify logic', () => {
  // The drift guard: the fragments below are load-bearing lines of the two
  // extracted implementations. If one reappears in a workflow, the copies are
  // back and the next fix will land in some of them.
  for (const [name, expected] of Object.entries(CALLERS)) {
    const source = readRepoFile(`.github/workflows/${name}`);
    assert.equal(
      source.includes('-ckpt-'),
      false,
      `${name} builds a -ckpt- side ref inline — that belongs to the shared checkpoint action`,
    );
    assert.equal(
      source.includes('--json headRefOid'),
      false,
      `${name} reads the PR head tip inline — that belongs to the shared verify action`,
    );
    // The agent's-final-summary extraction. The build worker keeps its own
    // (its verify step asserts a PR exists, owns the lane labels and the
    // recovery-PR path — a different contract that shares only a name), so it
    // is the one workflow allowed to retain this.
    assert.equal(
      source.includes('select(.type? == "result")'),
      !expected.verify,
      `${name}: inline summary extraction should exist only in the build worker's bespoke verify step`,
    );
  }
});

test('SECURITY: every `with:` key a caller passes is a declared input of the action', () => {
  // GitHub silently IGNORES unknown inputs on a composite action, so a typo or
  // a rename degrades to the default with no error: `checkpoint-marker` would
  // become empty (no recovery comment) and `escalate-marker` would drop the
  // marker the outcomes ledger counts escalations by.
  const specs = [
    { action: CHECKPOINT_ACTION, ref: CHECKPOINT_REF, key: 'checkpoint' as const },
    { action: VERIFY_ACTION, ref: VERIFY_REF, key: 'verify' as const },
  ];
  for (const { action, ref, key } of specs) {
    const inputs = declaredInputs(readRepoFile(action));
    for (const [name, expected] of Object.entries(CALLERS)) {
      if (!expected[key]) continue;
      const calls = withKeysFor(readRepoFile(`.github/workflows/${name}`), ref);
      assert.ok(calls.length > 0, `${name} does not call ${ref}`);
      for (const keys of calls) {
        for (const passed of keys) {
          assert.ok(
            inputs.has(passed),
            `${name} passes \`${passed}\` to ${path.basename(path.dirname(action))}, which declares no such input`,
          );
        }
      }
    }
  }
});

test('required inputs of the shared actions are passed by every caller', () => {
  const required = (source: string) => {
    const names = new Set<string>();
    const lines = source.split('\n');
    const start = lines.findIndex((line) => line === 'inputs:');
    let current = '';
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break;
      const head = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
      if (head) current = head[1];
      else if (/^ {4}required:\s*true\s*$/.test(line) && current) names.add(current);
    }
    return names;
  };
  for (const { action, ref, key } of [
    { action: CHECKPOINT_ACTION, ref: CHECKPOINT_REF, key: 'checkpoint' as const },
    { action: VERIFY_ACTION, ref: VERIFY_REF, key: 'verify' as const },
  ]) {
    const need = required(readRepoFile(action));
    for (const [name, expected] of Object.entries(CALLERS)) {
      if (!expected[key]) continue;
      for (const keys of withKeysFor(readRepoFile(`.github/workflows/${name}`), ref)) {
        for (const req of need) {
          assert.ok(keys.includes(req), `${name} omits required input \`${req}\` of ${ref}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 2 · Behaviour — run the extracted shell against stub git/gh
// ---------------------------------------------------------------------------

type StubEnv = Record<string, string>;

/**
 * Execute the checkpoint script with stub `git` and `gh` on PATH. The stubs
 * append every interesting call to $STUB_LOG so the test can assert on what
 * the script actually did.
 */
function runCheckpoint(env: StubEnv): {
  code: number;
  log: string[];
  outputs: Record<string, string>;
  stdout: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'ckpt-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const log = path.join(dir, 'log');
    writeFileSync(log, '');
    const outputs = path.join(dir, 'outputs');
    writeFileSync(outputs, '');

    // `git push <url> HEAD:refs/heads/<target>` — log the TARGET only, never
    // the URL (it carries the token).
    writeFileSync(
      path.join(bin, 'git'),
      `#!/usr/bin/env bash
case "$1 $2" in
  "rev-parse --abbrev-ref") echo "\${STUB_BRANCH}" ;;
  "rev-parse HEAD") [ -n "\${STUB_HEAD}" ] && echo "\${STUB_HEAD}" || exit 1 ;;
  "rev-list --count") echo "\${STUB_AHEAD:-0}" ;;
  "merge-base --is-ancestor") exit "\${STUB_ANCESTOR:-0}" ;;
  "push "*)
    target="\${3#HEAD:refs/heads/}"
    echo "push \${target}" >> "\${STUB_LOG}"
    if [ "\${target}" = "\${STUB_PUSH_REJECTS:-}" ]; then exit 1; fi
    ;;
  *) : ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(bin, 'gh'),
      `#!/usr/bin/env bash
if [ "$1" = "api" ]; then printf '%s' "\${STUB_REMOTE_SHA:-}"; echo; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  body="$(cat)"
  { echo "comment \${3}"; echo "\${body}"; } >> "\${STUB_LOG}"
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );
    chmodSync(path.join(bin, 'git'), 0o755);
    chmodSync(path.join(bin, 'gh'), 0o755);

    const script = extractRunBody(readRepoFile(CHECKPOINT_ACTION));
    const result = spawnSync('bash', ['-c', script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: outputs,
        STUB_LOG: log,
        GH_TOKEN: 'stub-token',
        REPOSITORY: OWNER_REPO,
        DEFAULT_BRANCH: 'main',
        RUN_ID: '4242',
        BRANCH: '',
        HEAD_BEFORE: '',
        PR_NUMBER: '',
        CHECKPOINT_MARKER: '',
        LOOP_NAME: 'test agent',
        SUBJECT: 'This',
        ...env,
      },
      encoding: 'utf8',
    });
    const parsed: Record<string, string> = {};
    for (const line of readFileSync(outputs, 'utf8').split('\n')) {
      const match = /^([a-z]+)=(.*)$/.exec(line);
      if (match) {
        assert.equal(parsed[match[1]], undefined, `output key ${match[1]} written more than once`);
        parsed[match[1]] = match[2];
      }
    }
    return {
      code: result.status ?? -1,
      log: readFileSync(log, 'utf8').split('\n').filter(Boolean),
      outputs: parsed,
      stdout: `${result.stdout}${result.stderr}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('checkpoint: an agent that committed nothing pushes nothing', () => {
  const run = runCheckpoint({ BRANCH: 'fix/x', STUB_HEAD: SHA_A, HEAD_BEFORE: SHA_A });
  assert.deepEqual(run.log, []);
  assert.equal(run.outputs.checkpointed, 'false');
  assert.equal(run.code, 0);
});

test('SECURITY: checkpoint refuses to treat the default branch or a detached HEAD as a work branch', () => {
  for (const branch of ['main', 'HEAD', '']) {
    const run = runCheckpoint({ BRANCH: '', STUB_BRANCH: branch, STUB_HEAD: SHA_B, STUB_AHEAD: '3' });
    assert.deepEqual(run.log, [], `pushed something with branch=${branch || '(empty)'}`);
    assert.equal(run.outputs.checkpointed, 'false');
  }
});

test('checkpoint: with no head-before it falls back to "ahead of the default branch" (the build worker)', () => {
  const behind = runCheckpoint({ BRANCH: '', STUB_BRANCH: 'feat/y', STUB_HEAD: SHA_A, STUB_AHEAD: '0' });
  assert.deepEqual(behind.log, []);

  const ahead = runCheckpoint({ BRANCH: '', STUB_BRANCH: 'feat/y', STUB_HEAD: SHA_A, STUB_AHEAD: '2' });
  assert.deepEqual(ahead.log, ['push feat/y']);
  assert.equal(ahead.outputs.checkpointed, 'true');
  assert.equal(ahead.outputs.ref, 'feat/y');
  assert.equal(ahead.outputs.sha, SHA_A);
});

test('checkpoint: a non-sha API response still fast-forwards onto the work branch', () => {
  // The 40-hex guard. `gh api` prints its ERROR BODY to stdout on a 404, so an
  // unguarded value fails the ancestor test and diverts a perfectly
  // fast-forwardable recovery onto a side ref.
  const run = runCheckpoint({
    BRANCH: 'fix/x',
    STUB_HEAD: SHA_A,
    HEAD_BEFORE: SHA_B,
    STUB_REMOTE_SHA: 'null',
    STUB_ANCESTOR: '1', // would divert, if the guard did not blank the value first
  });
  assert.deepEqual(run.log, ['push fix/x']);
  assert.equal(run.outputs.ref, 'fix/x');
});

test('checkpoint: a diverged remote is parked on a side ref, never rewritten', () => {
  const run = runCheckpoint({
    BRANCH: 'fix/x',
    STUB_HEAD: SHA_A,
    HEAD_BEFORE: SHA_B,
    STUB_REMOTE_SHA: SHA_B,
    STUB_ANCESTOR: '1',
  });
  assert.deepEqual(run.log, ['push fix/x-ckpt-4242']);
  assert.equal(run.outputs.ref, 'fix/x-ckpt-4242');
  assert.equal(run.outputs.checkpointed, 'true');
});

test('checkpoint: a rejected fast-forward push falls back to the side ref (the build worker behaviour)', () => {
  const run = runCheckpoint({
    BRANCH: 'fix/x',
    STUB_HEAD: SHA_A,
    HEAD_BEFORE: SHA_B,
    STUB_REMOTE_SHA: SHA_B,
    STUB_ANCESTOR: '0', // pre-check says fast-forward…
    STUB_PUSH_REJECTS: 'fix/x', // …but the server disagrees
  });
  assert.deepEqual(run.log, ['push fix/x', 'push fix/x-ckpt-4242']);
  assert.equal(run.outputs.ref, 'fix/x-ckpt-4242');
});

test('checkpoint: an already-pushed head reports the ref without pushing again', () => {
  const run = runCheckpoint({
    BRANCH: 'fix/x',
    STUB_HEAD: SHA_A,
    HEAD_BEFORE: SHA_B,
    STUB_REMOTE_SHA: SHA_A,
  });
  assert.deepEqual(run.log, []);
  assert.equal(run.outputs.ref, 'fix/x', 'the surviving branch must still be reported for the resume path');
  assert.equal(run.outputs.checkpointed, 'false');
});

test('checkpoint: the recovery comment leads with the marker and is skipped without a PR', () => {
  const withPr = runCheckpoint({
    BRANCH: 'fix/x',
    STUB_HEAD: SHA_A,
    HEAD_BEFORE: SHA_B,
    PR_NUMBER: '77',
    CHECKPOINT_MARKER: '<!-- pipeline-autofix-checkpoint -->',
    LOOP_NAME: 'autofix agent',
  });
  const commentAt = withPr.log.indexOf('comment 77');
  assert.notEqual(commentAt, -1, 'no recovery comment posted');
  // Marker on line 1 — pipeline-outcomes.mjs and the handoff resolver match on
  // position, not just on the text appearing somewhere.
  assert.equal(withPr.log[commentAt + 1], '<!-- pipeline-autofix-checkpoint -->');
  const body = withPr.log.slice(commentAt + 1).join('\n');
  assert.match(body, /autofix agent/);
  assert.match(body, /not verified by the agent/);
  // The old inline form carried its YAML block indentation into the comment,
  // so GitHub rendered the explanation as a code block.
  assert.equal(/^ {4}/m.test(body), false, 'comment body is indented — it will render as a code block');

  const noPr = runCheckpoint({ BRANCH: 'fix/x', STUB_HEAD: SHA_A, HEAD_BEFORE: SHA_B });
  assert.equal(
    noPr.log.some((line) => line.startsWith('comment')),
    false,
    'commented without a PR number',
  );
});
