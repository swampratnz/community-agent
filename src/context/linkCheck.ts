import dns from 'node:dns/promises';
import { Agent, buildConnector, type Dispatcher } from 'undici';
import { logger } from '../logger.js';
import {
  latestKnowledgeSourceCheckAt,
  listKnowledgeSourceUrls,
  recordKnowledgeSourceCheck,
} from '../storage/repository.js';

/**
 * Knowledge link-rot check (issue #448): a weekly opt-in background job that
 * HEAD-checks every knowledge entry's `sourceUrl` and stamps whether it's
 * still reachable, so a dead citation doesn't keep rendering to members as
 * authoritative forever with zero admin signal.
 *
 * Trust & privacy: `sourceUrl` is admin-authored only (via
 * save_knowledge/update_knowledge, already an admin-tier action, or
 * docs-ingest's own fixed first-party source) — this is not a new
 * untrusted-input surface. The response BODY of a checked URL is never read,
 * logged, or persisted anywhere: every request issues either a HEAD, or (on
 * a HEAD-unsupported host) a ranged GET whose body is immediately cancelled
 * without being read. This is a pure reachability probe, distinct from
 * WebFetch (disallowed for every tier) — no model is ever in this loop. See
 * docs/SECURITY.md.
 *
 * SSRF guard: unlike every other outbound poller in this repo (which hits
 * one fixed first-party host), `sourceUrl` spans N admin-supplied arbitrary
 * hosts. Without a guard, an admin could use the returned reachability
 * boolean as a blind internal-network probe (e.g. a cloud metadata address).
 * The initial URL AND every redirect hop's Location are DNS-resolved and
 * checked against a denylist of loopback/private/link-local/cloud-metadata
 * ranges before any request is issued to them; a disallowed target is
 * refused outright — no request, no persisted result (see
 * `classifySourceUrl`'s `'refused'` outcome and `runKnowledgeLinkCheck`,
 * which never calls `recordKnowledgeSourceCheck` for it).
 *
 * DNS-rebinding/TOCTOU closed (issue #587): the guard resolves each hop's
 * hostname exactly once via the injectable `lookup`; the request for that
 * hop is then connected to that SAME guard-checked IP literal (pinned via a
 * custom undici connector — Node's global `fetch` is undici, which ignores
 * a Node `http(s).Agent`), with the original hostname presented as the TLS
 * SNI/Host header. The connection layer never performs its own independent
 * DNS resolution, so a low-TTL DNS record that would resolve differently a
 * moment later can no longer bypass the guard.
 */

export const LINK_CHECK_USER_AGENT = 'nz-claude-community-agent/link-check (+community bot)';

/** Re-run at most ~weekly, mirroring docs-ingest's own cadence. */
const CHECK_MIN_INTERVAL_MS = 6 * 24 * 3_600_000;

/** A handful of hops at most — enough for a legitimate host migration, not an open-ended chase. */
const REDIRECT_HOP_CAP = 5;

const REQUEST_TIMEOUT_MS = 5_000;

export function shouldRunKnowledgeLinkCheck(latest: Date | null, now: number): boolean {
  if (!latest) return true;
  return now - latest.getTime() >= CHECK_MIN_INTERVAL_MS;
}

/** Read the freshness watermark for the scheduler's ~weekly guard. */
export function latestLinkCheckAt(): Promise<Date | null> {
  return latestKnowledgeSourceCheckAt();
}

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

async function defaultLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return dns.lookup(hostname, { all: true });
}

const DISALLOWED_V4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16], // includes 169.254.169.254, the common cloud metadata address
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isDisallowedIpv4(ip: string): boolean {
  const target = ipv4ToInt(ip);
  return DISALLOWED_V4_CIDRS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (target & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Split an IPv6 literal (`::`-compression-aware) into its 8 hex groups. */
function expandIpv6(ip: string): string[] {
  const addr = ip.split('%')[0]; // strip a zone id, if any
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, ''];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  return [...headParts, ...Array(missing).fill('0'), ...tailParts].map((p) => p || '0');
}

function isDisallowedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true; // unspecified / loopback
  const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isDisallowedIpv4(v4Mapped[1]);
  const v4Compat = normalized.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Compat) return isDisallowedIpv4(v4Compat[1]); // deprecated "IPv4-compatible" form
  const groups = expandIpv6(normalized).map((g) => parseInt(g, 16));
  const first16 = groups[0];
  if ((first16 & 0xfe00) === 0xfc00) return true; // fc00::/7 (unique local)
  if ((first16 & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((first16 & 0xffc0) === 0xfec0) return true; // fec0::/10 (deprecated site-local)
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return true; // 64:ff9b::/96 (NAT64 well-known prefix — may embed a disallowed IPv4 target)
  }
  return false;
}

/** True if `ip` falls in a loopback/private/link-local/cloud-metadata range. */
export function isDisallowedIp(ip: string, family: number): boolean {
  return family === 6 ? isDisallowedIpv6(ip) : isDisallowedIpv4(ip);
}

type GuardOutcome =
  { kind: 'allowed'; pinnedAddress: string } | { kind: 'blocked' } | { kind: 'dns-failure' };

/**
 * https-only, plus a DNS resolution check against the denylist above. A
 * `'dns-failure'` (the hostname simply doesn't resolve) is NOT `'blocked'` —
 * that's a legitimate reachability signal (`classifySourceUrl` turns it into
 * `'unreachable'`), distinct from a hostname that resolves fine but to a
 * disallowed range (`'blocked'`, which `classifySourceUrl` turns into
 * `'refused'` — no request ever issued, no result ever persisted). On
 * `'allowed'`, `pinnedAddress` is the ONE resolved IP the caller must
 * connect to — this is the single DNS resolution for this hop; the request
 * itself must never trigger a second one (see `buildPinnedDispatcher`).
 */
async function guardTarget(url: URL, lookup: DnsLookupFn): Promise<GuardOutcome> {
  if (url.protocol !== 'https:') return { kind: 'blocked' };
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(url.hostname);
  } catch {
    return { kind: 'dns-failure' };
  }
  if (addrs.length === 0) return { kind: 'dns-failure' };
  if (addrs.some((a) => isDisallowedIp(a.address, a.family))) return { kind: 'blocked' };
  return { kind: 'allowed', pinnedAddress: addrs[0].address };
}

export type DispatcherFactory = (pinnedAddress: string) => unknown;

/**
 * Connects by IP literal to `pinnedAddress`, leaving `host`/`servername`
 * untouched so undici's default connector still presents the ORIGINAL
 * hostname as the TLS SNI (and the request's `Host` header, derived
 * independently from the request URL, is unaffected). This is what actually
 * closes the DNS-rebinding gap: the socket never re-resolves the hostname —
 * it connects straight to the address `guardTarget` already vetted, so
 * there is no second, independent DNS resolution for a rebinding attacker to
 * win a race against.
 */
function pinnedConnect(pinnedAddress: string): buildConnector.connector {
  const connect = buildConnector({});
  return (opts, callback) => connect({ ...opts, hostname: pinnedAddress }, callback);
}

/** Real dispatcher factory (production default) — tests inject their own. */
export function buildPinnedDispatcher(pinnedAddress: string): Dispatcher {
  return new Agent({ connect: pinnedConnect(pinnedAddress) });
}

async function closeDispatcher(dispatcher: unknown): Promise<void> {
  const closeable = dispatcher as { close?: () => Promise<void> } | null;
  if (typeof closeable?.close === 'function') {
    try {
      await closeable.close();
    } catch {
      // best-effort cleanup — the request itself already completed
    }
  }
}

async function issueRequest(
  url: URL,
  method: 'HEAD' | 'GET',
  fetchImpl: typeof fetch,
  timeoutMs: number,
  pinnedAddress: string,
  buildDispatcher: DispatcherFactory,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const dispatcher = buildDispatcher(pinnedAddress);
  try {
    const headers: Record<string, string> = { 'user-agent': LINK_CHECK_USER_AGENT };
    if (method === 'GET') headers['range'] = 'bytes=0-0';
    const init: RequestInit = {
      method,
      redirect: 'manual',
      signal: ctrl.signal,
      headers,
      dispatcher: dispatcher as RequestInit['dispatcher'],
    };
    const res = await fetchImpl(url, init);
    // Never read the body — a pure reachability check (see module header).
    if (res.body) {
      try {
        await res.body.cancel();
      } catch {
        // best-effort discard; the status/headers we need are already read
      }
    }
    return res;
  } finally {
    clearTimeout(timer);
    await closeDispatcher(dispatcher);
  }
}

/** HEAD, falling back to a body-less ranged GET on a host that rejects HEAD. */
async function requestOnce(
  url: URL,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  pinnedAddress: string,
  buildDispatcher: DispatcherFactory,
): Promise<Response> {
  const head = await issueRequest(url, 'HEAD', fetchImpl, timeoutMs, pinnedAddress, buildDispatcher);
  if (head.status === 405 || head.status === 501) {
    return issueRequest(url, 'GET', fetchImpl, timeoutMs, pinnedAddress, buildDispatcher);
  }
  return head;
}

export type SourceCheckOutcome = 'reachable' | 'unreachable' | 'refused';

export interface ClassifyDeps {
  fetchImpl?: typeof fetch;
  lookup?: DnsLookupFn;
  timeoutMs?: number;
  /** Builds the per-hop pinned connection. Defaults to `buildPinnedDispatcher`; tests inject their own. */
  buildDispatcher?: DispatcherFactory;
}

/**
 * Classify one sourceUrl: 2xx/3xx-within-the-redirect-cap → 'reachable';
 * 4xx/5xx/timeout/DNS-failure → 'unreachable'. 'refused' means the SSRF
 * guard blocked the initial URL or a redirect hop — the caller MUST NOT
 * persist anything for that outcome (see `runKnowledgeLinkCheck`).
 */
export async function classifySourceUrl(
  sourceUrl: string,
  deps: ClassifyDeps = {},
): Promise<SourceCheckOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const lookup = deps.lookup ?? defaultLookup;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const buildDispatcher = deps.buildDispatcher ?? buildPinnedDispatcher;

  let current: URL;
  try {
    current = new URL(sourceUrl);
  } catch {
    return 'unreachable';
  }

  for (let hop = 0; hop <= REDIRECT_HOP_CAP; hop++) {
    const guard = await guardTarget(current, lookup);
    if (guard.kind === 'blocked') return 'refused';
    if (guard.kind === 'dns-failure') return 'unreachable';

    let res: Response;
    try {
      res = await requestOnce(current, fetchImpl, timeoutMs, guard.pinnedAddress, buildDispatcher);
    } catch {
      return 'unreachable'; // network error / timeout
    }

    if (res.status >= 200 && res.status < 300) return 'reachable';
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return 'unreachable';
      try {
        current = new URL(location, current);
      } catch {
        return 'unreachable';
      }
      continue; // re-guard the new hop at the top of the loop
    }
    return 'unreachable'; // 4xx/5xx
  }
  return 'unreachable'; // exceeded the redirect-hop cap without resolving
}

export interface LinkCheckResult {
  /** Entries with a non-null sourceUrl this run considered. */
  candidates: number;
  reachable: number;
  unreachable: number;
  /** Blocked by the SSRF guard — never requested, never persisted. */
  refused: number;
  /** classifySourceUrl or the DB write threw unexpectedly for this entry. */
  failed: number;
}

/**
 * One link-check run. Sweeps every knowledge entry with a sourceUrl,
 * classifies it, and persists the result — except a 'refused' outcome,
 * which is deliberately left untouched (see the module header's SSRF-guard
 * section). `deps` is injectable so tests never touch the real network/DNS.
 */
export async function runKnowledgeLinkCheck(deps: ClassifyDeps = {}): Promise<LinkCheckResult> {
  const result: LinkCheckResult = { candidates: 0, reachable: 0, unreachable: 0, refused: 0, failed: 0 };
  const entries = await listKnowledgeSourceUrls();
  result.candidates = entries.length;

  for (const entry of entries) {
    try {
      const outcome = await classifySourceUrl(entry.sourceUrl, deps);
      if (outcome === 'refused') {
        result.refused += 1;
        logger.warn(
          { id: entry.id },
          'Knowledge link check: sourceUrl refused by the SSRF guard; leaving entry untouched',
        );
        continue;
      }
      await recordKnowledgeSourceCheck(entry.id, outcome === 'unreachable');
      if (outcome === 'unreachable') result.unreachable += 1;
      else result.reachable += 1;
    } catch (err) {
      logger.warn({ err, id: entry.id }, 'Knowledge link check: entry failed');
      result.failed += 1;
    }
  }
  return result;
}
