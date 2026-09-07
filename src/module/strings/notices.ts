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
  /**
   * The heading that joins the admin-configured welcome message onto
   * `notifyMemberApproved`'s approval DM (issue #1222 — the welcome-message
   * sibling of `guidelinesHeading` above, for the same pre-registered/
   * `team_setup`-batched population #1171 fixed guidelines for). No `mi`
   * variant, same rationale as `guidelinesHeading`: this heading is new, not
   * a byte-for-byte move of an existing literal, but keeping it English-only
   * matches every other heading in this pack today.
   */
  welcomeHeading: {
    base: 'Welcome message:',
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
  // --- guidelines/digest empty states (issue #1161) -------------------------
  communityGuidelinesUnsetNotice: {
    base: 'No community guidelines have been set yet — ask an admin.',
    language: {
      mi: 'Kāore anō kia whakaritea he aratohu hapori — pātaia he kaiwhakahaere.',
    },
  },
  memberDigestEmptyNotice: {
    base: 'Nothing to report right now.',
    language: {
      mi: 'Kāore he pūrongo i tēnei wā.',
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
  // --- decline_access_request resolution DM (agent/tools/notify.ts, issue #1126) ---
  /**
   * The neutral decline DM for `decline_access_request` — static/templated,
   * same shape as `memberApprovedMessage`/`adminApprovedMessage` above (issue
   * #1126 acceptance criterion #8): the admin-authored `reason` field is never
   * interpolated into this translated base string, only appended afterward as
   * a distinct, quoted, `truncateForEcho`-capped clause (see
   * `notifyAccessRequestDeclined` in notify.ts).
   */
  accessRequestDeclinedMessage: {
    base: 'Your request for access to NZ Claude Community was reviewed and was not approved this time.',
    language: {
      mi: 'I arotakehia tō tono uru ki NZ Claude Community, ā, kāore i whakaaetia i tēnei wā.',
    },
    style: {
      plain: 'Your request to join NZ Claude Community was not approved this time.',
    },
  },
  // --- remove_project resolution DM (agent/tools/notify.ts, issue #1185) ---
  /**
   * The neutral removal DM for the admin-tier `remove_project` — static, same
   * shape as `accessRequestDeclinedMessage` above: the admin-authored
   * `reason` field is never interpolated into this translated base string,
   * only appended afterward as a distinct, quoted, `truncateForEcho`-capped
   * clause (see `notifyProjectRemoved` in notify.ts). Sent only when the
   * admin supplies a reason — omitting one removes the project silently.
   */
  projectRemovedMessage: {
    base: 'One of your projects was removed from the NZ Claude Community project showcase by an admin.',
    language: {
      mi: 'I tangohia tētahi o āu kaupapa mai i te whakaaturanga kaupapa a NZ Claude Community e tētahi kaiwhakahaere.',
    },
    style: {
      plain: 'An admin removed one of your projects from the NZ Claude Community showcase.',
    },
  },
  // --- remove_interests resolution DM (agent/tools/notify.ts, issue #1230) ---
  /**
   * The neutral removal DM for the admin-tier `remove_interests` — static,
   * same shape as `projectRemovedMessage` above: the admin-authored `reason`
   * field is never interpolated into this translated base string, only
   * appended afterward as a distinct, quoted, `truncateForEcho`-capped clause
   * (see `notifyInterestsRemoved` in notify.ts). Sent only when the admin
   * supplies a reason — omitting one clears the interests silently.
   */
  interestsRemovedMessage: {
    base: 'Your published interests were removed from member discovery (who_is_into) by an admin.',
    language: {
      mi: 'I tangohia ō hiahia kua whakaputaina mai i te rapunga mema (who_is_into) e tētahi kaiwhakahaere.',
    },
    style: {
      plain: 'An admin removed your published interests from member discovery.',
    },
  },
  // --- project_add_member / project_remove_member grant-and-revoke DMs
  // (agent/tools/notify.ts, issue #1241) ---
  /**
   * The neutral grant DM for the admin-tier `project_add_member` (and
   * `team_setup`'s existing-member branch) — static, same non-interpolation
   * shape as `projectRemovedMessage` above: the project name is never
   * interpolated into this translated base string, only appended afterward
   * as a distinct, quoted, `truncateForEcho`-capped clause (see
   * `notifyProjectMemberAdded` in notify.ts). Unlike `projectRemovedMessage`/
   * `interestsRemovedMessage`, this fires unconditionally — there is no
   * moderation-silence rationale for an ordinary access grant.
   */
  projectMemberAddedMessage: {
    base: "You've been given access to a project's shared memory on NZ Claude Community.",
    language: {
      mi: 'Kua whakawāteatia koe ki ngā mahara tiritahi o tētahi kaupapa i NZ Claude Community.',
    },
    style: {
      plain: "You now have access to a project's shared memory on NZ Claude Community.",
    },
  },
  /**
   * The neutral revoke DM for the admin-tier `project_remove_member` —
   * static, same non-interpolation shape as `projectMemberAddedMessage`
   * above: the project name is appended only as a distinct, quoted,
   * `truncateForEcho`-capped clause (see `notifyProjectMemberRemoved` in
   * notify.ts). Unconditional, same rationale as `projectMemberAddedMessage`
   * — team-access revocation is ordinary housekeeping, not moderation.
   */
  projectMemberRemovedMessage: {
    base: "Your access to a project's shared memory on NZ Claude Community was removed by an admin.",
    language: {
      mi: 'I tangohia tō urunga ki ngā mahara tiritahi o tētahi kaupapa i NZ Claude Community e tētahi kaiwhakahaere.',
    },
    style: {
      plain: "An admin removed your access to a project's shared memory on NZ Claude Community.",
    },
  },
  // --- find_helper / share_project / request_project_connection peer-DM
  // recipient notifications (agent/tools/social.ts, issue #1245) ---
  /**
   * The neutral match DM `find_helper` sends to the matched HELPER (not the
   * caller) — issue #1163's own doc comment named these two peer-DM sites as
   * deliberately out of scope ("stay untranslated by design"); issue #1245
   * closes that carve-out. `requesterLabel` is the caller's own
   * `resolveSanitizedLabel` output — already sanitized, not raw untrusted
   * content — so it is interpolated directly into the translated sentence,
   * same convention `formatShareProjectText`'s `similar` branch already uses
   * for a pre-sanitized owner label. The caller's free-text topic stays out
   * of this template entirely: the call site appends
   * `untrusted('topic', args.topic)` AFTER the rendered sentence, in the same
   * position (a distinct line, joined by `\n`) as before this issue, in every
   * language/style branch.
   */
  findHelperMatchMessage: {
    base: (requesterLabel: string) =>
      `${requesterLabel} could use some help with something you're into — reach out if you're able to.`,
    language: {
      mi: (requesterLabel: string) =>
        `Kei te hiahia āwhina a ${requesterLabel} mō tētahi mea e pā ana ki ō hiahia — whakapā atu mehemea ka taea e koe.`,
    },
    style: {
      plain: (requesterLabel: string) =>
        `${requesterLabel} could use some help with something you're into. Reach out if you can.`,
    },
  },
  /**
   * The neutral match DM `share_project`'s #1200 seeking-collaborators push
   * sends to the matched HELPER — the third site issue #1245 closes,
   * inherited unchanged from `find_helper` by #1200. Same
   * pre-sanitized-label-interpolated, quarantined-content-appended-after
   * shape as `findHelperMatchMessage` above: the caller's free-text project
   * description is appended by the call site as
   * `untrusted('project', args.description)`, never part of this template.
   */
  shareProjectMatchMessage: {
    base: (requesterLabel: string) =>
      `${requesterLabel} just shared a project looking for collaborators that matches what you're into.`,
    language: {
      mi: (requesterLabel: string) =>
        `Kua tohatoha a ${requesterLabel} i tētahi kaupapa e rapu hoa mahi ana e ōrite ana ki ō hiahia.`,
    },
    style: {
      plain: (requesterLabel: string) =>
        `${requesterLabel} shared a project looking for collaborators. It matches what you're into.`,
    },
  },
  /**
   * The neutral DM `request_project_connection` sends to the project OWNER —
   * the second site issue #1163 itself carved out ("same carve-out as
   * find_helper's match notification"), closed here. Unlike the two entries
   * above, the caller-supplied, `untrusted()`-quarantined project name was
   * always interpolated MID-sentence (before the trailing "reach out"
   * clause), never appended on its own line — `quarantinedProjectName` here
   * is that same already-quarantined string (the call site still wraps it
   * with `untrusted('project', project.name)` first), placed at the
   * identical position in every language/style branch, preserving issue
   * #1245's SECURITY acceptance criterion that this position never move.
   */
  requestProjectConnectionMessage: {
    base: (requesterLabel: string, quarantinedProjectName: string) =>
      `${requesterLabel} is interested in collaborating on ${quarantinedProjectName} — reach out if you're able to.`,
    language: {
      mi: (requesterLabel: string, quarantinedProjectName: string) =>
        `Kei te hiahia a ${requesterLabel} ki te mahi tahi mō ${quarantinedProjectName} — whakapā atu mehemea ka taea e koe.`,
    },
    style: {
      plain: (requesterLabel: string, quarantinedProjectName: string) =>
        `${requesterLabel} wants to collaborate on ${quarantinedProjectName}. Reach out if you can.`,
    },
  },
  // --- community_info member capabilities rundown (agent/tools/info.ts) ---
  /**
   * The member-tier segment of `community_info`/`/help`/`!help`'s capability
   * rundown (issue #1028) — `base` moved VERBATIM from the old
   * `MEMBER_CAPABILITIES_TEXT` constant in info.ts, so this is a byte-neutral
   * relocation, not a rewrite. Both follow-ups its original scope named have
   * since landed: the admin/super-admin segments got the same treatment in
   * `communityInfoAdminCapabilities`/`communityInfoSuperAdminCapabilities`
   * below (issue #1056), and the WhatsApp `!`-shortcuts segment got its own
   * `mi` variant in `whatsappTextCommands` below (issue #1034). No segment of
   * this rundown is English-only any more.
   */
  communityInfoMemberCapabilities: {
    base:
      'NZ Claude Community — a New Zealand group building with Claude and the Anthropic API. ' +
      "Here's what you can ask me to do:\n" +
      '- Flag harassment, spam, or a rule violation to admins ("report this"), or withdraw one filed by mistake\n' +
      '- Ask admins to review a warning you think was a mistake ("appeal my warning"), or withdraw an ' +
      'appeal you filed\n' +
      '- Ask me for our community guidelines ("what are the rules here?")\n' +
      '- Answer questions from curated community knowledge — just ask\n' +
      '- Browse the topics our knowledge base covers, if you\'re not sure what to ask ("what do you know about?")\n' +
      '- Ask what\'s most relied on in our knowledge base ("what does the community find most useful?")\n' +
      "- Search our knowledge base using your own published interests as the query, once you've set " +
      'them ("find things related to what I\'m into")\n' +
      '- Search back through your own past messages for something said earlier\n' +
      "- Check what I've stored about you, your active warnings, or your filed suggestions/reports\n" +
      '- Catch you up on recent activity in this conversation ("what did I miss?")\n' +
      '- Suggest how the bot or community could be better, or withdraw an improvement suggestion you filed, ' +
      'or suggest a knowledge-base tip for other members to find later, or withdraw one before an admin ' +
      'reviews it\n' +
      '- Rate my last answer helpful or not\n' +
      '- Ask to talk to a human community admin, if I\'m not getting you anywhere ("can I talk to a ' +
      'human?")\n' +
      '- Ask me to explain things more simply, or reply in te reo Māori ("keep it simple")\n' +
      '- React to a message with an emoji instead of replying\n' +
      '- Ask if a Claude/API problem is a known Anthropic outage, not your bug\n' +
      '- Ask what meetups/events are coming up ("what\'s on?")\n' +
      '- Share a project you\'ve built with the community, or browse what others have shared ("share my ' +
      'project", "what has everyone built?")\n' +
      "- Ask to connect with a project owner who's looking for collaborators (\"I'd like to help with that " +
      'project")\n' +
      '- Publish your own interests so other members can find you, or find members into a topic ("add me to ' +
      'who\'s into RAG", "who\'s working on Discord bots?")\n' +
      '- Ask if someone in the community can help with something you\'re stuck on ("can someone help with ' +
      'X?"), or opt in/out of being notified for other members\' requests\n' +
      '- Pull the community digest on demand\n' +
      "- Record decisions in a project you're part of and search that project's shared memory later, or " +
      'list your projects\n' +
      '- Erase all your stored data any time ("forget me")',
    language: {
      mi:
        'NZ Claude Community — he rōpū o Aotearoa e hanga ana ki a Claude me te Anthropic API. ' +
        'Anei ngā mea ka taea e koe te tono mai ki ahau:\n' +
        '- Tohu i te whakatoihara, te para, te takahi tikanga rānei ki ngā kaiwhakahaere ("report this"), ' +
        'tango rānei i tētahi i tukuna pōhēhē\n' +
        '- Tono ki ngā kaiwhakahaere kia arotake i tētahi whakatūpato e whakaaro ana koe he pōhēhē ' +
        '("appeal my warning"), tango rānei i tētahi pīra i tukuna e koe\n' +
        '- Pātai mai i ā mātou tikanga hapori ("what are the rules here?")\n' +
        '- Whakautu pātai mai i te mōhiotanga hapori kua whiriwhiria — pātai noa mai\n' +
        '- Tirotiro i ngā kaupapa e kapi ana e tō mātou pātengi mōhiotanga, mehemea kāore koe e mōhio he aha ' +
        'te pātai ("what do you know about?")\n' +
        '- Pātai he aha kei roto i tō mātou pātengi mōhiotanga e tino whakamahia ana e te hapori ("what does ' +
        'the community find most useful?")\n' +
        '- Rapu i tō mātou pātengi mōhiotanga mā ō hiahia kua whakaputaina hei kupu rapu, ina kua ' +
        'whakaritea kētia e koe ("find things related to what I\'m into")\n' +
        '- Rapu whakamuri i āu karere o mua mō tētahi mea i kīa i mua\n' +
        '- Tirohia he aha kua rongoātia e ahau mōu, ō whakatūpato e mahi tonu ana, ō tono/pūrongo rānei kua ' +
        'tukuna\n' +
        '- Whakahōtaka i a koe mō ngā mahi hōu i tēnei kōrerorero ("what did I miss?")\n' +
        '- Tuku whakaaro mō te pai ake o te pouaka, o te hapori rānei, tango rānei i tētahi taunakitanga kua ' +
        'tukuna e koe, tuku whakaaro mō tētahi taunakitanga mō te pātengi mōhiotanga hei kitenga mā ētahi atu ' +
        'mema, tango rānei i tētahi i mua i te arotakenga a te kaiwhakahaere\n' +
        '- Tohu i tāku whakautu whakamutunga he āwhina, kāore rānei\n' +
        '- Tono ki te kōrero ki tētahi kaiwhakahaere tangata, mehemea kāore au e āwhina ana i a koe ("can I ' +
        'talk to a human?")\n' +
        '- Tono ki ahau kia whakamāramatia ngā mea kia ngāwari ake, whakahoki mai rānei i te reo Māori ' +
        '("keep it simple")\n' +
        '- Tohu karere mā te emoji, kaua e whakahoki kōrero\n' +
        '- Pātai mehemea he raru mōhiotia nā Anthropic tā Claude/API raru, ehara i te hapa nāu\n' +
        '- Pātai he aha ngā hui/kaupapa e haere ake nei ("what\'s on?")\n' +
        '- Tohatoha i tētahi kaupapa i hangaia e koe ki te hapori, tirotiro rānei i ngā mea kua tohaina e ' +
        'ētahi atu ("share my project", "what has everyone built?")\n' +
        '- Tono kia hono ki te kaipupuri kaupapa e rapu hoa mahi ana ("I\'d like to help with that ' +
        'project")\n' +
        '- Whakaputa i ō ake hiahia kia kitea koe e ētahi atu mema, rapu rānei i ngā mema e pā ana ki ' +
        'tētahi kaupapa ("add me to who\'s into RAG", "who\'s working on Discord bots?")\n' +
        '- Pātai mehemea ka taea e tētahi o te hapori te āwhina i a koe ki tētahi mea e raru ana koe ("can ' +
        'someone help with X?"), whakauru rānei/waiho rānei kia kaua e whakamōhiotia mō ngā tono a ētahi ' +
        'atu mema\n' +
        '- Tiki i te whakarāpopototanga hapori ā-tono\n' +
        '- Tuhi whakatau i roto i tētahi kaupapa e uru ana koe, rapu anō i ngā mahara tiritahi o taua ' +
        'kaupapa ā muri ake, rārangi rānei i ō kaupapa\n' +
        '- Muku i katoa āu raraunga kua rongoātia i ngā wā katoa ("forget me")',
    },
  },
  /**
   * The Agent Skills discoverability line appended to `community_info`/
   * `/help`/`!help`'s member segment (issue #1116) — `formatCommunityInfoText`
   * (`info.ts`) appends this to `memberSegment` only when
   * `config.agentSkills.enabled` is true, mirroring the existing
   * `whatsappTextCommands` conditional-append shape exactly (same file, same
   * function, same pattern, different flag). Deliberately generic/
   * example-driven rather than an enumerated skill list, so it never needs
   * editing as `ENABLED_SKILLS` (`agent/enabledSkills.ts`) changes — the same
   * drift `feature_flags`' old hardcoded label hit (#941). No `style` variant,
   * matching `communityInfoMemberCapabilities`'s own scope.
   */
  communityInfoSkillsCapabilities: {
    base:
      'Ask for a deeper, guided walkthrough on things like reviewing a prompt, designing a RAG pipeline, or ' +
      "debugging an API error — just describe what you're stuck on",
    language: {
      mi:
        'Pātai mai mō tētahi arahanga hōhonu, kua arahina, mō ētahi mea pēnei i te arotake i tētahi tono ' +
        '(prompt), te hoahoa i tētahi paipa RAG, te whakatikatika rānei i tētahi hapa API — whakaahuatia noa ' +
        'tō raru',
    },
  },
  /**
   * The admin-tier segment of `community_info`/`/help`/`!help`'s capability
   * rundown (issue #1056) — `base` moved VERBATIM from the old
   * `ADMIN_CAPABILITIES_TEXT` constant in info.ts (byte-neutral relocation,
   * same discipline `communityInfoMemberCapabilities` used for #1028), plus a
   * fresh `mi` translation. Closes the mid-message language mix #1028 itself
   * introduced: before this entry existed, an admin/super-admin caller with a
   * standing `'mi'` preference got a te reo member segment immediately
   * followed by an untranslated English admin segment.
   */
  communityInfoAdminCapabilities: {
    base:
      'As an admin, you also have:\n' +
      "- Moderate the community: warn, mute, kick, or remove a message, clear a member's warnings, archive a Discord thread, review the moderation history log, pull one member's full warning history, list everyone who's currently muted, list who's currently blocked on WhatsApp, review and resolve filed appeals, remove a project from the community showcase, or clear a member's published interests\n" +
      "- Manage membership: add a new member, remove a member, link a member's cross-platform identity, or unlink a member's cross-platform identity\n" +
      '- Review flagged content reports and resolve each report, review suggestions members submit and resolve each suggestion, see how members rated my answers, check which knowledge entries are rated poorly, and review recurring unhelpful-answer themes across all answers\n' +
      '- Post to the community: make an announcement, create a poll or end one poll early, open a Discord thread, or schedule/cancel an event\n' +
      "- Curate the knowledge base: save a new knowledge entry, browse knowledge entries, semantically find a knowledge entry's id by what it says, edit a knowledge entry, delete a knowledge entry, or merge two entries together, check for near-duplicate entries or conflicting entries, rank entries by how often they're retrieved, or force an immediate reachability re-check of a knowledge entry's citation\n" +
      "- Review knowledge candidates, accept a candidate or decline a candidate, track knowledge gaps (questions I couldn't answer), recurring question clusters, raw context digests, pull your own admin-digest snapshot on demand, get a review-queue roll-up of all five review queues at once, or check how quickly I've been answering members (response latency)\n" +
      '- See who is waiting for access, decline a pending access request without granting it, or see who ' +
      'has joined or left the server\n' +
      "- Add a note about a member, review notes on a member, delete a note, or look up a member's history across conversations\n" +
      '- Set the community guidelines or the welcome message shown to new members\n' +
      '- Assign a Discord role, remove a Discord role, or list which roles are available to assign\n' +
      "- Set up team projects: create one, give a member access, take a member's access away, allow or " +
      'stop it being discussed here, review who has access, or archive a finished project and bring it ' +
      'back again, or batch-create a whole team (project, roster, and this channel) in one confirmed call\n' +
      '- Generate an image, read a web page from an allowlisted host, or check recent changes to the ' +
      'bot and community (the changelog)',
    language: {
      mi:
        'I a koe e noho kaiwhakahaere ana, kei a koe hoki:\n' +
        '- Whakahaere i te hapori: whakatūpato, aukati mō tētahi wā (mute), pana, tango karere rānei, ' +
        'ūkui i ngā whakatūpato o tētahi mema, pupuri i tētahi kōrero (thread) Discord, arotake i te ' +
        'pukapuka hītori whakahaere, tiki i te hītori whakatūpato katoa o tētahi mema, whakarārangi i te ' +
        'hunga e aukatia ana ināianei, whakarārangi i te hunga kua ārairia i runga i WhatsApp ināianei, ' +
        'arotake me te whakatau rānei i ngā pīra (appeal) kua tukuna, tango rānei i tētahi kaupapa mai i te ' +
        'whakaaturanga kaupapa a te hapori, ūkui rānei i ngā hiahia kua whakaputaina e tētahi mema\n' +
        '- Whakahaere i te whakaurunga mema: tāpiri mema hōu, tango mema, hono i te tuakiri-ā-papa-rārangi-' +
        'maha o tētahi mema, wetewete rānei i taua hononga\n' +
        '- Arotake i ngā pūrongo tohu tuhinga kua tukuna, ā, whakatau i ia pūrongo, arotake i ngā ' +
        'taunakitanga kua tukuna e ngā mema, ā, whakatau i ia taunakitanga, tiro i te pehea o te whakatau ' +
        'a ngā mema mō aku whakautu, tirotiro i ngā whakaurunga mōhiotanga e iti ana te whakatau, ā, ' +
        'arotake i ngā kaupapa e hoki mai tonu ana mō ngā whakautu kāore i āwhina\n' +
        '- Tuku pānui ki te hapori: hanga pānui, hanga pōti (poll) rānei, whakamutu wawe i tētahi pōti, ' +
        'tuwhera i tētahi kōrero (thread) Discord, whakarite/whakakore rānei i tētahi hui\n' +
        '- Tiaki i te pātengi mōhiotanga: tiaki whakaurunga hōu, tirotiro whakaurunga, kimi-a-tikanga ' +
        '(semantic search) i te tuhinga ID o tētahi whakaurunga mā tāna kōrero, whakatika i tētahi ' +
        'whakaurunga, muku i tētahi whakaurunga, kōpui rānei i ētahi whakaurunga e rua, tirotiro mō ngā ' +
        'whakaurunga rite tonu, whakatau taupatupatu rānei, tātari rānei i ngā whakaurunga e ai ki te maha ' +
        'o ā rātou tikinga, whakatinanahia rānei ināianei tonu tētahi arotake mō te taea o te tohutoro a ' +
        'tētahi whakaurunga\n' +
        '- Arotake i ngā kaupapa mōhiotanga tūmataiti, whakaae rānei whakakore i tētahi, whāia ngā āputa ' +
        'mōhiotanga (ngā pātai kāore au i taea te whakautu), ngā kāhui pātai e hoki mai tonu ana, ngā ' +
        'rīpoata horopaki mata, tiki i tō ake whārangi whakarāpopototanga ā-kaiwhakahaere i ngā wā katoa e ' +
        'hiahiatia ana, whiwhi i te whakarāpopototanga o ngā ratonga arotake e rima katoa i te wā kotahi, ' +
        'tirotiro rānei i te tere o aku whakautu ki ngā mema (wā tatari)\n' +
        '- Tiro i te hunga e tatari ana mō te urunga, whakakore i tētahi tono urunga kāore e whakaaehia ana, ' +
        'tiro rānei i te hunga kua uru mai, kua wehe rānei i te tūmau\n' +
        '- Tāpiri i tētahi tuhinga mō tētahi mema, arotake i ngā tuhinga mō tētahi mema, muku i tētahi ' +
        'tuhinga, rapu rānei i te hītori o tētahi mema puta noa i ngā kōrerorero\n' +
        '- Whakarite i ngā tikanga hapori, i te karere pōwhiri rānei e whakaatuhia ana ki ngā mema hōu\n' +
        '- Tuku tūranga (role) Discord, tango tūranga Discord, whakarārangi rānei i ngā tūranga e wātea ana ' +
        'mō te tuku\n' +
        '- Whakarite kaupapa mō te tīma: hanga i tētahi, tuku urunga ki tētahi mema, tango i te urunga a ' +
        'tētahi mema, whakaae kia kōrerohia i konei, kāti rānei i tērā, arotake i te hunga whai urunga, ' +
        'whakahoki mai rānei i tētahi kaupapa kua mutu, kua oti rānei, tae atu ki te hanga pukuhohe i tētahi ' +
        'tīma katoa (kaupapa, rārangi ingoa, me tēnei ipurangi kōrero) i roto i te tono whakaū kotahi\n' +
        '- Hanga whakaahua, pānui i tētahi whārangi ipurangi nō roto i te rārangi whitinga (allowlist), ' +
        'tirotiro rānei i ngā panonitanga hōu ki te pouaka me te hapori (te rārangi panonitanga)',
    },
  },
  /**
   * The super-admin-tier segment of `community_info`/`/help`/`!help`'s
   * capability rundown (issue #1056), sibling to
   * `communityInfoAdminCapabilities` above — `base` moved VERBATIM from the
   * old `SUPER_ADMIN_CAPABILITIES_TEXT` constant in info.ts, plus a fresh
   * `mi` translation.
   */
  communityInfoSuperAdminCapabilities: {
    base:
      'As a super admin, you also have:\n' +
      '- Grant or revoke admin status for a member\n' +
      '- Pause or resume the bot, view audit logs, review admin activity, list current admins, ' +
      'or check usage/engagement stats\n' +
      '- Erase all of a user\'s stored data on request ("purge their data")\n' +
      '- Change bot-wide policy settings, or trigger a redeploy of the bot\n' +
      '- See which optional feature flags are currently on or off\n' +
      '- File a GitHub issue suggesting an improvement\n' +
      '- Dispatch a remote dev-team job to assess or deliver a change, check its status, fetch its result, ' +
      "turn a completed assessment into a tracked backlog, list an assessment's findings, or re-check one finding",
    language: {
      mi:
        'I a koe e noho kaiwhakahaere matua (super admin) ana, kei a koe hoki:\n' +
        '- Tuku, tango rānei i te tūnga kaiwhakahaere mō tētahi mema\n' +
        '- Whakatārewa, whakahoki anō rānei i te pouaka, tiro i ngā pukapuka arotake (audit log), arotake ' +
        'i ngā mahi a ngā kaiwhakahaere, whakarārangi i ngā kaiwhakahaere o nāianei, tirotiro rānei i ngā ' +
        'tatauranga whakamahi/whakaurunga\n' +
        '- Muku i katoa ngā raraunga kua rongoātia mō tētahi kaiwhakamahi, i runga i te tono ("purge their ' +
        'data")\n' +
        '- Whakarerekē i ngā tautuhinga kaupapahere o te pouaka whānui, whakaoho rānei i te whakatū anō ' +
        '(redeploy) o te pouaka\n' +
        '- Tiro he aha ngā haki (feature flags) kōwhiringa e mahi ana, kāore rānei, i tēnei wā\n' +
        '- Tuku pūrongo (issue) ki GitHub e whakaaro ana mō tētahi whakapainga\n' +
        '- Tuku mahi ki te tīma whanaketanga mamao hei arotake, hei tuku rānei i tētahi panonitanga, ' +
        'tirotiro i tōna tūnga, tiki i tōna hua, huri i tētahi arotake kua oti hei rārangi mahi e whāia ' +
        'ana, whakarārangi i ngā kitenga o tētahi arotake, tirotiro anō rānei i tētahi kitenga',
    },
  },
  // --- community_info WhatsApp `!`-shortcuts discovery block (agent/tools/info.ts) ---
  /**
   * The WhatsApp-only `!`-shortcuts discovery block appended to the member
   * capabilities segment above (issue #872) — `base` moved VERBATIM from the
   * old `WHATSAPP_TEXT_COMMANDS_TEXT` constant in info.ts, so this is a
   * byte-neutral relocation, not a rewrite (issue #1034, the follow-up
   * `communityInfoMemberCapabilities`'s own doc comment named as scoped
   * out). The `!`-prefixed command tokens stay literal/untranslated in the
   * `mi` variant — `commands.ts`'s regexes match those exact ASCII strings.
   * No `style` variant, matching `communityInfoMemberCapabilities`'s own
   * scope. Never interpolates caller or message data — same trust level as
   * the member capabilities notice above. `!kbtopics` (issue #1036) was
   * added to both variants by issue #1044/#1034, closing a gap where it
   * shipped without ever being added to this list. `!kbhelpful` (issue
   * #1087) was added to both variants in the SAME PR as the command itself,
   * precisely to avoid repeating that gap.
   */
  whatsappTextCommands: {
    base:
      "You're on WhatsApp, so you can also use these zero-wait shortcuts:\n" +
      '- `!whois <topic>` — find members into a topic\n' +
      '- `!projects [query]` — browse the project showcase\n' +
      '- `!guidelines` — community guidelines\n' +
      "- `!digest` — this week's digest\n" +
      '- `!status` — check for a known Anthropic outage\n' +
      '- `!kbtopics` — browse what the knowledge base covers\n' +
      '- `!kbhelpful` — see the most relied-on knowledge entries\n' +
      '- `!warnings` — your own active warning count\n' +
      '- `!mysubmissions` — status of your filed suggestions/reports\n' +
      '- `!mydata` — what the bot has stored about you\n' +
      '- `!help` — this capability rundown',
    language: {
      mi:
        'Kei runga koe i WhatsApp, nō reira ka taea hoki e koe te whakamahi i ēnei pokatata tere:\n' +
        '- `!whois <topic>` — rapu mema e pā ana ki tētahi kaupapa\n' +
        '- `!projects [query]` — tirotiro i te whakaaturanga kaupapa\n' +
        '- `!guidelines` — ngā tikanga hapori\n' +
        '- `!digest` — te whakarāpopototanga o tēnei wiki\n' +
        '- `!status` — tirotiro mehemea he raru mōhiotia nā Anthropic\n' +
        '- `!kbtopics` — tirotiro i ngā kaupapa e kapi ana e te pātengi mōhiotanga\n' +
        '- `!kbhelpful` — tiro i ngā mōhiotanga e whakawhirinaki nuitia ana\n' +
        '- `!warnings` — te tatau o ō whakatūpato e mahi tonu ana\n' +
        '- `!mysubmissions` — te āhua o ō tono/pūrongo kua tukuna\n' +
        '- `!mydata` — he aha kua rongoātia e ahau mōu\n' +
        '- `!help` — tēnei whakarāpopototanga pūkenga',
    },
  },
  /**
   * The admin-tier sibling of `whatsappTextCommands` above (issue #1097) —
   * `!reviewqueue` (issue #1095) is the first admin-tier `!`-shortcut, and
   * the member-only block above is unconditionally shown to every member+
   * caller, so it can never carry an admin-only entry without advertising a
   * command a plain member would be silently refused. `formatCommunityInfoText`
   * appends this only in the WhatsApp `admin`/`super_admin` branches, directly
   * after `communityInfoAdminCapabilities` — never to `memberSegment`. No
   * intro sentence: the member block above (already shown first to every
   * admin/super-admin caller on WhatsApp) carries the "zero-wait shortcuts"
   * framing once; this is just the one additional bullet. The `!`-prefixed
   * token stays literal/untranslated in the `mi` variant, matching the
   * sibling block's convention. No `style` variant, matching
   * `whatsappTextCommands`'s own scope. `!mutedlist` (issue #1114) is the
   * second admin-tier shortcut, appended here in the SAME diff that shipped
   * it — the discovery gap #1097 had to file separately after `!reviewqueue`
   * itself shipped without a line here. `!blockedlist` (issue #1145) is the
   * third, appended in the SAME diff that shipped it for the same reason.
   * `!topknowledge` (issue #1165) is the fourth, appended in the SAME diff
   * for the same reason. `!admindigest` (issue #1194) is the fifth,
   * appended in the SAME diff that shipped it, for the same reason.
   */
  whatsappAdminTextCommands: {
    base:
      '- `!reviewqueue` — access-request/suggestion/knowledge-candidate/appeal backlog at a glance\n' +
      '- `!mutedlist` — currently muted members, by identity\n' +
      '- `!blockedlist` — currently blocked users, by identity\n' +
      '- `!topknowledge` — knowledge entries ranked by retrieval count, most relied-on first\n' +
      '- `!admindigest` — your own admin-digest snapshot, on demand',
    language: {
      mi:
        '- `!reviewqueue` — te whakarāpopototanga o ngā ratonga arotake e rima i te tirohanga kotahi\n' +
        '- `!mutedlist` — ngā mema kua whakarahua i tēnei wā, mā te tuakiri\n' +
        '- `!blockedlist` — ngā kaiwhakamahi kua ārairia i tēnei wā, mā te tuakiri\n' +
        '- `!topknowledge` — ngā whiwhinga mōhiotanga kua raupapatia mā te tatauranga tikiake, ko te mea ' +
        'whakawhirinaki nuitia i mua\n' +
        '- `!admindigest` — tō ake whakarāpopototanga whakahaere, i te wā e hiahiatia ana',
    },
  },
  /**
   * The super-admin-tier sibling of `whatsappAdminTextCommands` above (issue
   * #1204) — `!featureflags` (issue #1183) is the first `super_admin`-floor
   * `!`-shortcut, and `whatsappAdminTextCommands` is shown to plain `admin`
   * callers too, so it can never carry a super-admin-only entry without
   * advertising a command a plain admin cannot use and gets silently refused
   * for (`atLeast(role, 'super_admin')`, `commands.ts`). `formatCommunityInfoText`
   * appends this only in the WhatsApp `super_admin` branch, directly after
   * `communityInfoSuperAdminCapabilities` — never to `memberSegment` or the
   * `admin` branch. No intro sentence, same reasoning as
   * `whatsappAdminTextCommands`: the member block (already shown first to
   * every super-admin caller on WhatsApp) carries the "zero-wait shortcuts"
   * framing once. The `!`-prefixed token stays literal/untranslated in the
   * `mi` variant, matching the sibling blocks' convention. No `style`
   * variant, matching `whatsappAdminTextCommands`'s own scope. English text
   * mirrors `communityInfoSuperAdminCapabilities`'s own "See which optional
   * feature flags are currently on or off" bullet. `!adminlist` (issue
   * #1218) is the second `super_admin`-floor shortcut, appended here in the
   * SAME diff that shipped it, same reasoning as `!mutedlist`'s own
   * same-diff addition to `whatsappAdminTextCommands` above.
   */
  whatsappSuperAdminTextCommands: {
    base:
      '- `!featureflags` — which optional feature flags are currently on or off\n' +
      '- `!adminlist` — who currently holds bot-admin privilege, by identity',
    language: {
      mi:
        '- `!featureflags` — he aha ngā haki (feature flags) kōwhiringa e mahi ana, kāore rānei, i tēnei wā\n' +
        '- `!adminlist` — ko wai kei a ia te mana whakahaere pi, mā te tuakiri',
    },
  },
  // --- member digest section labels (memberDigest.ts) ----------------------
  /**
   * The fixed label/frame fragments behind `formatMemberDigestMessage`'s six
   * sections (issue #1042) — the last per-caller digest pull surface left
   * without `mi` awareness (`community_digest`/`/digest`/`!digest`; the
   * weekly scheduled channel push stays English-only on purpose, since it has
   * no single reader whose preference should win). Every interpolated count,
   * title list, comma-join and English singular/plural choice stays exactly
   * where it already lived in `memberDigest.ts` — these entries carry only
   * the static wording around them, mirroring `communityInfoMemberCapabilities`'s
   * own base-moved-verbatim, mi-added-fresh shape. `memberDigestKnowledgeHeading`
   * is a template so its own "(N): " frame renders byte-identical to the
   * pre-#1042 literal; the other project/interests/connections lines are
   * full-sentence templates (same shape as `warnDm`/`codeTruncatedNote`
   * above) because te reo Māori needs no singular/plural inflection, so the
   * mi variant needs no equivalent to the English ternary.
   */
  memberDigestTopicsHeading: {
    base: "📅 This week's topics:",
    language: { mi: '📅 Ngā kaupapa o tēnei wiki:' },
  },
  memberDigestKnowledgeHeading: {
    base: (count: number) => `📚 New in the knowledge base (${count}): `,
    language: {
      mi: (count: number) => `📚 Ngā mea hōu i te pātengi mōhiotanga (${count}): `,
    },
  },
  memberDigestProjectShowcase: {
    base: (count: number) =>
      `🚀 ${count} new project${count === 1 ? '' : 's'} added to the showcase this week — ask me to show the project showcase to browse.`,
    language: {
      mi: (count: number) =>
        `🚀 ${count} kaupapa hōu kua tāpirihia ki te whakaaturanga kaupapa i tēnei wiki — pātai mai kia whakaaturia te whakaaturanga kaupapa hei tirotiro.`,
    },
  },
  memberDigestPlatformUpdatesHeading: {
    base: '🆕 Anthropic platform updates this week:',
    language: { mi: '🆕 Ngā whakahoutanga o te pae Anthropic i tēnei wiki:' },
  },
  memberDigestInterestsUpdate: {
    base: (count: number) =>
      `🔍 ${count} member${count === 1 ? '' : 's'} published or updated their interests this week — ask me "who's into X?" to find them.`,
    language: {
      mi: (count: number) =>
        `🔍 ${count} mema kua whakaputa, kua whakahou rānei i ō rātou hiahia i tēnei wiki — pātai mai "ko wai kei te hiahia ki a X?" kia kitea ai rātou.`,
    },
  },
  memberDigestConnectionsUpdate: {
    base: (count: number) =>
      `🤝 ${count} member${count === 1 ? '' : 's'} connected with help or a collaborator this week.`,
    language: {
      mi: (count: number) => `🤝 ${count} mema kua hono ki tētahi āwhina, hoa mahi rānei i tēnei wiki.`,
    },
  },
  // --- project notes/recall (agent/tools/projectNotes.ts, issue #1141) ----
  //
  // The last member-tier tool family the `mi`-preference sweep had not yet
  // reached (#1030, #1077, #1105, #1107, #1119 covered every sibling). Mirrors
  // `formatListProjectsEmptyText`'s pattern in helpers.ts: fixed shell text
  // only, with at most a count or the already-validated project slug
  // interpolated — never caller-supplied free text (query/content/title/
  // referenceUrl). See the SECURITY test in tests/tools.test.ts.
  projectRecallEmpty: {
    base: 'Nothing in project memory matches that (or you have no project accessible here).',
    language: {
      mi: 'Kāore he mea i ngā mahara tiritahi o te kaupapa e ōrite ana ki tērā (kāore rānei he kaupapa e watea ana ki a koe i konei).',
    },
  },
  projectNoteInvalidProject: {
    base: 'No project by that name is accessible here.',
    language: {
      mi: 'Kāore he kaupapa e taua ingoa e watea ana i konei.',
    },
  },
  projectNoteRateLimited: {
    base: (limit: number) =>
      `You've already recorded ${limit} project notes in the last 24 hours. Try again later, or ask an ` +
      'admin if the team needs a higher limit.',
    language: {
      mi: (limit: number) =>
        `Kua tuhia kētia e koe ${limit} ngā tuhinga kaupapa i roto i ngā haora 24 kua hipa. Whakamātau anō ` +
        'ā muri ake, pātai rānei ki tētahi kaiwhakahaere mehemea e hiahiatia ana e te tīma tētahi tepe teitei ake.',
    },
  },
  projectNoteSaved: {
    base: (project: string) => `Recorded in ${project}.`,
    language: {
      mi: (project: string) => `Kua tuhia ki ${project}.`,
    },
  },
  projectListEmpty: {
    base: 'You have no project accessible in this conversation.',
    language: {
      mi: 'Kāore he kaupapa e watea ana ki a koe i roto i tēnei kōrero.',
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
  knowledgeConflictCaveat: {
    base: "some of these entries may disagree with each other — an admin hasn't reconciled them yet",
    language: {
      mi: 'tērā pea kāore ētahi o ēnei mōhiotanga e whakaae ana ki a rātou anō — kāore anō i whakatikahia e tētahi kaiwhakahaere',
    },
  },
  knowledgeSearchEmpty: {
    base:
      'No matching knowledge entries. If you find the answer, suggest_knowledge can save it for the ' +
      "next person, or if you'd like, I can loop in a human community admin instead.",
    language: {
      mi:
        'Kāore he mōhiohio e tau ana. Ki te kitea e koe te whakautu, mā te suggest_knowledge e tiaki mō ' +
        'te tangata e whai ake nei, ki te hiahia koe, ka taea e au te karanga i tētahi kaiwhakahaere ' +
        'ā-tangata hei āwhina.',
    },
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
