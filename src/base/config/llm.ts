import { z } from 'zod';

/** LLM / Claude slice (config.llm + config.agentSkills). */
export const llmSlice = {
  // LLM / Claude
  CLAUDE_CODE_OAUTH_TOKEN: z
    .string()
    .min(1, 'CLAUDE_CODE_OAUTH_TOKEN is required (run `claude setup-token`)'),
  AGENT_MODEL: z.string().default('claude-sonnet-5'),
  // Optional per-tier override of AGENT_MODEL for member/guest turns (issue
  // #382), mirroring AGENT_MAX_TURNS_MEMBER's role-tiering pattern applied to
  // model choice instead of loop depth. Unconstrained string, same validation
  // as AGENT_MODEL — no artificial model allow-list to maintain. Unset/empty
  // = opt-out: every role resolves to AGENT_MODEL, byte-identical to today.
  AGENT_MODEL_MEMBER: z.string().optional(),
  // Optional override of AGENT_MODEL for the two tool-less, single-turn,
  // fixed-format background classifier/extractor query() calls (issue #394):
  // classifyAbuseWithLlm (src/moderation/moderator.ts) and summarizeCluster
  // (src/context/builder.ts). Unlike AGENT_MODEL_MEMBER (keyed to caller
  // role), these call sites have no caller role — one runs against ambient
  // chat text, the other in an unattended weekly job — so this is a separate
  // knob, same unconstrained-string validation, same unset/empty = opt-out
  // posture. researchTopic (src/context/knowledgeRefresh.ts) is deliberately
  // NOT covered: it's multi-turn, uses WebSearch, and produces free-text
  // knowledge-base content where model strength plausibly matters.
  AGENT_MODEL_CLASSIFIER: z.string().optional(),
  // Optional fallback model(s) for the main agent turn (issue #738,
  // docs/CAPABILITY-IDEAS.md §B3): passed straight through to the SDK's own
  // Options.fallbackModel, which the SDK retries the primary model against
  // fresh at the start of every turn (a temporary overload never permanently
  // demotes the session). Accepts a comma-separated list per the SDK's own
  // accepted shape — this repo does no parsing of it, just forwards the
  // string. Same unconstrained-string, unset-means-opt-out shape as
  // AGENT_MODEL_MEMBER/AGENT_MODEL_CLASSIFIER — no artificial model
  // allow-list to maintain. Unset (default): buildQueryOptions omits
  // fallbackModel entirely, byte-identical to today.
  AGENT_MODEL_FALLBACK: z.string().optional(),
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(12),
  // Lower agentic-loop ceiling for member/guest turns (issue #347):
  // MEMBER_TOOLS is a much narrower surface than admin+'s (no WebSearch, no
  // moderation/curation tool chains), so the highest-volume, lowest-trust
  // tier gets a tighter worst-case cost/blast-radius bound than
  // AGENT_MAX_TURNS. admin/super_admin are unaffected — they keep
  // AGENT_MAX_TURNS unchanged.
  AGENT_MAX_TURNS_MEMBER: z.coerce.number().int().positive().default(6),
  // Per-conversation rolling-hour cap on WebSearch invocations for admin+
  // turns (issue #412) — WebSearch is the one metered, real-cost built-in
  // Claude Code tool the bot grants (admin+ only, see buildQueryOptions), and
  // unlike the bot's own MCP tools it was previously bounded only by the
  // shared AGENT_MAX_TURNS loop-depth ceiling, not by a per-conversation cap
  // like the four sibling reserve*Slot levers (create_poll/end_poll/
  // create_thread/warn_user/announce). Generous default: a legitimate
  // multi-step admin research turn never approaches it; the goal is a
  // backstop against runaway/injected repetition across many turns in an
  // hour, not throttling normal use.
  AGENT_WEB_SEARCH_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(20),
  // Query-level dedup for admin+ WebSearch (issue #589): the rate cap above
  // bounds worst-case call VOLUME but never inspects the query, so an
  // agentic turn can reformulate and re-fire the same search — a second
  // metered call plus its redundant result tokens re-entering context, for
  // no new information. Denies an exact repeat (normalized: trimmed,
  // whitespace-collapsed, casefolded) of one of the last
  // AGENT_WEB_SEARCH_DEDUP_HISTORY_SIZE queries within this rolling window,
  // scoped per conversation. Low-risk defaults: short window + small history
  // so a legitimate multi-topic research turn can't plausibly be blocked.
  AGENT_WEB_SEARCH_DEDUP_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  AGENT_WEB_SEARCH_DEDUP_HISTORY_SIZE: z.coerce.number().int().positive().default(3),
  // Embedding-similarity dedup (issue #706, the growth path #589 itself
  // named): once the exact-match check above misses, a near-paraphrase of a
  // recent query ("NZ contractor tax rules" vs "New Zealand tax rules for
  // contractors") is still denied if its embed()-cosine-similarity against
  // any windowed history entry meets this floor. Same default/validation
  // shape as KNOWLEDGE_SHORTCUT_THRESHOLD, the precedent this mirrors.
  AGENT_WEB_SEARCH_DEDUP_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  // Wires the SDK's Agent Skills mechanism (issue #741): when on,
  // buildQueryOptions (agent/core.ts) adds 'Skill' to the base tools array
  // and loads the repo-bundled agent/skills/ plugin directory (the skills
  // named in agent/enabledSkills.ts, never 'all' — six of them as of
  // #755/#757/#758/#759; that list is the single source, so do not restate it
  // here, which is exactly how the feature_flags label went stale), and the #635
  // prompt-review checklist moves out of the always-on GUIDELINES
  // system-prompt block into skills/prompt-review/SKILL.md — a lower
  // per-turn cached-prefix token count for the overwhelming majority of
  // turns that never invoke it. `claude-code-setup` (issue #757) is a new
  // on-demand skill with no GUIDELINES counterpart to move, so this flag
  // gates only its availability, not any always-on token cost. Off by
  // default, same convention as every other opt-in flag here; while off,
  // the prompt-review checklist stays inline in GUIDELINES exactly as
  // before, so there is no configuration in which that capability is
  // absent — claude-code-setup simply isn't loadable until the flag is on.
  AGENT_SKILLS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
};
