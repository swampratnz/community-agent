import { config } from './config.js';
import { logger } from './logger.js';
import { startTrackedJob } from './backgroundJobs.js';
import {
  listContextDigests,
  listCuratedKnowledgeCreatedSince,
  recordMemberDigestSent,
  wasMemberDigestSentRecently,
  type ContextDigest,
} from './storage/repository.js';
import type { PlatformAdapter } from './platforms/types.js';

/** Same weekly window as `adminDigest.ts`'s `FRESHNESS_DAYS` — this signal targets the same ~7-day cadence. */
const FRESHNESS_DAYS = 7;
const MAX_TOPICS = 10;
const MAX_NEW_KNOWLEDGE_TITLES = 10;

/**
 * Pure message builder (issue #645) — this week's `context_digests` topics
 * (title + question count, the same aggregate fields `list_context_digests`
 * already renders to admins) plus a "new in the knowledge base" line of
 * curated-only titles. `null` when there is nothing to say (both inputs
 * empty) so the caller can skip the send entirely — silence over noise, a
 * week with zero digests and zero new curated entries posts nothing.
 *
 * Every input here is already aggregate-by-construction: `topic` is the
 * offline builder's own no-names/no-handles summary label (`builder.ts`'s
 * `summarizeCluster` prompt contract), `questionCount` is a bare integer,
 * and `newKnowledgeTitles` are knowledge-entry titles, never message
 * content or a member identifier — this function only ever renders
 * topic-level text and counts.
 */
export function formatMemberDigestMessage(
  topics: ReadonlyArray<{ topic: string; questionCount: number }>,
  newKnowledgeTitles: readonly string[],
): string | null {
  if (topics.length === 0 && newKnowledgeTitles.length === 0) return null;

  const sections: string[] = [];
  if (topics.length > 0) {
    sections.push(
      "📅 This week's topics:\n" +
        topics
          .map((t) => `• ${t.topic} (${t.questionCount} question${t.questionCount === 1 ? '' : 's'})`)
          .join('\n'),
    );
  }
  if (newKnowledgeTitles.length > 0) {
    sections.push(
      `📚 New in the knowledge base (${newKnowledgeTitles.length}): ${newKnowledgeTitles.join(', ')}`,
    );
  }
  return sections.join('\n\n');
}

/**
 * Builds the default weekly `runOnce`, closing the freshness guard +
 * `context_digests`/curated-`knowledge` reads + the channel send over one
 * tick. Every dependency is injectable (tests only) so the cadence/content
 * logic can be exercised without a real DB or adapter — production always
 * uses the already-exported repository defaults.
 */
export function makeDefaultMemberDigestRun(
  adapters: readonly PlatformAdapter[],
  deps: {
    wasSentRecently?: (days: number) => Promise<boolean>;
    getDigests?: (days: number, limit: number) => Promise<ContextDigest[]>;
    getNewKnowledgeTitles?: (since: Date, limit: number) => Promise<string[]>;
    recordSent?: () => Promise<void>;
  } = {},
): () => Promise<void> {
  const wasSentRecently = deps.wasSentRecently ?? wasMemberDigestSentRecently;
  const getDigests = deps.getDigests ?? listContextDigests;
  const getNewKnowledgeTitles = deps.getNewKnowledgeTitles ?? listCuratedKnowledgeCreatedSince;
  const recordSent = deps.recordSent ?? recordMemberDigestSent;

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

    const since = new Date(Date.now() - FRESHNESS_DAYS * 24 * 3_600_000);
    const [digests, newKnowledgeTitles] = await Promise.all([
      getDigests(FRESHNESS_DAYS, MAX_TOPICS),
      getNewKnowledgeTitles(since, MAX_NEW_KNOWLEDGE_TITLES),
    ]);
    const message = formatMemberDigestMessage(
      digests.map((d) => ({ topic: d.topic, questionCount: d.questionCount })),
      newKnowledgeTitles,
    );
    // Quiet week — nothing to post. Deliberately leaves the freshness row
    // untouched (same convention as adminDigest.ts's quiet-week skip) so a
    // week that starts quiet but gains a digest/knowledge entry partway
    // through still posts on a later tick instead of waiting out a full week.
    if (!message) return;

    await adapter.sendMessage({ conversationId: channelId, text: message });
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
