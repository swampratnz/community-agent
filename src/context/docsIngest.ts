import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  clearDocsIngestUrlFailures,
  listDocsIngestUrlFailures,
  markDocsIngestUrlsReported,
  recordDocsIngestUrlFailures,
  type DocsIngestUrlFailure,
} from '../storage/repository/docsIngestFailures.js';
import {
  deleteProvenancedKnowledgeByTitles,
  latestKnowledgeUpdateAtByProvenance,
  listGlobalKnowledgeTitlesByProvenance,
  syncGlobalKnowledgeByProvenance,
} from '../storage/repository/knowledge.js';
import { pageKeyOf } from './docTitles.js';

/**
 * Docs ingest: backfill Anthropic's official developer docs into the knowledge
 * base as RAG chunks, and keep them current with a ~weekly content diff.
 *
 * Source & trust: reads ONE fixed official source over HTTPS — the llms.txt
 * index (config.docsIngest.indexUrl) → each page's `.md`. No model is in the
 * loop (deterministic fetch/chunk/embed), and the topics/URLs are not
 * user/chat-derived. Entries are written with the 'docs' provenance and treated
 * as TRUSTED at retrieval (served verbatim, shortcut-eligible) — a deliberate
 * call: this is Anthropic's own authoritative documentation, not open-web
 * research (contrast the 'auto' daily refresh, which IS quarantined). See
 * docs/SECURITY.md.
 *
 * Efficiency & change-visibility: each chunk is keyed by a stable title and
 * diffed on content — unchanged sections are skipped (no re-embed), so a weekly
 * refresh only pays for genuinely changed docs, and the returned
 * created/updated/unchanged/removed counts ARE the "what changed" view. Sections
 * that vanish upstream are pruned (scoped to the 'docs' provenance only).
 */

export const DOCS_PROVENANCE = 'docs' as const;

/** Re-run at most ~weekly; a redeploy restarts the process but must not re-ingest. */
const REFRESH_MIN_INTERVAL_MS = 6 * 24 * 3_600_000;

/** Per-section chunk size cap (chars). Small enough that the local embedding sees the whole chunk. */
const MAX_CHUNK_CHARS = 3500;

export function shouldRunDocsIngest(latest: Date | null, now: number): boolean {
  if (!latest) return true;
  return now - latest.getTime() >= REFRESH_MIN_INTERVAL_MS;
}

export function latestDocsIngestAt(): Promise<Date | null> {
  return latestKnowledgeUpdateAtByProvenance(DOCS_PROVENANCE);
}

/**
 * Pull every per-page `.md` URL out of the llms.txt index, keeping ONLY those
 * on the same origin as the index. This enforces the "one fixed, first-party
 * source" invariant the trust model relies on (docs are served verbatim and are
 * shortcut-eligible): a stray/compromised third-party `.md` link in the index
 * is dropped, never ingested as trusted. `titleForUrl` also strips the host, so
 * this same-origin gate is what stops a foreign same-path URL from silently
 * overwriting a legitimate docs row.
 */
export function parseDocIndex(indexText: string, allowedOrigin: string): string[] {
  const urls = new Set<string>();
  for (const m of indexText.matchAll(/https?:\/\/[^\s)"'<>]+\.md/g)) {
    try {
      if (new URL(m[0]).origin === allowedOrigin) urls.add(m[0]);
    } catch {
      // malformed URL — skip
    }
  }
  return [...urls];
}

/** The normalised doc path of a page URL, e.g. "api/messages" (drops host, .md, and the docs/en prefix). */
export function docPathOf(url: string): string {
  return url
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.md$/, '')
    .replace(/^docs\/en\//, '')
    .replace(/^en\//, '');
}

/** A short, stable, human-readable title from a page URL, e.g. "docs: api/messages". */
export function titleForUrl(url: string): string {
  return `docs: ${docPathOf(url)}`;
}

/**
 * Drop page URLs whose doc path is at or under any excluded prefix
 * (config.docsIngest.excludePaths). Applied to the FULL index list so excluded
 * pages are neither fetched NOR counted as "in the index" — which means their
 * chunks are also pruned on the next run if they were previously ingested.
 */
export function filterExcludedUrls(urls: string[], excludePaths: readonly string[]): string[] {
  if (excludePaths.length === 0) return urls;
  return urls.filter((u) => {
    const path = docPathOf(u);
    return !excludePaths.some((p) => path === p || path.startsWith(`${p}/`));
  });
}

/**
 * Chunk a page's markdown into retrieval-sized sections, each prefixed with the
 * page title for context and capped at MAX_CHUNK_CHARS (a long section is
 * hard-split at line boundaries into "… (part N)"). Deterministic.
 *
 * Splits at H2 (`##`) ONLY — `#` (the page title) and `###`+ subheadings stay
 * inline within their parent section. Splitting at every `###` over-fragments
 * API-reference pages (one `###` per parameter → dozens of tiny chunks and a
 * ~50k-chunk corpus); folding them into their H2 keeps chunks coherent and the
 * corpus an order of magnitude smaller, while the size cap still bounds any one
 * chunk to roughly what the local embedding model can see.
 */
export function chunkMarkdown(pageTitle: string, md: string): Array<{ title: string; content: string }> {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const sections: Array<{ heading: string | null; body: string[] }> = [{ heading: null, body: [] }];
  for (const line of lines) {
    if (/^##\s+\S/.test(line)) {
      sections.push({ heading: line.replace(/^##\s+/, '').trim(), body: [] });
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }

  const out: Array<{ title: string; content: string }> = [];
  // Guard against a page repeating a heading (e.g. two "## Examples"): identical
  // titles would otherwise upsert onto each other and lose content.
  const seenTitles = new Map<string, number>();
  const dedupe = (title: string): string => {
    const n = (seenTitles.get(title) ?? 0) + 1;
    seenTitles.set(title, n);
    return n === 1 ? title : `${title} #${n}`;
  };
  for (const s of sections) {
    const text = s.body.join('\n').trim();
    if (!text) continue;
    const sectionTitle = s.heading ? `${pageTitle} › ${s.heading}` : pageTitle;
    const pieces = splitToSize(text, MAX_CHUNK_CHARS);
    pieces.forEach((piece, i) => {
      const base = pieces.length > 1 ? `${sectionTitle} (part ${i + 1})` : sectionTitle;
      // Prefix the page title so the embedded chunk carries its own context.
      out.push({ title: dedupe(base), content: `${sectionTitle}\n\n${piece}` });
    });
  }
  return out;
}

/** Split text into <=maxChars pieces at line boundaries (never mid-line). */
function splitToSize(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > maxChars) {
      pieces.push(cur);
      cur = '';
    }
    // A single over-long line still goes in on its own (hard cap by the reader/embedder).
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/** Fetch text over HTTPS with a timeout. Injectable so tests never hit the network. */
async function defaultFetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'nz-claude-community-agent/docs-ingest (+community bot)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Group failed-fetch URLs by their doc-path directory (all but the leaf page
 * segment) for a by-prefix rollup — e.g. a batch of dead `api/terraform/beta/*`
 * pages collapses into one `N× api/terraform/beta` line instead of N separate
 * warn lines (issue #613). Falls back to the full path for a single-segment
 * page (no '/' to split on).
 */
function rollupByPathPrefix(urls: readonly string[]): Array<{ prefix: string; count: number }> {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const path = docPathOf(url);
    const idx = path.lastIndexOf('/');
    const prefix = idx === -1 ? path : path.slice(0, idx);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}

/**
 * Decide which listed URLs to actually fetch this run, given each URL's current
 * failing streak (issue #611). A URL is SKIPPED only when it has failed
 * `deadRuns` or more consecutive runs AND its last failure is inside the
 * re-probe cooldown. Pure (state + clock in, decision out) so the policy is
 * unit-testable without a DB or network.
 *
 * `deadRuns <= 0` disables skipping entirely — every listed URL is fetched, as
 * before this feature.
 *
 * The cooldown is what keeps a skip self-healing: once `recheckMs` has elapsed
 * a dead URL is re-probed exactly once. If upstream restored it the fetch
 * succeeds, its failure row is deleted, and it rejoins the normal set with no
 * operator action; if it still 404s, its streak bumps and it goes quiet again.
 */
export function partitionDeadUrls(
  urls: readonly string[],
  failures: ReadonlyMap<string, { consecutiveFailures: number; lastFailedAt: Date }>,
  deadRuns: number,
  recheckMs: number,
  now: number,
): { toFetch: string[]; skipped: string[] } {
  if (deadRuns <= 0) return { toFetch: [...urls], skipped: [] };
  const toFetch: string[] = [];
  const skipped: string[] = [];
  for (const url of urls) {
    const state = failures.get(url);
    const isDead = state !== undefined && state.consecutiveFailures >= deadRuns;
    const dueForRecheck = state !== undefined && now - state.lastFailedAt.getTime() >= recheckMs;
    if (isDead && !dueForRecheck) skipped.push(url);
    else toFetch.push(url);
  }
  return { toFetch, skipped };
}

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

export interface DocsIngestResult {
  pages: number;
  fetched: number;
  failed: number;
  chunks: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
  /**
   * Pages in the index slice NOT fetched this run because they are currently
   * skipped as persistently dead (issue #611). Counted separately from
   * `skipped` (which means "chunk not written") and from `failed` (a fetch that
   * was attempted and threw) — a dead-skipped page costs no request at all.
   * `pages - deadSkipped` is therefore the number of fetches actually
   * attempted, which is what the caller's all-fetches-failed check must use.
   */
  deadSkipped: number;
  /**
   * True only when the llms.txt index itself failed to fetch — a total-run
   * failure, distinct from a zero-URL parse (a legitimate no-op when the
   * index is reachable but happens to list nothing). This is only the FIRST
   * of three total-failure stages defaultDocsIngestRun (src/backgroundJobs.ts)
   * checks: the index fetching fine says nothing about whether every page
   * fetch, or every chunk upsert, subsequently failed too — those two stages
   * are derived directly from pages/fetched/chunks/created/updated/unchanged/
   * skipped below rather than needing their own boolean.
   */
  indexFetchFailed: boolean;
}

/**
 * Dead-URL store + clock, injectable so the skip/report policy can be tested
 * without a DB (issue #611). Production uses the repository defaults.
 */
export interface DocsIngestDeps {
  listFailures?: () => Promise<DocsIngestUrlFailure[]>;
  recordFailures?: (urls: readonly string[]) => Promise<void>;
  clearFailures?: (urls: readonly string[]) => Promise<void>;
  markReported?: (urls: readonly string[]) => Promise<void>;
  now?: () => number;
}

/**
 * One ingest run. Fetches the index, then every page (concurrency-limited),
 * chunks + diff-upserts each into `knowledge` under the 'docs' provenance, and
 * prunes chunks whose sections disappeared upstream. `fetchText` is injectable
 * so tests never touch the network. Never throws on a single page's failure —
 * it's counted and the run continues.
 */
export async function runDocsIngest(
  fetchText: (url: string) => Promise<string> = defaultFetchText,
  deps: DocsIngestDeps = {},
): Promise<DocsIngestResult> {
  const {
    listFailures = listDocsIngestUrlFailures,
    recordFailures = recordDocsIngestUrlFailures,
    clearFailures = clearDocsIngestUrlFailures,
    markReported = markDocsIngestUrlsReported,
    now = () => Date.now(),
  } = deps;
  const result: DocsIngestResult = {
    pages: 0,
    fetched: 0,
    failed: 0,
    chunks: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    skipped: 0,
    deadSkipped: 0,
    indexFetchFailed: false,
  };

  let indexText: string;
  try {
    indexText = await fetchText(config.docsIngest.indexUrl);
  } catch (err) {
    logger.error({ err, url: config.docsIngest.indexUrl }, 'Docs ingest: index fetch failed; skipping run');
    result.indexFetchFailed = true;
    return result;
  }

  // Same-origin as the (fixed, official) index URL only — see parseDocIndex.
  const allowedOrigin = new URL(config.docsIngest.indexUrl).origin;
  // The FULL index drives prune membership; the maxPages slice bounds only what
  // we fetch this run. Keeping these separate means a page we simply didn't
  // fetch (because it's past the cap) is never mistaken for a removed page and
  // deleted — it's still listed upstream.
  // Drop excluded sections (e.g. the per-language SDK reference) from the FULL
  // list, so they're neither fetched nor treated as still-in-the-index (their
  // previously-ingested chunks get pruned below).
  const allUrls = filterExcludedUrls(parseDocIndex(indexText, allowedOrigin), config.docsIngest.excludePaths);
  const urls = allUrls.slice(0, config.docsIngest.maxPages);
  result.pages = urls.length;
  if (urls.length === 0) {
    logger.warn('Docs ingest: index parsed to zero page URLs; leaving existing docs entries untouched');
    return result;
  }

  const seen = new Set<string>();
  // Failed-fetch URLs, collected as the pool runs so they can be batched into
  // ONE warn-level summary after the run instead of one warn line per page
  // (issue #613 — an upstream index listing a large dead-link tranche, e.g.
  // 157/586 pages under api/terraform/beta/*, otherwise buries any genuine new
  // failure class in near-identical lines). Full per-page detail is still
  // emitted at debug level, unchanged in shape.
  const failedFetchUrls: string[] = [];
  // Successfully-fetched URLs that currently carry a failing streak — clearing
  // only these (rather than all successes) keeps the post-run write proportional
  // to the dead tranche instead of to the whole index (issue #611).
  const recoveredUrls: string[] = [];

  // Skip URLs that have failed for `deadUrlRuns` consecutive runs and are still
  // inside their re-probe cooldown, so a permanently-dead upstream tranche
  // stops costing a request every run (issue #611). Reading the streak state
  // must never break a run: on a read failure, fall back to fetching everything
  // (today's behaviour) rather than skipping blindly.
  // `DOCS_INGEST_DEAD_URL_RUNS=0` is a COMPLETE off-switch, not just "never
  // skip": no streak read, no streak write, no reporting — so a deployment that
  // opts out behaves byte-identically to before this feature, with no extra
  // queries at all.
  const deadUrlsEnabled = config.docsIngest.deadUrlRuns > 0;
  let failureState = new Map<string, DocsIngestUrlFailure>();
  if (deadUrlsEnabled) {
    try {
      failureState = new Map((await listFailures()).map((f) => [f.url, f]));
    } catch (err) {
      logger.warn({ err }, 'Docs ingest: dead-URL state read failed; fetching every listed page this run');
    }
  }
  const { toFetch, skipped: deadSkippedUrls } = partitionDeadUrls(
    urls,
    failureState,
    config.docsIngest.deadUrlRuns,
    config.docsIngest.deadUrlRecheckDays * 86_400_000,
    now(),
  );
  result.deadSkipped = deadSkippedUrls.length;

  const worker = async (url: string): Promise<void> => {
    let md: string;
    try {
      md = await fetchText(url);
      result.fetched += 1;
      if (failureState.has(url)) recoveredUrls.push(url);
    } catch (err) {
      logger.debug({ err, url }, 'Docs ingest: page fetch failed');
      failedFetchUrls.push(url);
      result.failed += 1;
      return;
    }
    for (const chunk of chunkMarkdown(titleForUrl(url), md)) {
      if (result.chunks >= config.docsIngest.maxChunks) {
        result.skipped += 1;
        continue;
      }
      result.chunks += 1;
      seen.add(chunk.title);
      try {
        const outcome = await syncGlobalKnowledgeByProvenance(chunk.title, chunk.content, DOCS_PROVENANCE, {
          url,
          title: chunk.title,
        });
        if (outcome === 'created') result.created += 1;
        else if (outcome === 'updated') result.updated += 1;
        else if (outcome === 'unchanged') result.unchanged += 1;
        else result.skipped += 1; // title-taken-by-other (a human entry owns it)
      } catch (err) {
        logger.warn({ err, title: chunk.title }, 'Docs ingest: chunk upsert failed');
        result.failed += 1;
      }
    }
  };

  await runPool(toFetch, config.docsIngest.concurrency, worker);

  // Persist this run's outcomes, then report any URL that has JUST crossed the
  // dead threshold — once. Best-effort throughout: this is bookkeeping for a
  // logging/efficiency optimisation, so a write failure must never fail a run
  // whose actual ingest work succeeded.
  if (deadUrlsEnabled) {
    try {
      // A streak row is also stale once its URL has left the index entirely —
      // dropped upstream, or newly excluded via DOCS_INGEST_EXCLUDE_PATHS. Such
      // a URL is never fetched again, so a success would never clear it and the
      // row would linger forever. Reap those here, keyed off the FULL index
      // (`allUrls`, not the maxPages slice) exactly like the chunk prune below,
      // so a page merely past the fetch cap is never mistaken for one that
      // vanished. This is what actually bounds the table by the CURRENT dead
      // tranche rather than by history (PR #691 review).
      const indexed = new Set(allUrls);
      const orphaned = [...failureState.keys()].filter((url) => !indexed.has(url));
      await clearFailures([...recoveredUrls, ...orphaned]);
      await recordFailures(failedFetchUrls);
      // A URL is newly dead when this run's failure takes its streak to the
      // threshold and it has never been reported. `+ 1` because `failureState`
      // is the pre-run snapshot and `recordFailures` has just bumped it.
      const crossedThisRun = failedFetchUrls.filter((url) => {
        const prior = failureState.get(url);
        const streak = (prior?.consecutiveFailures ?? 0) + 1;
        return streak >= config.docsIngest.deadUrlRuns && prior?.reportedAt == null;
      });
      // A URL can also become dead WITHOUT failing this run: lowering
      // DOCS_INGEST_DEAD_URL_RUNS pushes an existing sub-threshold streak over
      // the line, and it is then skipped before it is ever re-attempted — so it
      // would go quiet having never been reported. Report those too, so
      // "reported once, then skipped" holds however the URL crossed.
      const skippedUnreported = deadSkippedUrls.filter((url) => failureState.get(url)?.reportedAt == null);
      const newlyDead = [...new Set([...crossedThisRun, ...skippedUnreported])];
      if (newlyDead.length > 0) {
        logger.warn(
          {
            count: newlyDead.length,
            consecutiveRuns: config.docsIngest.deadUrlRuns,
            recheckDays: config.docsIngest.deadUrlRecheckDays,
            sample: newlyDead.slice(0, 5),
            rollup: rollupByPathPrefix(newlyDead)
              .map(({ prefix, count }) => `${count}× ${prefix}`)
              .join(', '),
          },
          'Docs ingest: URLs persistently failing; skipping them until the next re-probe',
        );
        await markReported(newlyDead);
      }
    } catch (err) {
      logger.warn({ err }, 'Docs ingest: dead-URL bookkeeping failed; run results are unaffected');
    }
  }

  if (failedFetchUrls.length > 0) {
    const rollup = rollupByPathPrefix(failedFetchUrls)
      .map(({ prefix, count }) => `${count}× ${prefix}`)
      .join(', ');
    logger.warn(
      {
        failed: failedFetchUrls.length,
        // Fetches actually ATTEMPTED — excludes dead-skipped pages, which cost
        // no request (issue #611), so "failed of attempted" stays honest.
        attempted: toFetch.length,
        deadSkipped: result.deadSkipped,
        sample: failedFetchUrls.slice(0, 5),
        rollup,
      },
      'Docs ingest: page fetch failures',
    );
  }

  // Prune docs chunks whose PAGE no longer appears in the index. Keyed off the
  // index (`urls`), NOT off which pages we managed to fetch this run — a page
  // still listed in the index but transiently 404/timeout stays put; only a page
  // genuinely dropped from the index is removed. This is safe even when many
  // pages fail on a run (the docs index habitually lists some 404 URLs), unlike
  // a fetch-success-based prune. Scoped to the 'docs' provenance, so it can
  // never touch a human/other entry. `seen` avoids re-listing on an empty run.
  if (seen.size > 0) {
    const indexPages = new Set(allUrls.map(titleForUrl)); // full index, not the fetch-capped slice
    const stored = await listGlobalKnowledgeTitlesByProvenance(DOCS_PROVENANCE);
    const doomed = stored.filter((t) => !indexPages.has(pageKeyOf(t)));
    result.removed = await deleteProvenancedKnowledgeByTitles(DOCS_PROVENANCE, doomed);
  }
  return result;
}
