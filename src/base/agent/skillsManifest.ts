/**
 * Skills manifest registration (agent-base plan §3 `skills` row, Phase-1
 * item 8): the base-owned enforcement point between a module's skill bundle
 * and core.ts's `query()` options.
 *
 * SECURITY: this file is part of the security spine (docs/SECURITY.md). The
 * invariant it owns is the never-`'all'` allowlist rule (issue #741): the
 * SDK's `skills: 'all'` wildcard would activate every skill file present in
 * the plugin directory, so a future skill dropped into the directory would
 * self-activate without the deliberate second edit this repo's hand-written
 * allowlist convention requires. Registration therefore rejects anything
 * that is not a plain array of non-`'all'`, non-empty skill names — a module
 * can only ever NARROW what its own bundled directory could offer, never
 * widen activation beyond the literal list it registers. The registered list
 * is copied and frozen, so no later mutation can widen it either, and a
 * second registration throws rather than swapping the manifest after boot.
 */

export interface SkillsManifest {
  /** Absolute path of the repo-bundled, code-reviewed skills plugin directory. */
  skillsDir: string;
  /** The literal skill-name allowlist — never `'all'`, never runtime-derived. */
  enabledSkills: readonly string[];
}

let manifest: SkillsManifest | null = null;

export function registerSkillsManifest(candidate: SkillsManifest): void {
  // Content validation runs BEFORE the already-registered check so a hostile
  // widening attempt is always rejected as such, never masked as a duplicate.
  if (!Array.isArray(candidate.enabledSkills)) {
    throw new Error(
      "enabledSkills must be a literal array of skill names — the SDK's 'all' wildcard (or any non-array) is never accepted",
    );
  }
  for (const skill of candidate.enabledSkills) {
    if (typeof skill !== 'string' || skill.trim() === '' || skill === 'all') {
      throw new Error(
        `invalid skill name ${JSON.stringify(skill)} — enabledSkills entries must be non-empty names and never 'all'`,
      );
    }
  }
  if (typeof candidate.skillsDir !== 'string' || candidate.skillsDir.trim() === '') {
    throw new Error('skillsDir must be a non-empty path to the bundled skills plugin directory');
  }
  if (manifest) {
    throw new Error('skills manifest already registered — the allowlist cannot be swapped after boot');
  }
  manifest = { skillsDir: candidate.skillsDir, enabledSkills: Object.freeze([...candidate.enabledSkills]) };
}

/** The registered manifest; throws if the community skills module never loaded. */
export function skillsManifest(): SkillsManifest {
  if (!manifest) {
    throw new Error('no skills manifest registered — import the community skills module first');
  }
  return manifest;
}
