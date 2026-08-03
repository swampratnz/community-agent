/**
 * Locale/style notice catalogue — the base-owned MECHANISM half of the
 * agent-base plan's `strings` extension point (docs/AGENT-BASE-PLAN.md §3):
 * one place that implements the selection precedence every `*_MI`/`*_PLAIN`
 * call site used to re-encode by hand, over OPEN axes a module registers
 * (this repo's community pack registers language `'mi'` and style `'plain'`
 * in `notices.ts`) instead of closed `'mi'`/`'plain'` unions baked into the
 * platform contract.
 *
 * The precedence is EXACTLY today's per-site chain, generalised:
 *
 *   1. a registered LANGUAGE the caller has set claims the turn — the
 *      entry's variant for it if one exists, else the base (English) text.
 *      The style axis is never consulted once a registered language is set
 *      ('mi' takes precedence over 'plain' at every existing site, and a
 *      notice with an `_MI` gap never fell through to `_PLAIN`);
 *   2. otherwise a registered STYLE selects its variant if the entry has
 *      one, else the base text;
 *   3. otherwise the base text ('auto'/'en' language and 'standard' style
 *      are deliberately NOT registered axis values — they mean "default").
 *
 * Trust level is unchanged from the constants this replaces: every value in
 * a pack is a fixed, human-authored literal — no model call, no translation,
 * no runtime input — and everything selected here still leaves through the
 * adapters' outbound filter (`filtered()`), so the catalogue adds no egress
 * path.
 */

/** What the caller has standing preferences for. Open strings on purpose —
 * see the axis-registration note above. The DB-facing unions
 * (`LanguagePreference`/`ResponseStyle` in `storage/repository/preferences.ts`)
 * and the `set_language_preference`/`set_response_style` tool input enums
 * stay CLOSED: a DB CHECK constrains the stored values and a closed
 * model-facing input enum is a security invariant — same tension, same
 * resolution, as `JobSpec.name` vs the DB-constrained `BackgroundJob` union
 * (src/jobs/types.ts). */
export interface NoticeSelection {
  language?: string;
  style?: string;
}

/**
 * One notice: a base (English/default) value plus optional per-axis-value
 * variants. `T` is a plain string for fixed notices, or a template function
 * for the few "translate the shell, interpolate the dynamic value unchanged"
 * notices (pending-notice descriptions, budget counts, snippet line counts).
 */
export interface NoticeEntry<T> {
  base: T;
  /** Variants keyed by registered language (today: `{ mi: … }`). */
  language?: Record<string, T>;
  /** Variants keyed by registered style (today: `{ plain: … }`). */
  style?: Record<string, T>;
}

export interface NoticeAxes {
  /** Language axis values that claim a turn outright (today: `['mi']`). */
  languages: readonly string[];
  /** Style axis values that apply when no registered language did (today: `['plain']`). */
  styles: readonly string[];
}

/**
 * Pure variant selection — the one implementation of the precedence rules
 * documented in the file header. Exported separately from the catalogue
 * factory so the table-driven equivalence test can drive it directly.
 */
export function selectNoticeVariant<T>(
  entry: NoticeEntry<T>,
  axes: NoticeAxes,
  selection?: NoticeSelection,
): T {
  const language = selection?.language;
  if (language !== undefined && axes.languages.includes(language)) {
    return entry.language?.[language] ?? entry.base;
  }
  const style = selection?.style;
  if (style !== undefined && axes.styles.includes(style)) {
    return entry.style?.[style] ?? entry.base;
  }
  return entry.base;
}

/** A notice value: fixed text, or a template function over dynamic values. */
export type NoticeValue = string | ((...args: never[]) => string);

/**
 * Per-id notice types — the type-side half of pack registration. The pack
 * module augments this interface over its own entry map (`notices.ts` does
 * `declare module './catalogue.js'`), so `notice()` keeps each id's concrete
 * return type — a template entry comes back as its function type and a fixed
 * entry as a string, with zero casts at call sites — without this module
 * ever importing the pack. Empty until a pack augments it, so an
 * unregistered id is a compile error, not just the runtime throw below.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NoticeIdMap {}

let registered: { axes: NoticeAxes; entries: Record<string, NoticeEntry<NoticeValue>> } | null = null;

/**
 * Register THE notice pack, exactly once per process — called by the pack
 * module (src/strings/notices.ts) at its own module scope, so importing the
 * pack anywhere is what makes `notice` servable. A second registration
 * throws rather than swapping packs after boot, matching `registerToolTiers`
 * (auth/rbac.ts) and the skills-manifest/prompt-sections registries.
 */
export function registerNoticePack(
  axes: NoticeAxes,
  entries: Record<string, NoticeEntry<NoticeValue>>,
): void {
  if (registered) {
    throw new Error('notice pack already registered — the pack cannot be swapped after boot');
  }
  registered = { axes, entries };
}

/**
 * `notice(id, {language, style})` — the one selection point, reading the
 * registered pack. Pass the caller's standing preferences RAW
 * (`'auto'`/`'en'`/`'standard'` mean "default" because they are not
 * registered axis values); never pre-resolve the precedence at a call site.
 * FAILS LOUD — never a silent empty string — if the pack module was never
 * imported: several consumers derive exported consts from `notice()` at
 * their own module scope, so a missing registration import surfaces as an
 * immediate throw at load time, not as blank member-facing text.
 */
export function notice<K extends keyof NoticeIdMap>(id: K, selection?: NoticeSelection): NoticeIdMap[K] {
  if (!registered) {
    throw new Error(
      'no notice pack registered — import the pack module (src/strings/notices.js) before requesting a notice',
    );
  }
  const entry = registered.entries[id as string];
  if (!entry) {
    throw new Error(`unknown notice id: ${String(id)} — not present in the registered pack`);
  }
  return selectNoticeVariant(entry, registered.axes, selection) as NoticeIdMap[K];
}
