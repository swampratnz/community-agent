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
 * Builds a typed `notice(id, {language, style})` lookup over a module's
 * entry map. The return type is the entry's own `base` type, so a template
 * entry comes back as its concrete function type and a fixed entry as a
 * string — call sites keep full type safety with zero casts.
 */
export function createNoticeCatalogue<M extends Record<string, NoticeEntry<NoticeValue>>>(
  axes: NoticeAxes,
  entries: M,
): {
  axes: NoticeAxes;
  entries: M;
  notice: <K extends keyof M>(id: K, selection?: NoticeSelection) => M[K]['base'];
} {
  return {
    axes,
    entries,
    notice: <K extends keyof M>(id: K, selection?: NoticeSelection): M[K]['base'] =>
      selectNoticeVariant(entries[id], axes, selection),
  };
}
