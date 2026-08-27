import type { Platform, PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';
import { WindowClosedError } from '@swampratnz/agent-base/platforms/types.js';
import { KNOWN_PLATFORMS } from '@swampratnz/agent-base/platforms/registry.js';
import { atLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { resolveRole, superAdminIds } from '@swampratnz/agent-base/auth/roles.js';
import { config } from '@swampratnz/agent-base/config.js';
import { logger, hashId } from '@swampratnz/agent-base/logger.js';
import { queuePendingAlert, type AlertPriority } from '@swampratnz/agent-base/pendingAlertQueue.js';
import { manualWarnBlockedAlertText } from '@swampratnz/agent-base/moderation/moderator.js';
import { notice } from '../../strings/notices.js';
import {
  addWarning,
  countActiveWarnings,
  getLanguagePreference,
  getResponseStyle,
  isKnownMessage,
  listAdmins,
  type ResponseStyle,
} from '@swampratnz/agent-base/storage/repository.js';
import { getCommunityGuidelines, getCommunityGuidelinesMi } from '../../storage/policies.js';
import { truncateForEcho } from './helpers.js';

// Every registered platform, derived from the platform registry (agent-base
// plan item 9) — this used to be a hand-kept `['discord', 'whatsapp']` copy.
const ALL_PLATFORMS: readonly Platform[] = KNOWN_PLATFORMS;

/**
 * Shared per-recipient rejection handler for `notifySuperAdmins`/
 * `notifyAdmins` below (issue #602). A rejection that is SPECIFICALLY a
 * `WindowClosedError` — the WhatsApp Cloud adapter's "adapter connected, this
 * one recipient's 24h window is closed" failure — is queued via the
 * adapter's optional `queueForWindowReopen` instead of only logged and
 * dropped, so it's delivered once that exact recipient's own next inbound
 * message reopens their window (`cloudAdapter.ts`'s `onCloudMessage` /
 * `flushWindowReopenQueue`). Any other rejection (a Discord/Baileys send, or
 * a genuine non-recoverable Cloud API failure) falls through to today's
 * unchanged log-and-drop — this never widens what gets queued.
 *
 * `priority` is the alert's producer trust level, threaded from the caller so
 * the per-recipient window-reopen queue evicts by the same #545 rule as the
 * shared pending-alert queue: a member-reachable 'low' alert can never evict a
 * 'system' one (admin-action audit / escalation).
 */
function handleAdminAlertSendFailure(
  target: PlatformAdapter,
  id: string,
  platform: Platform,
  message: string,
  err: unknown,
  logLabel: string,
  priority: AlertPriority,
): void {
  if (err instanceof WindowClosedError && target.queueForWindowReopen) {
    target.queueForWindowReopen(id, message, priority);
    logger.warn({ id, platform }, `${logLabel}: recipient's window is closed, queued for reopen`);
    return;
  }
  logger.warn({ err, id, platform }, logLabel);
}

/**
 * Alerts every super admin on every platform, not just the one the triggering
 * event happened on (issue #288) — mirrors the loop-every-connected-adapter
 * pattern already used by `usageAlert.ts`'s `alertSuperAdmins` and
 * `router.ts`'s budget-check alert. `adapterFor` is the same per-platform
 * lookup `buildToolServer` already threads through for #157; a platform with
 * no registered or connected adapter is silently skipped, matching that
 * lookup's existing fallback behaviour. If NO platform has a connected
 * adapter, the alert is queued (shared with health.ts/backgroundJobs.ts —
 * see src/pendingAlertQueue.ts) instead of silently dropped, and flushed
 * through the first adapter to reconnect via health.ts's existing
 * flushPendingAlerts (issue #545).
 */
export async function notifySuperAdmins(
  adapterFor: (platform: Platform) => PlatformAdapter | undefined,
  message: string,
  excludeUserId: string,
  priority: AlertPriority,
): Promise<void> {
  const anyConnected = ALL_PLATFORMS.some((platform) => adapterFor(platform)?.isConnected());
  if (!anyConnected) {
    logger.warn(
      { message },
      'Super-admin alert could not be delivered live — no connected adapter; queued for flush on reconnect',
    );
    // notifySuperAdmins is reachable from member-tier tools (report_content,
    // appeal_moderation) at 'low', but also from the bot's own privileged-
    // action audit at 'system' — the caller-supplied priority decides eviction
    // so a 'low' alert never evicts a 'system' one from the shared queue (#545).
    queuePendingAlert(`🔔 ${message}`, priority);
    return;
  }
  for (const platform of ALL_PLATFORMS) {
    const target = adapterFor(platform);
    if (!target || !target.isConnected()) continue; // can't send through a dead/unregistered connection
    for (const id of superAdminIds(platform)) {
      if (id === excludeUserId) continue;
      const alertText = `🔔 ${message}`;
      target
        .sendDirectMessage(id, alertText)
        .catch((err) =>
          handleAdminAlertSendFailure(
            target,
            id,
            platform,
            alertText,
            err,
            'Super-admin alert failed',
            priority,
          ),
        );
    }
  }
}

/**
 * Real-time counterpart to `notifySuperAdmins` above (issue #479's admin
 * escalation), sourced from `listAdmins()` — every `community_users.role =
 * 'admin'` row guild-wide, the same recipient set the weekly digest already
 * uses — instead of `superAdminIds()`. Called directly from the router's
 * deterministic "yes"-confirmation intercept, never from a model-callable
 * tool: there is no new privileged data access here, only a change in WHEN an
 * admin sees data already visible via the digest. Best-effort throughout: a
 * `listAdmins()` failure or a single admin's DM failure is logged and never
 * prevents alerting the rest.
 *
 * If NO resolved admin (other than `excludeUserId`) has a connected adapter
 * (issue #625 — previously this silently finished having sent nothing), the
 * alert is queued with the resolved recipient set (minus `excludeUserId`)
 * via the shared pendingAlertQueue and flushed through the first adapter to
 * reconnect (`health.ts`'s `flushPendingAlerts`) — mirroring
 * `notifySuperAdmins`'s `anyConnected` shape above, but computed over the
 * *resolved admin list's* platforms rather than `ALL_PLATFORMS`, since this
 * function's audience is `listAdmins()`, not every platform's super admins.
 * If at least one OTHER resolved admin's adapter is connected, behaviour is
 * unchanged: the loop below still just skips any individually-disconnected
 * admin. Queued at `'low'` priority, not `'system'`: this function's only
 * caller is the router's member-facing escalation-confirmation intercept
 * (`ESCALATION_RATE_LIMIT_PER_HOUR`-gated, but still member-reachable), the
 * same reachability class `notifySuperAdmins`'s `'low'` exists for — a
 * `'system'` label here would let a member's escalation confirmations evict
 * genuine bot/health-originated alerts from the shared queue (issue #545's
 * priority-inversion class).
 */
export async function notifyAdmins(
  adapterFor: (platform: Platform) => PlatformAdapter | undefined,
  message: string,
  excludeUserId: string,
): Promise<void> {
  let admins: Awaited<ReturnType<typeof listAdmins>>;
  try {
    admins = await listAdmins();
  } catch (err) {
    logger.warn({ err }, 'listAdmins failed; escalation admin alert skipped');
    return;
  }
  if (admins.length === 0) return;
  // Excluding excludeUserId can empty the roster (e.g. a single-admin guild
  // where the escalating user is that admin) — nobody left to notify or
  // queue for, so bail out before anyConnected/queuePendingAlert see a
  // truthy-but-empty recipients array (which health.ts's flush would treat
  // as "deliver to nobody", wasting a queue slot forever).
  const recipients = admins.filter((admin) => admin.platformUserId !== excludeUserId);
  if (recipients.length === 0) return;
  const anyConnected = recipients.some((admin) => adapterFor(admin.platform)?.isConnected());
  if (!anyConnected) {
    logger.warn(
      { message },
      'Admin escalation alert could not be delivered live — no connected adapter; queued for flush on reconnect',
    );
    queuePendingAlert(
      `🔔 ${message}`,
      'low', // member-reachable via the router's escalation-confirmation intercept — see doc comment above
      recipients.map((admin) => ({ platform: admin.platform, platformUserId: admin.platformUserId })),
    );
    return;
  }
  for (const admin of recipients) {
    const target = adapterFor(admin.platform);
    if (!target || !target.isConnected()) continue; // can't send through a dead/unregistered connection
    const alertText = `🔔 ${message}`;
    target.sendDirectMessage(admin.platformUserId, alertText).catch((err) =>
      handleAdminAlertSendFailure(
        target,
        admin.platformUserId,
        admin.platform,
        alertText,
        err,
        'Admin alert failed',
        // Escalations (issue #479) are bot/router-originated, never
        // member-reachable — 'system', so they can't be evicted by a
        // member's queued report/appeal for the same recipient.
        'system',
      ),
    );
  }
}

// The approval-DM texts (English base, te reo Māori counterpart issue #331 —
// same `_MI` pattern as `community_guidelines`/#266 — and the plain-language
// counterpart issue #657) live in the strings catalogue
// (`strings/notices.ts` entries `memberApprovedMessage`/
// `adminApprovedMessage`), which also owns the 'mi'-over-'plain' selection
// precedence. Never a model translation, so there's no paraphrase/drift risk
// on a fixed confirmation string.

/**
 * Best-effort confirmation DM for a member grant. Fires only on an actual
 * transition into membership (`wasAlreadyMember` false) so re-running
 * `add_member` on an existing member/admin doesn't re-send it. A failed DM
 * (closed DMs, WhatsApp 24h window, etc.) is logged and swallowed — the
 * membership grant itself is the source of truth, never blocked on this.
 * Exported separately from the `add_member` tool so it's unit-testable
 * without the MCP tool-call transport. Honours the target's standing
 * `'mi'` language preference (issue #331, same `_MI` + `getLanguagePreference`
 * pattern as #266/#282/#300): the lookup is wrapped in its own `.catch` so a
 * DB hiccup degrades to the English default rather than throwing or
 * dropping the DM (issue #52's invariant, same shape as router.ts's
 * `getLangPref(...).catch(() => 'auto')`), distinct from the send's own
 * `.catch(logger.warn)` below.
 *
 * Returns `true` when the grant was already in place (nothing to attempt,
 * so no failure), the DM send resolved, or the send rejected specifically
 * with `WindowClosedError` and was queued via `queueForWindowReopen` (issue
 * #644 — treated as "handled, will still arrive," the same #602 rejection
 * class `handleAdminAlertSendFailure` above already recovers for admin
 * alerts, extended here to this member-facing DM); `false` when a DM was
 * attempted and the send threw/rejected for any OTHER reason (issue #556) —
 * `add_member` uses this to tell the acting admin the confirmation DM
 * didn't land, since today it can't.
 *
 * Issue #1171: this is the one grant-DM path #212 didn't reach, so a member
 * who is pre-registered or `team_setup`-batched — and therefore never
 * generates a join/first-contact event — otherwise never sees the community
 * guidelines anywhere. When guidelines are set, they're appended the same
 * way the join-welcome adapters already append them (`guidelinesHeading` +
 * the text, verbatim, never model-translated), `mi`-aware with the same
 * `getGuidelinesMi() ?? getGuidelines()` fallback `community_guidelines`
 * itself uses. The whole lookup is wrapped in one `.catch(() => null)` so a
 * DB hiccup degrades to "no guidelines appended" — same #52 invariant as the
 * language/style lookups above — rather than throwing out of this function
 * or blocking the DM.
 */
export async function notifyMemberApproved(
  adapter: PlatformAdapter,
  userId: string,
  wasAlreadyMember: boolean,
  platform: Platform,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
  getRespStyle: typeof getResponseStyle = getResponseStyle,
  getGuidelines: typeof getCommunityGuidelines = getCommunityGuidelines,
  getGuidelinesMi: typeof getCommunityGuidelinesMi = getCommunityGuidelinesMi,
): Promise<boolean> {
  if (wasAlreadyMember) return true;
  const lang = await getLangPref(platform, userId).catch(() => 'auto' as const);
  // Style is only consulted once 'mi' is ruled out (it takes precedence), same
  // nested-lookup shape router.ts uses at its own getRespStyle call sites
  // (issue #430) — no style DB read on the 'mi' path. Degrades to 'standard'
  // (English) on any lookup failure, same #52 invariant as the language
  // lookup above. Variant selection itself lives in strings/notices.ts.
  const style: ResponseStyle | undefined =
    lang === 'mi' ? undefined : await getRespStyle(platform, userId).catch(() => 'standard' as const);
  const baseMessage = notice('memberApprovedMessage', { language: lang, style });
  const guidelines = await (
    lang === 'mi' ? getGuidelinesMi().then((mi) => mi ?? getGuidelines()) : getGuidelines()
  ).catch(() => null);
  const message = guidelines
    ? `${baseMessage}\n\n${notice('guidelinesHeading')}\n${guidelines}`
    : baseMessage;
  return adapter
    .sendDirectMessage(userId, message)
    .then(() => true)
    .catch((err) => {
      if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
        adapter.queueForWindowReopen(userId, message, 'low');
        logger.warn({ userId, platform }, "Approval DM: recipient's window is closed, queued for reopen");
        return true;
      }
      logger.warn({ err, userId }, 'Approval DM failed');
      return false;
    });
}

/**
 * The `adminApprovedMessage` catalogue entry is static and templated
 * deliberately (issue #201): `displayName` reaches `grant_admin` as an
 * untrusted tool argument, so it must never be interpolated into the DM —
 * same no-interpolation shape as the `memberApprovedMessage` entry. It
 * points at community_info's existing admin-aware branch rather than
 * enumerating ADMIN_TOOLS inline, so there's one place to keep in sync.
 *
 * Best-effort orientation DM for an admin grant, mirroring notifyMemberApproved's
 * shape exactly: fires only on an actual transition into admin
 * (`wasAlreadyAdmin` false) so re-running `grant_admin` on an existing admin
 * doesn't re-send it, and a failed DM (closed DMs, WhatsApp 24h window, etc.)
 * is logged and swallowed — the grant itself is the source of truth, never
 * blocked on this. A `WindowClosedError` rejection is queued via
 * `queueForWindowReopen` at `'low'` priority instead of logged-and-dropped
 * (issue #1040 — the last function in the #644/#888/#922/#998
 * WindowClosedError-parity series for this file; any other rejection is
 * unaffected). Exported separately from the `grant_admin` tool so it's
 * unit-testable without the MCP tool-call transport. Honours the target's
 * standing `'mi'` language preference identically to `notifyMemberApproved`
 * above (issue #331).
 *
 * Returns `true`/`false` on the same terms as `notifyMemberApproved` above
 * (issue #556) — `grant_admin` uses this to tell the acting super admin the
 * promotion DM didn't land.
 */
export async function notifyAdminApproved(
  adapter: PlatformAdapter,
  userId: string,
  wasAlreadyAdmin: boolean,
  platform: Platform,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
  getRespStyle: typeof getResponseStyle = getResponseStyle,
): Promise<boolean> {
  if (wasAlreadyAdmin) return true;
  const lang = await getLangPref(platform, userId).catch(() => 'auto' as const);
  // Same nested getRespStyle shape as notifyMemberApproved above.
  const style: ResponseStyle | undefined =
    lang === 'mi' ? undefined : await getRespStyle(platform, userId).catch(() => 'standard' as const);
  const message = notice('adminApprovedMessage', { language: lang, style });
  return adapter
    .sendDirectMessage(userId, message)
    .then(() => true)
    .catch((err) => {
      if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
        adapter.queueForWindowReopen(userId, message, 'low');
        logger.warn(
          { userId, platform },
          "Admin promotion DM: recipient's window is closed, queued for reopen",
        );
        return true;
      }
      logger.warn({ err, userId }, 'Admin promotion DM failed');
      return false;
    });
}

/**
 * Best-effort decline DM for `decline_access_request` (issue #1126) — the
 * last member of the review-queue decline family (`resolve_suggestion`,
 * `resolve_report`, `resolve_appeal`, `decline_knowledge_candidate`) that
 * stayed silent toward the person whose row it resolved. Reaches a
 * not-yet-member guest directly by `(platform, userId)` via the adapter, the
 * same mechanism `notifyMemberApproved` above already proves in production
 * for the *approve* path on this identical pending row — fire-and-forget,
 * `.catch(logger.warn)`, never blocks or changes `decline_access_request`'s
 * own reported outcome. The base text is a static, translated catalogue
 * entry (`strings/notices.ts`'s `accessRequestDeclinedMessage`, same
 * static/templated shape as `memberApprovedMessage`/`adminApprovedMessage`
 * above) rather than the inline-ternary shape `notifySuggestionResolved`
 * below uses, because there is no per-row content to select wording by —
 * only a fixed neutral decline. `reason` is an optional, admin-authored,
 * one-line explanation appended via `truncateForEcho`, as a distinct
 * trailing clause, never interpolated into the translated base string —
 * same non-interpolation convention as every sibling's `adminReason`/
 * `reason` field. Omitted, the DM stays byte-identical to the reasonless
 * base text. Never persisted: the caller keeps it out of `audited()`'s
 * params, same as every sibling. Honours the requester's standing `'mi'`
 * language preference (issue #331), same degrade-to-`'auto'`-on-failure
 * shape as `notifyMemberApproved` above. A `WindowClosedError` rejection is
 * queued via `queueForWindowReopen` at `'low'` priority instead of
 * logged-and-dropped (issue #644, the same #602 recovery extended to every
 * sibling in this family); any other rejection is unaffected. Exported
 * separately so it's unit-testable without the MCP tool-call transport, same
 * convention as every sibling notify function in this file.
 */
export async function notifyAccessRequestDeclined(
  adapter: PlatformAdapter,
  userId: string,
  platform: Platform,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
  reason?: string,
): Promise<void> {
  const lang = await getLangPref(platform, userId).catch(() => 'auto' as const);
  const base = notice('accessRequestDeclinedMessage', { language: lang });
  const echoedReason = reason ? truncateForEcho(reason) : null;
  const message = echoedReason ? `${base} ${lang === 'mi' ? 'Take' : 'Reason'}: "${echoedReason}"` : base;
  await adapter.sendDirectMessage(userId, message).catch((err) => {
    if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
      adapter.queueForWindowReopen(userId, message, 'low');
      logger.warn(
        { userId: hashId(userId), platform },
        "Access request decline DM: recipient's window is closed, queued for reopen",
      );
      return;
    }
    logger.warn({ err, userId: hashId(userId) }, 'Access request decline DM failed');
  });
}

/**
 * Best-effort resolution DM to a project's original owner when an admin
 * removes it from the showcase via `remove_project` (issue #1185) — the
 * admin-moderation counterpart to `notifyAccessRequestDeclined`, same shape:
 * fire-and-forget, `.catch(logger.warn)`, never blocks or changes
 * `remove_project`'s own reported outcome. The base text is a static,
 * translated catalogue entry (`strings/notices.ts`'s `projectRemovedMessage`,
 * same static shape as `accessRequestDeclinedMessage`) rather than an
 * inline-ternary, since there is no per-row content to select wording by —
 * only a fixed neutral removal notice. Only called when the admin supplies a
 * `reason` (the tool handler skips this entirely when it's omitted, so
 * removal stays silent by default). `reason` is an admin-authored, one-line
 * explanation appended via `truncateForEcho`, as a distinct trailing clause,
 * never interpolated into the translated base string — same
 * non-interpolation convention as `notifyAccessRequestDeclined`'s `reason`.
 * Never persisted: the caller keeps it out of `audited()`'s params. Honours
 * the owner's standing `'mi'` language preference, same degrade-to-`'auto'`-
 * on-failure shape as every sibling in this file. A `WindowClosedError`
 * rejection is queued via `queueForWindowReopen` at `'low'` priority instead
 * of logged-and-dropped, same #644 recovery every sibling gets. Exported
 * separately so it's unit-testable without the MCP tool-call transport, same
 * convention as every sibling notify function in this file.
 */
export async function notifyProjectRemoved(
  adapter: PlatformAdapter,
  userId: string,
  platform: Platform,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
  reason?: string,
): Promise<void> {
  const lang = await getLangPref(platform, userId).catch(() => 'auto' as const);
  const base = notice('projectRemovedMessage', { language: lang });
  const echoedReason = reason ? truncateForEcho(reason) : null;
  const message = echoedReason ? `${base} ${lang === 'mi' ? 'Take' : 'Reason'}: "${echoedReason}"` : base;
  await adapter.sendDirectMessage(userId, message).catch((err) => {
    if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
      adapter.queueForWindowReopen(userId, message, 'low');
      logger.warn(
        { userId: hashId(userId), platform },
        "Project removal DM: recipient's window is closed, queued for reopen",
      );
      return;
    }
    logger.warn({ err, userId: hashId(userId) }, 'Project removal DM failed');
  });
}

/**
 * Best-effort confirmation DM to a member when their suggest_improvement
 * submission is resolved — closes the "suggestion box into the void" gap
 * (issue #116), mirroring notifyMemberApproved's shape exactly: fire-and-
 * forget, .catch(logger.warn), never blocks or changes resolve_suggestion's
 * own reported outcome. Exported separately so it's unit-testable without
 * the MCP tool-call transport, same convention as notifyMemberApproved.
 * Honours the submitter's standing `'mi'` language preference (issue #331,
 * same degrade-to-`'auto'`-on-failure shape as notifyMemberApproved above)
 * — the echoed suggestion text (`truncateForEcho`) stays untranslated user
 * content either way. A `WindowClosedError` rejection is queued via
 * `queueForWindowReopen` at `'low'` priority instead of logged-and-dropped
 * (issue #644 — the same #602 recovery `handleAdminAlertSendFailure` gives
 * admin alerts, extended to this member-facing DM); any other rejection is
 * unaffected. `adminReason` (issue #1099, mirroring `decline_knowledge_
 * candidate`'s #1050 field) is an optional, admin-authored, one-line
 * explanation appended via `truncateForEcho`, distinct from the echoed
 * suggestion content, on the `declined` branch only — supplied on any other
 * status it is ignored, and omitted entirely the message stays byte-
 * identical to before #1099. Never persisted: the caller keeps it out of
 * `audited()`'s params, same as #1050.
 */
export async function notifySuggestionResolved(
  adapter: PlatformAdapter,
  userId: string,
  status: 'reviewed' | 'declined' | 'done',
  content: string,
  platform: Platform,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
  adminReason?: string,
): Promise<void> {
  const echoed = truncateForEcho(content);
  const lang = await getLangPref(platform, userId).catch(() => 'auto' as const);
  const base =
    lang === 'mi'
      ? status === 'declined'
        ? `Ngā mihi mō tō whakaaro — i muri i te arotake, kāore e hangaia ā tōna wā: "${echoed}"`
        : status === 'done'
          ? `Kua oti tō whakaaro — ngā mihi mō tō koha! ("${echoed}")`
          : `Kua arotakehia tō whakaaro — ngā mihi mō tō koha! ("${echoed}")`
      : status === 'declined'
        ? `Thanks for the suggestion — after review it won't be built for now: "${echoed}"`
        : status === 'done'
          ? `Your suggestion has been marked **done** — thanks for the input! ("${echoed}")`
          : `Your suggestion has been reviewed — thanks for the input! ("${echoed}")`;
  const echoedReason = status === 'declined' && adminReason ? truncateForEcho(adminReason) : null;
  const message = echoedReason ? `${base} ${lang === 'mi' ? 'Take' : 'Reason'}: "${echoedReason}"` : base;
  await adapter.sendDirectMessage(userId, message).catch((err) => {
    if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
      adapter.queueForWindowReopen(userId, message, 'low');
      logger.warn(
        { userId: hashId(userId), platform },
        "Suggestion resolution DM: recipient's window is closed, queued for reopen",
      );
      return;
    }
    logger.warn({ err, userId: hashId(userId) }, 'Suggestion resolution DM failed');
  });
}

/**
 * Best-effort confirmation DM to a member when their report_content
 * submission is resolved — closes the same "shout into the void" gap
 * `notifySuggestionResolved` closed for suggestions (issue #120), same
 * fire-and-forget shape: `.catch(logger.warn)`, never blocks or changes
 * resolve_report's own reported outcome. The `dismissed` wording is
 * deliberately neutral-to-supportive rather than a bare "dismissed" — an
 * unsolicited DM telling someone their safety report was rejected must not
 * read as dismissive of the underlying concern, even when the triage
 * outcome itself is correct. Only echoes the reporter's own previously-
 * submitted reason (truncated) plus a status word — never the reported
 * user's identity or any other report's fields. Exported separately so it's
 * unit-testable without the MCP tool-call transport, same convention as
 * notifySuggestionResolved. Honours the reporter's standing `'mi'` language
 * preference (issue #331, same degrade-to-`'auto'`-on-failure shape as
 * notifyMemberApproved above) — the echoed reason (`truncateForEcho`) stays
 * untranslated user content either way, and the `mi` `dismissed` wording
 * stays just as neutral-to-supportive as the English original. A
 * `WindowClosedError` rejection is queued via `queueForWindowReopen` at
 * `'low'` priority instead of logged-and-dropped (issue #644, same #602
 * recovery extended to this member-facing DM); any other rejection is
 * unaffected. `adminReason` (issue #1099, mirroring `decline_knowledge_
 * candidate`'s #1050 field) is an optional, admin-authored, one-line
 * explanation appended via `truncateForEcho`, distinct from the echoed
 * reporter-filed reason, on the `dismissed` branch only — supplied on any
 * other status it is ignored, and omitted entirely the message stays
 * byte-identical to before #1099. Never persisted: the caller keeps it out
 * of `audited()`'s params, same as #1050.
 */
export async function notifyReportResolved(
  adapter: PlatformAdapter,
  userId: string,
  status: 'resolved' | 'dismissed',
  reason: string,
  platform: Platform,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
  adminReason?: string,
): Promise<void> {
  const echoed = truncateForEcho(reason);
  const lang = await getLangPref(platform, userId).catch(() => 'auto' as const);
  const base =
    lang === 'mi'
      ? status === 'dismissed'
        ? `Kua arotakehia tō pūrongo. I muri i te wātea, kāore he mahi anō i mahia — ngā mihi mō te whakamōhio mai: "${echoed}"`
        : `Kua arotakehia, kua whakatauhia hoki tō pūrongo — ngā mihi mō te whakamōhio mai: "${echoed}"`
      : status === 'dismissed'
        ? `Your report has been reviewed. After triage, no further action was taken — thanks for flagging it: "${echoed}"`
        : `Your report has been reviewed and resolved — thanks for flagging it: "${echoed}"`;
  const echoedReason = status === 'dismissed' && adminReason ? truncateForEcho(adminReason) : null;
  const message = echoedReason ? `${base} ${lang === 'mi' ? 'Take' : 'Reason'}: "${echoedReason}"` : base;
  await adapter.sendDirectMessage(userId, message).catch((err) => {
    if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
      adapter.queueForWindowReopen(userId, message, 'low');
      logger.warn(
        { userId: hashId(userId), platform },
        "Report resolution DM: recipient's window is closed, queued for reopen",
      );
      return;
    }
    logger.warn({ err, userId: hashId(userId) }, 'Report resolution DM failed');
  });
}

/**
 * Proactive super-admin alert fired the moment a report is filed, instead of
 * relying on an admin to remember to poll `list_reports` (issue #90) — reuses
 * `notifySuperAdmins`, the exact mechanism `audited()` already uses for every
 * other privileged-action alert. Not batched/debounced: unlike the usage/
 * disconnect alerts (which debounce a *persisting condition*), a report is a
 * discrete "someone needs help" event where the first one matters as much as
 * the tenth — the existing per-reporter rate cap already bounds volume.
 * Exposes no new data: the reporter/reason/target were already visible to
 * super admins via `list_reports`; this only changes when they're seen. The
 * reporter-supplied `reason` is quoted (`Reporter said: "..."`) so a crafted
 * reason can't cosmetically impersonate the 🔔 system-alert prefix to the
 * human reading it. Exported separately so it's unit-testable without the MCP
 * tool-call transport, same convention as notifyReportResolved.
 */
/**
 * Threshold (inclusive count) at which a repeated same-(reporter, target) DM
 * report pattern gets an extra warning line appended below — see
 * `recentSameTargetCount` on `notifyReportFiled` (issue #305).
 */
const REPEATED_DM_REPORT_TARGET_THRESHOLD = 3;

export async function notifyReportFiled(
  adapterFor: (platform: Platform) => PlatformAdapter | undefined,
  report: {
    id: number;
    reporterUserId: string;
    reporterName: string | null;
    conversationId: string;
    targetUserId?: string;
    messageId?: string;
    reason: string;
    /**
     * Count of DM reports (inclusive of this one) this reporter has filed
     * naming this same target within the trailing window — see
     * `countRecentDmReportsByReporterAndTarget` (issue #305). Only ever
     * computed by the caller for a DM report naming a known target; omitted
     * otherwise, in which case no extra line is appended.
     */
    recentSameTargetCount?: number;
  },
): Promise<void> {
  const lines = [
    `New report #${report.id} filed by ${report.reporterName ?? report.reporterUserId} in conversation ${report.conversationId}.`,
    `Reporter said: "${report.reason}"`,
  ];
  if (report.targetUserId) lines.push(`Target user: ${report.targetUserId}`);
  if (report.messageId) lines.push(`Message id: ${report.messageId}`);
  if (
    report.recentSameTargetCount !== undefined &&
    report.recentSameTargetCount >= REPEATED_DM_REPORT_TARGET_THRESHOLD
  ) {
    lines.push(
      `⚠️ This reporter has now named this same target in ${report.recentSameTargetCount} DM report(s) within ` +
        'the past 30 days. The accused-admin exclusion means that target may not have seen any of them — ' +
        'review with list_reports as super admin.',
    );
  }
  // 'low': report_content is a member-tier tool, so a queued report alert must
  // never evict a 'system' escalation/audit for the same window-closed recipient.
  await notifySuperAdmins(adapterFor, lines.join('\n'), report.reporterUserId, 'low');
}

/**
 * Best-effort super-admin alert when a reporter withdraws their own report(s)
 * (companion to `notifyReportFiled`). A withdrawal is surfaced, not silent, so
 * a withdrawn *serious* complaint doesn't just vanish unnoticed — e.g. if a
 * reporter were pressured into retracting one, super admins still see it and
 * can follow up. Exposes nothing beyond the report ids + the reporter already
 * visible via `list_reports`. Fire-and-forget (`void ... .catch`), never
 * blocks or changes the tool's own outcome. Exported for unit testing, same
 * convention as `notifyReportFiled`.
 */
export async function notifyReportWithdrawn(
  adapterFor: (platform: Platform) => PlatformAdapter | undefined,
  info: { ids: number[]; reporterUserId: string; reporterName: string | null },
): Promise<void> {
  const list = info.ids.map((id) => `#${id}`).join(', ');
  const plural = info.ids.length > 1;
  await notifySuperAdmins(
    adapterFor,
    `Report${plural ? 's' : ''} ${list} withdrawn by the reporter ${info.reporterName ?? info.reporterUserId}. ` +
      `Marked 'withdrawn' and kept on record — no action needed unless you want to check in.`,
    info.reporterUserId,
    'low', // member-reachable (a member withdrawing their own report)
  );
}

/**
 * Proactive super-admin alert fired when a member appeals their own active
 * moderation warning(s)/mute (issue #496) — reuses `notifySuperAdmins`, the
 * exact fan-out `notifyReportFiled`/`notifyReportWithdrawn` already use, per
 * the adversarial review's correction to stay within one PR (no new
 * conversation-scoped push helper). Exposes no new data: the caller's active
 * warning count is already readable by admins via `list_member_warnings`;
 * this only changes when it's proactively surfaced. Exported for unit
 * testing without the MCP tool-call transport, same convention as
 * notifyReportFiled/notifyReportWithdrawn.
 */
export async function notifyAppealFiled(
  adapterFor: (platform: Platform) => PlatformAdapter | undefined,
  appeal: {
    callerUserId: string;
    callerName: string | null;
    activeWarnings: number;
    strikeLimit: number;
    reason?: string;
  },
): Promise<void> {
  const lines = [
    `${appeal.callerName ?? appeal.callerUserId} is appealing their own moderation status ` +
      `(${appeal.activeWarnings}/${appeal.strikeLimit} active warnings).`,
    `Reason given: ${appeal.reason ? `"${appeal.reason}"` : 'no reason given'}`,
  ];
  // 'low': appeal_moderation is a member-tier tool.
  await notifySuperAdmins(adapterFor, lines.join('\n'), appeal.callerUserId, 'low');
}

/**
 * Best-effort confirmation DM to a member when their moderation appeal is
 * resolved — closes the gap #554 left open: `resolve_appeal` deliberately
 * never touches `member_warnings`/mute state, so without this the appellant
 * has no signal at all that their appeal was even looked at (issue #622).
 * Mirrors `notifyReportResolved`'s shape exactly: fire-and-forget,
 * `.catch(logger.warn)`, never blocks or changes `resolve_appeal`'s own
 * reported outcome, same neutral-to-supportive `dismissed` wording (a
 * dismissed appeal must not read as the bot being dismissive of the
 * underlying grievance). `reason` is nullable on `ModerationAppeal` (a
 * member can appeal without giving one) — echoed via `truncateForEcho` when
 * present, the quoted line omitted entirely otherwise. Exported separately
 * so it's unit-testable without the MCP tool-call transport, same
 * convention as `notifyReportResolved`. Honours the appellant's standing
 * `'mi'` language preference (issue #331), same degrade-to-`'auto'`-on-
 * failure shape. A `WindowClosedError` rejection is queued via
 * `queueForWindowReopen` at `'low'` priority instead of logged-and-dropped
 * (issue #644, same #602 recovery extended to this member-facing DM); any
 * other rejection is unaffected. `adminReason` (issue #1099, mirroring
 * `decline_knowledge_candidate`'s #1050 field) is an optional, admin-authored,
 * one-line explanation appended via `truncateForEcho`, distinct from the
 * echoed appellant-filed reason, on the `dismissed` branch only — supplied on
 * any other status it is ignored, and omitted entirely the message stays
 * byte-identical to before #1099. Never persisted: the caller keeps it out of
 * `audited()`'s params, same as #1050.
 */
export async function notifyAppealResolved(
  adapter: PlatformAdapter,
  userId: string,
  status: 'resolved' | 'dismissed',
  reason: string | null,
  platform: Platform,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
  adminReason?: string,
): Promise<void> {
  const echoed = reason ? truncateForEcho(reason) : null;
  const lang = await getLangPref(platform, userId).catch(() => 'auto' as const);
  const base =
    lang === 'mi'
      ? status === 'dismissed'
        ? `Kua arotakehia tō pīra. I muri i te wātea, kāore he mahi anō i mahia — ngā mihi mō tō whakamōhio mai.${echoed ? ` "${echoed}"` : ''}`
        : `Kua arotakehia, kua whakatauhia hoki tō pīra — ngā mihi mō tō whakamōhio mai.${echoed ? ` "${echoed}"` : ''}`
      : status === 'dismissed'
        ? `Your appeal has been reviewed. After triage, no further action was taken — thanks for reaching out.${echoed ? ` "${echoed}"` : ''}`
        : `Your appeal has been reviewed and resolved — thanks for reaching out.${echoed ? ` "${echoed}"` : ''}`;
  const echoedReason = status === 'dismissed' && adminReason ? truncateForEcho(adminReason) : null;
  const message = echoedReason ? `${base} ${lang === 'mi' ? 'Take' : 'Reason'}: "${echoedReason}"` : base;
  await adapter.sendDirectMessage(userId, message).catch((err) => {
    if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
      adapter.queueForWindowReopen(userId, message, 'low');
      logger.warn(
        { userId: hashId(userId), platform },
        "Appeal resolution DM: recipient's window is closed, queued for reopen",
      );
      return;
    }
    logger.warn({ err, userId: hashId(userId) }, 'Appeal resolution DM failed');
  });
}

/**
 * Best-effort confirmation DM to a member when their `suggest_knowledge` tip
 * (issue #633) is resolved via `accept_knowledge_candidate`/
 * `decline_knowledge_candidate` — closes #633's own named-and-unbuilt growth
 * path (issue #703), the one member-initiated flow whose resolution was
 * otherwise silent to the person who started it. Mirrors
 * `notifyAppealResolved`'s shape exactly: fire-and-forget, `.catch(logger.warn)`,
 * never blocks or changes the accept/decline tool's own reported outcome.
 * `decline_knowledge_candidate` accepts an optional `reason` (issue #1050);
 * when supplied it is appended, `truncateForEcho`-capped and quoted, as a
 * distinct trailing clause after the title clause, on the `declined` branch
 * only — the `accepted` branch ignores it. When `reason` is omitted the
 * `declined` wording stays exactly what it was before #1050 (neutral-to-
 * supportive, mirroring `notifyAppealResolved`'s `dismissed` case, rather
 * than fabricating one). Only ever echoes the (possibly admin-overridden)
 * title of the member's own previously-submitted tip and the admin's own
 * decline `reason`, both via `truncateForEcho` — never any other
 * candidate's fields. Exported separately so it's unit-testable without the
 * MCP tool-call transport, same convention as `notifyAppealResolved`.
 * Honours the submitter's standing `'mi'` language preference (issue #331),
 * same degrade-to-`'auto'`-on-failure shape. A `WindowClosedError`
 * rejection is queued via `queueForWindowReopen` at `'low'` priority
 * instead of logged-and-dropped (issue #644, same #602 recovery extended to
 * this member-facing DM); any other rejection is unaffected.
 */
export async function notifyKnowledgeTipResolved(
  adapter: PlatformAdapter,
  userId: string,
  status: 'accepted' | 'declined',
  title: string,
  platform: Platform,
  reason?: string | null,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
): Promise<void> {
  const echoed = truncateForEcho(title);
  const echoedReason = status === 'declined' && reason ? truncateForEcho(reason) : null;
  const lang = await getLangPref(platform, userId).catch(() => 'auto' as const);
  const base =
    lang === 'mi'
      ? status === 'declined'
        ? `Ngā mihi mō tō koha mātauranga — i muri i te arotake, kāore i tāpirihia ā tōna wā: "${echoed}"`
        : `Kua tāpirihia tō koha ki te pātaka mātauranga — ngā mihi mō tō koha! ("${echoed}")`
      : status === 'declined'
        ? `Thanks for the knowledge tip — after review it wasn't added this time: "${echoed}"`
        : `Your knowledge tip has been added to the knowledge base — thanks for the contribution! ("${echoed}")`;
  const message = echoedReason ? `${base}. ${lang === 'mi' ? 'Take' : 'Reason'}: "${echoedReason}"` : base;
  await adapter.sendDirectMessage(userId, message).catch((err) => {
    if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
      adapter.queueForWindowReopen(userId, message, 'low');
      logger.warn(
        { userId: hashId(userId), platform },
        "Knowledge tip resolution DM: recipient's window is closed, queued for reopen",
      );
      return;
    }
    logger.warn({ err, userId: hashId(userId) }, 'Knowledge tip resolution DM failed');
  });
}

/**
 * Best-effort confirmation DM to a member when an admin's `clear_warnings`
 * call actually clears one of their active warnings — closes the last of the
 * codebase's member-resolution flows that stayed silent (issue #865):
 * `resolve_appeal`'s own description carves the unmute out as `clear_warnings`'
 * separate job, so #622's `notifyAppealResolved` never covers it, and a
 * cleared/unmuted member otherwise has no signal short of testing whether
 * they can post again. Mirrors `notifyAppealResolved`'s shape exactly:
 * fire-and-forget, `.catch(logger.warn)`, never blocks or changes
 * `clear_warnings`' own reported outcome. `muteLifted` drives "mute lifted"
 * vs. "nothing to lift" wording; the caller passes `true` only when an
 * `unmute_user` call was actually attempted AND succeeded — never merely
 * because the platform lacks the capability (WhatsApp has no mute mechanism
 * at all, so `muteLifted` must stay `false` there even on a genuine
 * `cleared > 0` clear) — so this never claims to have lifted a mute that was
 * either never attempted or that the caller was just told it could not.
 * Only ever called on a genuine `cleared > 0` transition; never for a no-op
 * clear. Exported separately so it's unit-testable without the MCP tool-call
 * transport, same convention as `notifyAppealResolved`. Honours the target's
 * standing `'mi'` language preference (issue #331), same degrade-to-`'auto'`-
 * on-failure shape. A `WindowClosedError` rejection is queued via
 * `queueForWindowReopen` at `'low'` priority instead of logged-and-dropped
 * (issue #644, same #602 recovery extended to this member-facing DM); any
 * other rejection is unaffected.
 */
export async function notifyWarningsCleared(
  adapter: PlatformAdapter,
  userId: string,
  platform: Platform,
  muteLifted: boolean,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
): Promise<void> {
  const lang = await getLangPref(platform, userId).catch(() => 'auto' as const);
  const message =
    lang === 'mi'
      ? muteLifted
        ? 'Kua whakawāteahia ō whakatūpato, kua tangohia hoki tō noho pōkai — ka taea anō e koe te tuku karere.'
        : 'Kua whakawāteahia ō whakatūpato.'
      : muteLifted
        ? 'Your warnings have been cleared and your mute has been lifted — you can post again.'
        : 'Your warnings have been cleared.';
  await adapter.sendDirectMessage(userId, message).catch((err) => {
    if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
      adapter.queueForWindowReopen(userId, message, 'low');
      logger.warn(
        { userId: hashId(userId), platform },
        "Warnings-cleared DM: recipient's window is closed, queued for reopen",
      );
      return;
    }
    logger.warn({ err, userId: hashId(userId) }, 'Warnings-cleared DM failed');
  });
}

/**
 * Best-effort confirmation DM to a member who previously rated one of the
 * bot's answers unhelpful, sent when an admin's `update_knowledge`/
 * `merge_knowledge` call fixes the entry that answer was served from (issue
 * #1169) — closes the one member-initiated write in `feedback.ts`
 * (`rate_answer`'s thumbs-down) that had no sibling in this file: every other
 * member-initiated queue here (`notifySuggestionResolved`,
 * `notifyReportResolved`, `notifyAppealResolved`, `notifyKnowledgeTipResolved`,
 * `notifyAccessRequestDeclined`, `notifyWarningsCleared`) already tells the
 * submitter when their thing is resolved. Deliberately generic and static —
 * no knowledge-entry title/content, no other rater's identity, no acting
 * admin's identity — since the rater never submitted any of that themselves
 * (unlike `notifyKnowledgeTipResolved`, which echoes the tip's OWN title back
 * to the member who wrote it). Mirrors `notifyWarningsCleared`'s shape:
 * fire-and-forget, `.catch(logger.warn)`, never blocks or changes
 * `update_knowledge`/`merge_knowledge`'s own reported outcome. Honours the
 * rater's standing `'mi'` language preference (issue #331), same
 * degrade-to-`'auto'`-on-failure shape as every sibling in this file. A
 * `WindowClosedError` rejection is queued via `queueForWindowReopen` at
 * `'low'` priority instead of logged-and-dropped, the same #602/#644 recovery
 * extended to this member-facing DM.
 */
export async function notifyKnowledgeEntryFixed(
  adapter: PlatformAdapter,
  userId: string,
  platform: Platform,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
): Promise<void> {
  const lang = await getLangPref(platform, userId).catch(() => 'auto' as const);
  const message =
    lang === 'mi'
      ? 'Kua whakatikaina tētahi whakautu i kīia e koe he kore-āwhina i mua — nau mai ki te pātai anō mehemea ' +
        'kei te hiahia koe ki ngā mōhiohanga hōu.'
      : "An answer you rated unhelpful earlier has since been corrected — feel free to ask again if you'd " +
        'like the updated info.';
  await adapter.sendDirectMessage(userId, message).catch((err) => {
    if (err instanceof WindowClosedError && adapter.queueForWindowReopen) {
      adapter.queueForWindowReopen(userId, message, 'low');
      logger.warn(
        { userId: hashId(userId), platform },
        "Knowledge-fix resolution DM: recipient's window is closed, queued for reopen",
      );
      return;
    }
    logger.warn({ err, userId: hashId(userId) }, 'Knowledge-fix resolution DM failed');
  });
}

/**
 * Wires a manual `warn_user` into the same strike system `Moderator.scan`
 * feeds for auto-detected hits (issue #384) — writes the warning row with
 * `source: 'admin'` (unless the target resolves admin+, who are never warned
 * or muted, mirroring `moderation/index.ts`'s `isExempt`), then escalates to
 * a mute using the SAME `strikeWindowDays` windowing `Moderator.scan` uses
 * for its own immediate-mute decision, so manual and automatic strikes agree.
 * Callers must catch: this must never let a bookkeeping/enforcement failure
 * mask that the warning DM itself already went out.
 */
export async function applyManualWarnStrike(opts: {
  adapter: PlatformAdapter;
  platform: Platform;
  targetUserId: string;
  issuedByUserId: string;
  reason: string;
}): Promise<void> {
  const { adapter, platform, targetUserId, issuedByUserId, reason } = opts;
  if (atLeast(await resolveRole(platform, targetUserId), 'admin')) return;

  await addWarning({
    platform,
    userId: targetUserId,
    reason,
    excerpt: null,
    source: 'admin',
    issuedBy: issuedByUserId,
  });

  if (!config.moderation.enabled || !adapter.adminCapabilities.has('mute_user')) return;

  const active = await countActiveWarnings(platform, targetUserId, config.moderation.strikeWindowDays);
  if (active < config.moderation.strikeLimit) return;

  await adapter.performAdminAction({
    kind: 'mute_user',
    targetUserId,
    params: {
      alertText: manualWarnBlockedAlertText(
        targetUserId,
        issuedByUserId,
        active,
        config.moderation.strikeLimit,
        reason,
      ),
    },
  });
}

/**
 * Best-effort acknowledgement reaction on the message a `report_content`
 * submission named (issue #231's binding "concrete wired use" requirement —
 * a free-floating `react_to_message` the model may or may not call does not
 * itself satisfy the acceptance criteria). Deterministic, not model-invoked:
 * fires directly off a successful report filing, same fire-and-forget shape
 * as `notifyReportFiled`. Silently skipped when the platform doesn't support
 * reactions, no messageId was given, or the message isn't one the bot has
 * actually seen in this conversation — never surfaces an error to the
 * reporter, since the report itself already succeeded.
 */
export function ackReportedMessage(
  adapter: PlatformAdapter,
  platform: Platform,
  conversationId: string,
  messageId: string | undefined,
): void {
  if (!messageId || !adapter.reactToMessage) return;
  void (async () => {
    try {
      if (!(await isKnownMessage(platform, conversationId, messageId))) return;
      await adapter.reactToMessage!(conversationId, messageId, '👀');
    } catch (err) {
      logger.warn({ err, messageId }, 'report_content acknowledgement reaction failed');
    }
  })();
}
