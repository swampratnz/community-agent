import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectNoticeVariant,
  type NoticeEntry,
  type NoticeValue,
} from '@swampratnz/agent-base/strings/catalogue.js';
import { NOTICE_AXES, NOTICE_ENTRIES, notice, type NoticeId } from '../src/module/strings/notices.js';

import './support/registerNotices.js';

/**
 * Representative arguments for every template (function-valued) entry, so
 * variant equivalence is asserted on RENDERED output, not function identity.
 * Chosen to exercise each template's own branches (singular/plural, the
 * wait-clause no-op guard, fractional day flooring).
 */
const SAMPLE_ARGS: Partial<Record<NoticeId, unknown[][]>> = {
  dailyReplyBudgetWarning: [[0], [1], [2], [7]],
  pendingNotice: [['delete knowledge entry #5']],
  codeTruncatedNote: [[15]],
  gatedWaitClause: [
    ['Notice text.', undefined],
    ['Notice text.', 0],
    ['Notice text.', 1],
    ['Notice text.', 2.7],
    ['Notice text.', 5],
  ],
  warnDm: [
    [1, 3],
    [2, 2],
  ],
  blockedDm: [[]],
  memberDigestKnowledgeHeading: [[1], [2]],
  memberDigestProjectShowcase: [[1], [3]],
  memberDigestInterestsUpdate: [[1], [3]],
  memberDigestConnectionsUpdate: [[1], [3]],
};

function render(value: NoticeValue, args: readonly unknown[]): string {
  return typeof value === 'function' ? (value as (...a: unknown[]) => string)(...args) : value;
}

/**
 * TODAY'S per-site precedence chain, re-encoded literally — `'mi'` language
 * wins outright ('plain' is never consulted once the language is 'mi', even
 * for an entry with no mi variant), `'plain'` style applies only otherwise,
 * default English else. The catalogue must match this for every entry and
 * every (language, style) combination, or a converted call site drifted.
 */
function legacyChain(
  entry: { base: NoticeValue; language?: Record<string, NoticeValue>; style?: Record<string, NoticeValue> },
  language: string | undefined,
  style: string | undefined,
): NoticeValue {
  if (language === 'mi') return entry.language?.mi ?? entry.base;
  if (style === 'plain') return entry.style?.plain ?? entry.base;
  return entry.base;
}

const LANGUAGES = [undefined, 'auto', 'en', 'mi', 'fr'];
const STYLES = [undefined, 'standard', 'plain', 'shout'];

test('community pack registers exactly the historical axes', () => {
  assert.deepEqual([...NOTICE_AXES.languages], ['mi']);
  assert.deepEqual([...NOTICE_AXES.styles], ['plain']);
});

test('catalogue selection matches the legacy per-site precedence chain for every entry and combo', () => {
  for (const [id, entry] of Object.entries(NOTICE_ENTRIES)) {
    const argSets = SAMPLE_ARGS[id as NoticeId] ?? [[]];
    for (const language of LANGUAGES) {
      for (const style of STYLES) {
        const expected = legacyChain(entry, language, style);
        const actual = selectNoticeVariant<NoticeValue>(entry, NOTICE_AXES, { language, style });
        const viaNotice = notice(id as NoticeId, { language, style });
        for (const args of argSets) {
          const label = `${id} (language=${String(language)}, style=${String(style)}, args=${JSON.stringify(args)})`;
          assert.equal(render(actual, args), render(expected, args), label);
          assert.equal(render(viaNotice, args), render(expected, args), `notice(): ${label}`);
        }
      }
    }
  }
});

test('unregistered axis values always render the default text', () => {
  for (const [id, entry] of Object.entries(NOTICE_ENTRIES)) {
    const argSets = SAMPLE_ARGS[id as NoticeId] ?? [[]];
    for (const args of argSets) {
      const base = render(entry.base, args);
      assert.equal(render(notice(id as NoticeId, { language: 'fr' }), args), base, id);
      assert.equal(render(notice(id as NoticeId, { style: 'shout' }), args), base, id);
      assert.equal(render(notice(id as NoticeId), args), base, id);
    }
  }
});

test("a registered language claims the turn: 'mi' + 'plain' renders the mi variant (or base when the entry has no mi variant)", () => {
  for (const [id, rawEntry] of Object.entries(NOTICE_ENTRIES)) {
    // Widened: some entries are base-only (`gatedNoticeWithAdmins`,
    // `guidelinesHeading`), so the union has members with no `language` key.
    const entry = rawEntry as NoticeEntry<NoticeValue>;
    const argSets = SAMPLE_ARGS[id as NoticeId] ?? [[]];
    const expected = entry.language?.mi ?? entry.base;
    for (const args of argSets) {
      assert.equal(
        render(notice(id as NoticeId, { language: 'mi', style: 'plain' }), args),
        render(expected, args),
        id,
      );
    }
  }
});

// The 'legacy exported constants are byte-identical to their catalogue
// lookups' case is gone with the package flip. It pinned the Phase-1 refactor:
// base leaf modules (rateLimitNotice.ts, pauseNotice.ts, upstreamFailure.ts,
// dailyReplyBudgetWarning.ts) kept exporting `X`/`X_MI`/`X_PLAIN` consts
// DERIVED from the catalogue, so the move could be proved byte-neutral.
// agent-base deleted every one of them: they named this community's two axis
// values in framework code, and — worse — rendering a notice at import time
// made merely importing a base module throw unless a pack was already
// registered, which is unimplementable for a package whose entry point is
// `createAgent`. Base serves those ids at the call site now, and the two
// remaining cases here (precedence equivalence over the whole pack, and the
// literal CONFIRM/CANCEL tokens) still cover the community-owned half.

test('CONFIRM/CANCEL stay literal, untranslated tokens in every pending-notice variant', () => {
  // classifyConfirmReply (agent/pendingActions.ts) matches exactly these
  // base-owned words — a pack variant that translated them would break the
  // confirm protocol itself.
  for (const selection of [undefined, { language: 'mi' as const }, { style: 'plain' as const }]) {
    const text = notice('pendingNotice', selection)('x');
    assert.match(text, /\bCONFIRM\b/);
    assert.match(text, /\bCANCEL\b/);
  }
});

test(
  "SECURITY: communityInfoMemberCapabilities' base and mi values contain no template placeholders/" +
    "interpolation tokens — fixed, human-authored text only, consistent with this file's equivalence checks " +
    'above (issue #1028 acceptance criterion 6)',
  () => {
    const entry = NOTICE_ENTRIES.communityInfoMemberCapabilities;
    const placeholderPattern = /\$\{|\{\{|%s|%d|\{[0-9a-zA-Z_]*\}/;
    assert.doesNotMatch(
      entry.base,
      placeholderPattern,
      'base must be fixed text with no interpolation markers',
    );
    assert.doesNotMatch(
      entry.language.mi,
      placeholderPattern,
      'the mi variant must be fixed text with no interpolation markers',
    );
  },
);

test(
  'SECURITY: the six memberDigest section-label catalogue entries contain no template placeholders/' +
    'interpolation tokens in their static wording — checked on the RENDERED output for the four ' +
    'count-taking templates, so a leftover placeholder in the surrounding fixed text would still be ' +
    'caught even though the count itself is legitimately interpolated (issue #1042 acceptance criterion 6)',
  () => {
    const placeholderPattern = /\$\{|\{\{|%s|%d|\{[0-9a-zA-Z_]*\}/;
    const ids = [
      'memberDigestTopicsHeading',
      'memberDigestKnowledgeHeading',
      'memberDigestProjectShowcase',
      'memberDigestPlatformUpdatesHeading',
      'memberDigestInterestsUpdate',
      'memberDigestConnectionsUpdate',
    ] as const;
    for (const id of ids) {
      const entry = NOTICE_ENTRIES[id] as NoticeEntry<NoticeValue>;
      const sample = typeof entry.base === 'function' ? [3] : [];
      assert.doesNotMatch(
        render(entry.base, sample),
        placeholderPattern,
        `${id} base must render fixed text with no interpolation markers`,
      );
      const mi = entry.language?.mi;
      assert.ok(mi, `${id} must have an mi variant`);
      assert.doesNotMatch(
        render(mi, sample),
        placeholderPattern,
        `${id} mi variant must render fixed text with no interpolation markers`,
      );
    }
  },
);
