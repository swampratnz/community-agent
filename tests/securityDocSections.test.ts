import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// docs/SECURITY.md's threat-model sections, pinned exactly.
//
// WHY THIS FILE EXISTS
//
// This document used to be on the auto-merge governance list, which routed
// every PR touching it to a mandatory human merge. Measured against the last
// 40 merges it appeared in 7 of them and was the ONLY governed path in all
// seven — 64% of every human press that list forced, more than `.github/`.
//
// It came off that list because the list's own stated reason does not reach
// it. The reason is that a PR editing a governed path can weaken the check
// that would catch it: `pull_request` CI runs the workflow FROM THE PR BRANCH,
// so a PR can neuter a gate and still show that named check "passing". That is
// true of `.github/`, `scripts/`, and the lint/typecheck config. It is not
// true of this file: no workflow or check reads it, so editing it cannot
// change what runs or what "green" means.
//
// It is NOT inert, and an earlier draft of this comment wrongly said so.
// CLAUDE.md:10 tells every agent to start with README.md, "then
// docs/ARCHITECTURE.md and docs/SECURITY.md", and both the build worker and
// the review worker are told to read CLAUDE.md — so an agent following that
// pointer does read this document, and a wrong edit could mislead one. That
// pointer is shared with docs/ARCHITECTURE.md, docs/STANDARDS.md and
// docs/agents/*, none of which are governed either; and the rules an agent
// must not regress live in CLAUDE.md's own security-posture section, which
// stays governed. So the belief-channel is real but not unique to this file,
// and the snapshot below does not close it — it pins structure, not content.
//
// What it CAN do is drift — stop describing the controls that actually exist —
// and losing the gate lost the guaranteed human read that would notice. This
// snapshot is the replacement, and it is the same trade
// tests/toolTierMap.test.ts already makes for a MORE dangerous file: pin the
// structure so a change becomes a reviewable diff instead of an unnoticed one,
// at zero throughput cost.
//
// It is not hypothetical. PRs #1035 and #1057 each added a section numbered
// 27, both passed every check, and the collision was caught by hand afterwards
// while resolving their merge conflict. The uniqueness assertion below catches
// that in CI instead.
//
// MAINTENANCE: adding a section means adding one line here, in document order.
// That is the intended friction — the diff is the audit trail, and it makes
// "which invariant changed" a question the review can answer from the diff
// alone. Regenerate wholesale with:
//
//   npx tsx tests/dumpSecurityDocSections.ts
const SECURITY_DOC = fileURLToPath(new URL('../docs/SECURITY.md', import.meta.url));

/** Every `### <n>. <title>` threat-model section, in document order. */
const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ['1', 'Privilege escalation via chat ("prompt injection")'],
  ['2', 'Secret exposure'],
  ['3', 'Abuse / cost runaway'],
  ['4', 'Moderation misuse / accountability'],
  ['5', 'Host compromise / blast radius'],
  ['6', 'Data protection (member PII)'],
  ['6b', 'WhatsApp LIDs must never become member ids (2026-08-01 incident)'],
  ['7', 'Cross-platform identity linking (`link_member` / `unlink_member`)'],
  ['8', 'Image generation via the host Grok CLI (`generate_image`)'],
  ['9', 'Emoji reactions (`react_to_message`, issue #231)'],
  ['10', 'Cosmetic community roles (`assign_community_role` / `remove_community_role`, issue #232)'],
  ['11', 'Discord thread management (`create_thread` / `archive_thread`, issue #229)'],
  ['11b', 'Scheduled events (`create_event`, issue #230)'],
  ['12', 'GitHub issue filing (`suggest_issue`, opt-in)'],
  ['13', 'WhatsApp/Discord voice transcription (configurable min tier, opt-in)'],
  [
    '14',
    'Real-time admin escalation after a max-turns failure (`ESCALATION_TO_ADMIN_ENABLED`, off by default, issue #479)',
  ],
  ['15', 'Help-channel auto-answer mode (`AUTO_ANSWER_CHANNEL_IDS`, opt-in, Discord-only, issue #477)'],
  ['16', 'Config-flag visibility (`feature_flags`, super-admin, issue #559)'],
  ['17', 'Opt-in Discord auto-enroll (`DISCORD_AUTO_ENROLL_MEMBERS`, off by default, issue #605)'],
  ['18', 'WhatsApp bot-side block list (`block_user`/`unblock_user`, issue #572)'],
  [
    '20',
    'Discord slash commands (`/kb`, `/whois`, `/projects`, `/guidelines`, `/digest`, `DISCORD_SLASH_COMMANDS_ENABLED`, off by default, issues #744, #841)',
  ],
  ['19', 'Agent Skills (`AGENT_SKILLS_ENABLED`, off by default, issues #741, #755, #757, #759)'],
  ['21', 'Pipeline handoff notes (build worker → PR-review worker)'],
  [
    '22',
    'Image-attachment input (`IMAGE_INPUT_ENABLED` Discord / `WHATSAPP_IMAGE_INPUT_ENABLED` WhatsApp-Baileys / `WHATSAPP_CLOUD_IMAGE_INPUT_ENABLED` WhatsApp Cloud API, all off by default, `super_admin`-only default, issues #783 / #879 / #891)',
  ],
  [
    '23',
    'WhatsApp text commands (`!whois`, `!projects`, `!guidelines`, `!digest`, `WHATSAPP_TEXT_COMMANDS_ENABLED`, off by default, issue #859)',
  ],
  ['24', 'WhatsApp text-command discovery (`community_info`, issue #872)'],
  ['25', 'Projects — shared team memory (`project_*`, issue #927)'],
  ['26', "`community_info` honours a standing `'mi'` language preference (issue #1028)"],
  ['27', "`community_info` extends the `'mi'` preference to the admin/super-admin segments (issue #1056)"],
  [
    '28',
    "WhatsApp `!`-shortcuts discovery block honours a standing `'mi'` language preference too (issue #1034)",
  ],
  [
    '29',
    'Discord text-attachment input (`TEXT_INPUT_ENABLED`, off by default, `super_admin`-only default, agent-base #44)',
  ],
  ['30', 'On-demand knowledge-source re-check (`check_knowledge_source`, issue #1188)'],
  [
    '31',
    '`notifyMemberApproved` appends the admin-configured welcome message, gated on `isKnownUser` (issue #1222)',
  ],
];

/** Parsed straight from the document — the same regex the dump script uses. */
function actualSections(): Array<[string, string]> {
  const source = readFileSync(SECURITY_DOC, 'utf8');
  const out: Array<[string, string]> = [];
  for (const line of source.split('\n')) {
    const m = /^### ([0-9]+[a-z]?)\. (.+)$/.exec(line);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

test('docs/SECURITY.md: the threat-model section list matches the pinned snapshot', () => {
  assert.deepEqual(
    actualSections(),
    EXPECTED.map((e) => [...e]),
    'a section was added, removed, renumbered or retitled — update EXPECTED in this diff so the change ' +
      'is reviewable rather than silent (npx tsx tests/dumpSecurityDocSections.ts regenerates it)',
  );
});

test('SECURITY: no two threat-model sections share a number — a duplicate hides one behind the other', () => {
  // The concrete failure this is here for: #1035 and #1057 both added a §27,
  // independently, and both went green. Cross-references elsewhere in the
  // document address sections by number, so a duplicate silently points half
  // of them at the wrong control.
  const numbers = actualSections().map(([n]) => n);
  const seen = new Set<string>();
  const duplicates = numbers.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
  assert.deepEqual(duplicates, [], `duplicate section numbers: ${duplicates.join(', ')}`);
});
