#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Changelog coverage check (see .github/workflows/changelog-coverage.yml).
//
// CHANGELOG.md is what the bot's `whats_new` tool reads, so a merged user-facing
// PR that never lands an entry is invisible to the community. This flags recent
// merged PRs whose change is NOT yet reflected in the changelog, so the gap is
// caught the next day instead of discovered weeks later.
//
// Reads `gh pr list --json number,title,mergedAt,body` output on stdin and
// CHANGELOG.md from the repo root; prints one Markdown bullet per undocumented
// user-facing PR (empty output = nothing missing). Always exits 0 — the caller
// (workflow) decides what to do with the list.
//
// Usage:
//   gh pr list --state merged --limit 100 \
//     --json number,title,mergedAt,body | node scripts/check-changelog-coverage.mjs [--window-days N]
//
// Coverage is judged by three signals, ANY of which counts as "documented":
//   1. the PR's own number appears in CHANGELOG.md (`#123`), OR
//   2. a `Closes #NNN` issue number from the PR body appears there, OR
//   3. a distinctive identifier from the PR title (a snake_case tool name or an
//      UPPER_SNAKE env var) appears there — the changelog often describes a
//      feature in prose and cites the *issue* rather than the PR number.
// This is a heuristic tuned to err toward flagging (a false "please check #X" is
// cheap; a silently-missing entry is not). Internal PRs (CI, deps, tests,
// pipeline, pure refactors) are excluded by title convention — mirror this list
// in the workflow if you rename anything.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changelog = readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
const changelogLower = changelog.toLowerCase();
const referenced = new Set([...changelog.matchAll(/#(\d+)/g)].map((m) => m[1]));

const windowArg = process.argv.find((a) => a.startsWith('--window-days'));
const windowDays = windowArg
  ? Number(windowArg.split('=')[1] ?? process.argv[process.argv.indexOf(windowArg) + 1])
  : 14;

// Non-user-facing PRs that legitimately never get a changelog entry. Keep this
// deliberately broad: a missed CI/chore PR flagged here is worse noise than a
// missed feature, and features never match these prefixes.
const INTERNAL =
  /^(ci|ci\(|docs\(|chore|test|refactor|Bump |Build worker|build worker)|De-flake|un-break|self-heal|needs-human|build-failure|forbid the build worker|grant gh issue view|deterministic fast-path|merge_group|Keep security-floor|reduce needs-human|one-shot framing|report-only|adversarial routine|Pipeline hardening|Backport push-loop|Auto-resolve build-worker|Auto-fix failing PRs|Auto-retry failed builds|Give build worker room|per-issue concurrency|migrate base schema|dummy CLAUDE_CODE|security-gate runner-flag|Harden and tidy the CI|Harden build-worker tool allowlist|repo governance files|security-invariants test gate|Move community-context export/i;

const tokensOf = (title) =>
  [...title.matchAll(/\b([a-z][a-z0-9]*_[a-z0-9_]+|[A-Z][A-Z0-9]+_[A-Z0-9_]+)\b/g)].map((m) => m[1]);

function isDocumented(pr) {
  const closes = [...(pr.body || '').matchAll(/[Cc]loses #(\d+)/g)].map((m) => m[1]);
  if ([String(pr.number), ...closes].some((id) => referenced.has(id))) return true;
  // Prose-described entry: a distinctive tool/env identifier is enough.
  return tokensOf(pr.title).some((tk) => changelogLower.includes(tk.toLowerCase()));
}

let prs;
try {
  prs = JSON.parse(readFileSync(0, 'utf8')); // fd 0 = stdin
} catch {
  console.error('check-changelog-coverage: expected `gh pr list --json ...` JSON on stdin.');
  process.exit(0); // never fail the workflow on a bad/empty pipe
}

const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
const gaps = prs
  .filter((pr) => pr.mergedAt && Date.parse(pr.mergedAt) >= cutoff)
  .filter((pr) => !INTERNAL.test(pr.title))
  .filter((pr) => !isDocumented(pr))
  .sort((a, b) => b.number - a.number);

for (const pr of gaps) {
  console.log(`- [ ] #${pr.number} (${pr.mergedAt.slice(0, 10)}) — ${pr.title}`);
}
