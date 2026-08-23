import { config } from '@swampratnz/agent-base/config.js';
import { logger } from '@swampratnz/agent-base/logger.js';
import { startTrackedJob } from '@swampratnz/agent-base/jobs/trackedJob.js';
import { scrubPII } from './context/export.js';
import { notice } from './strings/notices.js';
import { EVENTS_LIST_LIMIT, formatUpcomingEvents } from './agent/tools/info.js';
import {
  countAcceptedMemberKnowledgeTipsSince,
  countHelperMatchesSince,
  countInterestsPublishedSince,
  countProjectConnectionsSince,
  countProjectsSharedSince,
  getLanguagePreference,
  listContextDigests,
  listCuratedKnowledgeCreatedSince,
  listReleaseWatchUpdatesSince,
  recordMemberDigestSent,
  wasMemberDigestSentRecently,
  type ContextDigest,
  type LanguagePreference,
} from '@swampratnz/agent-base/storage/repository.js';
import type { JobSpec } from '@swampratnz/agent-base/jobs/types.js';
import type { Platform, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';

/** Same weekly window as `adminDigest.ts`'s `FRESHNESS_DAYS` — this signal targets the same ~7-day cadence. */
const FRESHNESS_DAYS = 7;
const MAX_TOPICS = 10;
const MAX_NEW_KNOWLEDGE_TITLES = 10;
const MAX_RELEASE_WATCH_PAGES = 10;

/**
 * Pure message builder (issue #645) — this week's `context_digests` topics
 * (title + question count, the same aggregate fields `list_context_digests`
 * already renders to admins) plus a "new in the knowledge base" line of
 * curated-only titles, plus a bare project-showcase count (issue #714).
 * `null` when there is nothing to say (all three inputs empty) so the
 * caller can skip the send entirely — silence over noise, a week with
 * zero digests, zero new curated entries, and zero new projects posts
 * nothing.
 *
 * Every input here is already aggregate-by-construction: `topic` is the
 * offline builder's own no-names/no-handles summary label (`builder.ts`'s
 * `summarizeCluster` prompt contract), `questionCount` is a bare integer,
 * `newKnowledgeTitles` are knowledge-entry titles, never message content or
 * a member identifier, and `newProjectCount` is a bare integer — this
 * function only ever renders topic-level text and counts.
 *
 * `topic` is run through the same lexical `scrubPII` (issue #53's
 * `context/export.ts`) the community-context export applies before its
 * `topic`/`summary` ever leave the admin-only boundary — PR #651 review:
 * the builder's "no names/handles" contract is prompt-only, and this is now
 * a public, all-members Discord post rather than a private-repo export, so
 * the same belt-and-braces scrub applies here too.
 *
 * `newProjectCount` deliberately takes only a bare count, never a project
 * row/list — `share_project`'s own description promises visibility scoped
 * to "every other member via `list_projects`" (an RBAC-gated, member-tier
 * tool), while this digest is an ungated public channel post. Surfacing a
 * project's name/description/link/owner here would widen that audience
 * beyond what a member consented to when they shared, so this function's
 * signature makes that leak structurally impossible rather than relying on
 * callers to remember to omit fields.
 *
 * `releaseWatchPages` (issue #733) is a 4th, optional section — Anthropic
 * release-notes/model-deprecation pages docsIngest re-fetched/diffed this
 * week (config-fixed doc titles/URLs only, never member-derived, so unlike
 * the topics section above it needs no `scrubPII` call). Empty by default so
 * every existing call site (and every existing test's byte-for-byte
 * expectation) is unaffected; renders only when non-empty, same
 * add-a-section-only-if-it-has-content convention as the other three.
 *
 * `memberTipCount` (issue #837) is not its own section — it is a trailing
 * clause on the knowledge-base line, surfacing that some of this week's
 * accepted entries came from a member's own `suggest_knowledge` (#633)
 * rather than only admin/machine drafting. Zero by default (byte-identical
 * to pre-#837 output) and, when the knowledge-base line renders at all,
 * clamped to `newKnowledgeTitles.length` so the clause can never read as "M
 * of the N titles above" when M exceeds N — `newKnowledgeTitles` is itself
 * capped at `MAX_NEW_KNOWLEDGE_TITLES` while this count is a plain,
 * uncapped `COUNT(*)`. Takes only a bare `number`, never a candidate
 * row/list, so a platform/user id reaching this public template is
 * structurally impossible — the same guarantee this file already documents
 * for `newProjectCount`.
 * `newInterestCount` (issue #815) is a 6th, optional section — the direct
 * sibling of `newProjectCount` for `member_interests` (published/updated via
 * `set_my_interests`), same bare-count-only shape for the same reason:
 * `set_my_interests`'s own publication consent is scoped to "other members
 * via `who_is_into`" (a member-tier, on-demand tool), not this ungated
 * public channel post, so only an integer ever reaches this surface, never
 * interest text or a member identifier. Defaults to 0 so every existing call
 * site is unaffected.
 *
 * `connectionCount` (issue #1012) is a 7th, optional section — the
 * member→member flywheel-throughput signal, surfaced here for the first
 * time (it already reaches admins via `adminDigest.ts`'s #820/#870 flywheel
 * line). It is a single combined integer, `helperMatchesCount +
 * projectConnectionsCount` (successful `find_helper` DMs plus successful
 * `request_project_connection` handoffs) — deliberately not split into two
 * clauses, per this issue's tightened acceptance criteria, to keep the
 * "people are actually helping each other" framing to one line. Neither
 * source function returns an identity, topic, or project name (bare
 * `COUNT(*)` only, same guarantee `newProjectCount`/`newInterestCount`
 * document above), so this parameter's `number` type makes leaking either
 * party's identity through this surface structurally impossible. Defaults
 * to 0 so every existing call site is unaffected.
 *
 * `language` (issue #1042) defaults to `'auto'` (not a registered notice
 * axis value, so it renders the base/English text — byte-identical to every
 * pre-#1042 call site) and selects the `mi` variant of the six section
 * label/frame fragments below via `notice()`. Every interpolated count,
 * title list, comma-join and English singular/plural choice stays exactly
 * where it already lived in this function; only the static label wording
 * around them comes from the notice pack now. The scheduled weekly push
 * (`makeDefaultMemberDigestRun`) never passes anything but the default here
 * — see that function's own comment for why.
 */
export function formatMemberDigestMessage(
  topics: ReadonlyArray<{ topic: string; questionCount: number }>,
  newKnowledgeTitles: readonly string[],
  newProjectCount: number,
  releaseWatchPages: ReadonlyArray<{ title: string; url: string | null }> = [],
  memberTipCount = 0,
  newInterestCount = 0,
  connectionCount = 0,
  language: LanguagePreference = 'auto',
): string | null {
  if (
    topics.length === 0 &&
    newKnowledgeTitles.length === 0 &&
    newProjectCount === 0 &&
    releaseWatchPages.length === 0 &&
    newInterestCount === 0 &&
    connectionCount === 0
  )
    return null;

  const sections: string[] = [];
  if (topics.length > 0) {
    sections.push(
      `${notice('memberDigestTopicsHeading', { language })}\n` +
        topics
          .map(
            (t) => `• ${scrubPII(t.topic)} (${t.questionCount} question${t.questionCount === 1 ? '' : 's'})`,
          )
          .join('\n'),
    );
  }
  if (newKnowledgeTitles.length > 0) {
    const clampedTipCount = Math.min(Math.max(memberTipCount, 0), newKnowledgeTitles.length);
    const tipClause =
      clampedTipCount === 1
        ? ' — 1 suggested by a member like you 💡'
        : clampedTipCount > 1
          ? ` — ${clampedTipCount} suggested by members like you 💡`
          : '';
    sections.push(
      `${notice('memberDigestKnowledgeHeading', { language })(newKnowledgeTitles.length)}` +
        `${newKnowledgeTitles.join(', ')}${tipClause}`,
    );
  }
  if (newProjectCount > 0) {
    sections.push(notice('memberDigestProjectShowcase', { language })(newProjectCount));
  }
  if (releaseWatchPages.length > 0) {
    sections.push(
      `${notice('memberDigestPlatformUpdatesHeading', { language })} ${releaseWatchPages
        .map((p) => (p.url ? `[${p.title}](${p.url})` : p.title))
        .join(', ')}`,
    );
  }
  if (newInterestCount > 0) {
    sections.push(notice('memberDigestInterestsUpdate', { language })(newInterestCount));
  }
  if (connectionCount > 0) {
    sections.push(notice('memberDigestConnectionsUpdate', { language })(connectionCount));
  }
  return sections.join('\n\n');
}

/**
 * The content-gather deps for {@link buildMemberDigestContent}. **Every field is
 * required on purpose** (issue #868): these default to real repository reads, so
 * a *partial* deps object silently leaves the un-stubbed reads pointing at live
 * Postgres. A test that stubbed 5 of 6 fields still hit the DB for the 6th, and
 * because `node:test` runs files in parallel those stray reads/writes made
 * global count/delta assertions in other files flaky.
 *
 * Requiring every field converts that into a compile error: adding a new signal
 * here breaks every test call site until its author decides, per site, whether
 * to stub the new read or accept a real one. Pass nothing at all (production,
 * and every on-demand pull) to get the repository defaults for all of them.
 *
 * A shared spread-base for tests is fine ONLY if every field THROWS (see
 * `throwingContentDeps` in tests/memberDigest.test.ts). A base of inert
 * `async () => 0` stubs would re-create this footgun in a quieter form: a newly
 * added signal would silently acquire a plausible zero nobody chose, and the
 * test that was supposed to cover it would pass vacuously.
 *
 * `getLanguagePreference` (issue #1042) is invoked only when
 * {@link buildMemberDigestContent}'s own `caller` parameter is supplied —
 * every OTHER field here is unconditional, so this is the one field a test
 * exercising a caller-less call (the scheduled weekly push) never needs to
 * stub even via `throwingContentDeps`.
 */
export type MemberDigestContentDeps = {
  getDigests: (days: number, limit: number) => Promise<ContextDigest[]>;
  getNewKnowledgeTitles: (since: Date, limit: number) => Promise<string[]>;
  getNewProjectCount: (since: Date) => Promise<number>;
  getReleaseWatchUpdates: (
    since: Date,
    pathPrefixes: readonly string[],
    limit: number,
  ) => Promise<Array<{ pageTitle: string; sourceUrl: string | null }>>;
  getMemberTipCount: (since: Date) => Promise<number>;
  getNewInterestCount: (since: Date) => Promise<number>;
  getHelperMatchesCount: (since: Date) => Promise<number>;
  getProjectConnectionsCount: (since: Date) => Promise<number>;
  getLanguagePreference: (platform: Platform, userId: string) => Promise<LanguagePreference>;
};

/**
 * {@link makeDefaultMemberDigestRun}'s deps: the content gather plus the
 * cadence bookkeeping. All-required for the same reason as
 * {@link MemberDigestContentDeps} — and note the content half is genuinely
 * load-bearing here, because the run threads these straight into
 * `buildMemberDigestContent`. Before #868 a cadence-only test (stubbing just
 * `wasSentRecently`/`recordSent`) reached the gather with 6 undefined deps and
 * ran the real reads against Postgres.
 */
export type MemberDigestRunDeps = MemberDigestContentDeps & {
  wasSentRecently: (days: number) => Promise<boolean>;
  recordSent: () => Promise<void>;
};

/**
 * Gathers every member-digest signal (the same reads `makeDefaultMemberDigestRun`
 * used to run inline) and renders them via {@link formatMemberDigestMessage}, returning
 * the exact text the weekly push would post right now, or `null` on a quiet
 * week. Extracted (issue #841) so the scheduled push and an on-demand pull
 * (the `community_digest` tool / `/digest` slash command) share one gathering
 * implementation instead of a second, driftable copy — the same
 * `admin_digest`/`buildAdminDigestForAdmin` precedent (issue #499).
 *
 * Deliberately excludes the freshness/cadence bookkeeping
 * (`wasMemberDigestSentRecently`/`recordMemberDigestSent`) and the actual
 * `sendMessage` — those stay exclusive to `makeDefaultMemberDigestRun`'s
 * closure, so a caller of this helper (an on-demand pull) can never suppress
 * or advance the next scheduled weekly push.
 *
 * Every dependency is injectable (tests only) so the content logic can be
 * exercised without a real DB; production and every on-demand pull call this
 * with no arguments, using the already-exported repository defaults.
 *
 * The deps parameter is ALL-OR-NOTHING by type ({@link MemberDigestContentDeps}
 * has no optional fields) — see that type's own comment for why a partial
 * object is a footgun rather than a convenience.
 *
 * `caller` (issue #1042) is a SEPARATE, genuinely optional parameter — not
 * part of the all-or-nothing deps object, because it is not a stubbable read
 * but the identity of whoever is pulling this on demand. When supplied (every
 * on-demand pull: `community_digest`'s handler, `/digest`, `!digest`), the
 * caller's own stored `language_preference` is read via
 * `deps.getLanguagePreference` and threaded into
 * {@link formatMemberDigestMessage} so the six section labels render in the
 * caller's language. When omitted — `makeDefaultMemberDigestRun`'s scheduled
 * weekly push, which has no single reader whose preference should win — no
 * language read happens at all and the digest renders exactly as before
 * #1042, regardless of any recipient's stored preference.
 */
export async function buildMemberDigestContent(
  deps?: MemberDigestContentDeps,
  caller?: { platform: Platform; userId: string },
): Promise<string | null> {
  const getDigests = deps?.getDigests ?? listContextDigests;
  const getNewKnowledgeTitles = deps?.getNewKnowledgeTitles ?? listCuratedKnowledgeCreatedSince;
  const getNewProjectCount = deps?.getNewProjectCount ?? countProjectsSharedSince;
  const getReleaseWatchUpdates = deps?.getReleaseWatchUpdates ?? listReleaseWatchUpdatesSince;
  const getMemberTipCount = deps?.getMemberTipCount ?? countAcceptedMemberKnowledgeTipsSince;
  const getNewInterestCount = deps?.getNewInterestCount ?? countInterestsPublishedSince;
  // config.findHelper.enabled gates the read itself, not just its output —
  // mirrors adminDigest.ts's own countHelperMatchesSince call site exactly
  // (issue #820), so a deployment with find_helper off never issues the
  // extra helper_notifications query here either.
  const getHelperMatchesCount =
    deps?.getHelperMatchesCount ??
    ((since: Date) => (config.findHelper.enabled ? countHelperMatchesSince(since) : Promise.resolve(0)));
  // No feature flag exists for request_project_connection, unlike find_helper
  // — called unconditionally, mirroring adminDigest.ts's own
  // countProjectConnectionsSince call site (issue #870).
  const getProjectConnectionsCount = deps?.getProjectConnectionsCount ?? countProjectConnectionsSince;
  const getLangPref = deps?.getLanguagePreference ?? getLanguagePreference;

  const since = new Date(Date.now() - FRESHNESS_DAYS * 24 * 3_600_000);
  // RELEASE_WATCH_ENABLED gates the read itself, not just its output — when
  // off, getReleaseWatchUpdates must never be invoked (issue #733's
  // byte-identical-when-disabled contract), so this is a conditional
  // Promise, not a post-hoc empty-array filter. Same shape for the language
  // read (issue #1042): a caller-less call (the scheduled weekly push) must
  // never invoke getLanguagePreference at all, not just discard its result.
  const [
    digests,
    newKnowledgeTitles,
    newProjectCount,
    releaseWatchPages,
    memberTipCount,
    newInterestCount,
    helperMatchesCount,
    projectConnectionsCount,
    language,
  ] = await Promise.all([
    getDigests(FRESHNESS_DAYS, MAX_TOPICS),
    getNewKnowledgeTitles(since, MAX_NEW_KNOWLEDGE_TITLES),
    getNewProjectCount(since),
    config.releaseWatch.enabled
      ? getReleaseWatchUpdates(since, config.releaseWatch.docPaths, MAX_RELEASE_WATCH_PAGES)
      : Promise.resolve([]),
    getMemberTipCount(since),
    getNewInterestCount(since),
    getHelperMatchesCount(since),
    getProjectConnectionsCount(since),
    caller ? getLangPref(caller.platform, caller.userId) : Promise.resolve(undefined),
  ]);
  // Two independent floors before a digest topic reaches this public
  // surface (PR #651 review):
  //  - k-anonymity: this surface is more exposed than either existing
  //    context_digests consumer, so it gets its OWN configurable floor
  //    (MEMBER_DIGEST_MIN_DISTINCT_USERS) rather than inheriting whichever
  //    value CONTEXT_BUILDER_MIN_DISTINCT_USERS happens to be set to.
  //  - platform: a digest's clustering is unscoped by platform (it can be
  //    built from a mix of Discord and WhatsApp interactions), which was
  //    fine when every consumer was admin-only. Restrict to `discord`/null
  //    so a WhatsApp-sourced topic is never surfaced to a Discord
  //    audience that never had access to that conversation.
  const eligible = digests.filter(
    (d) =>
      d.distinctUsers >= config.memberDigest.minDistinctUsers &&
      (d.platform === 'discord' || d.platform === null),
  );
  return formatMemberDigestMessage(
    eligible.map((d) => ({ topic: d.topic, questionCount: d.questionCount })),
    newKnowledgeTitles,
    newProjectCount,
    releaseWatchPages.map((p) => ({ title: p.pageTitle, url: p.sourceUrl })),
    memberTipCount,
    newInterestCount,
    helperMatchesCount + projectConnectionsCount,
    language,
  );
}

/**
 * Builds the default weekly `runOnce`, closing the freshness guard +
 * `buildMemberDigestContent`'s gather/render + the channel send over one
 * tick. `wasSentRecently`/`recordSent` are injectable (tests only) so the
 * cadence logic can be exercised without a real DB or adapter; the content
 * gather itself is injectable via the same deps, threaded into
 * `buildMemberDigestContent` — production always uses the already-exported
 * repository defaults.
 */
export function makeDefaultMemberDigestRun(
  adapters: readonly PlatformAdapter[],
  deps?: MemberDigestRunDeps,
): () => Promise<void> {
  const wasSentRecently = deps?.wasSentRecently ?? wasMemberDigestSentRecently;
  const recordSent = deps?.recordSent ?? recordMemberDigestSent;

  return async () => {
    // MEMBER_DIGEST_CHANNEL_ID is config-set only — never model- or
    // message-supplied. Unset means the operator turned the flag on without
    // finishing setup: stay inert (never guess/derive a target) rather than
    // throw, so this can't page an operator over an incomplete config.
    const channelId = config.memberDigest.channelId;
    if (!channelId) return;

    if (await wasSentRecently(FRESHNESS_DAYS)) return; // still inside this week's freshness window

    // Member-facing, so Discord only (the proposal's channel post target) —
    // never WhatsApp, and never a platform inferred from anything but this
    // fixed check.
    const adapter = adapters.find((a) => a.platform === 'discord' && a.isConnected());
    if (!adapter) {
      logger.warn('Member digest: no connected Discord adapter this tick; will retry next tick');
      return;
    }

    // Passed straight through, not re-listed field-by-field: MemberDigestRunDeps
    // is a superset of MemberDigestContentDeps, so a new content signal needs no
    // change here. The old explicit list was a second place to forget one, which
    // is how #822's and #839's new deps reached the gather as `undefined`.
    //
    // SECURITY (issue #1042): deliberately no second (`caller`) argument — this
    // is a single broadcast to a shared channel, not a reply to one member, so
    // no recipient's stored `language_preference` may ever select which
    // language it renders in. Passing one here would make the scheduled push
    // silently branch on whichever member's preference happened to be read.
    const message = await buildMemberDigestContent(deps);
    // Quiet week — nothing to post. Deliberately leaves the freshness row
    // untouched (same convention as adminDigest.ts's quiet-week skip) so a
    // week that starts quiet but gains a digest/knowledge entry partway
    // through still posts on a later tick instead of waiting out a full week.
    if (!message) return;

    // Issue #1093: append an "Upcoming events" section, but only on a week
    // that is already posting (the read above this point never runs on a
    // fully quiet week — that's the v1 scope decision, not an oversight).
    // adapter.listUpcomingEvents is a live Discord REST read, not a DB-backed
    // aggregate like the deps above, so it's deliberately not threaded
    // through MemberDigestContentDeps/buildMemberDigestContent — those two
    // other call sites (community_digest tool, /digest, !digest) have no
    // adapter to reach it with. Reuses list_events' own formatter/cap
    // (formatUpcomingEvents/EVENTS_LIST_LIMIT from tools/info.ts) so the
    // fields shown here are byte-identical to what a member can already pull
    // themselves. try/catch: a transient Discord API failure degrades to "no
    // events section this week", the same fail-safe posture as every other
    // supplementary read in this function — it must never block or fail the
    // rest of the digest send.
    let fullMessage = message;
    try {
      const events = adapter.listUpcomingEvents ? await adapter.listUpcomingEvents(EVENTS_LIST_LIMIT) : [];
      if (events.length > 0) {
        fullMessage = `${message}\n\nUpcoming events:\n${formatUpcomingEvents(events)}`;
      }
    } catch (err) {
      logger.warn({ err }, 'Member digest: listUpcomingEvents failed; posting without an events section');
    }

    await adapter.sendMessage({ conversationId: channelId, text: fullMessage });
    await recordSent();
  };
}

/**
 * Weekly member-facing channel post (issue #645), off unless
 * `MEMBER_DIGEST_ENABLED`. Widens the audience of already admin-visible,
 * k-floored/anonymised `context_digests` topics and curated (non-`auto`)
 * knowledge titles to the whole community, closing the mission's "find
 * what the community already discussed instead of re-asking" gap for
 * members who weren't online that week — today's only push summaries
 * (`admin_digest`) are admin-only.
 *
 * Routed through the shared `startTrackedJob` (same 6h outer tick as every
 * other opt-in job) rather than a bespoke timer, so a throwing `runOnce`
 * (e.g. a DB error) gets the existing consecutive-failure alerting for
 * free. The outer 6h tick is faster than the real ~weekly cadence;
 * `runOnce`'s own `wasMemberDigestSentRecently` freshness guard keeps the
 * actual post at the real cadence regardless, the same "faster outer tick,
 * freshness-guarded inner cadence" shape every other digest job in this
 * repo already uses.
 */
export function startMemberDigest(
  adapters: readonly PlatformAdapter[],
  runOnce: () => Promise<void> = makeDefaultMemberDigestRun(adapters),
): ReturnType<typeof setInterval> | null {
  return startTrackedJob('member-digest', adapters, config.memberDigest.enabled, runOnce);
}

// Registry entry (see src/module/jobs/registry.ts) — gate mirrors startMemberDigest's own flag.
export const memberDigestJob: JobSpec = {
  name: 'member-digest',
  enabled: (cfg) => cfg.memberDigest.enabled,
  start: (adapters) => startMemberDigest(adapters),
};
