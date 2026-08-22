/**
 * Regenerates `tests/securityDocSections.test.ts`'s EXPECTED snapshot.
 *
 * Sibling of `tests/dumpToolTiers.ts`, and here for the same reason: the
 * snapshot exists to make a change reviewable, not to be retyped by hand. Adding
 * one section is a one-line edit and should stay that way — reach for this only
 * when the list has drifted wholesale (a renumbering pass, say).
 *
 *   npx tsx tests/dumpSecurityDocSections.ts
 *
 * Prints the array body to stdout; paste it between the EXPECTED brackets.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../docs/SECURITY.md', import.meta.url)), 'utf8');

for (const line of source.split('\n')) {
  const m = /^### ([0-9]+[a-z]?)\. (.+)$/.exec(line);
  if (!m) continue;
  const title = m[2].replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  process.stdout.write(`  ['${m[1]}', '${title}'],\n`);
}
