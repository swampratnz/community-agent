/**
 * Leaf helpers over docs-ingest chunk TITLES — no imports, deliberately.
 *
 * `pageKeyOf` used to live in docsIngest.ts, but storage/repository/knowledge.ts
 * needs it too (the member digest's release-watch grouping reuses it verbatim so
 * the two stay in lockstep), and docsIngest.ts reads its queries from the
 * storage layer — routing the shared helper through docsIngest.ts was the
 * repository ⇄ docsIngest import cycle (AGENT-BASE-PLAN Phase 1 item 4). Both
 * sides now import this leaf instead.
 */

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
