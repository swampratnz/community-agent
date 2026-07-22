import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Anthropic status check (issue #206): "is this me, or is Anthropic having
 * an incident?" is one of the most common support questions in any Claude/
 * API community, and the bot previously had no authoritative answer for it.
 *
 * Source & trust: reads ONE fixed, official, first-party HTTPS source —
 * Anthropic's own public Statuspage summary endpoint
 * (config.statusCheck.apiUrl, https-enforced at config validation, override-
 * only). No model is in the fetch/parse loop — this is a deterministic
 * background poll into an in-memory cache; a member's turn only ever reads
 * the cache via check_status, never triggers a live fetch. Same trust
 * framing docs/SECURITY.md already applies to docs ingest.
 *
 * No DB table: the data is already public, ephemeral, and re-fetchable, so a
 * plain module-level cache is enough — see the proposal's "alternatives
 * considered" for why persistence was deliberately left out of v1.
 */

export type StatusIndicator = 'none' | 'minor' | 'major' | 'critical';

export interface StatusIncident {
  name: string;
  impact: StatusIndicator;
  status: string;
  updatedAt: string;
}

export interface StatusSummary {
  indicator: StatusIndicator;
  description: string;
  incidents: StatusIncident[];
}

export interface StatusCacheState {
  fetchedAt: Date;
  summary: StatusSummary;
}

function normalizeIndicator(value: unknown): StatusIndicator {
  return value === 'minor' || value === 'major' || value === 'critical' ? value : 'none';
}

/**
 * Parse a Statuspage `summary.json` body into our small typed shape. Throws
 * on invalid JSON or an unexpected top-level shape — the caller treats a
 * parse failure exactly like a fetch failure (degrade to last-known-good),
 * so a 200 response with a malformed body can never surface as a false "all
 * operational" or throw into a member's turn.
 */
export function parseStatusSummary(body: string): StatusSummary {
  const data: unknown = JSON.parse(body);
  if (typeof data !== 'object' || data === null || !('status' in data)) {
    throw new Error('Anthropic status summary: missing "status"');
  }
  const status = data.status;
  if (
    typeof status !== 'object' ||
    status === null ||
    typeof (status as { description?: unknown }).description !== 'string'
  ) {
    throw new Error('Anthropic status summary: missing status.description');
  }

  const incidentsRaw = (data as { incidents?: unknown }).incidents;
  const incidents: StatusIncident[] = (Array.isArray(incidentsRaw) ? incidentsRaw : [])
    .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
    .map((i) => ({
      name: typeof i.name === 'string' ? i.name : 'Unnamed incident',
      impact: normalizeIndicator(i.impact),
      status: typeof i.status === 'string' ? i.status : 'unknown',
      updatedAt: typeof i.updated_at === 'string' ? i.updated_at : new Date(0).toISOString(),
    }))
    // Statuspage's summary.json already omits resolved incidents in
    // practice, but filter defensively in case that ever changes upstream.
    .filter((i) => i.status !== 'resolved');

  return {
    indicator: normalizeIndicator((status as { indicator?: unknown }).indicator),
    description: (status as { description: string }).description,
    incidents,
  };
}

/** Fetch text over HTTPS with a timeout. Injectable so tests never hit the network. */
async function defaultFetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'nz-claude-community-agent/status-check (+community bot)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

let cache: StatusCacheState | null = null;

/** The current cached status, or null if no fetch has ever succeeded. */
export function getStatusCache(): StatusCacheState | null {
  return cache;
}

/** Test-only reset of module state between test cases. */
export function resetStatusCacheForTests(): void {
  cache = null;
}

/**
 * One poll. Never throws — a fetch failure or a malformed response body both
 * log a warning and leave the existing cache (if any) untouched, so
 * check_status always degrades to the last-known-good value with its age
 * rather than an error or a silently-stale-but-unlabelled answer. Returns
 * whether the cache was actually updated (issue #321): the caller uses this
 * boolean to drive consecutive-failure alerting without this function ever
 * needing to throw or change its degrade-on-failure contract.
 */
export async function pollAnthropicStatus(
  fetchText: (url: string) => Promise<string> = defaultFetchText,
): Promise<boolean> {
  const url = config.statusCheck.apiUrl;
  let body: string;
  try {
    body = await fetchText(url);
  } catch (err) {
    logger.warn({ err, url }, 'Anthropic status check: fetch failed; keeping last-known-good');
    return false;
  }
  try {
    cache = { fetchedAt: new Date(), summary: parseStatusSummary(body) };
    return true;
  } catch (err) {
    logger.warn({ err, url }, 'Anthropic status check: malformed summary; keeping last-known-good');
    return false;
  }
}

function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'less than a minute';
  if (minutes === 1) return '1 minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/**
 * The member-facing string check_status returns. Pure (takes the cache state
 * and "now" as arguments) so it's trivially unit-testable without touching
 * module state or the clock. Deliberately never asserts "all operational"
 * means the member's own problem is on their end — only that there's no
 * KNOWN Anthropic incident (adversarial review tightening on issue #206:
 * Statuspage can lag or omit partial/region/model-specific degradations).
 */
export function formatStatusMessage(state: StatusCacheState | null, now: number): string {
  if (!state) {
    return "I haven't been able to check Anthropic's status yet — try again shortly.";
  }
  const age = formatAge(now - state.fetchedAt.getTime());
  const { incidents } = state.summary;
  if (incidents.length === 0) {
    return (
      `No known Anthropic incidents right now (checked ${age} ago). ` +
      "That's Anthropic's own status page, not a diagnosis of your specific issue — " +
      "worth double-checking your own request/setup too if something's still not working."
    );
  }
  const lines = incidents.map(
    (i) =>
      `- ${i.name} (${i.impact} impact, ${i.status}, updated ${formatAge(now - Date.parse(i.updatedAt))} ago)`,
  );
  return (
    `⚠️ Anthropic has ${incidents.length} active incident${incidents.length === 1 ? '' : 's'} ` +
    `(checked ${age} ago):\n${lines.join('\n')}`
  );
}

/**
 * The proactive super-admin DM sent on a `none → incident` transition (issue
 * #601). Deliberately reuses `formatStatusMessage` verbatim for the incident
 * body rather than hand-interpolating `StatusSummary`'s Anthropic-supplied
 * `name`/`description` strings again — those are first-party but still
 * externally-authored, so staying on the one already-reviewed rendering path
 * (used today by member-facing `check_status`) avoids opening a second,
 * divergent interpolation surface into this unprompted admin DM.
 */
export function formatStatusIncidentAlert(state: StatusCacheState, now: number): string {
  return `🔔 Proactive alert (Anthropic status changed): ${formatStatusMessage(state, now)}`;
}
