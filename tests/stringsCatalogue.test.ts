import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectNoticeVariant, type NoticeValue } from '../src/base/strings/catalogue.js';
import { NOTICE_AXES, NOTICE_ENTRIES, notice, type NoticeId } from '../src/module/strings/notices.js';
// Leaf notice modules only (no config/DB import chain), to prove the
// zero-churn barrel discipline: the old exported constants are derived from
// the catalogue and stay identical.
import {
  RATE_LIMIT_NOTICE_TEXT,
  RATE_LIMIT_NOTICE_TEXT_MI,
  RATE_LIMIT_NOTICE_TEXT_PLAIN,
} from '../src/base/rateLimitNotice.js';
import { PAUSE_NOTICE_TEXT, PAUSE_NOTICE_TEXT_MI, PAUSE_NOTICE_TEXT_PLAIN } from '../src/base/pauseNotice.js';
import {
  DAILY_REPLY_BUDGET_WARNING_TEXT,
  DAILY_REPLY_BUDGET_WARNING_TEXT_MI,
  DAILY_REPLY_BUDGET_WARNING_TEXT_PLAIN,
} from '../src/base/dailyReplyBudgetWarning.js';
import {
  USAGE_LIMIT_REPLY,
  USAGE_LIMIT_REPLY_ADMIN_NOTIFIED,
  USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_MI,
  USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_PLAIN,
  USAGE_LIMIT_REPLY_MI,
  USAGE_LIMIT_REPLY_PLAIN,
} from '../src/base/agent/upstreamFailure.js';

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
  for (const [id, entry] of Object.entries(NOTICE_ENTRIES)) {
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

test('legacy exported constants are byte-identical to their catalogue lookups', () => {
  assert.equal(RATE_LIMIT_NOTICE_TEXT, notice('rateLimitNotice'));
  assert.equal(RATE_LIMIT_NOTICE_TEXT_MI, notice('rateLimitNotice', { language: 'mi' }));
  assert.equal(RATE_LIMIT_NOTICE_TEXT_PLAIN, notice('rateLimitNotice', { style: 'plain' }));
  assert.equal(PAUSE_NOTICE_TEXT, notice('pauseNotice'));
  assert.equal(PAUSE_NOTICE_TEXT_MI, notice('pauseNotice', { language: 'mi' }));
  assert.equal(PAUSE_NOTICE_TEXT_PLAIN, notice('pauseNotice', { style: 'plain' }));
  assert.equal(DAILY_REPLY_BUDGET_WARNING_TEXT(1), notice('dailyReplyBudgetWarning')(1));
  assert.equal(
    DAILY_REPLY_BUDGET_WARNING_TEXT_MI(2),
    notice('dailyReplyBudgetWarning', { language: 'mi' })(2),
  );
  assert.equal(
    DAILY_REPLY_BUDGET_WARNING_TEXT_PLAIN(3),
    notice('dailyReplyBudgetWarning', { style: 'plain' })(3),
  );
  assert.equal(USAGE_LIMIT_REPLY, notice('usageLimitReply'));
  assert.equal(USAGE_LIMIT_REPLY_MI, notice('usageLimitReply', { language: 'mi' }));
  assert.equal(USAGE_LIMIT_REPLY_PLAIN, notice('usageLimitReply', { style: 'plain' }));
  assert.equal(USAGE_LIMIT_REPLY_ADMIN_NOTIFIED, notice('usageLimitReplyAdminNotified'));
  assert.equal(
    USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_MI,
    notice('usageLimitReplyAdminNotified', { language: 'mi' }),
  );
  assert.equal(
    USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_PLAIN,
    notice('usageLimitReplyAdminNotified', { style: 'plain' }),
  );
  // The admin-notified variants are the shared shell + a fixed suffix, per
  // variant — composition must survive the catalogue move.
  assert.ok(USAGE_LIMIT_REPLY_ADMIN_NOTIFIED.startsWith(USAGE_LIMIT_REPLY));
  assert.ok(USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_MI.startsWith(USAGE_LIMIT_REPLY_MI));
  assert.ok(USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_PLAIN.startsWith(USAGE_LIMIT_REPLY_PLAIN));
});

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
