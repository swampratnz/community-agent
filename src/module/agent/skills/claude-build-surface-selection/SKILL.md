---
name: claude-build-surface-selection
description: Resolve the "which Claude product do I even build with" fork — Claude Code vs Agent SDK vs raw Messages API vs claude.ai — before handing off to claude-code-setup, getting-started, or model-and-plan-selection
---

- Trigger on the surface/product fork itself, upstream of every other Claude
  skill here: "how do I build X with Claude", "should I use Claude Code or the
  API", "what's the difference between Claude Code and the Agent SDK", "can I
  just use claude.ai for this", "I want to automate Y with Claude, where do I
  start". Not a narrow factual question (`knowledge_search`'s job), and not
  yet a sequencing or setup question — the member hasn't picked a starting
  point yet, which is what makes this distinct from `getting-started`
  (sequences steps *after* a surface is chosen) and `claude-code-setup`
  (assumes Claude Code specifically has already been chosen).
- Ask one clarifying question first, matching the diagnostic style
  `claude-code-setup`/`getting-started` already use, rather than dumping all
  four options at once: what are they actually trying to do —
  - interactively code or automate work in their own repo/terminal;
  - embed an autonomous agent inside their own product, with its own tool
    loop and lifecycle;
  - make a one-off or simple API call from an existing app/pipeline; or
  - just chat or experiment, with no integration at all.
- Branch on the answer, in general/public terms only — never name this
  deployment's own internal tools, RBAC tiers, tables, or infrastructure as a
  worked example, same constraint every sibling skill in this bundle follows:
  - **Claude Code** — a terminal-first coding agent for working *in your own
    codebase*, interactively or via scripted automation. Not a general
    app-building framework.
  - **Claude Agent SDK** — for building your *own* standalone, deployable
    agent or app with its own tool loop, memory, and lifecycle, embedded in a
    product you ship.
  - **Raw Messages API** — for a simple integration into an existing app or
    pipeline where you want direct control and minimal framework overhead,
    without an agent loop.
  - **claude.ai (chat UI / Projects)** — no-code, interactive use with no
    integration required at all.
- Every capability or limit claim about any of the four surfaces must come
  from `knowledge_search`, attributed per the provenance rule in GUIDELINES
  above — never hardcode SDK/API specifics, since they drift. Where
  `knowledge_search` has nothing on the specific point, follow the
  fast-moving-facts rule in GUIDELINES: give a best-effort answer with a
  natural caveat that it may be out of date, and suggest confirming on the
  current Anthropic docs, rather than stating a specific capability as
  confirmed fact on a miss.
- Hand off the moment the fork is resolved — this skill owns only the choice
  of surface, not what comes after:
  - Claude Code chosen, needs installing/authenticating/troubleshooting →
    `claude-code-setup`.
  - Surface chosen, needs an ordered learning path → `getting-started`.
  - Agent SDK or API chosen, now doing detailed design → `mcp-server-design`,
    `tool-use-and-structured-output-design`, `rag-and-retrieval-design`,
    `multi-agent-and-subagent-orchestration-design`, or
    `agent-security-and-untrusted-input-design`, whichever matches.
  - Cost/latency questions once building → `api-cost-and-latency`.
  - The question turns out to be about billing or plan inclusion rather than
    surface → `model-and-plan-selection`.
  Recognise the hand-off cue and defer rather than re-implementing a
  sibling's guidance here.
- Stay within the code policy above: a short illustrative snippet only if one
  is genuinely needed, never a full script.
