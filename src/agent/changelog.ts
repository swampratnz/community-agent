import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * CHANGELOG.md is the maintained source of truth at the repo root. In a
 * production build tsc emits this module to `dist/agent/` and the build step
 * copies CHANGELOG.md to `dist/` (mirroring how schema.sql is bundled), so it
 * sits at `dist/CHANGELOG.md`. Under tsx (dev / tests) this runs from
 * `src/agent/` with the file still at the repo root. Try both layouts.
 */
const CANDIDATE_PATHS = [
  join(__dirname, '..', 'CHANGELOG.md'), // dist/agent -> dist/CHANGELOG.md (prod)
  join(__dirname, '..', '..', 'CHANGELOG.md'), // src/agent -> repo root (dev/tests)
];

export interface ChangelogSection {
  /** The `##` heading text, e.g. "2026-07-03" or a version. */
  heading: string;
  /** Everything under that heading up to the next `##`, trimmed. */
  body: string;
}

let cache: ChangelogSection[] | null = null;

async function readChangelogFile(): Promise<string | null> {
  for (const path of CANDIDATE_PATHS) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      // Try the next candidate layout.
    }
  }
  return null;
}

/**
 * Parse the top-level `##` sections of CHANGELOG.md in file order (newest
 * first, by convention). The `#` title preamble and `###` subsections are not
 * treated as section boundaries. Result is cached for the process lifetime
 * (the file only changes on redeploy, which restarts the process).
 */
export async function loadChangelog(): Promise<ChangelogSection[]> {
  if (cache) return cache;
  const raw = await readChangelogFile();
  if (raw === null) {
    logger.warn({ paths: CANDIDATE_PATHS }, 'CHANGELOG.md not found; whats_new has nothing to report');
    return [];
  }
  const sections: ChangelogSection[] = [];
  for (const chunk of raw.split(/\n(?=## )/)) {
    const match = chunk.match(/^## +(.+)$/m);
    if (!match) continue; // skips the H1 preamble chunk
    const heading = match[1].trim();
    const body = chunk.slice(chunk.indexOf(match[0]) + match[0].length).trim();
    if (body) sections.push({ heading, body });
  }
  cache = sections;
  return sections;
}

/** Format the most recent `limit` changelog sections as a compact summary. */
export async function recentChanges(limit = 2): Promise<string> {
  const sections = await loadChangelog();
  if (sections.length === 0) return 'No changelog is available right now.';
  const count = Math.min(Math.max(1, limit), sections.length);
  return sections
    .slice(0, count)
    .map((section) => `## ${section.heading}\n${section.body}`)
    .join('\n\n');
}
