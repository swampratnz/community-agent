#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pipeline outcome ledger (see .github/workflows/pipeline-outcomes.yml).
//
// The self-improving pipeline has seven agent loops that fix, revise, resolve
// and merge PRs, and until now NOTHING measured them. A loop could burn an
// escalation on a one-command fix, die mid-turn without pushing, or thrash for
// weeks, and the only trace was a marker comment on one PR that nobody
// aggregates. "Is this loop earning its tokens?" was unanswerable.
//
// This reconstructs the ledger from evidence that ALREADY exists: every loop
// stamps a marker HTML comment when it engages, recovers committed-but-unpushed
// work, or escalates to a human. Counting those markers over a window gives a
// per-loop success/failure record with no new writes, no new state to keep in
// sync, and no LLM in the path — the same read-only, deterministic shape as
// scripts/check-changelog-coverage.mjs.
//
// Reads `gh pr view --json number,title,url,createdAt,comments` output for a
// set of PRs (a JSON array) on stdin; prints a Markdown report. Always exits 0
// — the caller decides what to do with the report.
//
// Usage:
//   ... build prs.json ... | node scripts/pipeline-outcomes.mjs [--window-days N]
//
// Reading the report:
//   * Engaged      — the loop started work on a PR (attempt markers).
//   * Recovered    — the agent COMMITTED but never pushed, and the workflow's
//                    deterministic checkpoint step rescued the work. Every one
//                    of these is an agent that ended its turn early (usually
//                    "waiting" for a command that never reports back), which is
//                    a prompt/harness defect, not a code defect. A rising
//                    Recovered count is the signal to fix the loop itself.
//   * Escalated    — the loop gave up and labelled `needs-human`.
//   * Clean        — engaged, neither recovered nor escalated.
// ---------------------------------------------------------------------------

/**
 * Loops that stamp markers, in report order. `attempt` is what counts as
 * "engaged"; auto-merge has no attempt marker (it merges silently on success
 * and only ever comments when it CAN'T), so its blocked/human-ready notices are
 * counted as engagements — a non-zero count there is by definition friction.
 */
const LOOPS = [
  {
    name: 'autofix',
    attempt: '<!-- pipeline-autofix-attempt -->',
    checkpoint: '<!-- pipeline-autofix-checkpoint -->',
    escalation: '<!-- pipeline-autofix-escalation -->',
  },
  {
    name: 'revise',
    attempt: '<!-- pipeline-pr-revise-attempt -->',
    checkpoint: '<!-- pipeline-pr-revise-checkpoint -->',
    escalation: '<!-- pipeline-pr-revise-escalation -->',
  },
  {
    name: 'conflict-resolver',
    attempt: '<!-- pipeline-pr-conflict-attempt -->',
    checkpoint: '<!-- pipeline-pr-conflict-checkpoint -->',
    escalation: '<!-- pipeline-pr-conflict-escalation -->',
  },
  {
    name: 'auto-merge',
    attempt: '<!-- pipeline-automerge-blocked -->',
    checkpoint: null,
    escalation: '<!-- pipeline-automerge-human-ready -->',
  },
];

import { readFileSync } from 'node:fs';

const windowArg = process.argv.find((a) => a.startsWith('--window-days'));
const windowDays = windowArg
  ? Number(windowArg.split('=')[1] ?? process.argv[process.argv.indexOf(windowArg) + 1])
  : 14;

let prs;
try {
  prs = JSON.parse(readFileSync(0, 'utf8')); // fd 0 = stdin
} catch {
  console.error('pipeline-outcomes: expected an array of `gh pr view --json ...` objects on stdin.');
  process.exit(0); // never fail the workflow on a bad/empty pipe
}
if (!Array.isArray(prs)) prs = [prs];

const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
const inWindow = (iso) => iso && Date.parse(iso) >= cutoff;

const tally = new Map(LOOPS.map((loop) => [loop.name, { engaged: 0, recovered: 0, escalated: 0 }]));
/** PRs worth a human glance: escalations and silent-death recoveries. */
const notable = [];

for (const pr of prs) {
  const comments = Array.isArray(pr?.comments) ? pr.comments : [];
  for (const loop of LOOPS) {
    const has = (marker) =>
      marker &&
      comments.filter((c) => inWindow(c?.createdAt) && String(c?.body ?? '').includes(marker)).length;

    const engaged = has(loop.attempt) || 0;
    const recovered = has(loop.checkpoint) || 0;
    const escalated = has(loop.escalation) || 0;
    if (!engaged && !recovered && !escalated) continue;

    const row = tally.get(loop.name);
    // A checkpoint or escalation without an attempt marker still means the loop
    // ran (the conflict resolver's older runs predate its attempt marker), so
    // count the engagement rather than losing it.
    row.engaged += Math.max(engaged, recovered, escalated);
    row.recovered += recovered;
    row.escalated += escalated;

    if (recovered || escalated) {
      notable.push({
        number: pr.number,
        title: pr.title ?? '',
        url: pr.url ?? '',
        loop: loop.name,
        recovered,
        escalated,
      });
    }
  }
}

const rows = LOOPS.map((loop) => ({ name: loop.name, ...tally.get(loop.name) })).filter(
  (row) => row.engaged > 0,
);

if (rows.length === 0) {
  console.log(`No pipeline loop engaged in the last ${windowDays} days — nothing to report.`);
  process.exit(0);
}

const pct = (n, d) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);

console.log(`## Pipeline loop outcomes — last ${windowDays} days\n`);
console.log('| Loop | Engaged | Recovered (agent stopped early) | Escalated to human | Clean |');
console.log('| --- | --- | --- | --- | --- |');
for (const row of rows) {
  const clean = Math.max(0, row.engaged - row.escalated - row.recovered);
  console.log(
    `| ${row.name} | ${row.engaged} | ${row.recovered} (${pct(row.recovered, row.engaged)}) | ` +
      `${row.escalated} (${pct(row.escalated, row.engaged)}) | ${clean} (${pct(clean, row.engaged)}) |`,
  );
}

if (notable.length > 0) {
  console.log('\n### PRs where a loop did not finish on its own\n');
  for (const item of notable.sort((a, b) => b.number - a.number)) {
    const what = [
      item.escalated ? `escalated ${item.escalated}×` : '',
      item.recovered ? `checkpoint-recovered ${item.recovered}×` : '',
    ]
      .filter(Boolean)
      .join(', ');
    console.log(`- #${item.number} — **${item.loop}** ${what} — ${item.title}`);
  }
}

console.log(
  '\n> A **Recovered** row is an agent that committed work then ended its turn without pushing — ' +
    'a prompt/harness defect in that loop, not a code defect in the PR. **Escalated** is the loop ' +
    'correctly giving up. Both are cheaper to fix than to keep paying for.',
);
