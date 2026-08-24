import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillsManifest } from '@swampratnz/agent-base/agent/skillsManifest.js';

/**
 * The explicit, hand-written Agent Skills allowlist (issue #741) — never
 * `'all'`, so a future skill file added to the skills directory needs a
 * deliberate second edit here to activate, matching this repo's existing
 * convention of hand-written, non-reflective tool/skill allowlists elsewhere.
 *
 * This lives in its own leaf module, rather than in `agent/core.ts` where it
 * started, for one reason: `feature_flags` (agent/tools.ts) must be able to
 * NAME the skills it reports as enabled, and `core.ts` already imports
 * `tools.js`, so importing back the other way would be a cycle.
 *
 * That indirection exists because the alternative silently failed. The
 * `feature_flags` label was written once (#742) naming the two skills that
 * existed then, and was never touched again while four more were added
 * (#755, #757, #758, #759, plus getting-started) — so an admin asking the bot
 * what was enabled was told "prompt-review, claude-code-setup" long after six
 * were live. A hand-maintained list in one place and a hand-maintained
 * sentence about it in another WILL drift; deriving the sentence from the list
 * is what makes that impossible rather than merely unlikely.
 */
export const ENABLED_SKILLS = [
  'prompt-review',
  'model-and-plan-selection',
  'agent-architecture-review',
  'project-showcase',
  'claude-code-setup',
  'getting-started',
  'knowledge-contribution',
  'debug-claude-api-error',
  'member-connection',
  'api-cost-and-latency',
  'rag-and-retrieval-design',
  'mcp-server-design',
  'eval-and-testing-design',
  'tool-use-and-structured-output-design',
] as const;

/**
 * Repo-bundled Agent Skills plugin directory (issue #741), resolved the same
 * way the schema manifest locates its fragments: relative to this file's own
 * compiled location, so it resolves to src/module/agent/skills in dev (tsx) and
 * dist/agent/skills in the built artifact (package.json's build script
 * copies it there, mirroring the existing schema-fragments copy step).
 * Contains only a `.claude-plugin/plugin.json` manifest and static per-skill
 * `skills/<name>/SKILL.md` files — no hooks/agents/commands/.mcp.json — so
 * nothing beyond those static markdown skill bodies is ever loadable from it
 * (pinned by a dedicated test).
 *
 * Exported here as the community skills manifest (agent-base plan item 8),
 * registered by this module's manifest (src/module/agentModule.ts):
 * `skillsManifest.ts` owns the never-`'all'` invariant and core.ts reads the
 * manifest instead of importing this list directly. The prompt-review
 * SKILL.md in this directory and PROMPT_REVIEW_CLAUSE
 * (communityPromptSections.ts) are a byte-identical pair — they move
 * together, pinned by tests/agentSkillsEnabled.test.ts.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

export const COMMUNITY_SKILLS: SkillsManifest = {
  skillsDir: join(__dirname, 'skills'),
  enabledSkills: ENABLED_SKILLS,
};
