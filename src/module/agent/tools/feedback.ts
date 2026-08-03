import { z } from 'zod';
import { assertAtLeast, atLeast } from '../../../base/auth/tiers.js';
import { config } from '../../../base/config.js';
import { logger } from '../../../base/logger.js';
import {
  answerFeedbackGrounding,
  candidateTopicAlreadyReviewed,
  countMismatchedHelpfulRatings,
  createAnswerFeedback,
  createKnowledgeTip,
  createSuggestion,
  findKnowledgeCoveringTopic,
  KNOWLEDGE_TIP_RATE_LIMIT_PER_DAY,
  RATE_ANSWER_DAILY_LIMIT,
  SUGGESTION_MAX_CHARS,
  SUGGESTION_RATE_LIMIT_PER_DAY,
} from '../../../base/storage/repository.js';
import { makeSlidingWindowReserver } from '../../../base/util/rateReservation.js';
import { text } from './helpers.js';
import { defineTool } from '../../../base/agent/tools/types.js';

/**
 * request_human_help timestamps per caller (`platform:userId`), for its own
 * rolling-24h daily cap (HUMAN_HELP_REQUEST_DAILY_LIMIT_PER_USER, issue
 * #808) — in-memory, same sliding-window shape as `reservePollSlot`/
 * `reserveAnnounceSlot` above, not a new table. This bounds a single
 * caller's own worst-case share of the shared guild-wide
 * ESCALATION_RATE_LIMIT_PER_HOUR budget: without it one member spamming the
 * tool could alone exhaust that hourly cap and starve every other member's
 * max-turns/thumbs-down escalations for the rest of the hour.
 */
export const HUMAN_HELP_REQUEST_DAILY_LIMIT_PER_USER = 3;

/**
 * Reserve one request_human_help slot for `key` against a rolling 24h cap —
 * same sliding-window shape as `reservePollSlot`, but a day-long window
 * (this bounds a caller's daily share, not a per-conversation hourly burst).
 * Returns false without reserving if `key` already hit `limit` within the
 * last 24h.
 */
const reserveHumanHelpRequestSlot = makeSlidingWindowReserver(24 * 60 * 60 * 1000);

export const feedbackTools = [
  // Write-only into the member's own queue (rate-capped); the shared-queue
  // read side (list_suggestions) is admin-tier — a member can never read
  // anyone else's suggestion, only their own via my_submissions.
  defineTool({
    name: 'suggest_improvement',
    description:
      "Record a member's suggestion for how this assistant/community bot could be improved, so the human " +
      'maintainers see it. Capture only: a human reviews these and decides — never promise the change ' +
      'will be built. The shared queue stays admin-only (triaged with list_suggestions); the member can ' +
      'check their own status with my_submissions.',
    minTier: 'member',
    readOnlyHint: false,
    schema: {
      content: z
        .string()
        .min(1)
        .max(SUGGESTION_MAX_CHARS)
        .describe(`The suggestion, in the member's own words (max ${SUGGESTION_MAX_CHARS} characters)`),
    },
    handler: async (args, { caller }) => {
      const created = await createSuggestion({
        platform: caller.platform,
        userId: caller.userId,
        displayName: caller.userName,
        content: args.content,
      });
      if (!created) {
        return text(
          `You've already filed ${SUGGESTION_RATE_LIMIT_PER_DAY} suggestions in the last 24 hours. ` +
            'Please wait before filing another.',
          true,
        );
      }
      return text(
        `Suggestion #${created.id} recorded. A human maintainer reviews these — thanks for the idea, ` +
          'but no promises on if/when it gets built.',
      );
    },
  }),

  // Write-only, boolean-only rating of the bot's own last answer to the
  // caller (rate-capped); the read side (list_answer_feedback) is
  // admin-tier — a member can never read the aggregate feedback queue.
  defineTool({
    name: 'rate_answer',
    description:
      "Record whether the bot's most recent answer to the caller in this conversation was helpful. Call " +
      'this ONLY on a clear, explicit member cue about the bot\'s own last answer (e.g. "that helped, ' +
      'thanks", "that\'s wrong", a 👍/👎) — never on general positivity, ambiguous chatter, or feedback ' +
      "about something other than the bot's last reply.",
    minTier: 'member',
    readOnlyHint: false,
    schema: {
      helpful: z.boolean().describe('true if the answer helped, false if it did not'),
      comment: z
        .string()
        .max(200)
        .optional()
        .describe(
          "Optional short reason the member gave alongside the rating in the SAME message (e.g. 'wrong " +
            "pricing, it changed last month'). Only pass through what they actually said — never invent one, " +
            'and never ask a follow-up question just to solicit it.',
        ),
    },
    handler: async (args, { caller, turnState }) => {
      const created = await createAnswerFeedback({
        platform: caller.platform,
        conversationId: caller.conversationId,
        userId: caller.userId,
        helpful: args.helpful,
        comment: args.comment,
      });
      if (created === 'no_recent_answer') {
        return text("I don't have a recent answer of mine to rate in this conversation yet.", true);
      }
      if (created === 'rate_limited') {
        return text(
          `You've already rated ${RATE_ANSWER_DAILY_LIMIT} answers in the last 24 hours. ` +
            'Please wait before rating another.',
          true,
        );
      }
      // Real-time admin escalation (issue #598): only a genuinely-recorded
      // thumbs-down sets the turn-scoped flag — never a positive rating, and
      // never the 'no_recent_answer'/'rate_limited' branches above, which
      // return before reaching here. `notifyAdmins` is deliberately NOT
      // called from this tool handler; `router.ts` reads this flag back
      // post-turn and direct-fires it, preserving the documented "never from
      // a model-callable tool" boundary (see `notifyAdmins`'s doc comment).
      if (turnState && args.helpful === false) {
        turnState.unhelpfulAnswerRated = true;
      }
      // Answered-question -> knowledge-base loop (issue #726,
      // CAPABILITY-IDEAS.md §D2): a genuinely helpful, UNGROUNDED answer is
      // silently drafted into the SAME admin-reviewed candidate queue
      // suggest_knowledge (#633) writes into, via the exact same
      // createKnowledgeTip/candidateTopicAlreadyReviewed/
      // findKnowledgeCoveringTopic dedup+write path — the member-facing reply
      // below is byte-identical either way. Fails closed whenever the
      // grounding lookup can't recover a coherent preceding question (no
      // `replyToUserId`, or no qualifying inbound row), never on the rater's
      // own identity — the drafted row is attributed to the QUESTION's
      // author (`grounding.questionUserId`), which can differ from the rater
      // when `resolveAnswerFeedbackTarget` bound this rating to a reply
      // addressed to someone else (SECURITY, issue #726 AC10).
      // DM exclusion (issue #730 review): a 1:1 DM Q&A only ever enters the
      // guild-wide, admin-visible candidate queue via the EXPLICIT
      // suggest_knowledge act — never implicitly from a "helpful" rating.
      // In a channel the exchange was already visible to the room; in a DM
      // the member may reasonably assume privacy, and "helpful" is not
      // consent to republish.
      // Tier gate (issue #730 review, round 2): open-mode guests hold
      // rate_answer (MEMBER_TOOLS surface), but writing into the
      // knowledge_candidates queue is a member+ capability — suggest_knowledge
      // asserts exactly that on the SAME createKnowledgeTip path. `atLeast`
      // (not assertAtLeast) because the RATING itself stays guest-allowed:
      // a guest's helpful rating records normally and only the drafting side
      // effect is silently suppressed, same shape as the DM exclusion.
      // Whole block is try/caught: drafting is a
      // silent side effect on an already-recorded rating, so a transient
      // failure in any of its reads/writes must degrade to "no draft" —
      // never surface as a tool error on the rating itself (same fail-open
      // posture as the gap/stale/retrieval supplements in knowledge_search).
      if (
        config.knowledgeAnswerCandidate.enabled &&
        args.helpful === true &&
        !caller.isDirect &&
        atLeast(caller.role, 'member')
      ) {
        try {
          const grounding = await answerFeedbackGrounding(created.interactionId);
          if (
            grounding &&
            grounding.knowledgeEntryId === null &&
            grounding.questionContent !== null &&
            grounding.questionUserId !== null
          ) {
            // SECURITY (issue #726 follow-up): createKnowledgeTip's cap alone
            // bounds how much of a single VICTIM's quota this can absorb, not
            // how many DIFFERENT victims one rater can draft against via the
            // mismatched-attribution fallback above — rate_answer's own daily
            // cap (RATE_ANSWER_DAILY_LIMIT, 20/day) is far looser than any one
            // victim's KNOWLEDGE_TIP_RATE_LIMIT_PER_DAY (3/day). A matched
            // self-rating is exempt: that case is already bounded by
            // createKnowledgeTip's own per-source-user cap. Fails closed
            // (silently, same as every other branch here) rather than erroring
            // the rating itself.
            const mismatched = grounding.questionUserId !== caller.userId;
            // Deliberately check-then-act, not atomic (issue #730 review): the
            // count runs over answer_feedback AFTER this rating's own row was
            // inserted, so the only overshoot window is calls truly in flight
            // at the same instant, and the per-VICTIM cap inside
            // createKnowledgeTip (an atomic INSERT..SELECT) stays the hard
            // bound on actual damage regardless. A cross-table atomic rewrite
            // would buy precision on an advisory secondary guard.
            const raterExhausted =
              mismatched &&
              (await countMismatchedHelpfulRatings(caller.platform, caller.userId)) >
                KNOWLEDGE_TIP_RATE_LIMIT_PER_DAY;
            if (!raterExhausted) {
              const { blocked, embedding: topicEmbedding } = await candidateTopicAlreadyReviewed(
                grounding.questionContent,
              );
              if (!blocked) {
                const covering = await findKnowledgeCoveringTopic(topicEmbedding);
                if (!covering) {
                  await createKnowledgeTip({
                    platform: caller.platform,
                    userId: grounding.questionUserId,
                    topic: grounding.questionContent,
                    title: grounding.questionContent,
                    content: grounding.answerContent,
                    topicEmbedding,
                  });
                }
              }
            }
          }
        } catch (err) {
          logger.warn({ err }, 'rate_answer knowledge-candidate drafting failed; rating already recorded');
        }
      }
      return text(args.helpful ? 'Thanks, glad that helped!' : 'Thanks for the feedback, noted.');
    },
  }),

  // Zero-argument write; sets a turn-scoped flag only (rate-capped per
  // caller) — router.ts reads it back post-turn to direct-fire the same
  // admin escalation notifyAdmins path rate_answer's thumbs-down uses
  // (issue #808). Never a free-text field, so there is nothing here for a
  // model-composed admin-notification injection to ride.
  defineTool({
    name: 'request_human_help',
    description:
      'Ask for a human community admin to be looped into this conversation. Call this ONLY on a clear, ' +
      'explicit member ask for a human/admin (e.g. "can I talk to a human", "is there an admin I can ' +
      'ask", "I need a person for this") — never on general frustration, ambiguous chatter, or a ' +
      'question a normal answer can still address.',
    minTier: 'member',
    readOnlyHint: false,
    schema: {},
    handler: async (_args, { caller, turnState }) => {
      // SECURITY: tier is re-asserted here, not merely surface-gated by
      // MEMBER_TOOLS — same defensive-double-check discipline as
      // suggest_knowledge/every other privileged/self-service tool in this
      // file.
      assertAtLeast(caller.role, 'member', 'request_human_help');

      // Per-caller daily cap (issue #808): the ONE genuinely new piece this
      // tool introduces — see reserveHumanHelpRequestSlot's doc comment for
      // why. Checked before touching turnState, so a declined-by-cap call
      // never sets the flag router.ts acts on.
      const key = `${caller.platform}:${caller.userId}`;
      if (!reserveHumanHelpRequestSlot(key, HUMAN_HELP_REQUEST_DAILY_LIMIT_PER_USER)) {
        return text(
          `You've already asked to talk to a human ${HUMAN_HELP_REQUEST_DAILY_LIMIT_PER_USER} times in ` +
            'the last 24 hours. Please wait before asking again.',
          true,
        );
      }

      // Real-time admin escalation (issue #808): mirrors rate_answer's
      // turn-scoped-flag discipline exactly (issue #598). `notifyAdmins` is
      // deliberately NEVER called from this file — `router.ts` reads this
      // flag back post-turn and direct-fires it from `msg.text`/
      // `msg.userName`/`msg.platform`/`msg.conversationId` only, never from
      // anything returned or accepted here (see `notifyAdmins`'s own doc
      // comment). This is a zero-argument tool, so there is no model-composed
      // free-text field that could reach that notification in the first
      // place.
      if (turnState) {
        turnState.humanHelpRequested = true;
      }
      return text("Got it — I've flagged this for a community admin to follow up.");
    },
  }),
];
