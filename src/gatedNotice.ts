import { sanitizeName } from './agent/systemPrompt.js';
import { logger } from './logger.js';
import type { Platform } from './platforms/types.js';
import { listAdminDisplayNames as listAdminDisplayNamesReal } from './storage/repository.js';

/**
 * Static fallback (issue #360's baseline, unchanged byte-for-byte from the
 * pre-#360 GATED_NOTICE) — used whenever zero admin display names are
 * resolvable, so a fresh deploy or an admin roster with no stored/rostered
 * name never degrades into an empty-list sentence.
 */
export const GATED_NOTICE =
  'Kia ora! This assistant is member-only. Ask a community admin to add you as a member and I can help.';

/**
 * Adversarial-review cap (issue #360 approval): a large admin roster must
 * never be enumerated in full into one message, and the rendered set must
 * not depend on nondeterministic ordering — `listAdminDisplayNames`'s stable
 * `community_users.id` ordering plus this slice keeps the notice both short
 * and repeatable.
 */
export const GATED_NOTICE_MAX_ADMIN_NAMES = 3;

// Mirrors storage/policies.ts's CACHE_TTL_MS shape: GATED_NOTICE is on a hot,
// repeated path (every addressed message from every gated guest), so this
// must not add a DB round-trip per message.
const CACHE_TTL_MS = 30_000;

/** "Alice" / "Alice or Bob" / "Alice, Bob or Carol" — natural prose, no Oxford comma before the final "or". */
function joinNames(names: string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * Pure renderer: names in, notice text out. Every name is run through
 * `sanitizeName` first (same treatment `resolveSanitizedLabel` gives any
 * other display name before it reaches outbound/model-visible text, issue
 * #227) — `display_name` is platform-supplied (e.g. a Discord nickname) with
 * no length or newline limit, and this notice is auto-sent, unsolicited, to
 * every gated guest, so a name can't inject Markdown link syntax or embedded
 * newlines into it. A name that sanitizes to empty (e.g. only angle
 * brackets/whitespace) is dropped rather than shown blank. Empty input (or
 * an input that sanitizes to nothing) renders the unchanged static
 * `GATED_NOTICE` (acceptance criterion 3); otherwise the result is capped at
 * `GATED_NOTICE_MAX_ADMIN_NAMES`.
 */
export function renderGatedNotice(names: string[]): string {
  const sanitized = names.map((name) => sanitizeName(name)).filter((name) => name.length > 0);
  if (sanitized.length === 0) return GATED_NOTICE;
  const shown = joinNames(sanitized.slice(0, GATED_NOTICE_MAX_ADMIN_NAMES));
  return `Kia ora! This assistant is member-only. Ask a community admin — ${shown} — to add you as a member and I can help.`;
}

interface CacheEntry {
  names: string[];
  expires: number;
}

/**
 * Builds a platform-keyed, TTL-cached gated-notice reader (issue #360),
 * mirroring `storage/policies.ts`'s cache/`CACHE_TTL_MS` shape but factored
 * as a factory — like `moderation/moderator.ts`'s `makeClassifier` — so
 * tests can inject a fake `listNames`/`now` against an isolated cache
 * instead of racing the module-level singleton below. A `listNames` failure
 * (DB down, query error) resolves to an empty list rather than throwing:
 * this path exists to unblock a gated guest, so it must degrade to the
 * always-safe static `GATED_NOTICE`, never drop or delay the reply.
 */
export function makeGatedNoticeBuilder(
  opts: {
    listNames?: (platform: Platform) => Promise<string[]>;
    now?: () => number;
  } = {},
): (platform: Platform) => Promise<string> {
  const listNames = opts.listNames ?? listAdminDisplayNamesReal;
  const now = opts.now ?? Date.now;
  const cache = new Map<Platform, CacheEntry>();

  return async (platform: Platform): Promise<string> => {
    const hit = cache.get(platform);
    let names: string[];
    if (hit && hit.expires > now()) {
      names = hit.names;
    } else {
      try {
        names = await listNames(platform);
      } catch (err) {
        logger.warn({ err, platform }, 'Admin display-name lookup failed; using the static gated notice');
        names = [];
      }
      cache.set(platform, { names, expires: now() + CACHE_TTL_MS });
    }
    return renderGatedNotice(names);
  };
}

/**
 * The real, DB-backed builder — a module-level singleton so its cache is
 * actually shared across every gated guest's message, not re-created per
 * call. This is what `router.ts` uses by default.
 */
export const buildGatedNotice = makeGatedNoticeBuilder();
