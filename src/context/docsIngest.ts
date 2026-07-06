import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  deleteProvenancedKnowledgeByTitles,
  latestKnowledgeUpdateAtByProvenance,
  listGlobalKnowledgeTitlesByProvenance,
  syncGlobalKnowledgeByProvenance,
} from '../storage/repository.js';

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

/** A short, stable, human-readable title from a page URL, e.g. "docs: api/messages". */
export function titleForUrl(url: string): string {
  const path = url
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.md$/, '')
    .replace(/^docs\/en\//, '')
    .replace(/^en\//, '');
  return `docs: ${path}`;
}

/**
 * The page a chunk title belongs to — the `titleForUrl(...)` prefix, with the
 * ` › section` and ` (part N)`/` #N` suffixes stripped. Used to decide, at prune
 * time, whether a stored chunk's PAGE still exists in the index (robust to a
 * page 404-ing on a given run).
 */
export function pageKeyOf(chunkTitle: string): string {
  return chunkTitle
    .split(' › ')[0]
    .replace(/ \(part \d+\)$/, '')
    .replace(/ #\d+$/, '');
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
): Promise<DocsIngestResult> {
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
  };

  let indexText: string;
  try {
    indexText = await fetchText(config.docsIngest.indexUrl);
  } catch (err) {
    logger.error({ err, url: config.docsIngest.indexUrl }, 'Docs ingest: index fetch failed; skipping run');
    return result;
  }

  // Same-origin as the (fixed, official) index URL only — see parseDocIndex.
  const allowedOrigin = new URL(config.docsIngest.indexUrl).origin;
  const urls = parseDocIndex(indexText, allowedOrigin).slice(0, config.docsIngest.maxPages);
  result.pages = urls.length;
  if (urls.length === 0) {
    logger.warn('Docs ingest: index parsed to zero page URLs; leaving existing docs entries untouched');
    return result;
  }

  const seen = new Set<string>();
  const worker = async (url: string): Promise<void> => {
    let md: string;
    try {
      md = await fetchText(url);
      result.fetched += 1;
    } catch (err) {
      logger.warn({ err, url }, 'Docs ingest: page fetch failed');
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
        const outcome = await syncGlobalKnowledgeByProvenance(chunk.title, chunk.content, DOCS_PROVENANCE);
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

  await runPool(urls, config.docsIngest.concurrency, worker);

  // Prune docs chunks whose PAGE no longer appears in the index. Keyed off the
  // index (`urls`), NOT off which pages we managed to fetch this run — a page
  // still listed in the index but transiently 404/timeout stays put; only a page
  // genuinely dropped from the index is removed. This is safe even when many
  // pages fail on a run (the docs index habitually lists some 404 URLs), unlike
  // a fetch-success-based prune. Scoped to the 'docs' provenance, so it can
  // never touch a human/other entry. `seen` avoids re-listing on an empty run.
  if (seen.size > 0) {
    const indexPages = new Set(urls.map(titleForUrl));
    const stored = await listGlobalKnowledgeTitlesByProvenance(DOCS_PROVENANCE);
    const doomed = stored.filter((t) => !indexPages.has(pageKeyOf(t)));
    result.removed = await deleteProvenancedKnowledgeByTitles(DOCS_PROVENANCE, doomed);
  }
  return result;
}
