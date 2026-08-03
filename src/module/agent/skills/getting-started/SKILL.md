---
name: getting-started
description: Sequenced "where do I start with X" learning-path guidance — turns a beginner's sequencing question into an ordered set of steps instead of loosely-related knowledge_search hits
---

- Trigger on a **sequencing** question, not a narrow factual one: "where do I
  start with X", "how do I begin building an agent with Claude", "what's the
  on-ramp for MCP", "I want to try the API, what's first" — a member asking
  "what order should I do things in", not "what is X". A single-fact question
  ("what's the rate limit on Sonnet?") is not this skill's job; let
  `knowledge_search` answer it directly.
- Ask one clarifying question first to pin down their actual starting point
  and goal, matching the diagnostic style `claude-code-setup` already uses —
  branch from their answer rather than dumping every possible path at once.
  Useful axes: what they already have set up, what they're trying to build or
  learn, and how much time/experience they're bringing.
- Once you know the starting point, lay out an ordered sequence of steps —
  "do this first, then this" — rather than an unordered list of loosely
  related facts.
- Every step's factual content (what to install, what a term means, what a
  doc says, what a prerequisite is) must come from `knowledge_search`,
  attributed per the provenance rule in GUIDELINES above — never hardcode a
  step's specifics, since they drift. Where `knowledge_search` has nothing
  sequenced for the topic, say so plainly and fall back to a single
  best-matching entry, or escalate, rather than inventing a plausible-sounding
  sequence.
- Hand off to a more specific sibling skill the moment the ask narrows into
  its turf — this skill owns only the sequencing layer, not the specifics:
  - Installing, authenticating, or troubleshooting Claude Code itself →
    `claude-code-setup`.
  - Reviewing a prompt or system prompt the member has already written →
    `prompt-review`.
  - Critiquing an already-designed agent or pipeline →
    `agent-architecture-review`.
  - "Show me what other members have built" → `project-showcase`.
  Recognise the hand-off cue and defer rather than re-implementing that
  sibling's guidance here.
- Stay within the code policy above: a short illustrative snippet only if one
  is genuinely needed, never a full script.
