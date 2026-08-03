import type { NoticeAxes } from '@swampratnz/agent-base/strings/catalogue.js';

/**
 * The NZ Claude Community notice PACK — the community-owned half of the
 * agent-base plan's `strings` extension point (docs/AGENT-BASE-PLAN.md §3),
 * paired with the base-owned mechanism in `catalogue.ts`.
 *
 * Every value here moved VERBATIM from the `*_MI`/`*_PLAIN` constant family
 * it replaces (rateLimitNotice.ts, pauseNotice.ts, dailyBudgetNotice.ts,
 * dailyReplyBudgetWarning.ts, voiceLanguageCaveatNotice.ts, gatedNotice.ts,
 * router.ts, agent/core.ts, agent/upstreamFailure.ts, agent/outbound.ts,
 * agent/tools/notify.ts, agent/tools/helpers.ts, moderation/moderator.ts) —
 * dozens of tests pin these member-facing strings byte-for-byte, and the
 * old exported constants remain importable from their original modules as
 * consts derived from this catalogue, so no import site or pinned value
 * changes. The per-constant provenance comments (issue numbers, trust
 * rationale) stay with those derived consts; the shared rationale is:
 * fixed, human-authored text only — no model call, no translation, no
 * injection surface — served per the standing `language_prefs`/
 * `response_style_prefs` rows and nothing else.
 *
 * The `CONFIRM`/`CANCEL` tokens inside the pending-notice variants stay
 * literal, untranslated, base-owned words in EVERY variant:
 * `classifyConfirmReply` (agent/pendingActions.ts) matches exactly those
 * strings, so a pack translating them would break the confirm protocol
 * itself (pinned by tests/stringsCatalogue.test.ts).
 */

/** The axes this community registers: te reo Māori + plain language. */
export const NOTICE_AXES: NoticeAxes = {
  languages: ['mi'],
  styles: ['plain'],
};

// Shared shells composed into more than one entry, kept as local consts so
// the composed values stay byte-identical to the old derived constants.
const USAGE_LIMIT_REPLY_BASE =
  "Sorry — I'm temporarily unable to answer because this bot has hit its shared usage limit. " +
  "This isn't a bug — please try again later.";
const USAGE_LIMIT_REPLY_BASE_MI =
  'Aroha mai — kāore e taea e au te whakautu i tēnei wā nā te mea kua eke tēnei pouaka ki tōna tepe ' +
  'whakamahi tahi. Ehara tēnei i te hapa — tēnā koa, whakamātauria anō i muri mai.';
const USAGE_LIMIT_REPLY_BASE_PLAIN =
  "Sorry, I can't answer right now. Too many people are using me at once. " +
  'This is not a problem with your message — please try again later.';

const MUTED_ROLE_NOTE_BASE = 'You can post again once an admin clears your warnings.';
const MUTED_ROLE_NOTE_BASE_MI =
  'Ka taea anō e koe te tuhi i te wā e whakawāteatia ai ō whakatūpato e tētahi kaiwhakahaere.';

const NOTICE_ENTRIES = {
  // --- standing member-facing notices (per-notice-file convention) --------
  rateLimitNotice: {
    base: "You're sending messages a bit fast — please wait a moment and try again.",
    language: {
      mi: 'Kei te tere rawa āu karere — tēnā koa, tatari mō tētahi wā poto ka whakamātau anō ai.',
    },
    style: {
      plain: "You're sending messages too fast. Please wait a bit, then try again.",
    },
  },
  pauseNotice: {
    base: 'The assistant is temporarily paused — please try again later.',
    language: {
      mi: 'Kua whakatārewahia te kaiāwhina mō tētahi wā poto — tēnā koa, tukua he wā.',
    },
    style: {
      plain: 'The assistant is paused right now. Please try again later.',
    },
  },
  dailyBudgetNotice: {
    base: "You've reached today's usage limit for the assistant — try again later.",
    language: {
      mi: 'Kua eke koe ki te whāiti whakamahi o te rā mō te kaiāwhina — tēnā koa, whakamātau anō ā tērā rā.',
    },
    style: {
      plain: "You've used all of today's replies. Try again tomorrow.",
    },
  },
  dailyReplyBudgetWarning: {
    base: (remaining: number) =>
      `\n\n(You have ${remaining} repl${remaining === 1 ? 'y' : 'ies'} left today.)`,
    language: {
      mi: (remaining: number) => `\n\n(E ${remaining} ō whakautu e toe ana māu i tēnei rā.)`,
    },
    style: {
      plain: (remaining: number) => `\n\n(You have ${remaining} left today.)`,
    },
  },
  voiceLanguageCaveat: {
    base:
      'Heads up: voice notes are transcribed in English only right now, so the text I acted on may ' +
      'not match what you said.',
    language: {
      mi:
        'He mihi whakamōhio: ko te reo Ingarihi anake e whakamāoritia ana ngā karere reo i tēnei wā, nā ' +
        'reira tērā pea kāore te kupu i mahia e au e rite tonu ana ki tāu i kī ai.',
    },
  },
  // --- gated mode ----------------------------------------------------------
  gatedNotice: {
    base: 'Kia ora! This assistant is member-only. Ask a community admin to add you as a member and I can help.',
    language: {
      mi:
        'Kia ora! He kaupapa mema anake tēnei kaiāwhina. Tonoa he kaiwhakahaere hapori ki te tāpiri i a ' +
        'koe hei mema, kātahi ka taea e au te āwhina.',
    },
    style: {
      plain:
        'Kia ora! Only members can use this assistant. Please ask a community admin to add you as a ' +
        'member — then I can help.',
    },
  },
  /**
   * The dynamic, admin-naming gated notice (issue #360). agent-base owns the
   * mechanism — resolve the admin display names, `sanitizeName` each, drop the
   * empties, cap at GATED_NOTICE_MAX_ADMIN_NAMES, join them — and interpolates
   * the finished list into this template; the SENTENCE is deployment prose, so
   * it lives here. Byte-identical to the string `renderGatedNotice` built
   * inline before the package flip.
   *
   * Deliberately no `language`/`style` variants, exactly as before: the
   * dynamic builder was English-only, and a caller with a standing registered
   * language gets the fixed `gatedNotice` translation instead (which names no
   * admins) — see the router's gated branch.
   */
  gatedNoticeWithAdmins: {
    base: (admins: string) =>
      `Kia ora! This assistant is member-only. Ask a community admin — ${admins} — to add you as a member and I can help.`,
  },
  /**
   * The heading that joins the admin-authored conduct guidelines onto a
   * welcome or gated notice. Was the bare literal `Community guidelines:`,
   * duplicated across the router and all three adapters; base asks the pack
   * for it now, since a framework cannot assume the deployment has a
   * "community".
   *
   * No `mi` variant, deliberately: the literal was English on every one of
   * those four paths, including the te reo gated-notice branch, so adding one
   * here would be a behaviour change rather than the flip's byte-for-byte
   * move. It is an obvious follow-up, not this PR's business.
   */
  guidelinesHeading: {
    base: 'Community guidelines:',
  },
  gatedWaitClause: {
    base: (notice: string, waitDays?: number) => {
      if (!waitDays || waitDays < 1) return notice;
      const days = Math.floor(waitDays);
      return `${notice} (You first asked ${days} day${days === 1 ? '' : 's'} ago — your request is on record.)`;
    },
    language: {
      mi: (notice: string, waitDays?: number) => {
        if (!waitDays || waitDays < 1) return notice;
        const days = Math.floor(waitDays);
        const whenClause = days === 1 ? 'i te rā kotahi kua pahure' : `i ngā rā e ${days} kua pahure`;
        return `${notice} (Nāu i pātai tuatahi mai ${whenClause} — kei te mau tonu tō tono.)`;
      },
    },
  },
  // --- CONFIRM/CANCEL intercept shells (router-authored) -------------------
  cancelConfirm: {
    base: 'Cancelled.',
    language: { mi: 'Kua whakakorea.' },
    // Deliberately no plain variant (issue #430): already at the floor of
    // simplicity, so a plain variant would be change for change's sake.
  },
  permissionsChanged: {
    base: 'Not executed: your permissions changed since this action was requested.',
    language: {
      mi: 'Kāore i whakahaerehia: kua rerekē ō mana whakaaetanga mai i te wā i tonoa ai tēnei mahi.',
    },
    style: {
      plain: 'I did not do this. Your permission level changed after you asked, so I can no longer do it.',
    },
  },
  confirmFailedPrefix: {
    base: 'Failed: ',
    language: { mi: 'I hapa: ' },
  },
  confirmDonePrefix: {
    base: 'Done: ',
    language: { mi: 'Kua oti: ' },
  },
  pendingNotice: {
    base: (description: string) =>
      `⚠️ Pending: ${description}\nReply CONFIRM within 60 seconds to proceed, or CANCEL to abort. ` +
      `(This confirmation is handled outside the AI and must come from you in this conversation.)`,
    language: {
      mi: (description: string) =>
        `⚠️ Kei te tatari: ${description}\nWhakahokia mai te CONFIRM i roto i te 60 hēkona kia haere tonu ai, ` +
        `CANCEL rānei kia whakakorehia. (Ka whakahaeretia tēnei whakaūnga i waho o te AI, ā, me ahu mai i a koe ` +
        `i roto i tēnei kōrerorero.)`,
    },
    style: {
      plain: (description: string) =>
        `⚠️ Waiting for you: ${description}\nReply CONFIRM within 60 seconds to go ahead, or CANCEL to stop. ` +
        `(A person must reply CONFIRM or CANCEL — I cannot do this step myself.)`,
    },
  },
  // --- shortcut replies (router-authored) ----------------------------------
  ackReply: {
    base: 'No worries!',
    language: { mi: 'Kāore he raru!' },
  },
  knowledgeShortcutSuffix: {
    base: "\n\n— From our knowledge base; ask me to explain if this doesn't quite answer it.",
    language: {
      mi:
        '\n\n— Nō tā mātou pātengi mōhiotanga; pātai mai kia whakamāramatia mehemea kāore tēnei e tino ' +
        'whakautu ana i tāu pātai.',
    },
  },
  guestKnowledgeShortcutNudge: {
    base: '\n\nAsk a community admin to add you as a member to keep chatting.',
    language: {
      mi: '\n\nTonoa tētahi kaiwhakahaere hapori ki te tāpiri i a koe hei mema kia taea ai te kōrero tonu.',
    },
  },
  repeatShortcutNotice: {
    base: "↩️ You asked this a moment ago — here's my answer again:\n\n",
    language: {
      mi: '↩️ I pātai mai koe i tēnei mea i tērā wā — anei anō tāku whakautu:\n\n',
    },
  },
  repeatMaxTurnsShortcutNotice: {
    base: '↩️ Same request as a moment ago — it still needs breaking down:\n\n',
    language: {
      mi: '↩️ He rite tonu ki tō tono o mua tata nei — me wāwāhi tonu:\n\n',
    },
  },
  // --- escalation to admin (router-authored) -------------------------------
  escalationOfferSuffix: {
    base: '\n\nWant me to flag this for a community admin? Reply yes within 10 minutes.',
    language: {
      mi: '\n\nMe tohu tēnei mō tētahi kaiwhakahaere hapori? Whakahokia mai "āe" i roto i te 10 meneti.',
    },
  },
  escalationConfirmed: {
    base: '👍 Flagged for a community admin — someone will follow up soon.',
    language: {
      mi: '👍 Kua tohu mō tētahi kaiwhakahaere hapori — ka whai kōrero mai tētahi i muri tata nei.',
    },
  },
  escalationRateLimited: {
    base: 'Already flagged the max I can this hour, sorry — please try again later or contact an admin directly.',
    language: {
      mi:
        'Kua tae ki te tepe mō tēnei haora, aroha mai — tēnā koa whakamātauria anō ā muri ake, ' +
        'whakapā tika rānei ki tētahi kaiwhakahaere.',
    },
  },
  // --- turn failure fallbacks (agent/core.ts, agent/upstreamFailure.ts) ----
  internalErrorReply: {
    base: 'Sorry — I hit an internal error and could not complete that. Please try again.',
    language: {
      mi: 'Aroha mai — i pā mai he hapa o roto, kāore i oti i ahau tēnā mahi. Tēnā koa, whakamātauria anō.',
    },
    style: {
      plain: 'Sorry, something went wrong on my end. Please try again.',
    },
  },
  maxTurnsReply: {
    base: 'Sorry — that took more steps than I allow per message. Try breaking it into smaller questions.',
    language: {
      mi:
        'Aroha mai — he maha rawa ngā hipanga i hiahiatia mō tēnei karere. Whakamātauria te wāwāhi i tō ' +
        'pātai kia iti ake ngā wāhanga.',
    },
    style: {
      plain:
        'Sorry, that was too many steps for me to finish in one go. Please split it into smaller questions.',
    },
  },
  turnFailedReply: {
    base: 'Sorry — I could not complete that request. Please try again.',
    language: {
      mi: 'Aroha mai — kāore i oti i ahau tēnā tono. Tēnā koa, whakamātauria anō.',
    },
    style: {
      plain: 'Sorry, I could not finish that. Please try again.',
    },
  },
  usageLimitReply: {
    base: USAGE_LIMIT_REPLY_BASE,
    language: { mi: USAGE_LIMIT_REPLY_BASE_MI },
    style: { plain: USAGE_LIMIT_REPLY_BASE_PLAIN },
  },
  usageLimitReplyAdminNotified: {
    base: `${USAGE_LIMIT_REPLY_BASE} An admin has been notified.`,
    language: { mi: `${USAGE_LIMIT_REPLY_BASE_MI} Kua whakamōhiotia tētahi kaiwhakahaere.` },
    style: { plain: `${USAGE_LIMIT_REPLY_BASE_PLAIN} An admin has been told.` },
  },
  // --- outbound code-policy notes (agent/outbound.ts) ----------------------
  codeOmittedNote: {
    base: '_[code omitted — this assistant does not write code for the community; try claude.ai or the API directly]_',
    language: {
      mi:
        '_[i whakakorehia te waehere — kāore tēnei kaiāwhina e tuhi waehere mō te hapori; whakamātauria a claude.ai, ' +
        'te API rānei]_',
    },
    style: {
      plain:
        '_[code removed — this assistant does not write code for the community; try claude.ai or the API instead]_',
    },
  },
  codeTruncatedNote: {
    base: (shown: number) =>
      `\n_[snippet truncated to ${shown} lines — community policy; ask on claude.ai for full programs]_`,
    language: {
      mi: (shown: number) =>
        `\n_[i poroa te tauira ki ${shown} rārangi — kaupapahere hapori; pātai atu i runga i a claude.ai mō ngā ` +
        'papatono katoa]_',
    },
    style: {
      plain: (shown: number) =>
        `\n_[showing only the first ${shown} lines — community rule; ask on claude.ai for the full code]_`,
    },
  },
  // --- grant confirmation DMs (agent/tools/notify.ts) ----------------------
  memberApprovedMessage: {
    base:
      "Kia ora! 👋 You've been approved — you're now a registered member of NZ Claude Community. " +
      'Feel free to message the bot here anytime. Ask me "what can you do?" any time for a quick rundown.',
    language: {
      mi:
        'Kia ora! 👋 Kua whakaaetia koe — kua noho mema rēhita koe o NZ Claude Community. ' +
        'Whakapā mai ki ahau i ngā wā katoa. Pātai mai "what can you do?" i ngā wā katoa mō tētahi whakarāpopototanga poto.',
    },
    style: {
      plain:
        "Kia ora! 👋 You're now a member of NZ Claude Community. " +
        'You can message the bot here anytime. Ask me "what can you do?" for a short list of things I can help with.',
    },
  },
  adminApprovedMessage: {
    base:
      "Kia ora! 👋 You've been promoted to admin on NZ Claude Community. " +
      'Ask me "what can you do?" any time for a rundown, including your new admin tools.',
    language: {
      mi:
        'Kia ora! 👋 Kua whakapikitia koe hei kaiwhakahaere (admin) mō NZ Claude Community. ' +
        'Pātai mai "what can you do?" i ngā wā katoa mō tētahi whakarāpopototanga, tae atu ki ō rākau whakahaere hou.',
    },
    style: {
      plain:
        "Kia ora! 👋 You're now an admin on NZ Claude Community. " +
        'Ask me "what can you do?" for a rundown, including your new admin tools.',
    },
  },
  // --- knowledge citation-note fragments (agent/tools/helpers.ts) ----------
  knowledgeLowRatedCaveat: {
    base: 'other members found this unhelpful — you can flag it too with rate_answer',
    language: {
      mi: 'i kitea e ētahi atu mema he kore-āwhina tēnei — ka taea hoki e koe te tohu mā te rate_answer',
    },
  },
  knowledgeStaleNote: {
    base: 'may be outdated',
    language: { mi: 'tērā pea kua tawhito' },
  },
  // --- moderation DM texts (moderation/moderator.ts) ------------------------
  mutedRoleNote: {
    base: MUTED_ROLE_NOTE_BASE,
    language: { mi: MUTED_ROLE_NOTE_BASE_MI },
  },
  warnDm: {
    base: (active: number, limit: number) =>
      `⚠️ A moderator warning was recorded for your message (${active}/${limit}). ` +
      `Please keep it respectful. At ${limit} warnings you'll be temporarily unable to post.`,
    language: {
      mi: (active: number, limit: number) =>
        `⚠️ Kua tuhia he whakatūpato mō tō karere (${active}/${limit}). ` +
        `Kia āta kōrero. Ka eke koe ki te ${limit}, ka aukatia koe mō tētahi wā poto.`,
    },
    style: {
      plain: (active: number, limit: number) =>
        `⚠️ You got a warning (${active}/${limit}). Please be respectful. ` +
        `At ${limit} warnings, you won't be able to post for a while.`,
    },
  },
  blockedDm: {
    base: () =>
      `⛔ You've reached the warning limit and can no longer post in the server. ${MUTED_ROLE_NOTE_BASE}`,
    language: {
      mi: () =>
        `⛔ Kua eke koe ki te tepe whakatūpato, kāore koe e taea te tuhi anō i roto i te hapori. ${MUTED_ROLE_NOTE_BASE_MI}`,
    },
    style: {
      // Reuses the base MUTED_ROLE_NOTE shell (not a separate plain variant)
      // since that shell is already short/plain by construction — the same
      // reasoning #430 used to skip a plain variant for cancelConfirm.
      plain: () =>
        `⛔ You've reached the warning limit. You can't post in the server right now. ${MUTED_ROLE_NOTE_BASE}`,
    },
  },
} as const;

// The pack is handed to `createAgent` by this module's manifest
// (src/module/agentModule.ts), which registers it before anything can serve a
// turn — so the base `notice()` in catalogue.ts never imports this pack, and
// no base module renders text at import time waiting for it.

/** Per-id base types for the pack — the type-side half of the registration. */
type CommunityNoticeBases = {
  [K in keyof typeof NOTICE_ENTRIES]: (typeof NOTICE_ENTRIES)[K]['base'];
};

declare module '@swampratnz/agent-base/strings/catalogue.js' {
  // Augments the base map so `notice()` keeps each id's concrete return type
  // (template entries stay functions, fixed entries stay strings) everywhere
  // in the program, without catalogue.ts importing this entry map.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface NoticeIdMap extends CommunityNoticeBases {}
}

/**
 * Re-exported for module-side consumers (agent/tools/helpers.ts, notify.ts):
 * same registry-backed `notice(id, {language, style})` as catalogue.ts. Pass
 * the caller's standing preferences RAW (`'auto'`/`'en'`/`'standard'` mean
 * "default" because they are not registered axis values); never pre-resolve
 * the precedence at a call site.
 */
export { notice } from '@swampratnz/agent-base/strings/catalogue.js';

/** The full entry map, exported for the table-driven equivalence test. */
export { NOTICE_ENTRIES };

export type NoticeId = keyof typeof NOTICE_ENTRIES;
