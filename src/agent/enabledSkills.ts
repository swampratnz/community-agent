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
] as const;
