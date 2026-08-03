import type { AdapterPolicyText, AdapterTextPack } from '@swampratnz/agent-base/platforms/types.js';

/**
 * The community-owned adapter text packs (agent-base plan item 6, the
 * `textPacks` extension point): the fixed texts each adapter sends on its
 * own initiative — the join welcome and the manual `warn_user` DM shell.
 *
 * Every string here moved VERBATIM from the adapter that used to define it
 * as its constructor default. The adapters now take a pack as a REQUIRED
 * constructor parameter and `platforms/factories.ts` hands each one its pack,
 * so an adapter carries no community prose of its own and a different module
 * supplies a different pack without forking the adapter. Everything an
 * adapter builds from a pack still leaves through that adapter's own
 * `filtered()` send paths, so an injected pack gains no new egress path.
 *
 * The te reo Māori warn-DM variants (issue #618) ride in each pack's
 * `warnUserDmPrefixByLanguage` map: the `'mi'` axis is community-registered,
 * so the base `AdapterTextPack` contract names no locale of its own.
 */

/**
 * The stored-policy half of every pack (agent-base plan §Phase-2 Stage 4):
 * which `policies` keys the join welcome reads. Shared by all three packs —
 * the keys are community-owned, the composition is not, so the adapters take
 * these as injected reads instead of importing `storage/policies.ts`. The
 * `'mi'` mapping is the one place the locale axis is named; base only ever
 * passes the target's standing preference through.
 *
 * Resolved by dynamic import inside each reader, deliberately: a static
 * import would drag the policy store — and through it the repository barrel
 * and the config singleton — into this file's module graph, and this file is
 * a leaf that every adapter test imports at its own module scope, before it
 * has set up its dummy environment. The module is loaded once and cached by
 * the ESM loader, so this costs one already-resolved promise per welcome.
 */
const COMMUNITY_POLICY_TEXT: AdapterPolicyText = {
  welcomeMessage: async () => (await import('../storage/policies.js')).getWelcomeMessage(),
  welcomeMessageForLanguage: async (language) =>
    language === 'mi' ? (await import('../storage/policies.js')).getWelcomeMessageMi() : null,
  guidelines: async () => (await import('../storage/policies.js')).getCommunityGuidelines(),
};

// Fixed wrapper prefix for a manual warn_user DM (the admin's `reason` is
// appended verbatim, untranslated — same scope boundary as router.ts's
// FAILED_PREFIX_MI/DONE_PREFIX_MI). Reused as-is (no interpolation) for
// byte-for-byte backward compatibility with the pre-#618 inline template.
const DISCORD_WARN_USER_DM_PREFIX = '⚠️ Warning from NZ Claude Community moderators:';

// Fixed, human-authored te reo Māori variant of WARN_USER_DM_PREFIX (issue
// #618), served when the target has a standing 'mi' language_prefs row
// (getLanguagePreference, issue #189) — same `_MI` pattern moderator.ts's
// warnDmTextMi (#333) already established for auto-moderation's warn DM.
const DISCORD_WARN_USER_DM_PREFIX_MI = '⚠️ He whakatūpato nā ngā kaiwhakahaere o NZ Claude Community:';

export const WELCOME_MESSAGE =
  "Kia ora, welcome! 👋 This server's bot answers Claude/Anthropic questions and remembers context, " +
  'but it only replies to registered members. Ask an admin to add you, or just say hi to the bot here ' +
  'and an admin will see your request.';

// Selected instead of WELCOME_MESSAGE when config.rbac.accessMode.discord is
// 'open' (issue #351) — that mode already lets a guest message the bot with
// no admin approval (router.ts gates on this exact value), so the default
// text must say so rather than claim gating that isn't in effect. Generic
// and static like WELCOME_MESSAGE — no joiner-supplied data interpolated.
export const WELCOME_MESSAGE_OPEN =
  "Kia ora, welcome! 👋 This server's bot answers Claude/Anthropic questions and remembers context — " +
  'go ahead and message me any time, no admin approval needed. Ask me "what can you do?" any time for ' +
  'a quick rundown.';

/** The Discord adapter's pack — exactly the constants it used to default to. */
export const DISCORD_TEXT_PACK: AdapterTextPack = {
  welcomeMessage: WELCOME_MESSAGE,
  welcomeMessageOpen: WELCOME_MESSAGE_OPEN,
  warnUserDmPrefix: DISCORD_WARN_USER_DM_PREFIX,
  warnUserDmPrefixByLanguage: { mi: DISCORD_WARN_USER_DM_PREFIX_MI },
  policyText: COMMUNITY_POLICY_TEXT,
};

// Fixed wrapper prefix for a manual warn_user DM (the admin's `reason` is
// appended verbatim, untranslated). Byte-for-byte the pre-#618 inline
// template's wording (no "moderators" — same as the WhatsApp Cloud pack's
// wording, kept independent per-adapter rather than unified).
const BAILEYS_WARN_USER_DM_PREFIX = '⚠️ Warning from NZ Claude Community:';

// Fixed, human-authored te reo Māori variant of WARN_USER_DM_PREFIX (issue
// #618), served when the target has a standing 'mi' language_prefs row
// (getLanguagePreference, issue #189) — same `_MI` pattern moderator.ts's
// warnDmTextMi (#333) already established.
const BAILEYS_WARN_USER_DM_PREFIX_MI = '⚠️ He whakatūpato nā NZ Claude Community:';

// Generic and static — no @-mention or echo of the joiner, so a bulk add
// can't be turned into a mass-ping and no participant JID reaches the chat.
export const WHATSAPP_GROUP_WELCOME_MESSAGE =
  "Kia ora! 👋 This bot only replies to registered members. If you're new here, ask an admin in this group to add you as a member.";

// Selected instead of WHATSAPP_GROUP_WELCOME_MESSAGE when
// config.rbac.accessMode.whatsapp is 'open' (issue #351) — same
// generic/static, no-@-mention shape, adapted to state that no admin
// approval is needed in that mode.
export const WHATSAPP_GROUP_WELCOME_MESSAGE_OPEN =
  'Kia ora! 👋 This bot answers Claude/Anthropic questions and remembers context — go ahead and message ' +
  'me any time, no admin approval needed. Ask me "what can you do?" any time for a quick rundown.';

/** The Baileys adapter's pack — exactly the constants it used to default to. */
export const BAILEYS_TEXT_PACK: AdapterTextPack = {
  welcomeMessage: WHATSAPP_GROUP_WELCOME_MESSAGE,
  welcomeMessageOpen: WHATSAPP_GROUP_WELCOME_MESSAGE_OPEN,
  warnUserDmPrefix: BAILEYS_WARN_USER_DM_PREFIX,
  warnUserDmPrefixByLanguage: { mi: BAILEYS_WARN_USER_DM_PREFIX_MI },
  policyText: COMMUNITY_POLICY_TEXT,
};

// Fixed wrapper prefix for a manual warn_user DM (the admin's `reason` is
// appended verbatim, untranslated). Byte-for-byte the pre-#618 inline
// template's wording (no "moderators" — this platform's existing wording
// already differs from Discord's, kept as-is rather than unified).
const WHATSAPP_CLOUD_WARN_USER_DM_PREFIX = '⚠️ Warning from NZ Claude Community:';

// Fixed, human-authored te reo Māori variant of WARN_USER_DM_PREFIX (issue
// #618), served when the target has a standing 'mi' language_prefs row
// (getLanguagePreference, issue #189) — same `_MI` pattern moderator.ts's
// warnDmTextMi (#333) already established.
const WHATSAPP_CLOUD_WARN_USER_DM_PREFIX_MI = '⚠️ He whakatūpato nā NZ Claude Community:';

// Generic and static — no @-mention or echo of the sender, so nothing
// user-supplied (msg.name/msg.from) ever reaches the text. Mirrors
// WHATSAPP_GROUP_WELCOME_MESSAGE's shape, adapted for a 1:1 first contact.
export const WHATSAPP_CLOUD_WELCOME_MESSAGE =
  'Kia ora! 👋 Thanks for messaging the NZ Claude Community bot. I can help answer Claude/Anthropic ' +
  "questions here in our 1:1 chat. If you're new, an admin may need to register you as a member first.";

// Selected instead of WHATSAPP_CLOUD_WELCOME_MESSAGE when
// config.rbac.accessMode.whatsapp is 'open' (issue #351) — same
// generic/static, no-sender-data shape, adapted to state that no admin
// approval is needed in that mode.
export const WHATSAPP_CLOUD_WELCOME_MESSAGE_OPEN =
  'Kia ora! 👋 Thanks for messaging the NZ Claude Community bot. I can help answer Claude/Anthropic ' +
  'questions here in our 1:1 chat any time, no admin approval needed. Ask me "what can you do?" any ' +
  'time for a quick rundown.';

/** The WhatsApp Cloud adapter's pack — exactly the constants it used to default to. */
export const WHATSAPP_CLOUD_TEXT_PACK: AdapterTextPack = {
  welcomeMessage: WHATSAPP_CLOUD_WELCOME_MESSAGE,
  welcomeMessageOpen: WHATSAPP_CLOUD_WELCOME_MESSAGE_OPEN,
  warnUserDmPrefix: WHATSAPP_CLOUD_WARN_USER_DM_PREFIX,
  warnUserDmPrefixByLanguage: { mi: WHATSAPP_CLOUD_WARN_USER_DM_PREFIX_MI },
  policyText: COMMUNITY_POLICY_TEXT,
};
