import { z } from 'zod';
import { assertAtLeast } from '../../auth/rbac.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import {
  areKnowledgeEntriesLowRated,
  candidateTopicAlreadyReviewed,
  createKnowledgeTip,
  findCrossedKnowledgeGapCluster,
  findKnowledgeCoveringTopic,
  hasConflictAmongIds,
  isKnowledgeStale,
  KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD,
  KNOWLEDGE_TIP_CONTENT_MAX_CHARS,
  KNOWLEDGE_TIP_RATE_LIMIT_PER_DAY,
  KNOWLEDGE_TIP_TITLE_MAX_CHARS,
  type KnowledgeSearchHit,
  listKnowledgeTopics,
  recordKnowledgeGap,
  recordKnowledgeRetrieval,
  searchKnowledge,
  searchKnowledgeLexical,
  withdrawOwnKnowledgeTips,
} from '../../storage/repository.js';
import { formatKnowledgeSearchResults, formatKnowledgeTopics, text } from './helpers.js';
import { defineTool } from './types.js';

export const knowledgeMemberTools = [
  defineTool({
    name: 'knowledge_search',
    description: 'Search curated community knowledge (FAQs, rules, resources admins have saved).',
    minTier: 'member',
    readOnlyHint: true,
    schema: { query: z.string().describe('Topic to look up') },
    handler: async (args, { caller, turnState }) => {
      const hits = await searchKnowledge(args.query, {
        platform: caller.platform,
        conversationId: caller.conversationId,
      });
      // Fire-and-forget usage tracking (issue #134) — entries that clear the
      // relevance floor are "used"; ones that exist but fall below it are
      // not. Never awaited and errors are swallowed here (not inside
      // recordKnowledgeRetrieval) so a counter-write failure can never delay
      // or fail this member-facing search, mirroring notifySuperAdmins'
      // inline-catch, non-awaited style.
      const relevantIds = hits
        .filter((h) => h.similarity >= KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD)
        .map((h) => h.id);
      recordKnowledgeRetrieval(relevantIds).catch((err) =>
        logger.warn({ err }, 'Knowledge retrieval count update failed'),
      );
      // Best-effort knowledge_search-hit correlation (issue #411): `hits` is
      // already ordered by similarity descending (searchKnowledge's `ORDER
      // BY embedding <=> $1`), so relevantIds[0] — if any cleared the floor —
      // is this call's top-scoring hit. Only overwrite on a QUALIFYING call;
      // a later call in the same turn whose hits all miss the floor must
      // never clobber an earlier qualifying id with null (acceptance
      // criterion #3: last *qualifying* call wins, not last call).
      if (turnState && relevantIds.length > 0) {
        turnState.lastKnowledgeHitId = relevantIds[0];
      }
      // Live conflict-candidate check (issue #389): only the ids that
      // cleared the relevance floor for THIS query, restricted to a
      // scoped, LIMIT-1 self-join — never the full-table audit
      // `listKnowledgeConflictCandidates` runs. Skipped entirely below 2
      // ids, matching hasConflictAmongIds' own zero-query short-circuit.
      // Fail-safe like the low-rated caveat below: the conflict note is a
      // purely advisory badge, so a lookup failure must degrade to "no note"
      // rather than discarding the hits we already fetched successfully.
      const hasConflict =
        relevantIds.length >= 2
          ? await hasConflictAmongIds(relevantIds).catch((err) => {
              logger.warn({ err }, 'Knowledge conflict check failed; omitting the conflict note');
              return false;
            })
          : false;
      // Member-facing low-rated-answer caveat (issue #432) — the display-side
      // counterpart to #337's shortcut-only caveat: this is the dominant
      // answer path (below the shortcut's 0.9-cosine ceiling), so gating and
      // fail-safe behaviour mirror sendKnowledgeShortcut's own exactly. The
      // extra query only runs when the feature is enabled AND at least one
      // hit cleared the relevance floor, matching hasConflictAmongIds' own
      // zero-query short-circuit for a too-small input.
      const lowRatedIds =
        config.behaviour.knowledgeLowRatedCaveatMinUnhelpful > 0 && relevantIds.length > 0
          ? await areKnowledgeEntriesLowRated(
              relevantIds,
              config.behaviour.knowledgeLowRatedCaveatMinUnhelpful,
            ).catch((err) => {
              logger.warn({ err }, 'Knowledge low-rated caveat lookup failed; omitting the caveat');
              return new Set<number>();
            })
          : new Set<number>();
      // Lexical fallback (issue #362): only on the below-floor-miss branch
      // below — semantic search had candidates but NONE cleared the
      // relevance floor. Dense sentence embeddings underweight rare,
      // SNAKE_CASE/camelCase identifiers and error codes, so a query that's
      // literally a string inside an entry can still miss; try a
      // substring-robust trigram match before accepting this as a gap. When
      // semantic search already found a relevant hit, this never runs —
      // output is byte-identical to before issue #362 for the common case.
      let lexicalHits: Awaited<ReturnType<typeof searchKnowledgeLexical>> = [];
      if (hits.length > 0 && relevantIds.length === 0) {
        // Fail-safe, same reasoning as the conflict/low-rated lookups above:
        // this is a supplementary second attempt on the below-floor branch,
        // so a failure here must degrade to "no lexical hits" and still show
        // the semantic results, never replace them with a raw DB error.
        lexicalHits = await searchKnowledgeLexical(args.query, {
          platform: caller.platform,
          conversationId: caller.conversationId,
        }).catch((err) => {
          logger.warn({ err }, 'Knowledge lexical fallback failed; returning semantic results only');
          return [];
        });
      }
      if (lexicalHits.length > 0) {
        recordKnowledgeRetrieval(lexicalHits.map((h) => h.id)).catch((err) =>
          logger.warn({ err }, 'Knowledge retrieval count update failed'),
        );
      } else if (hits.length > 0 && relevantIds.length === 0) {
        // Below-floor miss tracking (issue #208): only when hits existed but
        // NONE cleared the floor (semantic or, now, lexical) — never on a
        // plain empty result set, which is indistinguishable from a
        // searchKnowledge embed() failure and would otherwise log every
        // outage query as a false "gap". Fire-and-forget, same non-blocking
        // style as the retrieval-count bump above — UNLESS the real-time
        // cluster alert (issue #650) is enabled, in which case the insert is
        // awaited (one extra fast DB round-trip) so the immediately-following
        // cluster-threshold check has the new row's id to key off. With the
        // flag off (the default) this branch is byte-identical to before
        // #650 — no extra query, no await, no DM (acceptance criterion 3).
        if (config.knowledgeGapAlert.enabled && turnState) {
          const gapResult = await recordKnowledgeGap(
            caller.platform,
            caller.conversationId,
            caller.userId,
            args.query,
          ).catch((err) => {
            logger.warn({ err }, 'Knowledge gap recording failed');
            return null;
          });
          if (gapResult && gapResult !== 'rate_limited') {
            const crossed = await findCrossedKnowledgeGapCluster(
              caller.conversationId,
              gapResult.id,
              config.knowledgeGapAlert.threshold,
            ).catch((err) => {
              logger.warn({ err }, 'Knowledge gap cluster threshold check failed');
              return null;
            });
            if (crossed) turnState.knowledgeGapCluster = crossed;
          }
        } else {
          recordKnowledgeGap(caller.platform, caller.conversationId, caller.userId, args.query).catch((err) =>
            logger.warn({ err }, 'Knowledge gap recording failed'),
          );
        }
      }
      const finalHits: Array<KnowledgeSearchHit & { viaLexical?: boolean }> =
        lexicalHits.length > 0 ? [...hits, ...lexicalHits.map((h) => ({ ...h, viaLexical: true }))] : hits;
      // Real-time stale-knowledge admin nudge (issue #701): computed over
      // exactly the hits `formatKnowledgeSearchResults` below will actually
      // render (its own identical `viaLexical || similarity >= floor`
      // filter) — never a hit that exists but isn't shown. Gated on the flag
      // FIRST so this is a no-op (no isKnowledgeStale call, no turnState
      // write) when off, matching acceptance criterion 4's byte-identical
      // default. `notifyAdmins` itself is never called from this file — see
      // its own doc comment; router.ts does the gate+stamp+notify post-turn.
      if (config.knowledgeStaleAlert.enabled && turnState) {
        for (const h of finalHits) {
          if (!h.viaLexical && h.similarity < KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD) continue;
          if (
            isKnowledgeStale(
              { updatedAt: h.updatedAt, lastRetrievedAt: h.lastRetrievedAt ?? null },
              config.adminDigest.knowledgeStaleDays,
              config.adminDigest.knowledgeStaleMaxAgeDays,
            )
          ) {
            (turnState.staleKnowledgeAlertIds ??= []).push(h.id);
          }
        }
      }
      return text(
        formatKnowledgeSearchResults(
          finalHits,
          config.adminDigest.knowledgeStaleDays,
          config.adminDigest.knowledgeStaleMaxAgeDays,
          hasConflict,
          lowRatedIds,
        ),
      );
    },
  }),

  defineTool({
    name: 'list_knowledge_topics',
    description:
      'Browse the titles of what the community knowledge base covers — the proactive counterpart to ' +
      "knowledge_search for a member who doesn't yet know the right words to search for. Titles only, " +
      'no arguments, no content — call knowledge_search for an actual answer once you know what to ask.',
    minTier: 'member',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller }) => {
      const { titles, totalCount } = await listKnowledgeTopics(
        { platform: caller.platform, conversationId: caller.conversationId },
        config.behaviour.knowledgeTopicsListLimit,
      );
      return text(formatKnowledgeTopics(titles, totalCount));
    },
  }),

  defineTool({
    name: 'suggest_knowledge',
    description:
      'Suggest a durable knowledge-base tip for other members — a hard-won answer, workaround, or fact ' +
      'worth saving for the next person who hits the same thing (e.g. "for anyone else hitting this: X ' +
      'needs Y"). This does NOT add to the knowledge base directly: it queues the tip in the SAME admin-' +
      "reviewed candidate queue the offline context builder's own drafts use (list_knowledge_candidates) " +
      '— nothing a member writes here can influence answers until an admin accepts it. Never call this ' +
      'for a question, a request, or a feature/bot-improvement idea (use suggest_improvement for that).',
    minTier: 'member',
    readOnlyHint: false,
    schema: {
      title: z
        .string()
        .min(1)
        .max(KNOWLEDGE_TIP_TITLE_MAX_CHARS)
        .describe(`Short FAQ-style title for the tip (max ${KNOWLEDGE_TIP_TITLE_MAX_CHARS} characters)`),
      content: z
        .string()
        .min(1)
        .max(KNOWLEDGE_TIP_CONTENT_MAX_CHARS)
        .describe(
          `The tip itself, in the member's own words (max ${KNOWLEDGE_TIP_CONTENT_MAX_CHARS} characters)`,
        ),
    },
    handler: async (args, { caller }) => {
      // SECURITY: tier is re-asserted here, not merely surface-gated by
      // MEMBER_TOOLS — same defensive-double-check discipline every
      // privileged/self-service tool in this file follows.
      assertAtLeast(caller.role, 'member', 'suggest_knowledge');

      // Topic = title, and this reuses the context builder's OWN pre-insert
      // dedup guard verbatim (issue #503) so a member's tip is held to the
      // same "don't refill an already-queued/reviewed or already-answered
      // topic" bar as a machine-drafted candidate.
      const topic = args.title;
      const { blocked: alreadyQueued, embedding: topicEmbedding } =
        await candidateTopicAlreadyReviewed(topic);
      if (alreadyQueued) {
        return text(
          'Thanks, but a similar tip is already queued for review or has already been reviewed — no ' +
            'need to resubmit.',
        );
      }
      const covering = await findKnowledgeCoveringTopic(topicEmbedding);
      if (covering) {
        const label = covering.title ? `"${covering.title}"` : `entry #${covering.id}`;
        return text(`Thanks, but this looks already covered by existing knowledge entry ${label}.`);
      }

      const created = await createKnowledgeTip({
        platform: caller.platform,
        userId: caller.userId,
        topic,
        title: args.title,
        content: args.content,
        topicEmbedding,
      });
      if (!created) {
        return text(
          `You've already suggested ${KNOWLEDGE_TIP_RATE_LIMIT_PER_DAY} tips in the last 24 hours. ` +
            'Please wait before suggesting another.',
          true,
        );
      }
      return text(
        `Thanks! Tip #${created.id} queued for admin review — it won't appear in the knowledge base ` +
          'unless an admin accepts it.',
      );
    },
  }),

  defineTool({
    name: 'withdraw_knowledge_tip',
    description:
      'Withdraw your OWN still-pending suggest_knowledge tip(s) — use this if you filed one by mistake, as a ' +
      'joke, or want to fix it before an admin reviews it. It only ever affects tips YOU filed and only ones ' +
      "still pending; it cannot touch anyone else's tip, a machine-drafted candidate, or a tip already " +
      'reviewed. The tip is marked withdrawn and kept on record (not deleted).',
    minTier: 'member',
    readOnlyHint: false,
    schema: {},
    handler: async (_args, { caller }) => {
      const ids = await withdrawOwnKnowledgeTips(caller.platform, caller.userId);
      if (ids.length === 0) {
        return text('You have no pending knowledge tips to withdraw.', true);
      }
      const list = ids.map((id) => `#${id}`).join(', ');
      return text(
        `Withdrew your knowledge tip${ids.length > 1 ? 's' : ''} ${list}. ` +
          "They won't be reviewed — feel free to resubmit a better version with suggest_knowledge.",
      );
    },
  }),
];
