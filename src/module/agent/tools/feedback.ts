import { z } from 'zod';
import { assertAtLeast, atLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { config } from '@swampratnz/agent-base/config.js';
import { logger } from '@swampratnz/agent-base/logger.js';
import {
  answerFeedbackGrounding,
  candidateTopicAlreadyReviewed,
  countMismatchedHelpfulRatings,
  createAnswerFeedback,
  createKnowledgeTip,
  createSuggestion,
  findKnowledgeCoveringTopic,
  getLanguagePreference,
  KNOWLEDGE_TIP_RATE_LIMIT_PER_DAY,
  listOwnSuggestions,
  RATE_ANSWER_DAILY_LIMIT,
  SUGGESTION_MAX_CHARS,
  SUGGESTION_RATE_LIMIT_PER_DAY,
  type LanguagePreference,
} from '@swampratnz/agent-base/storage/repository.js';
import { makeSlidingWindowReserver } from '@swampratnz/agent-base/util/rateReservation.js';
import {
  getWithdrawnSuggestionIds,
  recordSuggestionWithdrawal,
} from '../../storage/suggestionWithdrawals.js';
import { text } from './helpers.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

/**
 * Pure render for `suggest_improvement`'s two outcomes — same "language
 * threaded as an explicit parameter" shape as `formatMyWarningsText`
 * (issue #1147), reusing `selfService.ts`'s pattern rather than inventing a
 * new one. The interpolated id/limit are identical in both languages; only
 * surrounding prose swaps.
 */
export function formatSuggestImprovementText(
  outcome: { recorded: true; id: number } | { recorded: false },
  limit: number,
  language: LanguagePreference,
): string {
  const mi = language === 'mi';
  if (!outcome.recorded) {
    return mi
      ? `Kua tukuna kētia e koe ${limit} ngā taunakitanga i roto i ngā haora 24 kua hipa. Tēnā koa, tatari i mua i te tuku i tētahi atu.`
      : `You've already filed ${limit} suggestions in the last 24 hours. Please wait before filing another.`;
  }
  return mi
    ? `Kua tuhia te Taunakitanga #${outcome.id}. Ka arotakehia ēnei e tētahi kaiwhakahaere tangata — mauruuru ` +
        'mō te whakaaro, engari kāore he oati mō te mea ka hangaia, āhea rānei.'
    : `Suggestion #${outcome.id} recorded. A human maintainer reviews these — thanks for the idea, but no ` +
        'promises on if/when it gets built.';
}

/**
 * Pure render for `withdraw_suggestion`'s outcomes — none-to-withdraw, and
 * withdrew (singular/plural) — same shape as `formatWithdrawReportText`
 * (reportsMember.ts) and `formatWithdrawKnowledgeTipConfirmText`
 * (knowledgeMember.ts, via helpers.ts). `ids` is already scoped to the
 * caller's own still-`'new'`, not-yet-withdrawn suggestions by the handler;
 * this function does no scoping itself, only formatting.
 */
export function formatWithdrawSuggestionText(ids: number[], language: LanguagePreference): string {
  const mi = language === 'mi';
  if (ids.length === 0) {
    return mi
      ? 'Kāore he taunakitanga e tatari ana hei tango māu.'
      : 'You have no pending suggestions to withdraw.';
  }
  const list = ids.map((id) => `#${id}`).join(', ');
  return mi
    ? `Kua tangohia ${ids.length > 1 ? 'ō taunakitanga' : 'tō taunakitanga'} ${list}. Kāore ēnei e arotakehia.`
    : `Withdrew your suggestion${ids.length > 1 ? 's' : ''} ${list}. They won't be reviewed.`;
}

/**
 * Pure render for `rate_answer`'s four outcomes (issue #1147), mirroring
 * `formatMyWarningsText`'s shape. `RATE_ANSWER_DAILY_LIMIT` and the boolean
 * outcome are unchanged interpolations in both languages.
 */
export function formatRateAnswerText(
  outcome: 'no_recent_answer' | 'rate_limited' | { helpful: boolean },
  limit: number,
  language: LanguagePreference,
): string {
  const mi = language === 'mi';
  if (outcome === 'no_recent_answer') {
    return mi
      ? 'Kāore aku whakautu tata nei hei arotake i roto i tēnei kōrero.'
      : "I don't have a recent answer of mine to rate in this conversation yet.";
  }
  if (outcome === 'rate_limited') {
    return mi
      ? `Kua arotakehia kētia e koe ${limit} ngā whakautu i roto i ngā haora 24 kua hipa. Tēnā koa, tatari i ` +
          'mua i te arotake i tētahi atu.'
      : `You've already rated ${limit} answers in the last 24 hours. Please wait before rating another.`;
  }
  return outcome.helpful
    ? mi
      ? 'Mauruuru, he pai te āwhina!'
      : 'Thanks, glad that helped!'
    : mi
      ? 'Mauruuru mō te whakahoki kōrero, kua tuhia.'
      : 'Thanks for the feedback, noted.';
}

/**
 * Pure render for `request_human_help`'s two outcomes (issue #1147).
 * `HUMAN_HELP_REQUEST_DAILY_LIMIT_PER_USER` is an unchanged interpolation.
 */
export function formatRequestHumanHelpText(
  outcome: 'recorded' | 'rate_limited',
  limit: number,
  language: LanguagePreference,
): string {
  const mi = language === 'mi';
  if (outcome === 'rate_limited') {
    return mi
      ? `Kua tono kētia koe ${limit} ngā wā mō te kōrero ki tētahi tangata i roto i ngā haora 24 kua hipa. ` +
          'Tēnā koa, tatari i mua i te tono anō.'
      : `You've already asked to talk to a human ${limit} times in the last 24 hours. Please wait before ` +
          'asking again.';
  }
  return mi
    ? 'Kua mau — kua tohu ahau i tēnei mō tētahi kaiwhakahaere hapori hei whai kōrero mai.'
    : "Got it — I've flagged this for a community admin to follow up.";
}

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

// withdraw_suggestion's candidate scan cap (issue #1243) — SUGGESTION_RATE_LIMIT_PER_DAY
// caps a member at 3 new suggestions/day, so 500 is comfortably above any
// real backlog of still-'new' suggestions one member could ever accumulate,
// same "generous, bounded fetch" reasoning as MOST_HELPFUL_KNOWLEDGE_FETCH_CAP
// (knowledgeMember.ts).
const WITHDRAW_SUGGESTION_SCAN_LIMIT = 500;

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
      const language = await getLanguagePreference(caller.platform, caller.userId);
      if (!created) {
        return text(
          formatSuggestImprovementText({ recorded: false }, SUGGESTION_RATE_LIMIT_PER_DAY, language),
          true,
        );
      }
      return text(
        formatSuggestImprovementText(
          { recorded: true, id: created.id },
          SUGGESTION_RATE_LIMIT_PER_DAY,
          language,
        ),
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
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatRateAnswerText('no_recent_answer', RATE_ANSWER_DAILY_LIMIT, language), true);
      }
      if (created === 'rate_limited') {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatRateAnswerText('rate_limited', RATE_ANSWER_DAILY_LIMIT, language), true);
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
      const language = await getLanguagePreference(caller.platform, caller.userId);
      return text(formatRateAnswerText({ helpful: args.helpful }, RATE_ANSWER_DAILY_LIMIT, language));
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
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(
          formatRequestHumanHelpText('rate_limited', HUMAN_HELP_REQUEST_DAILY_LIMIT_PER_USER, language),
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
      const language = await getLanguagePreference(caller.platform, caller.userId);
      return text(formatRequestHumanHelpText('recorded', HUMAN_HELP_REQUEST_DAILY_LIMIT_PER_USER, language));
    },
  }),

  // Retract your OWN still-'new' suggest_improvement suggestion(s) (issue
  // #1243, the follow-up #895 deferred) — scoped via listOwnSuggestions'
  // own (platform, userId) predicate, so it can never touch another
  // member's suggestion. Unlike withdraw_report/withdraw_knowledge_tip this
  // never mutates the base suggestions row (its status CHECK constraint is
  // base-owned, with no 'withdrawn' value): the withdrawal is recorded in
  // the module-owned suggestion_withdrawals table instead, consulted by
  // resolve_suggestion/list_suggestions/my_submissions rather than changing
  // what those reads select.
  defineTool({
    name: 'withdraw_suggestion',
    description:
      'Withdraw your OWN still-new suggest_improvement suggestion(s) — use this if you filed one by mistake, ' +
      'as a joke, or want to retract it before an admin reviews it. It only ever affects suggestions YOU ' +
      "filed and only ones still in 'new' status; it cannot touch anyone else's suggestion or one already " +
      'reviewed/declined/done. The suggestion is marked withdrawn and kept on record (not deleted); ' +
      'resolve_suggestion will refuse a withdrawn one.',
    minTier: 'member',
    readOnlyHint: false,
    schema: {},
    handler: async (_args, { caller }) => {
      // SECURITY: tier is re-asserted here, matching request_human_help's own
      // defensive double-check just above in this file — not merely
      // surface-gated by MEMBER_TOOLS.
      assertAtLeast(caller.role, 'member', 'withdraw_suggestion');
      const own = await listOwnSuggestions(caller.platform, caller.userId, WITHDRAW_SUGGESTION_SCAN_LIMIT);
      const pending = own.filter((s) => s.status === 'new');
      const alreadyWithdrawn =
        pending.length > 0 ? await getWithdrawnSuggestionIds(pending.map((s) => s.id)) : new Set<number>();
      const toWithdraw = pending.filter((s) => !alreadyWithdrawn.has(s.id));
      const language = await getLanguagePreference(caller.platform, caller.userId);
      if (toWithdraw.length === 0) {
        return text(formatWithdrawSuggestionText([], language), true);
      }
      await Promise.all(toWithdraw.map((s) => recordSuggestionWithdrawal(s.id)));
      return text(
        formatWithdrawSuggestionText(
          toWithdraw.map((s) => s.id),
          language,
        ),
      );
    },
  }),
];
