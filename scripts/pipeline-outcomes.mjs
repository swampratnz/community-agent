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
//   * Routed       — the loop deliberately handed the PR to a human because
//                    POLICY says so, having done everything asked of it. Today
//                    that is auto-merge meeting a governance-path PR. This is a
//                    SUCCESS and is counted separately from Escalated on
//                    purpose: lumping the two together made auto-merge read as
//                    "80% escalated" when it was in fact routing correctly
//                    almost every time, which both buried the real signal and
//                    kept the tracking issue permanently open (it auto-closes
//                    only on a window with no genuine failures).
//   * Clean        — engaged and finished by itself; not recovered, escalated
//                    or routed.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

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
    // No attempt marker: it merges silently on success and only ever comments
    // when it CANNOT, so both markers below are themselves the engagement.
    attempt: null,
    checkpoint: null,
    // A merge the branch protection REFUSED (e.g. it requires a human approving
    // review, which the automated verdict comment is not). Genuine friction:
    // the loop wanted to merge and could not.
    escalation: '<!-- pipeline-automerge-blocked -->',
    // A governance-path PR (.github/**, scripts/**, CLAUDE.md, docs/PIPELINE.md,
    // docs/VISION.md, …) that passed every other gate and was deliberately
    // handed to a human with a `human-merge-ready` label. This is the loop
    // working exactly as designed, NOT a failure — see `routed` below.
    routed: '<!-- pipeline-automerge-human-ready -->',
  },
];

const DEFAULT_WINDOW_DAYS = 14;
const windowArg = process.argv.find((a) => a.startsWith('--window-days'));
const requestedWindow = windowArg
  ? Number(windowArg.split('=')[1] ?? process.argv[process.argv.indexOf(windowArg) + 1])
  : DEFAULT_WINDOW_DAYS;
// A missing or non-numeric value used to render as "last NaN days" and match
// nothing — a confusing empty report rather than an obvious error. Fall back
// to the default instead; the workflow validates the input separately, so this
// only catches a hand-run invocation.
const windowDays =
  Number.isFinite(requestedWindow) && requestedWindow > 0 ? requestedWindow : DEFAULT_WINDOW_DAYS;

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

/**
 * Only the identity that actually POSTS markers can contribute one (issue #750
 * review, second pass). Markers are plain text in a public comment thread, so
 * without this any commenter could inflate "escalated" or manufacture a clean
 * window — and this report drives an auto-closing tracking issue, so a spoofed
 * row is not merely cosmetic.
 *
 * `claude[bot]` is deliberately NOT here, and that exclusion is the whole
 * point. Every marker across autofix/revise/conflict/auto-merge is written by
 * a DETERMINISTIC step using GITHUB_TOKEN, so it always lands as
 * github-actions; no loop ever posts a marker as claude. Meanwhile the revise
 * agent — uniquely among the loops — holds `Bash(gh pr comment:*)` (so it can
 * explain a principled refusal), runs under the claude[bot] identity, and
 * reads untrusted, prompt-injectable PR content. Allowing claude[bot] would
 * therefore hand the one injectable identity in the pipeline the ability to
 * fabricate ledger rows, which is worse than having no gate at all because the
 * gate implies the rows are trustworthy.
 *
 * Both github-actions renderings are accepted for the same reason
 * pipeline-pr-automerge.yml accepts both: gh's GraphQL comment authors render
 * as "github-actions" while REST renders "github-actions[bot]", and matching
 * only one made an identity gate silently match nothing.
 */
const MARKER_AUTHORS = new Set(['github-actions', 'github-actions[bot]']);
const fromPipeline = (comment) => MARKER_AUTHORS.has(comment?.author?.login ?? '');

const tally = new Map(
  LOOPS.map((loop) => [loop.name, { engaged: 0, recovered: 0, escalated: 0, routed: 0, clean: 0 }]),
);
/** PRs worth a human glance: escalations and silent-death recoveries. */
const notable = [];

for (const pr of prs) {
  const comments = Array.isArray(pr?.comments) ? pr.comments : [];
  for (const loop of LOOPS) {
    const has = (marker) =>
      marker &&
      comments.filter(
        (c) => fromPipeline(c) && inWindow(c?.createdAt) && String(c?.body ?? '').includes(marker),
      ).length;

    const engaged = has(loop.attempt) || 0;
    const recovered = has(loop.checkpoint) || 0;
    const escalated = has(loop.escalation) || 0;
    const routed = has(loop.routed) || 0;
    if (!engaged && !recovered && !escalated && !routed) continue;

    const row = tally.get(loop.name);
    // A checkpoint or escalation without an attempt marker still means the loop
    // ran (the conflict resolver's older runs predate its attempt marker), so
    // count the engagement rather than losing it.
    //
    // Recovered and Escalated are deliberately NOT mutually exclusive: one
    // engagement can be checkpoint-recovered AND then escalated (that is
    // exactly what happened on #609), so their percentages are each "share of
    // engagements with this outcome", not slices of a pie, and can legitimately
    // sum past 100%. Splitting them into exclusive buckets would hide the
    // double-failure case, which is the one most worth seeing.
    const engagements = Math.max(engaged, recovered, escalated, routed);
    row.engaged += engagements;
    row.recovered += recovered;
    row.escalated += escalated;
    row.routed += routed;
    // Clean is accumulated PER PR, never derived by subtracting loop totals
    // (issue #750 review). Because the two failure kinds overlap, aggregate
    // subtraction double-counts a double-failure PR and cancels out genuinely
    // clean engagements from OTHER PRs: one clean conflict-resolver PR plus one
    // #609-style attempt+checkpoint+escalation PR gave engaged=2, recovered=1,
    // escalated=1 → "0 clean", hiding a real clean run. A single engagement
    // that both recovered and escalated is ONE failed engagement, hence
    // max() rather than a sum.
    // Routed is subtracted alongside the two failure kinds because a routed
    // engagement did not finish by itself either — a human still has to press
    // merge. It is simply not a FAULT. `max(0, …)` guards the (unlikely, but
    // possible) case where one engagement is both routed and blocked, so the
    // two subtractions can never drive Clean negative.
    row.clean += Math.max(0, engagements - Math.max(recovered, escalated) - routed);

    // Deliberately NOT gated on `routed`. This list drives the tracking issue:
    // pipeline-outcomes.yml opens/refreshes it only when the report contains
    // the "did not finish on its own" heading, and closes it otherwise. Listing
    // a by-design governance routing here therefore pinned the issue open
    // forever and buried the genuine recoveries/escalations underneath it.
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
console.log(
  '| Loop | Engaged | Recovered (agent stopped early) | Escalated to human | Routed to human (by design) | Clean |',
);
console.log('| --- | --- | --- | --- | --- | --- |');
for (const row of rows) {
  console.log(
    `| ${row.name} | ${row.engaged} | ${row.recovered} (${pct(row.recovered, row.engaged)}) | ` +
      `${row.escalated} (${pct(row.escalated, row.engaged)}) | ` +
      `${row.routed} (${pct(row.routed, row.engaged)}) | ${row.clean} (${pct(row.clean, row.engaged)}) |`,
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
    'correctly giving up. Both are cheaper to fix than to keep paying for. The two are not ' +
    'mutually exclusive (one engagement can be recovered *and* then escalated), so those ' +
    'percentages are shares of engagements rather than slices of a pie and may sum past 100%.' +
    '\n>\n' +
    '> **Routed to human (by design)** is NOT a failure, and is deliberately left out of the ' +
    '"did not finish on its own" list: it is ' +
    'auto-merge meeting a governance-path PR (`.github/**`, `scripts/**`, `CLAUDE.md`, ' +
    '`docs/PIPELINE.md`, `docs/VISION.md`) and handing it to a person exactly as policy requires. ' +
    'Every path on that list is one a PR editing it could use to weaken the check that would catch ' +
    'it, so a Routed row is the guardrail working, not the loop struggling. `docs/SECURITY.md` used ' +
    'to be on the list and came off: no workflow or check reads it, so it could not do that, and it ' +
    'was costing 64% of the Routed rows. (It is not inert — `CLAUDE.md` points agents at it — but so ' +
    'are `docs/ARCHITECTURE.md` and `docs/agents/*`, which were never governed.)',
);
